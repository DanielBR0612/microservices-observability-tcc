// k6: WebSocket (ws-service, JWT) + RabbitMQ (management API)
//
// Uso:
//   k6 run -e WS_JWT_SECRET=segredo -e CONTA_ORIGEM=190612 \
//          -e CONTAS_DESTINO=111,222,333 k6-ws-rabbit.js
//
// Variaveis opcionais: BASE, WS_URL, MQ_URL, MQ_USER, MQ_PASS, DEBUG_WS=1

import ws from 'k6/ws';
import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check, sleep, fail } from 'k6';
import { Trend, Counter, Gauge, Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3000/banco/rest';
const WS_URL = __ENV.WS_URL || 'ws://localhost:8083';
const WS_SECRET = __ENV.WS_JWT_SECRET;
const CONTA_ORIGEM = __ENV.CONTA_ORIGEM;
const CONTAS_DESTINO = (__ENV.CONTAS_DESTINO || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MQ = __ENV.MQ_URL || 'http://localhost:15672/api';
const MQ_AUTH = 'Basic ' + encoding.b64encode(`${__ENV.MQ_USER || 'guest'}:${__ENV.MQ_PASS || 'guest'}`);
const mqParams = { headers: { Authorization: MQ_AUTH } };

// Metricas
const notifOk = new Rate('ws_notificacao_recebida');
const notifLatencia = new Trend('ws_notificacao_latencia_ms', true);
const notifBacklog = new Counter('ws_notificacoes_backlog');
const mqProntas = new Gauge('mq_mensagens_prontas');
const mqSemConsumer = new Counter('mq_fila_sem_consumer');
const mqDlq = new Gauge('mq_dlq_mensagens');

export const options = {
  scenarios: {
    websocket: {
      executor: 'per-vu-iterations',
      exec: 'websocket',
      // 1 VU por conta de destino: o ws-service mantem uma conexao por cliente
      vus: Math.max(CONTAS_DESTINO.length, 1),
      iterations: 5,
      maxDuration: '3m',
    },
    rabbit: {
      executor: 'constant-vus',
      exec: 'rabbit',
      vus: 1,
      duration: '1m',
    },
  },
  thresholds: {
    ws_notificacao_recebida: ['rate>0.95'],
    ws_notificacao_latencia_ms: ['p(95)<2000'],
    mq_dlq_mensagens: ['value<1'],
  },
};

// JWT HS256 (mesmo formato do ws-service/tools/generateToken.js)
function b64url(str) {
  return encoding.b64encode(str, 'rawurl');
}

function gerarJwt(sub, secret) {
  const agora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: String(sub),
    clienteId: String(sub),
    iat: agora,
    exp: agora + 3600,
  }));
  const data = `${header}.${payload}`;
  const assinatura = crypto.hmac('sha256', secret, data, 'base64rawurl');
  return `${data}.${assinatura}`;
}

export function setup() {
  if (!WS_SECRET || !CONTA_ORIGEM || CONTAS_DESTINO.length === 0) {
    fail('Defina WS_JWT_SECRET, CONTA_ORIGEM e CONTAS_DESTINO (lista separada por virgula).');
  }
  const r = http.get(`${MQ}/queues`, mqParams);
  if (r.status === 200) {
    const filas = r.json().map((q) => `${q.name} (prontas=${q.messages_ready}, consumers=${q.consumers})`);
    console.log(`Filas RabbitMQ: ${filas.join(' | ')}`);
  } else {
    console.log(`[AVISO] RabbitMQ management API respondeu ${r.status}: ${r.body}`);
  }
}

export function websocket() {
  const conta = CONTAS_DESTINO[(__VU - 1) % CONTAS_DESTINO.length];
  const url = `${WS_URL}?token=${gerarJwt(conta, WS_SECRET)}&clienteId=${conta}`;

  let pixEnviado = false;
  let recebeu = false;
  let t0 = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      // espera 1s: notificacoes antigas da fila (backlog) chegam logo na conexao
      socket.setTimeout(() => {
        t0 = Date.now();
        const r = http.post(`${BASE}/pix`, JSON.stringify({
          contaOrigem: CONTA_ORIGEM,
          chaveDestino: String(conta),
          valor: 1.0,
        }), { headers: { 'Content-Type': 'application/json' } });

        check(r, { 'WS: PIX disparador OK': (x) => x.status === 200 || x.status === 201 });
        if (r.status !== 200 && r.status !== 201) {
          console.log(`[ERRO WS/PIX] Conta: ${conta} | Status: ${r.status} | Body: ${r.body}`);
        }
        pixEnviado = true;
      }, 1000);
    });

    socket.on('message', (msg) => {
      if (__ENV.DEBUG_WS) console.log(`[WS ${conta}] ${msg}`);
      if (!pixEnviado) {
        notifBacklog.add(1);
        return;
      }
      if (!recebeu) {
        recebeu = true;
        notifLatencia.add(Date.now() - t0); // PIX + entrega ponta a ponta
        socket.close();
      }
    });

    socket.on('error', (e) => console.log(`[ERRO WS ${conta}] ${e.error()}`));
    socket.setTimeout(() => socket.close(), 8000);
  });

  check(res, { 'WS conectou (101)': (r) => r && r.status === 101 });
  notifOk.add(recebeu);
  if (!recebeu) console.log(`[ERRO WS] Conta ${conta}: nenhuma notificacao em 8s`);
  sleep(1);
}

export function rabbit() {
  const r = http.get(`${MQ}/queues`, mqParams);
  check(r, { 'RabbitMQ API 200': (x) => x.status === 200 });
  if (r.status === 200) {
    for (const q of r.json()) {
      if (q.name.startsWith('amq.')) continue;
      mqProntas.add(q.messages_ready || 0, { queue: q.name });
      if (/dlq|dead/i.test(q.name)) {
        mqDlq.add(q.messages || 0);
      } else if ((q.consumers || 0) === 0) {
        mqSemConsumer.add(1, { queue: q.name });
      }
    }
  }
  sleep(2);
}