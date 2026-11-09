// Propagacao de contexto de trace sobre o protocolo TCP de texto dos ATMs.
//
// TCP cru nao tem cabecalhos: o contexto (traceparent/tracestate do W3C Trace Context)
// viaja numa linha de metadados antes do comando, codificada como query string:
//
//   traceparent=00-<trace-id>-<span-id>-01\n
//   ABASTECER:ATM-CENTRO-01:500
//
// Sem OpenTelemetry (ou fora de um trace) o carrier fica vazio e o comando sai exatamente
// como antes, sem a linha de metadados; quem recebe aceita os dois formatos.
import { context, propagation, Context } from '@opentelemetry/api';

export function anexarContexto(comando: string, ctx: Context = context.active()): string {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  if (Object.keys(carrier).length === 0) return comando;
  return `${new URLSearchParams(carrier).toString()}\n${comando}`;
}

export function extrairContexto(mensagem: string): { ctx: Context; comando: string } {
  const quebra = mensagem.indexOf('\n');
  if (quebra < 0) return { ctx: context.active(), comando: mensagem };
  const carrier = Object.fromEntries(new URLSearchParams(mensagem.slice(0, quebra)));
  return { ctx: propagation.extract(context.active(), carrier), comando: mensagem.slice(quebra + 1) };
}
