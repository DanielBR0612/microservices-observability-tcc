// Enquadramento e propagacao de contexto de trace no protocolo TCP de texto dos ATMs.
//
// TCP entrega um fluxo de bytes, nao mensagens: um evento 'data' pode trazer meia mensagem
// ou varias juntas. Por isso cada mensagem e UMA LINHA terminada em '\n', e quem le acumula
// os bytes e so processa linhas completas (criarLeitorDeLinhas).
//
// TCP cru tambem nao tem cabecalhos: o contexto (traceparent/tracestate do W3C Trace Context)
// vai no inicio da linha, codificado como query string e separado do comando por um espaco:
//
//   traceparent=00-<trace-id>-<span-id>-01 ABASTECER:ATM-CENTRO-01:500\n
//
// Sem OpenTelemetry (ou fora de um trace) o carrier fica vazio e a linha e so o comando.
// Comandos nao tem espacos e a query string codifica espaco como '+', entao o primeiro espaco
// separa sem ambiguidade os metadados do comando.
import { context, propagation, Context } from '@opentelemetry/api';

export const FIM_DE_MENSAGEM = '\n';

export function anexarContexto(comando: string, ctx: Context = context.active()): string {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  const meta = Object.keys(carrier).length ? `${new URLSearchParams(carrier).toString()} ` : '';
  return `${meta}${comando}${FIM_DE_MENSAGEM}`;
}

export function extrairContexto(linha: string): { ctx: Context; comando: string } {
  const espaco = linha.indexOf(' ');
  if (espaco < 0) return { ctx: context.active(), comando: linha };
  const carrier = Object.fromEntries(new URLSearchParams(linha.slice(0, espaco)));
  return { ctx: propagation.extract(context.active(), carrier), comando: linha.slice(espaco + 1) };
}

// Devolve um handler para socket.on('data') que acumula os bytes e chama onLinha uma vez
// por mensagem completa, na ordem em que chegaram.
export function criarLeitorDeLinhas(onLinha: (linha: string) => void): (dados: Buffer) => void {
  let pendente = '';
  return (dados: Buffer) => {
    pendente += dados.toString();
    let fim: number;
    while ((fim = pendente.indexOf(FIM_DE_MENSAGEM)) >= 0) {
      const linha = pendente.slice(0, fim);
      pendente = pendente.slice(fim + FIM_DE_MENSAGEM.length);
      if (linha.length) onLinha(linha);
    }
  };
}
