#!/usr/bin/env node
// Cobertura de rastreamento por protocolo, a partir dos traces gravados no Jaeger.
//
// Para cada fluxo (rota do gateway) verifica se o trace contem todos os servicos que a
// requisicao realmente atravessa. Um servico ausente significa que o contexto de trace
// nao foi propagado por aquele protocolo (ou que o servico nao esta instrumentado).
//
// Uso:
//   node observabilidade/cobertura-traces.js --inicio 2026-11-06T00:54:30Z --fim 2026-11-06T00:55:11Z \
//        [--jaeger http://localhost:16686] [--saida resultados-k6/cobertura]
//   Sem --inicio/--fim usa os ultimos 10 minutos.
//
// Saida: tabela no console + cobertura.json e cobertura-fluxos.csv em --saida (se informado).
// Requer Node 18+ (fetch nativo). Sem dependencias.

const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------------------- argumentos
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const JAEGER = (args.jaeger || 'http://localhost:16686').replace(/\/$/, '');
const fim = args.fim ? new Date(args.fim) : new Date();
const inicio = args.inicio ? new Date(args.inicio) : new Date(fim.getTime() - 10 * 60 * 1000);
const SAIDA = args.saida;

// ----------------------------------------------------------------------------- modelo esperado
// Servicos que cada fluxo atravessa de verdade. A raiz e sempre o span HTTP do api-gateway.
// `via` indica o protocolo do salto que se espera ver propagado.
const SOAP = ['api-gateway', 'banco-soap'];
const REST = ['api-gateway', 'rest-api'];
const FLUXOS = [
  { rota: 'POST /auth/login', protocolo: 'SOAP', esperado: SOAP },
  { rota: 'POST /banco/soap/criarCliente', protocolo: 'SOAP', esperado: SOAP },
  { rota: 'POST /banco/soap/criarConta', protocolo: 'SOAP', esperado: SOAP },
  { rota: 'GET /banco/soap/saldo', protocolo: 'SOAP', esperado: SOAP },
  // Sem token o guard JWT do gateway responde 401 antes de chamar o SOAP
  { rota: 'GET /banco/soap/saldo', status: 401, protocolo: 'SOAP', esperado: ['api-gateway'] },
  { rota: 'POST /banco/soap/alterarSenha', protocolo: 'SOAP', esperado: SOAP },
  // TED e PIX tambem publicam a notificacao no RabbitMQ, consumida pelo ws-service (AMQP)
  { rota: 'POST /banco/soap/TED', protocolo: 'SOAP', esperado: [...SOAP, 'ws-service'], via: { 'ws-service': 'AMQP' } },
  { rota: 'POST /banco/rest/pix', protocolo: 'REST', esperado: [...REST, 'ws-service'], via: { 'ws-service': 'AMQP' } },
  { rota: 'POST /banco/rest/clientes/:id/chaves-pix', protocolo: 'REST', esperado: REST },
  { rota: 'GET /banco/rest/clientes/:numeroConta/chaves-pix', protocolo: 'REST', esperado: REST },
  { rota: 'GET /banco/rest/extrato', protocolo: 'REST', esperado: REST },
  { rota: 'POST /comprovantes/gerar', protocolo: 'gRPC', esperado: ['api-gateway', 'comprovantes-service'] },
  { rota: 'GET /atms', protocolo: 'TCP', esperado: ['api-gateway', 'atm-monitor'] },
  { rota: 'POST /atms/refill', protocolo: 'TCP', esperado: ['api-gateway', 'atm-monitor', 'atm-cluster'] },
  { rota: 'POST /atms/block', protocolo: 'TCP', esperado: ['api-gateway', 'atm-monitor'] },
];
// Servicos consultados no Jaeger (o proprio "jaeger" fica de fora)
const SERVICOS = ['api-gateway', 'banco-soap', 'rest-api', 'comprovantes-service', 'ws-service', 'atm-monitor', 'atm-cluster'];
// Servicos com trafego proprio, independente do k6 (heartbeats UDP dos ATMs)
const FUNDO = new Set(['atm-cluster', 'atm-monitor']);

