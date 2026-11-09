#!/usr/bin/env node
// Eixo 3: o que os traces mostram sobre uma falha injetada?
//
// Compara uma janela com falha a uma janela de base (sem falha) e, para cada fluxo
// (rota do span raiz no gateway), reporta o que um operador veria olhando so o Jaeger:
//   - deteccao:    taxa de traces com erro e mudanca na latencia do span raiz
//   - localizacao: o span com erro mais profundo (servico + operacao) e o span cujo
//                  tempo proprio (self time) mais cresceu em relacao a base
//   - causa:       mensagens de erro disponiveis no span (status, exception.*, rpc status)
//   - estrutura:   servicos que aparecem na base e somem com a falha
//
// Uso:
//   node observabilidade/diagnostico-falhas.js --base-inicio <ISO> --base-fim <ISO> \
//        --inicio <ISO> --fim <ISO> [--fluxo <regex>] [--saida <arquivo.json>]

const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const JAEGER = (args.jaeger || 'http://localhost:16686').replace(/\/$/, '');
const SERVICOS = ['api-gateway', 'banco-soap', 'rest-api', 'comprovantes-service', 'ws-service', 'atm-monitor', 'atm-cluster'];
const KIND = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
const filtro = args.fluxo ? new RegExp(args.fluxo, 'i') : null;

const ns = (s) => Number(BigInt(s));
const attr = (s, k) => {
  const a = (s.attributes || []).find((x) => x.key === k);
  if (!a) return undefined;
  const v = a.value;
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
};
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const o = [...arr].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.floor((p / 100) * o.length))];
};
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');

async function carregar(inicio, fim) {
  const traces = new Map();
  for (const svc of SERVICOS) {
    const url = `${JAEGER}/api/v3/traces?query.service_name=${svc}`
      + `&query.start_time_min=${new Date(inicio).toISOString()}&query.start_time_max=${new Date(fim).toISOString()}`
      + '&query.num_traces=10000';
    const r = await fetch(url);
    if (r.status === 404) continue;
    const j = await r.json();
    for (const rs of j.result?.resourceSpans || []) {
      const servico = rs.resource.attributes.find((a) => a.key === 'service.name').value.stringValue;
      for (const ss of rs.scopeSpans || []) for (const s of ss.spans || []) {
        if (!traces.has(s.traceId)) traces.set(s.traceId, new Map());
        traces.get(s.traceId).set(s.spanId, {
          ...s, servico,
          kind: typeof s.kind === 'number' ? KIND[s.kind] : String(s.kind).replace('SPAN_KIND_', ''),
          dur: (ns(s.endTimeUnixNano) - ns(s.startTimeUnixNano)) / 1e6,
        });
      }
    }
  }
  return traces;
}

function erroDo(s) {
  const st = s.status?.code;
  const http = Number(attr(s, 'http.response.status_code') ?? attr(s, 'http.status_code') ?? attr(s, 'status'));
  const grpc = attr(s, 'rpc.grpc.status_code');
  const exc = attr(s, 'exception');
  return st === 2 || st === 'STATUS_CODE_ERROR' || http >= 500 || (grpc !== undefined && Number(grpc) !== 0)
    || (exc !== undefined && exc !== 'none');
}

function mensagemDe(s) {
  const partes = [];
  if (s.status?.message) partes.push(`status: ${s.status.message}`);
  for (const k of ['exception', 'error.type', 'rpc.grpc.status_code', 'http.response.status_code', 'atm.resultado']) {
    const v = attr(s, k);
    if (v !== undefined && v !== 'none') partes.push(`${k}=${v}`);
  }
  for (const e of s.events || []) {
    if (e.name !== 'exception') continue;
    const tipo = (e.attributes || []).find((a) => a.key === 'exception.type')?.value.stringValue;
    const msg = (e.attributes || []).find((a) => a.key === 'exception.message')?.value.stringValue;
    partes.push(`exception: ${tipo || ''}${msg ? `: ${msg.slice(0, 90)}` : ''}`);
  }
  return partes.join(' | ');
}

// agrupa traces por fluxo (rota da raiz no gateway)
function porFluxo(traces) {
  const fluxos = new Map();
  for (const spans of traces.values()) {
    const lista = [...spans.values()];
    const ids = new Set(lista.map((s) => s.spanId));
    const raiz = lista.find((s) => s.servico === 'api-gateway' && s.kind === 'SERVER' && (!s.parentSpanId || !ids.has(s.parentSpanId)));
    if (!raiz) continue;
    const rota = `${raiz.name}`;
    if (filtro && !filtro.test(rota)) continue;
    if (!fluxos.has(rota)) fluxos.set(rota, []);
    // tempo proprio de cada span = duracao - soma dos filhos (aproximacao, ignora sobreposicao)
    const filhos = new Map();
    for (const s of lista) if (s.parentSpanId) filhos.set(s.parentSpanId, (filhos.get(s.parentSpanId) || 0) + s.dur);
    for (const s of lista) s.self = Math.max(0, s.dur - (filhos.get(s.spanId) || 0));
    fluxos.get(rota).push({ raiz, spans: lista, servicos: new Set(lista.map((s) => s.servico)) });
  }
  return fluxos;
}

