// Teste de carga ponta a ponta: cada iteracao percorre todos os servicos.
//
//   protocolo   caminho                                   operacoes
//   SOAP        gateway (HTTP/JSON) -> BancoCoreSOAP      criarCliente, criarConta, login, saldo, alterarSenha, TED
//   REST        gateway (HTTP/JSON) -> BancoRestApi       chave Pix, listar chaves, PIX, extrato
//   gRPC        gateway (HTTP/JSON) -> ComprovantesService comprovante PDF
//   TCP         gateway (HTTP/JSON) -> atm-monitor (TCP)  listar, abastecer, bloquear ATM
//   WebSocket   k6 -> ws-service                          handshake com JWT
//   AMQP        backend -> RabbitMQ -> ws-service -> WS   notificacao de PIX e TED ao destinatario
//   infra       RabbitMQ management, Jaeger               verificacoes (fora da analise)
//
// Toda requisicao leva as tags `protocolo` e `operacao`, entao o resumo do k6 e o JSON
// bruto (--out json) podem ser separados por protocolo.
//
// Modos de carga (variavel MODO):
//   vus   (padrao) VUs fixos com think time de 1s.      VUS=5 DURACAO=30s
//   taxa  taxa de chegada constante, sem think time.   TAXA=1 (iteracoes/s) DURACAO=60s
//         Use este modo para medir overhead: a carga oferecida nao depende da latencia.
//
// Rodar: docker compose run --rm k6
//        docker compose run --rm -e MODO=taxa -e TAXA=2 -e DURACAO=60s k6

import http from 'k6/http';
import ws from 'k6/ws';
import encoding from 'k6/encoding';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const MODO = __ENV.MODO || 'vus';
const DURACAO = __ENV.DURACAO || (MODO === 'taxa' ? '60s' : '30s');
const CHECAR_JAEGER = (__ENV.CHECAR_JAEGER || '1') === '1';

// Protocolos que passam por HTTP no gateway (WebSocket e AMQP tem metricas proprias)
const PROTOCOLOS = ['SOAP', 'REST', 'gRPC', 'TCP'];

const cenario = MODO === 'taxa'
  ? {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.TAXA || 1),
      timeUnit: '1s',
      duration: DURACAO,
      preAllocatedVUs: Number(__ENV.VUS || 10),
      maxVUs: Number(__ENV.MAX_VUS || 50),
    }
  : {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 5),
      duration: DURACAO,
    };

// Sub-metricas por protocolo so aparecem no resumo (e no --summary-export) se tiverem
// threshold; os thresholds abaixo sempre passam e existem apenas para isso.
const porProtocolo = {};
for (const p of PROTOCOLOS) {
  porProtocolo[`http_req_duration{protocolo:${p}}`] = ['max>=0'];
  porProtocolo[`http_req_failed{protocolo:${p}}`] = ['rate>=0'];
  porProtocolo[`http_reqs{protocolo:${p}}`] = ['count>=0'];
}
porProtocolo['ws_notificacao_latencia_ms{tipo:PIX}'] = ['max>=0'];
porProtocolo['ws_notificacao_latencia_ms{tipo:TED}'] = ['max>=0'];
porProtocolo['ws_connecting{protocolo:WebSocket}'] = ['max>=0'];