// ----------------------------------------------------------------------------- utilitarios
const KIND = { 1: 'INTERNAL', 2: 'SERVER', 3: 'CLIENT', 4: 'PRODUCER', 5: 'CONSUMER' };
const kindDe = (k) => (typeof k === 'number' ? KIND[k] : String(k || '').replace('SPAN_KIND_', '')) || 'INTERNAL';
const attr = (span, ...chaves) => {
  for (const a of span.attributes || []) {
    if (chaves.includes(a.key)) {
      const v = a.value || {};
      return v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.doubleValue ?? v.boolValue);
    }
  }
  return undefined;
};
const ms = (s) => (Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6);
const quantil = (arr, q) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
};
const media = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(d));

// ----------------------------------------------------------------------------- coleta
const LIMITE_JAEGER = 10000; // maximo de traces por busca aceito pelo Jaeger

// Busca os traces de um servico; se atingir o limite, divide a janela ao meio
async function buscarJanela(svc, de, ate, traces) {
  const url = `${JAEGER}/api/v3/traces?query.service_name=${encodeURIComponent(svc)}`
    + `&query.start_time_min=${de.toISOString()}&query.start_time_max=${ate.toISOString()}`
    + `&query.num_traces=${LIMITE_JAEGER}`;
  const res = await fetch(url);
  if (res.status === 404) return; // servico sem nenhum trace na janela
  if (!res.ok) throw new Error(`Jaeger ${res.status} em ${svc}: ${await res.text()}`);
  const corpo = await res.json();
  const ids = new Set();
  for (const rs of corpo.result?.resourceSpans || []) for (const ss of rs.scopeSpans || []) for (const s of ss.spans || []) ids.add(s.traceId);
  if (ids.size >= LIMITE_JAEGER && ate - de > 1000) {
    const meio = new Date(de.getTime() + (ate - de) / 2);
    await buscarJanela(svc, de, meio, traces);
    await buscarJanela(svc, meio, ate, traces);
    return;
  }
  juntar(corpo, traces);
}

async function buscarTraces() {
  const traces = new Map(); // traceId -> { spans: Map(spanId -> span) }
  for (const svc of SERVICOS) await buscarJanela(svc, inicio, fim, traces);
  return traces;
}

function juntar(corpo, traces) {
    for (const rs of corpo.result?.resourceSpans || []) {
      const servico = rs.resource.attributes.find((a) => a.key === 'service.name')?.value?.stringValue;
      for (const ss of rs.scopeSpans || []) {
        for (const s of ss.spans || []) {
          const t = traces.get(s.traceId) || { spans: new Map() };
          if (!t.spans.has(s.spanId)) t.spans.set(s.spanId, { ...s, servico, kind: kindDe(s.kind), escopo: ss.scope?.name });
          traces.set(s.traceId, t);
        }
      }
    }
}

function analisarTrace(t) {
  const spans = [...t.spans.values()];
  const ids = new Set(spans.map((s) => s.spanId));
  // raiz = span sem pai (ou cujo pai nao esta no trace)
  const raizes = spans.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
  const raiz = raizes.sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))[0];
  const filhos = new Map();
  for (const s of spans) if (s.parentSpanId) filhos.set(s.parentSpanId, [...(filhos.get(s.parentSpanId) || []), s]);
  const profundidade = (s) => 1 + Math.max(0, ...(filhos.get(s.spanId) || []).map(profundidade));
  // tempo "do lado servidor" de cada servico: spans SERVER/CONSUMER de nivel mais alto
  const servidor = {};
  for (const s of spans) {
    if (s.kind !== 'SERVER' && s.kind !== 'CONSUMER') continue;
    const pai = s.parentSpanId && t.spans.get(s.parentSpanId);
    if (pai && pai.servico === s.servico) continue; // ja contado pelo span pai do mesmo servico
    servidor[s.servico] = (servidor[s.servico] || 0) + ms(s);
  }
  return {
    raiz,
    rota: raiz.name,
    status: attr(raiz, 'http.response.status_code', 'http.status_code'),
    servicos: new Set(spans.map((s) => s.servico)),
    nSpans: spans.length,
    profundidade: profundidade(raiz),
    duracaoRaiz: ms(raiz),
    servidor,
    inicio: new Date(Number(BigInt(raiz.startTimeUnixNano) / 1000000n)),
  };
}