function profundidade(s, spans) {
  let d = 0; let p = s;
  const m = new Map(spans.map((x) => [x.spanId, x]));
  while (p && p.parentSpanId && m.has(p.parentSpanId)) { d++; p = m.get(p.parentSpanId); }
  return d;
}

(async () => {
  const [base, falha] = await Promise.all([
    carregar(args['base-inicio'], args['base-fim']).then(porFluxo),
    carregar(args.inicio, args.fim).then(porFluxo),
  ]);
  const saida = [];
  for (const [rota, ts] of falha) {
    const b = base.get(rota) || [];
    const comErro = ts.filter((t) => t.spans.some(erroDo));
    const durB = b.map((t) => t.raiz.dur); const durF = ts.map((t) => t.raiz.dur);

    // span com erro mais profundo de cada trace com erro
    const culpados = new Map();
    for (const t of comErro) {
      const erros = t.spans.filter(erroDo).sort((x, y) => profundidade(y, t.spans) - profundidade(x, t.spans));
      const s = erros[0];
      const k = `${s.servico} | ${s.kind} | ${s.name} | ${mensagemDe(s)}`;
      culpados.set(k, (culpados.get(k) || 0) + 1);
    }
    // span (servico + operacao) cujo tempo proprio mediano mais cresceu
    const selfMed = (lista) => {
      const m = new Map();
      for (const t of lista) for (const s of t.spans) {
        const k = `${s.servico} | ${s.kind} | ${s.name}`;
        (m.get(k) || m.set(k, []).get(k)).push(s.self);
      }
      return new Map([...m].map(([k, v]) => [k, pct(v, 50)]));
    };
    const sb = selfMed(b); const sf = selfMed(ts);
    const deltas = [...sf].map(([k, v]) => [k, v - (sb.get(k) ?? 0), sb.get(k), v]).sort((x, y) => y[1] - x[1]).slice(0, 2);
    // servicos presentes na base e ausentes na falha
    const presB = new Set(b.flatMap((t) => [...t.servicos]));
    const presF = new Set(ts.flatMap((t) => [...t.servicos]));
    const sumiram = [...presB].filter((s) => !presF.has(s));

    saida.push({
      fluxo: rota, traces_base: b.length, traces_falha: ts.length,
      erro_pct: (100 * comErro.length) / (ts.length || 1),
      raiz_p50_base: pct(durB, 50), raiz_p50_falha: pct(durF, 50), raiz_p95_base: pct(durB, 95), raiz_p95_falha: pct(durF, 95),
      culpados: [...culpados].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => ({ span: k, traces: n })),
      maior_aumento_self: deltas.map(([k, d, vb, vf]) => ({ span: k, base_ms: vb, falha_ms: vf, delta_ms: d })),
      servicos_ausentes: sumiram,
    });
  }

  saida.sort((a, b) => b.erro_pct - a.erro_pct || (b.raiz_p50_falha - b.raiz_p50_base) - (a.raiz_p50_falha - a.raiz_p50_base));
  for (const f of saida) {
    console.log(`\n### ${f.fluxo}  (traces: base ${f.traces_base}, falha ${f.traces_falha})`);
    console.log(`- erro: ${fmt(f.erro_pct)}% | raiz p50 ${fmt(f.raiz_p50_base)} -> ${fmt(f.raiz_p50_falha)} ms | p95 ${fmt(f.raiz_p95_base)} -> ${fmt(f.raiz_p95_falha)} ms`);
    for (const c of f.culpados) console.log(`- span com erro mais profundo (${c.traces}x): ${c.span}`);
    for (const d of f.maior_aumento_self) console.log(`- maior aumento de tempo proprio: ${d.span}: ${fmt(d.base_ms)} -> ${fmt(d.falha_ms)} ms`);
    if (f.servicos_ausentes.length) console.log(`- servicos que sumiram do trace: ${f.servicos_ausentes.join(', ')}`);
  }
  if (args.saida) fs.writeFileSync(args.saida, JSON.stringify({ base: [args['base-inicio'], args['base-fim']], falha: [args.inicio, args.fim], fluxos: saida }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
