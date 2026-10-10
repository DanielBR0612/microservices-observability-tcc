import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,          // 5 usuários virtuais simultâneos
  duration: '15s',  // Duração da simulação
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

  // ==================================================================
  // 1. LEGADO / SOAP: Criar Cliente (Origem)
  // ==================================================================
  const payloadCriarCliente = JSON.stringify({
    nome: `Cliente K6 VU ${__VU}`,
    cpf: cpf,
  });

  const resCriarCliente = http.post(`${BASE_URL}/banco/soap/criarCliente`, payloadCriarCliente, { headers: HEADERS });
  check(resCriarCliente, {
    'SOAP (Criar Cliente) Status 201/200': (r) => r.status === 201 || r.status === 200,
  });

  let clienteId = null;
  try {
    const jsonRes = resCriarCliente.json();
    clienteId = jsonRes.data?.id || jsonRes.id || jsonRes.clienteId;
  } catch (e) {}

  if (!clienteId) {
    clienteId = (__VU * 1000) + __ITER; 
  }

  // ==================================================================
  // 2. LEGADO / SOAP: Criar Conta para o Cliente (Origem)
  // ==================================================================
  const payloadCriarConta = JSON.stringify({
    clienteId: Number(clienteId),
    numeroConta: contaOrigem,
    saldoInicial: 2000,
  });

  const resCriarConta = http.post(`${BASE_URL}/banco/soap/criarConta`, payloadCriarConta, { headers: HEADERS });
  check(resCriarConta, {
    'SOAP (Criar Conta) Status 201/200': (r) => r.status === 201 || r.status === 200,
  });

  // ==================================================================
  // 6.1. Criar Conta de Destino para a TED não falhar
  // ==================================================================
  const cpfDestino = String(Math.floor(10000000000 + Math.random() * 89999999999));
  
  const resClidDestino = http.post(`${BASE_URL}/banco/soap/criarCliente`, JSON.stringify({
    nome: `Destino K6 VU ${__VU}`,
    cpf: cpfDestino
  }), { headers: HEADERS });
  
  let idCliDest = null;
  try {
    const jsonCliDest = resClidDestino.json();
    idCliDest = jsonCliDest.data?.id || jsonCliDest.id || jsonCliDest.clienteId;
  } catch (e) {}

  if (!idCliDest) {
    idCliDest = (__VU * 1000) + __ITER + 500;
  }

  http.post(`${BASE_URL}/banco/soap/criarConta`, JSON.stringify({
    clienteId: Number(idCliDest),
    numeroConta: contaDestino,
    saldoInicial: 1000
  }), { headers: HEADERS });

  // ==================================================================
  // 3. REST (KOTLIN): Criar Chave Pix para o Cliente
  // ==================================================================
  const payloadCriarChave = JSON.stringify({
    tipo: 'EMAIL',
    valor: chavePix,
    numeroConta: contaDestino
  });

  // Rota REST direta via Gateway (/clientes/{id}/chaves-pix)
  const resCriarChave = http.post(`${BASE_URL}/banco/rest/clientes/${idCliDest}/chaves-pix`, payloadCriarChave, { headers: HEADERS });
  
  check(resCriarChave, {
    'REST (Criar Chave Pix) Status 201/200': (r) => r.status === 201 || r.status === 200,
  });

  if (resCriarChave.status >= 400) {
    console.log(`[ERRO Criar Chave Pix] ID Usado: ${idCliDest} | Status: ${resCriarChave.status} | Body: ${resCriarChave.body}`);
  }

  // ==================================================================
  // 4. REST (KOTLIN): Consultar Chaves Pix do Cliente
  // ==================================================================
  const resConsultarChave = http.get(`${BASE_URL}/banco/rest/clientes/${contaOrigem}/chaves-pix`, { headers: HEADERS });
  
  if (resConsultarChave.status >= 400) {
    console.log(`[ERRO Consultar Chaves] ID Usado: ${contaOrigem} | Status: ${resConsultarChave.status} | Body: ${resConsultarChave.body}`);
  }

  // ==================================================================
  // 5. REST (KOTLIN): Realizar Transferência PIX (/pix/transferir)
  // ==================================================================
  const payloadPix = JSON.stringify({
    contaOrigem: contaOrigem,
    chaveDestino: chavePix,
    valor: 50.5,
  });

  const resPix = http.post(`${BASE_URL}/banco/rest/pix`, payloadPix, { headers: HEADERS });
  check(resPix, {
    'REST (Realizar PIX) Status 201/200': (r) => r.status === 201 || r.status === 200,
  });

  if (resPix.status >= 400) {
    console.log(`[ERRO PIX] para ${chavePix} Status: ${resPix.status} | Body: ${resPix.body}`);
  }

  // ==================================================================
  // 6. REST (KOTLIN): Consultar Extrato da Conta (/extrato/{conta})
  // ==================================================================
  const resExtrato = http.get(`${BASE_URL}/banco/rest/extrato?conta=${contaOrigem}`, { headers: HEADERS });
  check(resExtrato, {
    'REST (Extrato) Status 200': (r) => r.status === 200,
  });

  if (resExtrato.status >= 400) {
    console.log(`[ERRO EXTRATO] para ${contaOrigem} Status: ${resExtrato.status} | Body: ${resExtrato.body}`);
  }

  

  // ==================================================================
  // 7. LEGADO / SOAP: Realizar TED
  // ==================================================================
  const payloadTed = JSON.stringify({
    contaOrigem: contaOrigem,
    contaDestino: contaDestino,
    valor: 100,
  });

  const resTed = http.post(`${BASE_URL}/banco/soap/TED`, payloadTed, { headers: HEADERS });
  check(resTed, {
    'SOAP (Realizar TED) Status 201/200': (r) => r.status === 201 || r.status === 200,
  });

  if (resTed.status >= 400) {
    console.log(`[ERRO TED] Status: ${resTed.status} | Body: ${resTed.body}`);
  }

  // ==================================================================
  // 8. gRPC (COMPROVANTES): Gerar Comprovante da Transação
  // ==================================================================
  const payloadComprovante = JSON.stringify({
    tipo_transacao: 'PIX',
    conta_origem: contaOrigem,
    conta_destino: chavePix,
    valor: 50.5,
    data_hora: new Date().toISOString(),
    id_transacao: `txn_${idUnico}`,
  });

  const resComprovante = http.post(`${BASE_URL}/comprovantes/gerar`, payloadComprovante, { headers: HEADERS });
  check(resComprovante, {
    'gRPC (Gerar Comprovante) Status 201/200': (r) => r.status === 201 || r.status === 200,
  });

  // ==================================================================
  // 9. REST: Consulta de ATMs (/atms)
  // ==================================================================
  const resAtms = http.get(`${BASE_URL}/atms`, { headers: HEADERS });
  check(resAtms, {
    'REST (Consulta ATMs) Status 200': (r) => r.status === 200,
  });

  sleep(1);
}