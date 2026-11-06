#!/usr/bin/env node
// Agrega as repeticoes do experimento de overhead (observabilidade/experimento-overhead.sh).
//
// Uso: node observabilidade/agregar-experimento.js resultados-experimento/<data>
//
// Le, para cada <config>/rep-N:
//   resumo.json           --summary-export do k6 (latencia por protocolo)
//   recursos-inicio.csv   CPU acumulada (ms) e memoria (MB) de cada servico antes da rodada
//   recursos-fim.csv      idem, depois da rodada
//   meta.json             janela de tempo da rodada
//   cobertura.json        cobertura de traces (so nas configs com OpenTelemetry)
//
// Grava no mesmo diretorio:
//   latencia.csv     uma linha por config x rep x serie (protocolo / notificacao / websocket)
//   recursos.csv     uma linha por config x rep x servico (nucleos de CPU medios, memoria)
//   cobertura.csv    uma linha por config x rep x protocolo
//   comparacao.csv   mediana entre repeticoes, overhead vs linha de base e p-valor (Mann-Whitney)
//   comparacao.md    as mesmas tabelas em Markdown, prontas para o texto
//
// Sem dependencias. Node 18+.

const fs = require('fs');
const path = require('path');

const DIR = process.argv[2];
if (!DIR) { console.error('uso: node agregar-experimento.js <diretorio do experimento>'); process.exit(1); }
const BASE = process.env.BASE || 'sem-otel';

// Series de latencia lidas do resumo do k6
const SERIES = [
  ['SOAP', 'http_req_duration{protocolo:SOAP}'],
  ['REST', 'http_req_duration{protocolo:REST}'],
  ['gRPC', 'http_req_duration{protocolo:gRPC}'],
  ['TCP', 'http_req_duration{protocolo:TCP}'],
  ['WebSocket (handshake)', 'ws_connecting{protocolo:WebSocket}'],
  ['AMQP notificacao PIX', 'ws_notificacao_latencia_ms{tipo:PIX}'],
  ['AMQP notificacao TED', 'ws_notificacao_latencia_ms{tipo:TED}'],
  ['Total HTTP', 'http_req_duration'],
];
const FALHAS = { SOAP: 'http_req_failed{protocolo:SOAP}', REST: 'http_req_failed{protocolo:REST}', gRPC: 'http_req_failed{protocolo:gRPC}', TCP: 'http_req_failed{protocolo:TCP}', 'Total HTTP': 'http_req_failed' };
const ESTAT = [['p50', 'med'], ['p90', 'p(90)'], ['p95', 'p(95)'], ['p99', 'p(99)'], ['media', 'avg'], ['max', 'max']];

