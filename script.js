import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '15s',
};

const HEADERS = {
  'Content-Type': 'application/json',
};

export default function () {
  const BASE_URL = 'http://gateway:3000';

  const idUnico = `${Date.now()}_${__VU}_${__ITER}`;
  const timestamp = Date.now().toString().slice(-6);

  const cpf = String(Math.floor(10000000000 + Math.random() * 89999999999));
  const contaOrigem = `${timestamp}${__VU}${__ITER}`;
  const contaDestino = `${timestamp}${__VU}${__ITER + 50}`;
  const chavePix = `user_${timestamp}_${__VU}_${__ITER}@email.com`;

  const payloadCriarCliente = JSON.stringify({
    nome: `Cliente K6 VU ${__VU}`,
    cpf: cpf,
  });

  const resCriarCliente = http.post(
    `${BASE_URL}/banco/soap/criarCliente`,
    payloadCriarCliente,
    { headers: HEADERS }
  );

  check(resCriarCliente, {
    'SOAP (Criar Cliente) Status 201': (r) => r.status === 201 || r.status === 200,
  });

  const clienteCriado = resCriarCliente.json() || {};
  const clienteId = clienteCriado.id || clienteCriado.clienteId;

  const payloadCriarConta = JSON.stringify({
    clienteId: clienteId,
    numeroConta: contaOrigem,
    saldoInicial: 2000,
  });

  const resCriarConta = http.post(
    `${BASE_URL}/banco/soap/criarConta`,
    payloadCriarConta,
    { headers: HEADERS }
  );

  check(resCriarConta, {
    'SOAP (Criar Conta) Status 201': (r) => r.status === 201 || r.status === 200,
  });

  const payloadCriarChave = JSON.stringify({
    chave: chavePix,
    tipoChave: 'EMAIL',
    tipoConta: 'CORRENTE',
  });

  const resCriarChave = http.post(
    `${BASE_URL}/banco/rest/clientes/${clienteId}/chaves-pix`,
    payloadCriarChave,
    { headers: HEADERS }
  );

  check(resCriarChave, {
    'REST (Criar Chave Pix) Status 201': (r) => r.status === 201 || r.status === 200,
  });

  const resGetChaves = http.get(
    `${BASE_URL}/banco/rest/clientes/${clienteId}/chaves-pix`
  );

  check(resGetChaves, {
    'REST (Listar Chaves Pix) Status 200': (r) => r.status === 200,
  });

  const payloadPix = JSON.stringify({
    contaOrigem: contaOrigem,
    chaveDestino: chavePix,
    valor: 50.5,
  });

  const resPix = http.post(
    `${BASE_URL}/banco/rest/pix`,
    payloadPix,
    { headers: HEADERS }
  );

  check(resPix, {
    'REST (Realizar PIX) Status 201': (r) => r.status === 201 || r.status === 200,
  });

  const resExtrato = http.get(
    `${BASE_URL}/banco/rest/extrato?conta=${contaOrigem}`
  );

  check(resExtrato, {
    'REST (Extrato) Status 200': (r) => r.status === 200,
  });

  const payloadTed = JSON.stringify({
    contaOrigem: contaOrigem,
    contaDestino: contaDestino,
    valor: 100,
  });

  const resTed = http.post(
    `${BASE_URL}/banco/soap/TED`,
    payloadTed,
    { headers: HEADERS }
  );

  check(resTed, {
    'SOAP (Realizar TED) Status 201': (r) => r.status === 201 || r.status === 200,
  });

  const payloadComprovante = JSON.stringify({
    tipo_transacao: 'PIX',
    conta_origem: contaOrigem,
    conta_destino: chavePix,
    valor: 50.5,
    data_hora: new Date().toISOString(),
    id_transacao: `txn_${idUnico}`,
  });

  const resComprovante = http.post(
    `${BASE_URL}/comprovantes/gerar`,
    payloadComprovante,
    { headers: HEADERS }
  );

  check(resComprovante, {
    'gRPC (Gerar Comprovante) Status 201': (r) => r.status === 201 || r.status === 200,
  });

  const resAtms = http.get(`${BASE_URL}/atms`);

  check(resAtms, {
    'REST (Consulta ATMs) Status 200': (r) => r.status === 200,
  });

  sleep(1);
}