// Teste TCP/UDP do monitor de ATMs (Node puro, sem dependencias)
//
//   node atm-tcp-udp-test.js
//
// Variaveis: HOST, UDP_PORT(6000), ATM_TCP_PORT(6001), GW_TCP_PORT(6002),
//            CONC(20), REQS(10), FAKE_ATMS(5), UDP_SECONDS(10),
//            LINE_END=1 (acrescenta \n no fim de cada comando)
//
// Usa ATMs falsos com id LOADTEST-NNN, entao BLOCK/ABASTECER nunca atingem
// os ATMs reais. Eles continuam no registro do monitor ate ele reiniciar.

const net = require('net');
const dgram = require('dgram');

const HOST = process.env.HOST || 'localhost';
const UDP_PORT = +(process.env.UDP_PORT || 6000);
const ATM_TCP_PORT = +(process.env.ATM_TCP_PORT || 6001);
const GW_TCP_PORT = +(process.env.GW_TCP_PORT || 6002);
const CONC = +(process.env.CONC || 20);
const REQS = +(process.env.REQS || 10);
const FAKE_ATMS = +(process.env.FAKE_ATMS || 5);
const UDP_SECONDS = +(process.env.UDP_SECONDS || 10);
const EOL = process.env.LINE_END === '1' ? '\n' : '';
const TIMEOUT = 3000;

const agora = () => Number(process.hrtime.bigint()) / 1e6;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function resumo(nome, lat, falhas) {
  lat.sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : NaN);
  console.log(
    `${nome}: ok=${lat.length} falhas=${falhas} ` +
    `p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${p(1).toFixed(1)}ms`
  );
}

// Envia um comando para a interface do gateway (TCP 6002).
// expectJson=true: espera uma resposta JSON completa (GET_ALL).
function gwRequest(cmd, expectJson = true) {
  return new Promise((resolve) => {
    const t0 = agora();
    const sock = net.connect(GW_TCP_PORT, HOST);
    let buf = '';
    let feito = false;
    let timer;
    const fim = (ok) => {
      if (feito) return;
      feito = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ok, ms: agora() - t0, data: buf });
    };
    timer = setTimeout(() => fim(false), TIMEOUT);
    sock.on('connect', () => sock.write(cmd + EOL));
    sock.on('data', (d) => {
      buf += d;
      if (!expectJson) return fim(true);
      try { JSON.parse(buf); fim(true); } catch (_) { /* resposta incompleta */ }
    });
    sock.on('end', () => fim(buf.length > 0));
    sock.on('error', () => fim(false));
  });
}

// ATM falso conectado na porta de comandos (TCP 6001)
function criarAtmFalso(id) {
  return new Promise((resolve) => {
    const sock = net.connect(ATM_TCP_PORT, HOST);
    const atm = { id, sock, onCmd: null };
    sock.on('connect', () => {
      sock.write(`REGISTER:${id}` + EOL);
      resolve(atm);
    });
    sock.on('data', (d) => { if (atm.onCmd) atm.onCmd(d.toString()); });
    sock.on('error', () => resolve(null));
  });
}

// Dispara um comando pelo gateway e mede ate o ATM falso receber o CMD esperado
function testarComando(atm, comandoGw, esperado) {
  return new Promise((resolve) => {
    const t0 = agora();
    const to = setTimeout(() => resolve(null), TIMEOUT);
    atm.onCmd = (s) => {
      if (s.includes(esperado)) { clearTimeout(to); resolve(agora() - t0); }
    };
    gwRequest(comandoGw, false);
  });
}

async function faseGetAll() {
  console.log(`\n[1] TCP 6002: GET_ALL com ${CONC} conexoes x ${REQS} requisicoes`);
  const lat = [];
  let falhas = 0;
  let ultimoErro = '';
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (let i = 0; i < REQS; i++) {
      const r = await gwRequest('GET_ALL');
      if (r.ok) lat.push(r.ms); else { falhas++; ultimoErro = r.data; }
    }
  }));
  resumo('GET_ALL', lat, falhas);
  if (falhas > 0) {
    console.log('  Falhou? Tente LINE_END=1. Ultima resposta parcial: ' + JSON.stringify(ultimoErro.slice(0, 200)));
  }
}

async function faseUdpETcpComandos() {
  const ids = Array.from({ length: FAKE_ATMS }, (_, i) => `LOADTEST-${String(i + 1).padStart(3, '0')}`);

  console.log(`\n[2] TCP 6001: registrando ${FAKE_ATMS} ATMs falsos`);
  const atms = (await Promise.all(ids.map(criarAtmFalso))).filter(Boolean);
  console.log(`  conectados: ${atms.length}/${FAKE_ATMS}`);

  console.log(`\n[3] UDP 6000: heartbeats a cada 500ms por ${UDP_SECONDS}s`);
  const udp = dgram.createSocket('udp4');
  let enviados = 0;
  let errosUdp = 0;
  const fim = Date.now() + UDP_SECONDS * 1000;
  while (Date.now() < fim) {
    for (const id of ids) {
      const msg = Buffer.from(JSON.stringify({ id, status: 'ONLINE', dinheiro: 1000 }));
      udp.send(msg, UDP_PORT, HOST, (err) => { if (err) errosUdp++; else enviados++; });
    }
    await espera(500);
  }
  await espera(300);
  udp.close();
  console.log(`  datagramas enviados=${enviados} erros=${errosUdp} (UDP nao tem confirmacao de entrega)`);

  const r = await gwRequest('GET_ALL');
  const vistos = new Set((r.data.match(/LOADTEST-\d+/g) || []));
  console.log(`  ATMs falsos visiveis no monitor via GET_ALL: ${vistos.size}/${FAKE_ATMS}`);

  console.log('\n[4] Comandos criticos (gateway 6002 -> monitor -> ATM 6001)');
  const lRefill = [];
  const lLock = [];
  let fRefill = 0;
  let fLock = 0;
  const refills = await Promise.all(atms.map((a) => testarComando(a, `ABASTECER:${a.id}:100`, 'CMD_REFILL')));
  refills.forEach((ms) => (ms === null ? fRefill++ : lRefill.push(ms)));
  resumo('ABASTECER -> CMD_REFILL', lRefill, fRefill);

  const locks = await Promise.all(atms.map((a) => testarComando(a, `BLOCK:${a.id}`, 'CMD_LOCK')));
  locks.forEach((ms) => (ms === null ? fLock++ : lLock.push(ms)));
  resumo('BLOCK -> CMD_LOCK', lLock, fLock);

  atms.forEach((a) => a.sock.destroy());
}

(async () => {
  console.log(`Alvo: ${HOST} | UDP ${UDP_PORT} | TCP ATM ${ATM_TCP_PORT} | TCP gateway ${GW_TCP_PORT}`);
  await faseGetAll();
  await faseUdpETcpComandos();
  console.log('\nConcluido. Os ATMs LOADTEST-* ficam no registro ate reiniciar o monitor.');
  process.exit(0);
})();