function fluxoDe(a) {
  if (a.raiz.servico !== 'api-gateway') return null;
  return FLUXOS.find((f) => f.rota === a.rota && (f.status ? a.status === f.status : a.status !== 401 || f.rota === 'POST /auth/login'))
    || null;
}

// ----------------------------------------------------------------------------- principal
(async () => {
  const traces = await buscarTraces();
  const analises = [...traces.values()].map(analisarTrace).filter((a) => a.inicio >= inicio && a.inicio <= fim);

  const porFluxo = new Map(FLUXOS.map((f) => [f, []]));
  const orfaos = {};
  const naoMapeados = {};
  let fundo = 0;
  for (const a of analises) {
    const f = fluxoDe(a);
    if (f) { porFluxo.get(f).push(a); continue; }
    if (a.raiz.servico === 'api-gateway') { naoMapeados[a.rota] = (naoMapeados[a.rota] || 0) + 1; continue; }
    if (FUNDO.has(a.raiz.servico)) { fundo++; continue; }
    const k = `${a.raiz.servico}: ${a.rota}`;
    orfaos[k] = (orfaos[k] || 0) + 1;
  }

  const linhas = [];
  for (const [f, lista] of porFluxo) {
    if (!lista.length) continue;
    const faltando = {};
    let completos = 0;
    for (const a of lista) {
      const falta = f.esperado.filter((s) => !a.servicos.has(s));
      if (!falta.length) completos++;
      for (const s of falta) faltando[s] = (faltando[s] || 0) + 1;
    }
    // servico de destino direto do gateway (o primeiro salto do protocolo avaliado)
    const destino = f.esperado.find((s) => s !== 'api-gateway');
    const tempoDestino = destino ? lista.map((a) => a.servidor[destino]).filter((x) => x !== undefined) : [];
    linhas.push({
      protocolo: f.protocolo,
      fluxo: f.rota + (f.status ? ` [${f.status}]` : ''),
      esperado: f.esperado.join(' + '),
      traces: lista.length,
      completos,
      cobertura_pct: (100 * completos) / lista.length,
      ausentes: Object.entries(faltando).map(([s, n]) => `${s}${f.via?.[s] ? ` (${f.via[s]})` : ''} ${((100 * n) / lista.length).toFixed(0)}%`).join(', '),
      spans_por_trace: media(lista.map((a) => a.nSpans)),
      profundidade: media(lista.map((a) => a.profundidade)),
      raiz_p50_ms: quantil(lista.map((a) => a.duracaoRaiz), 0.5),
      raiz_p95_ms: quantil(lista.map((a) => a.duracaoRaiz), 0.95),
      // tempo dentro do servico de destino (lado servidor), quando ele aparece no trace
      destino,
      destino_p50_ms: quantil(tempoDestino, 0.5),
    });
  }

  // agregado por protocolo
  const protocolos = {};
  for (const l of linhas) {
    const p = (protocolos[l.protocolo] = protocolos[l.protocolo] || { traces: 0, completos: 0, spans: [], fluxos: 0 });
    p.traces += l.traces; p.completos += l.completos; p.fluxos++; p.spans.push(l.spans_por_trace);
  }
  // os saltos AMQP (TED/PIX -> ws-service) e WebSocket sao avaliados a parte
  const amqp = linhas.filter((l) => /ws-service/.test(l.esperado));
  const amqpPresente = amqp.reduce((s, l) => s + l.traces - (Number((l.ausentes.match(/ws-service \(AMQP\) (\d+)%/) || [])[1] || 0) / 100) * l.traces, 0);
  const amqpTotal = amqp.reduce((s, l) => s + l.traces, 0);

  // ------------------------------------------------------------------------- relatorio
  console.log(`\nCobertura de traces  ${inicio.toISOString()} .. ${fim.toISOString()}  (${analises.length} traces)\n`);
  console.log('| Protocolo | Fluxos | Traces | Completos | Cobertura | Spans/trace |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const [p, v] of Object.entries(protocolos)) {
    console.log(`| ${p} | ${v.fluxos} | ${v.traces} | ${v.completos} | ${fmt((100 * v.completos) / v.traces)}% | ${fmt(media(v.spans))} |`);
  }
  if (amqpTotal) console.log(`| AMQP (backend -> ws-service) | ${amqp.length} | ${amqpTotal} | ${Math.round(amqpPresente)} | ${fmt((100 * amqpPresente) / amqpTotal)}% | - |`);

  console.log('\n| Protocolo | Fluxo | Traces | Cobertura | Ausentes | Spans | Prof. | Raiz p50 | Raiz p95 | Destino p50 |');
  console.log('|---|---|---:|---:|---|---:|---:|---:|---:|---:|');
  for (const l of linhas) {
    console.log(`| ${l.protocolo} | ${l.fluxo} | ${l.traces} | ${fmt(l.cobertura_pct)}% | ${l.ausentes || '-'} | ${fmt(l.spans_por_trace)} | ${fmt(l.profundidade)} | ${fmt(l.raiz_p50_ms)} | ${fmt(l.raiz_p95_ms)} | ${l.destino ? `${fmt(l.destino_p50_ms)} (${l.destino})` : '-'} |`);
  }

  const totalOrfaos = Object.values(orfaos).reduce((s, v) => s + v, 0);
  console.log(`\nTraces orfaos (iniciam fora do gateway): ${totalOrfaos}`);
  for (const [k, v] of Object.entries(orfaos).sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`);
  console.log(`Traces de fundo (heartbeats dos ATMs, ignorados): ${fundo}`);
  if (Object.keys(naoMapeados).length) {
    console.log('Rotas do gateway sem fluxo definido:');
    for (const [k, v] of Object.entries(naoMapeados)) console.log(`  ${v}  ${k}`);
  }

  if (SAIDA) {
    fs.mkdirSync(SAIDA, { recursive: true });
    const cols = ['protocolo', 'fluxo', 'esperado', 'traces', 'completos', 'cobertura_pct', 'ausentes', 'spans_por_trace', 'profundidade', 'raiz_p50_ms', 'raiz_p95_ms', 'destino', 'destino_p50_ms'];
    const csv = [cols.join(','), ...linhas.map((l) => cols.map((c) => {
      const v = l[c];
      return typeof v === 'number' ? v.toFixed(3) : `"${String(v ?? '').replace(/"/g, '""')}"`;
    }).join(','))].join('\n');
    fs.writeFileSync(path.join(SAIDA, 'cobertura-fluxos.csv'), csv + '\n');
    fs.writeFileSync(path.join(SAIDA, 'cobertura.json'), JSON.stringify({
      janela: { inicio: inicio.toISOString(), fim: fim.toISOString() },
      totalTraces: analises.length,
      protocolos: Object.fromEntries(Object.entries(protocolos).map(([p, v]) => [p, {
        fluxos: v.fluxos, traces: v.traces, completos: v.completos, cobertura_pct: (100 * v.completos) / v.traces,
      }])),
      amqp: amqpTotal ? { traces: amqpTotal, com_ws_service: amqpPresente, cobertura_pct: (100 * amqpPresente) / amqpTotal } : null,
      fluxos: linhas,
      orfaos,
      fundo,
      naoMapeados,
    }, null, 2));
    console.log(`\nArquivos gravados em ${SAIDA}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