// ------------------------------------------------------------------ utilitarios
const lerJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const lerRecursos = (f) => {
  const m = {};
  if (!fs.existsSync(f)) return m;
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const [s, cpu, mem] = l.split(',');
    m[s] = { cpu: Number(cpu), mem: Number(mem) };
  }
  return m;
};
const mediana = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const media = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const desvio = (a) => { if (a.length < 2) return null; const m = media(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '' : Number(v).toFixed(d));
const csvLinha = (vals) => vals.map((v) => (typeof v === 'number' ? fmt(v, 4) : `"${String(v ?? '').replace(/"/g, '""')}"`)).join(',');

// Teste U de Mann-Whitney bicaudal, p-valor exato (sem empates) por contagem de permutacoes.
// Adequado para poucas repeticoes (n <= ~20 por grupo).
function mannWhitney(x, y) {
  const n1 = x.length, n2 = y.length;
  if (n1 < 2 || n2 < 2) return { u: null, p: null };
  const todos = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort((a, b) => a[0] - b[0]);
  const ranks = new Array(todos.length);
  for (let i = 0; i < todos.length;) { // ranks medios em caso de empate
    let j = i; while (j + 1 < todos.length && todos[j + 1][0] === todos[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const r1 = todos.reduce((s, t, i) => s + (t[1] === 0 ? ranks[i] : 0), 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  // distribuicao exata de U: f(m,n,k) = f(m-1,n,k-n) + f(m,n-1,k)
  const memo = new Map();
  const f = (m, n, k) => {
    if (k < 0) return 0;
    if (m === 0 || n === 0) return k === 0 ? 1 : 0;
    const chave = `${m},${n},${k}`;
    if (memo.has(chave)) return memo.get(chave);
    const v = f(m - 1, n, k - n) + f(m, n - 1, k);
    memo.set(chave, v); return v;
  };
  let total = 0, cauda = 0;
  for (let k = 0; k <= n1 * n2; k++) { const c = f(n1, n2, k); total += c; if (k <= Math.floor(u)) cauda += c; }
  return { u, p: Math.min(1, (2 * cauda) / total) };
}

// ------------------------------------------------------------------ leitura
const ORDEM = ['sem-otel', 'otel-10', 'otel-100'];
const configs = fs.readdirSync(DIR)
  .filter((d) => fs.statSync(path.join(DIR, d)).isDirectory() && fs.readdirSync(path.join(DIR, d)).some((r) => /^rep-\d+$/.test(r)))
  .sort((a, b) => (a === BASE ? -1 : b === BASE ? 1 : (ORDEM.indexOf(a) + 99) % 100 - (ORDEM.indexOf(b) + 99) % 100 || a.localeCompare(b)));
const lat = [], rec = [], cob = [];
for (const cfg of configs) {
  const reps = fs.readdirSync(path.join(DIR, cfg)).filter((r) => /^rep-\d+$/.test(r)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  for (const r of reps) {
    const d = path.join(DIR, cfg, r);
    const rep = Number(r.slice(4));
    const resumo = lerJson(path.join(d, 'resumo.json'));
    const meta = lerJson(path.join(d, 'meta.json')) || {};
    const exitK6 = fs.existsSync(path.join(d, 'k6-exit.txt')) ? fs.readFileSync(path.join(d, 'k6-exit.txt'), 'utf8').trim() : '';
    if (resumo) {
      const M = resumo.metrics;
      const durS = (meta.duracao_ms || 0) / 1000;
      for (const [serie, chave] of SERIES) {
        const m = M[chave];
        if (!m) continue;
        const falha = FALHAS[serie] && M[FALHAS[serie]];
        const reqs = M[chave.replace('http_req_duration', 'http_reqs')];
        lat.push({
          config: cfg, rep, ciclo: meta.ciclo ?? 1, serie,
          ...Object.fromEntries(ESTAT.map(([n, k]) => [n, m[k]])),
          amostras: m.count ?? null,
          erro_pct: falha ? 100 * (falha.value ?? 0) : null,
          vazao_req_s: chave.startsWith('http_req_duration') && reqs ? reqs.rate : null,
          iteracoes: M.iterations?.count ?? null,
          iteracoes_descartadas: M.dropped_iterations?.count ?? 0,
          checks_pct: M.checks ? 100 * M.checks.value : null,
          k6_exit: exitK6,
        });
      }
    }
    const ini = lerRecursos(path.join(d, 'recursos-inicio.csv'));
    const fim = lerRecursos(path.join(d, 'recursos-fim.csv'));
    for (const s of Object.keys(fim)) {
      if (!ini[s] || !meta.duracao_ms) continue;
      rec.push({ config: cfg, rep, ciclo: meta.ciclo ?? 1, servico: s, cpu_nucleos: (fim[s].cpu - ini[s].cpu) / meta.duracao_ms, mem_mb: fim[s].mem });
    }
    const c = lerJson(path.join(d, 'cobertura.json'));
    if (c) {
      for (const [p, v] of Object.entries(c.protocolos)) cob.push({ config: cfg, rep, protocolo: p, traces: v.traces, cobertura_pct: v.cobertura_pct });
      if (c.amqp) cob.push({ config: cfg, rep, protocolo: 'AMQP', traces: c.amqp.traces, cobertura_pct: c.amqp.cobertura_pct });
      cob.push({ config: cfg, rep, protocolo: 'orfaos', traces: Object.values(c.orfaos || {}).reduce((s, v) => s + v, 0), cobertura_pct: null });
    }
  }
}

// ------------------------------------------------------------------ CSVs brutos
const salvar = (nome, cols, linhas) => fs.writeFileSync(path.join(DIR, nome), [cols.join(','), ...linhas.map((l) => csvLinha(cols.map((c) => l[c])))].join('\n') + '\n');
salvar('latencia.csv', ['config', 'rep', 'ciclo', 'serie', ...ESTAT.map(([n]) => n), 'amostras', 'erro_pct', 'vazao_req_s', 'iteracoes', 'iteracoes_descartadas', 'checks_pct', 'k6_exit'], lat);
salvar('recursos.csv', ['config', 'rep', 'ciclo', 'servico', 'cpu_nucleos', 'mem_mb'], rec);
salvar('cobertura.csv', ['config', 'rep', 'protocolo', 'traces', 'cobertura_pct'], cob);

// ------------------------------------------------------------------ comparacao
const outrasConfigs = configs.filter((c) => c !== BASE);
const comp = [];
const md = [];
md.push(`# Resultado do experimento de overhead`, '', `Diretorio: \`${DIR}\`  `, `Linha de base: \`${BASE}\`. Valores = mediana entre repeticoes; overhead = (config - base) / base; p = Mann-Whitney bicaudal exato entre as repeticoes.`, '');

const params = lerJson(path.join(DIR, 'parametros.json'));
if (params) md.push(`Parametros: ${params.reps} repeticoes por configuracao, ${params.taxa_iter_s} iteracoes/s, ${params.duracao} por rodada, aquecimento ${params.aquecimento}.`, '');

function comparar(titulo, grupos, metricas, unidade) {
  md.push(`## ${titulo}`, '');
  const cab = ['Serie', 'Metrica', ...configs.map((c) => `${c} (${unidade})`), ...outrasConfigs.flatMap((c) => [`overhead ${c}`, `p ${c}`])];
  md.push(`| ${cab.join(' | ')} |`, `|${cab.map((_, i) => (i < 2 ? '---' : '---:')).join('|')}|`);
  for (const [serie, linhas] of grupos) {
    for (const met of metricas) {
      const porCfg = Object.fromEntries(configs.map((c) => [c, linhas.filter((l) => l.config === c).map((l) => l[met]).filter((v) => v !== null && v !== undefined)]));
      const base = mediana(porCfg[BASE] || []);
      const linha = { serie, metrica: met };
      const cel = [serie, met];
      for (const c of configs) {
        const med = mediana(porCfg[c]);
        linha[`${c}_mediana`] = med; linha[`${c}_media`] = media(porCfg[c]); linha[`${c}_desvio`] = desvio(porCfg[c]); linha[`${c}_n`] = porCfg[c].length;
        cel.push(med === null ? '-' : `${fmt(med)} ± ${fmt(desvio(porCfg[c]))}`);
      }
      for (const c of outrasConfigs) {
        const med = mediana(porCfg[c]);
        const ov = base && med !== null ? (100 * (med - base)) / base : null;
        const { p } = mannWhitney(porCfg[c] || [], porCfg[BASE] || []);
        linha[`overhead_${c}_pct`] = ov; linha[`p_${c}`] = p;
        cel.push(ov === null ? '-' : `${ov >= 0 ? '+' : ''}${fmt(ov, 1)}%`, p === null ? '-' : fmt(p, 3));
      }
      comp.push(linha);
      md.push(`| ${cel.join(' | ')} |`);
    }
  }
  md.push('');
}

const agrupar = (linhas, chave) => [...new Set(linhas.map((l) => l[chave]))].map((k) => [k, linhas.filter((l) => l[chave] === k)]);
comparar('Latencia por protocolo', agrupar(lat, 'serie'), ['p50', 'p95', 'p99'], 'ms');
comparar('Vazao e erros', agrupar(lat.filter((l) => l.vazao_req_s !== null), 'serie'), ['vazao_req_s', 'erro_pct'], 'valor');
comparar('CPU por servico (nucleos medios durante a rodada)', agrupar(rec, 'servico'), ['cpu_nucleos'], 'nucleos');
comparar('Memoria por servico (ao fim da rodada)', agrupar(rec, 'servico'), ['mem_mb'], 'MB');

if (cob.length) {
  md.push('## Cobertura de traces (configs com OpenTelemetry)', '');
  md.push('| Protocolo | ' + outrasConfigs.map((c) => `${c} cobertura (%)`).join(' | ') + ' | ' + outrasConfigs.map((c) => `${c} traces/rodada`).join(' | ') + ' |');
  md.push('|---|' + outrasConfigs.map(() => '---:').join('|') + '|' + outrasConfigs.map(() => '---:').join('|') + '|');
  for (const [p, linhas] of agrupar(cob, 'protocolo')) {
    const cobs = outrasConfigs.map((c) => fmt(mediana(linhas.filter((l) => l.config === c && l.cobertura_pct !== null).map((l) => l.cobertura_pct)), 1) || '-');
    const trs = outrasConfigs.map((c) => fmt(mediana(linhas.filter((l) => l.config === c).map((l) => l.traces)), 0) || '-');
    md.push(`| ${p} | ${cobs.join(' | ')} | ${trs.join(' | ')} |`);
  }
  md.push('');
}

const avisos = lat.filter((l) => l.serie === 'Total HTTP' && (l.k6_exit !== '0' || l.iteracoes_descartadas > 0));
if (avisos.length) {
  md.push('## Avisos', '');
  for (const a of avisos) md.push(`- ${a.config} rep ${a.rep}: k6 exit=${a.k6_exit}, iteracoes descartadas=${a.iteracoes_descartadas}, checks=${fmt(a.checks_pct, 1)}%`);
  md.push('');
}

const colsComp = [...new Set(comp.flatMap((l) => Object.keys(l)))];
salvar('comparacao.csv', colsComp, comp);
fs.writeFileSync(path.join(DIR, 'comparacao.md'), md.join('\n'));
console.log(md.join('\n'));
console.log(`\nArquivos: latencia.csv, recursos.csv, cobertura.csv, comparacao.csv, comparacao.md em ${DIR}`);