export const options = {
  scenarios: { principal: cenario },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  thresholds: {
    checks: ['rate==1.0'],
    http_req_failed: ['rate==0'],
    ws_notificacao_recebida: ['rate==1.0'],
    ...porProtocolo,
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://gateway:3000';
const WS_URL = __ENV.WS_URL || 'ws://ws-service:8083/ws';
const MQ_API = __ENV.MQ_API || 'http://rabbitmq:15672/api';
const JAEGER_API = __ENV.JAEGER_API || 'http://jaeger:16686/api';
const NOTIF_TIMEOUT_MS = Number(__ENV.NOTIF_TIMEOUT_MS || 10000);

const SENHA_PADRAO = '123456'; // senha criada pelo SOAP em criarCliente
const SENHA_NOVA = '654321';
const ATM_REAL = 'ATM-CENTRO-01';
const ATM_FALSO = 'LOADTEST-INEXISTENTE';
const VALOR_PIX = 50.5;
const VALOR_TED = 100;
const SALDO_INICIAL = 2000;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MQ_AUTH = 'Basic ' + encoding.b64encode('guest:guest');

// Notificacao: tempo entre o envio do PIX/TED e a chegada da mensagem no WebSocket do
// destinatario (backend -> RabbitMQ -> ws-service -> WebSocket)
const notifRecebida = new Rate('ws_notificacao_recebida');
const notifLatencia = new Trend('ws_notificacao_latencia_ms', true);

// Apenas 2xx conta como sucesso; os casos que esperam 401 declaram isso explicitamente.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }));

const pad = (n, w) => String(n).padStart(w, '0');

// Toda chamada HTTP passa por aqui para receber as tags de protocolo e operacao.
// `name` agrupa URLs com ids diferentes numa unica serie.
function chamar(metodo, path, body, { protocolo, operacao, headers = {}, esperado, base = BASE_URL }) {
  const params = {
    headers: { ...(body !== undefined ? JSON_HEADERS : {}), ...headers },
    tags: { protocolo, operacao, name: operacao },
  };
  if (esperado) params.responseCallback = http.expectedStatuses(esperado);
  const url = `${base}${path}`;
  return metodo === 'GET'
    ? http.get(url, params)
    : http.request(metodo, url, body !== undefined ? JSON.stringify(body) : null, params);
}

function json(res) {
  try { return res.json(); } catch (e) { return null; }
}

function logErro(nome, res) {
  if (res.status < 200 || res.status >= 300) {
    console.error(`[ERRO ${nome}] status=${res.status} body=${String(res.body).slice(0, 300)}`);
  }
}

function criarClienteEConta(nome, numeroConta, saldo) {
  const cpf = String(Math.floor(10000000000 + Math.random() * 89999999999));
  const resCli = chamar('POST', '/banco/soap/criarCliente', { nome, cpf },
    { protocolo: 'SOAP', operacao: 'criarCliente' });
  logErro('criarCliente', resCli);
  const clienteId = json(resCli)?.data?.id;
  check(resCli, {
    'SOAP criarCliente 2xx': (r) => r.status >= 200 && r.status < 300,
    'SOAP criarCliente retorna id': () => !!clienteId,
  });

  const resConta = chamar('POST', '/banco/soap/criarConta',
    { clienteId: Number(clienteId), numeroConta, saldoInicial: saldo },
    { protocolo: 'SOAP', operacao: 'criarConta' });
  logErro('criarConta', resConta);
  check(resConta, {
    'SOAP criarConta 2xx': (r) => r.status >= 200 && r.status < 300,
    'SOAP criarConta numero correto': (r) => String(json(r)?.data?.numeroConta) === numeroConta,
  });
  return clienteId;
}

// O login do gateway valida a senha chamando a operacao SOAP `autenticar`
function login(conta, senha, esperado) {
  const res = chamar('POST', '/auth/login', { conta, senha },
    { protocolo: 'SOAP', operacao: esperado ? 'login (senha invalida)' : 'login', esperado });
  return { res, token: json(res)?.data?.access_token }; // HateoasInterceptor envelopa em { data }
}

function consultarSaldo(token) {
  const res = chamar('GET', '/banco/soap/saldo', undefined,
    { protocolo: 'SOAP', operacao: 'saldo', headers: { Authorization: `Bearer ${token}` } });
  logErro('saldo', res);
  return { res, saldo: Number(json(res)?.data?.saldo) };
}

export default function () {
  // Numeros de conta unicos: timestamp + VU(3) + ITER(4) + sufixo (1 = origem, 2 = destino)
  const base = `${Date.now() % 1e7}${pad(__VU, 3)}${pad(__ITER, 4)}`;
  const contaOrigem = `${base}1`;
  const contaDestino = `${base}2`;
  const chavePix = `k6_${base}@email.com`;

  // ---------------------------------------------------------------- SOAP: cadastro
  let idCliDestino;
  group('SOAP cadastro', () => {
    criarClienteEConta(`Origem K6 VU ${__VU}`, contaOrigem, SALDO_INICIAL);
    idCliDestino = criarClienteEConta(`Destino K6 VU ${__VU}`, contaDestino, 1000);
  });

  // ---------------------------------------------------------------- Auth (JWT via SOAP autenticar)
  let tokenOrigem;
  let tokenDestino;
  group('Auth e saldo', () => {
    const lo = login(contaOrigem, SENHA_PADRAO);
    logErro('login origem', lo.res);
    tokenOrigem = lo.token;
    check(lo.res, { 'Auth login origem retorna token': () => !!tokenOrigem });

    const ld = login(contaDestino, SENHA_PADRAO);
    logErro('login destino', ld.res);
    tokenDestino = ld.token;
    check(ld.res, { 'Auth login destino retorna token': () => !!tokenDestino });

    const s = consultarSaldo(tokenOrigem);
    check(s.res, {
      'SOAP saldo (JWT) 200': (r) => r.status === 200,
      'SOAP saldo inicial correto': () => s.saldo === SALDO_INICIAL,
    });

    // Barrado pelo guard JWT do gateway: nao chega ao SOAP
    const semToken = chamar('GET', '/banco/soap/saldo', undefined,
      { protocolo: 'SOAP', operacao: 'saldo (sem token)', esperado: 401 });
    check(semToken, { 'SOAP saldo sem token 401': (r) => r.status === 401 });
  });

  // ---------------------------------------------------------------- SOAP: alterar senha
  group('SOAP alterar senha', () => {
    const res = chamar('POST', '/banco/soap/alterarSenha',
      { numeroConta: contaOrigem, senhaAntiga: SENHA_PADRAO, senhaNova: SENHA_NOVA },
      { protocolo: 'SOAP', operacao: 'alterarSenha' });
    logErro('alterarSenha', res);
    check(res, {
      'SOAP alterarSenha 2xx': (r) => r.status >= 200 && r.status < 300,
      'SOAP alterarSenha SUCESSO': (r) => json(r)?.data?.status === 'SUCESSO',
    });

    const nova = login(contaOrigem, SENHA_NOVA);
    logErro('login senha nova', nova.res);
    check(nova.res, { 'Auth login com senha nova': () => !!nova.token });
    if (nova.token) tokenOrigem = nova.token;

    const antiga = login(contaOrigem, SENHA_PADRAO, 401);
    check(antiga.res, { 'Auth senha antiga rejeitada 401': (r) => r.status === 401 });
  });

  // ---------------------------------------------------------------- REST: chave Pix
  group('REST chave Pix', () => {
    const res = chamar('POST', `/banco/rest/clientes/${idCliDestino}/chaves-pix`,
      { tipo: 'EMAIL', valor: chavePix, numeroConta: contaDestino },
      { protocolo: 'REST', operacao: 'criarChavePix' });
    logErro('criarChavePix', res);
    check(res, { 'REST criar chave Pix 2xx': (r) => r.status >= 200 && r.status < 300 });

    const lista = chamar('GET', `/banco/rest/clientes/${contaDestino}/chaves-pix`, undefined,
      { protocolo: 'REST', operacao: 'listarChavesPix' });
    logErro('listarChaves', lista);
    check(lista, {
      'REST listar chaves 200': (r) => r.status === 200,
      'REST listar chaves contem a nova': (r) => (json(r)?.data || []).some((c) => c.valor === chavePix),
    });
  });

  // ---------------------------------------------------------------- PIX + TED com destinatario online no WebSocket
  group('Transferencias + notificacao WebSocket', () => {
    const esperadas = { PIX: null, TED: null }; // timestamp do envio
    const recebidas = {};
    const contagem = {};

    const wsParams = { tags: { protocolo: 'WebSocket', operacao: 'handshake' } };
    const wsRes = ws.connect(`${WS_URL}?token=${tokenDestino}`, wsParams, (socket) => {
      let disparou = false;

      socket.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        if (msg.event === 'info' && !disparou) {
          disparou = true; // conectado e registrado no ws-service: dispara as transferencias

          esperadas.PIX = Date.now();
          const resPix = chamar('POST', '/banco/rest/pix',
            { contaOrigem, chaveDestino: chavePix, valor: VALOR_PIX },
            { protocolo: 'REST', operacao: 'PIX' });
          logErro('PIX', resPix);
          check(resPix, {
            'REST PIX 2xx': (r) => r.status >= 200 && r.status < 300,
            'REST PIX credita conta destino': (r) => json(r)?.data?.numeroContaDestino === contaDestino,
          });

          esperadas.TED = Date.now();
          const resTed = chamar('POST', '/banco/soap/TED',
            { contaOrigem, contaDestino, valor: VALOR_TED },
            { protocolo: 'SOAP', operacao: 'TED' });
          logErro('TED', resTed);
          check(resTed, {
            'SOAP TED 2xx': (r) => r.status >= 200 && r.status < 300,
            'SOAP TED SUCESSO': (r) => json(r)?.data?.status === 'SUCESSO',
          });

          socket.setTimeout(() => socket.close(), NOTIF_TIMEOUT_MS);
          return;
        }

        if (msg.event === 'nova-transacao') {
          const d = msg.data || {};
          const tipo = d.tipo;
          if (!esperadas[tipo] || String(d.contaDestino) !== contaDestino) return;
          contagem[tipo] = (contagem[tipo] || 0) + 1;
          if (!recebidas[tipo]) {
            recebidas[tipo] = Date.now();
            notifLatencia.add(recebidas[tipo] - esperadas[tipo], { tipo, protocolo: 'AMQP' });
            // Espera um pouco apos receber as duas para detectar notificacoes duplicadas
            if (recebidas.PIX && recebidas.TED) socket.setTimeout(() => socket.close(), 1500);
          }
        }
      });

      socket.on('error', (e) => console.error(`[WS] erro: ${e.error()}`));
    });

    check(wsRes, { 'WS handshake 101': (r) => r && r.status === 101 });
    for (const tipo of ['PIX', 'TED']) {
      const ok = !!recebidas[tipo];
      notifRecebida.add(ok, { tipo, protocolo: 'AMQP' });
      check(null, {
        [`WS notificacao ${tipo} recebida`]: () => ok,
        [`WS notificacao ${tipo} sem duplicata`]: () => (contagem[tipo] || 0) <= 1,
      });
      if (!ok) console.error(`[WS] notificacao ${tipo} nao chegou para ${contaDestino}`);
      if (contagem[tipo] > 1) console.error(`[WS] notificacao ${tipo} chegou ${contagem[tipo]}x para ${contaDestino}`);
    }
  });

  // ---------------------------------------------------------------- Conferencia de saldo e extrato
  group('Conferencia', () => {
    const s = consultarSaldo(tokenOrigem);
    const esperado = SALDO_INICIAL - VALOR_PIX - VALOR_TED;
    check(s.res, { 'SOAP saldo final = inicial - PIX - TED': () => Math.abs(s.saldo - esperado) < 0.001 });

    const ext = chamar('GET', `/banco/rest/extrato?conta=${contaOrigem}`, undefined,
      { protocolo: 'REST', operacao: 'extrato' });
    logErro('extrato', ext);
    const itens = json(ext)?.data || [];
    check(ext, {
      'REST extrato 200': (r) => r.status === 200,
      'REST extrato contem o PIX': () => itens.some((t) => Math.abs(Math.abs(Number(t.valor)) - VALOR_PIX) < 0.001),
    });
  });

  // ---------------------------------------------------------------- gRPC: comprovante
  group('gRPC comprovante', () => {
    const res = chamar('POST', '/comprovantes/gerar', {
      tipo_transacao: 'PIX',
      conta_origem: contaOrigem,
      conta_destino: chavePix,
      valor: VALOR_PIX,
      data_hora: new Date().toISOString(),
      id_transacao: `txn_${base}`,
    }, { protocolo: 'gRPC', operacao: 'gerarComprovante' });
    logErro('comprovante', res);
    check(res, {
      'gRPC comprovante 2xx': (r) => r.status >= 200 && r.status < 300,
      'gRPC comprovante e PDF': (r) => String(r.headers['Content-Type'] || '').includes('application/pdf')
        && String(r.body).startsWith('%PDF'),
    });
  });

  // ---------------------------------------------------------------- ATM monitor (TCP; status chega por UDP)
  group('ATM monitor', () => {
    const lista = chamar('GET', '/atms', undefined, { protocolo: 'TCP', operacao: 'listarATMs' });
    logErro('atms', lista);
    check(lista, {
      'ATM listar 200': (r) => r.status === 200,
      'ATM listar contem ATMs via UDP': (r) => json(r)?.data?.[ATM_REAL]?.status === 'ONLINE',
    });

    const refill = chamar('POST', '/atms/refill', { id: ATM_REAL, amount: 10 },
      { protocolo: 'TCP', operacao: 'abastecerATM' });
    logErro('refill', refill);
    check(refill, { 'ATM abastecer enviado': (r) => json(r)?.data?.status === 'Abastecimento enviado' });

    // Bloqueio usa um id inexistente para nao desligar os ATMs reais do cluster
    const block = chamar('POST', '/atms/block', { id: ATM_FALSO },
      { protocolo: 'TCP', operacao: 'bloquearATM' });
    logErro('block', block);
    check(block, { 'ATM bloquear responde (offline)': (r) => json(r)?.data?.status === 'ATM Offline' });
  });

  // ---------------------------------------------------------------- RabbitMQ (infra)
  group('RabbitMQ', () => {
    const q = chamar('GET', '/queues/%2F/notificacoes.transferencias', undefined,
      { protocolo: 'infra', operacao: 'rabbitmqFila', headers: { Authorization: MQ_AUTH }, base: MQ_API });
    logErro('rabbit queue', q);
    check(q, { 'RabbitMQ fila tem consumer (ws-service)': (r) => Number(json(r)?.consumers) > 0 });
  });

  if (MODO !== 'taxa') sleep(1);
}

export function teardown() {
  if (!CHECAR_JAEGER) return; // ex.: experimento com OpenTelemetry desligado
  // Aguarda o flush dos exportadores OTLP
  sleep(5);
  // Jaeger v2 expoe a API de consulta em /api/v3 (o /api/services legado responde 404)
  const res = chamar('GET', '/v3/services', undefined,
    { protocolo: 'infra', operacao: 'jaegerServicos', base: JAEGER_API });
  const servicos = json(res)?.services || [];
  console.log(`[Jaeger] servicos com traces: ${servicos.join(', ')}`);
  check(res, {
    'Jaeger traces do api-gateway': () => servicos.includes('api-gateway'),
    'Jaeger traces do ws-service': () => servicos.includes('ws-service'),
    'Jaeger traces do banco-soap': () => servicos.includes('banco-soap'),
    'Jaeger traces do rest-api': () => servicos.includes('rest-api'),
    'Jaeger traces do comprovantes-service': () => servicos.includes('comprovantes-service'),
  });
}
