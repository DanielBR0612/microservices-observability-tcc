// Teste deterministico do enquadramento TCP (METODOLOGIA 9.10).
//
// TCP entrega bytes, nao mensagens: o mesmo fluxo pode chegar em segmentos com fronteiras
// arbitrarias. Este teste entrega os mesmos comandos com fronteiras diferentes e compara
// quantos comandos cada leitor reconstroi:
//   - antiga: cada evento 'data' e tratado como UM comando (versao do commit 8e60fe8)
//   - nova:   criarLeitorDeLinhas acumula bytes e separa por '\n' (contexto-tcp.ts)
//
// Uso: docker exec atm-monitor npx ts-node teste-enquadramento.ts
import { criarLeitorDeLinhas, extrairContexto } from './contexto-tcp';

const TP = 'traceparent=00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const comandos = ['CMD_REFILL:100', 'CMD_REFILL:200', 'CMD_REFILL:300'];

// formato antigo: "<meta>\n<comando>" sem terminador; formato novo: "<meta> <comando>\n"
const fluxoAntigo = comandos.map((c) => `${TP}\n${c}`).join('');
const fluxoNovo = comandos.map((c) => `${TP} ${c}\n`).join('');

// leitor antigo, reproduzindo o atm-cluster da versao anterior: 1 evento 'data' = 1 comando,
// extrai o contexto da primeira linha e aplica `startsWith('CMD_REFILL:')` + parseInt
function lerAntigo(segmentos: string[]): string[] {
  const lidos: string[] = [];
  for (const s of segmentos) {
    const q = s.indexOf('\n');
    const comando = q < 0 ? s : s.slice(q + 1);
    if (comando.startsWith('CMD_REFILL:')) {
      const valor = parseInt(comando.split(':')[1]);
      if (!Number.isNaN(valor)) lidos.push(`CMD_REFILL:${valor}`);
    }
  }
  return lidos;
}

function lerNovo(segmentos: string[]): string[] {
  const lidos: string[] = [];
  const leitor = criarLeitorDeLinhas((linha) => lidos.push(extrairContexto(linha).comando));
  for (const s of segmentos) leitor(Buffer.from(s));
  return lidos;
}

const fatiar = (s: string, tamanho: number) => s.match(new RegExp(`[\\s\\S]{1,${tamanho}}`, 'g')) || [];
const porMensagem = (s: string, sep: RegExp) => s.split(sep).filter(Boolean);

const cenarios: [string, (fluxo: string, novo: boolean) => string[]][] = [
  ['1 mensagem por segmento (caso feliz)', (f, novo) => (novo ? porMensagem(f, /(?<=\n)/) : comandos.map((c) => `${TP}\n${c}`))],
  ['3 mensagens no mesmo segmento (coalescencia)', (f) => [f]],
  ['segmentos de 7 bytes (fragmentacao)', (f) => fatiar(f, 7)],
  ['segmentos de 1 byte (pior caso)', (f) => fatiar(f, 1)],
];

console.log(`Comandos enviados: ${comandos.length} (${comandos.join(', ')})\n`);
console.log('| Fronteiras dos segmentos | Leitor antigo | Leitor novo |');
console.log('|---|---:|---:|');
for (const [nome, segmentar] of cenarios) {
  const antigo = lerAntigo(segmentar(fluxoAntigo, false));
  const novo = lerNovo(segmentar(fluxoNovo, true));
  const ok = (l: string[]) => (l.join() === comandos.join() ? 'ok' : 'ERRO');
  console.log(`| ${nome} | ${antigo.length}/3 ${ok(antigo)} | ${novo.length}/3 ${ok(novo)} |`);
}
