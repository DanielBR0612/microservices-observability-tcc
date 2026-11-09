#!/usr/bin/env node
// Auditoria de dados sensiveis na telemetria (objetivo especifico 3 do artigo).
//
// Le do Jaeger todos os spans de uma janela de tempo, de todos os servicos, e procura dados
// sensiveis nos atributos dos spans, nos eventos e nos atributos de recurso. Cada achado
// registra a categoria, o servico, o nome do span e a chave do atributo, com o valor mascarado.
//
// Uso:
//   node observabilidade/auditoria-telemetria.js --inicio <ISO> --fim <ISO> [--saida <dir>]
// Saida: tabela no console + achados.csv e resumo.json em --saida (se informado).
// Requer Node 18+ (fetch nativo). Sem dependencias.

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
if (!args.inicio || !args.fim) {
  console.error('Uso: node auditoria-telemetria.js --inicio <ISO> --fim <ISO> [--saida <dir>]');
  process.exit(1);
}
const JAEGER = (args.jaeger || 'http://localhost:16686').replace(/\/$/, '');
const SERVICOS = ['api-gateway', 'banco-soap', 'rest-api', 'comprovantes-service', 'ws-service', 'atm-monitor', 'atm-cluster'];

// Valores fixos usados pela carga do k6 (script.js)
const SENHAS_K6 = ['123456', '654321'];

// Detectores: categoria -> funcao(chave, valor) -> boolean.
// A ordem importa so para a exibicao; um mesmo atributo pode cair em varias categorias.
const DETECTORES = [
  ['Token JWT', (k, v) => /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/.test(v)],
  ['Cabecalho Authorization', (k, v) => /authorization/i.test(k) || /^Bearer\s/i.test(v)],
  ['Senha (chave ou valor)', (k, v) => /senha|password|passwd|secret/i.test(k) || SENHAS_K6.some((s) => new RegExp(`(^|[^0-9])${s}([^0-9]|$)`).test(v))],
  ['CPF', (k, v) => /cpf/i.test(k) || /cpf/i.test(v)],
  ['Numero de conta em URL/rota', (k, v) => /(url|target|route|path|uri)/i.test(k) && /\d{12,}/.test(v)],
  ['Chave Pix (e-mail)', (k, v) => /[\w.+-]+@[\w-]+\.[\w.]+/.test(v)],
  ['Valor monetario', (k, v) => /valor|saldo|amount/i.test(k)],
  ['SQL com literais', (k, v) => /db\.(statement|query\.text)/.test(k) && /(=\s*'[^']*'|=\s*\d+|values\s*\((?!\s*\?))/i.test(v)],
  ['SQL (texto da consulta)', (k, v) => /db\.(statement|query\.text)/.test(k)],
  ['Query string em URL', (k, v) => /(url|target)/i.test(k) && /\?[^\s]+=/.test(v)],
];

const mascarar = (v) => {
  const s = String(v);
  return s.length <= 12 ? s.replace(/./g, (c, i) => (i < 2 ? c : '*')) : `${s.slice(0, 40)}${s.length > 40 ? '...' : ''}`
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, 'eyJ***.***.***')
    .replace(/\b(123456|654321)\b/g, '******')
    .replace(/\d{9,}/g, (d) => `${d.slice(0, 3)}${'*'.repeat(d.length - 3)}`);
};

const valorDe = (v) => {
  if (!v) return '';
  for (const t of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) if (v[t] !== undefined) return String(v[t]);
  if (v.arrayValue) return (v.arrayValue.values || []).map(valorDe).join(',');
  return JSON.stringify(v);
};

async function buscar(svc) {
  const url = `${JAEGER}/api/v3/traces?query.service_name=${encodeURIComponent(svc)}`
    + `&query.start_time_min=${new Date(args.inicio).toISOString()}&query.start_time_max=${new Date(args.fim).toISOString()}`
    + '&query.num_traces=10000';
  const r = await fetch(url);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`${svc}: HTTP ${r.status}`);
  const j = await r.json();
  return j.result?.resourceSpans || [];
}

(async () => {
  const spans = new Map(); // spanId -> { svc, nome, atributos: [[origem, chave, valor]] }
  for (const svc of SERVICOS) {
    for (const rs of await buscar(svc)) {
      const servico = rs.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue;
      const recurso = rs.resource.attributes.map((a) => ['recurso', a.key, valorDe(a.value)]);
      for (const ss of rs.scopeSpans || []) for (const s of ss.spans || []) {
        if (spans.has(s.spanId)) continue;
        const atributos = [
          ...(s.attributes || []).map((a) => ['span', a.key, valorDe(a.value)]),
          ...(s.events || []).flatMap((e) => (e.attributes || []).map((a) => [`evento:${e.name}`, a.key, valorDe(a.value)])),
          ...recurso,
        ];
        spans.set(s.spanId, { svc: servico, nome: s.name, atributos });
      }
    }
  }

  // agrega por (categoria, servico, chave)
  const achados = new Map();
  const chavesPorServico = {};
  for (const sp of spans.values()) {
    for (const [origem, chave, valor] of sp.atributos) {
      if (origem === 'span') (chavesPorServico[sp.svc] = chavesPorServico[sp.svc] || new Set()).add(chave);
      for (const [cat, det] of DETECTORES) {
        if (!det(chave, valor)) continue;
        const id = `${cat}|${sp.svc}|${origem}|${chave}`;
        const a = achados.get(id) || { categoria: cat, servico: sp.svc, origem, chave, spans: 0, exemplo_span: sp.nome, exemplo_valor: mascarar(valor) };
        a.spans++;
        achados.set(id, a);
      }
    }
  }

  const lista = [...achados.values()].sort((a, b) => a.categoria.localeCompare(b.categoria) || b.spans - a.spans);
  console.log(`Auditoria de telemetria  ${args.inicio} .. ${args.fim}  (${spans.size} spans)\n`);
  console.log('| Categoria | Servico | Origem | Atributo | Spans | Exemplo de span | Valor (mascarado) |');
  console.log('|---|---|---|---|---:|---|---|');
  for (const a of lista) {
    console.log(`| ${a.categoria} | ${a.servico} | ${a.origem} | \`${a.chave}\` | ${a.spans} | ${a.exemplo_span} | \`${a.exemplo_valor}\` |`);
  }

  if (args.saida) {
    fs.mkdirSync(args.saida, { recursive: true });
    const col = ['categoria', 'servico', 'origem', 'chave', 'spans', 'exemplo_span', 'exemplo_valor'];
    const csv = [col.join(','), ...lista.map((a) => col.map((c) => JSON.stringify(String(a[c]))).join(','))].join('\n');
    fs.writeFileSync(path.join(args.saida, 'achados.csv'), csv);
    fs.writeFileSync(path.join(args.saida, 'resumo.json'), JSON.stringify({
      inicio: args.inicio, fim: args.fim, spans: spans.size,
      chaves_por_servico: Object.fromEntries(Object.entries(chavesPorServico).map(([k, v]) => [k, [...v].sort()])),
      achados: lista,
    }, null, 2));
    console.log(`\nArquivos gravados em ${args.saida}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
