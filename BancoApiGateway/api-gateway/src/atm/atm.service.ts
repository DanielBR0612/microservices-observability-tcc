import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import * as net from 'net';
import { context, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// TCP cru nao tem cabecalhos nem instrumentacao de protocolo: o span CLIENT e manual e o
// contexto vai no inicio da linha do comando (mesmo formato de ATMService/contexto-tcp.ts):
//   traceparent=00-...-01 GET_ALL\n
// Cada mensagem (comando e resposta) e uma linha terminada em '\n', porque TCP e um fluxo
// de bytes: uma resposta pode chegar em varios segmentos.
const tracer = trace.getTracer('api-gateway.atm');

@Injectable()
export class AtmService {
  private readonly MONITOR_HOST = process.env.MONITOR_HOST || 'localhost';
  private readonly MONITOR_PORT = 6002;

  async listarTodos() {
    return this.enviarComandoTcp('GET_ALL');
  }

  async bloquear(id: string) {
    return this.enviarComandoTcp(`BLOCK:${id}`);
  }

  async abastecer(id: string, valor: number) {
  return this.enviarComandoTcp(`ABASTECER:${id}:${valor}`);
}

  private enviarComandoTcp(comando: string): Promise<any> {
    const nome = comando.split(':')[0];
    const span = tracer.startSpan(`tcp ${nome}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'network.transport': 'tcp',
        'server.address': this.MONITOR_HOST,
        'server.port': this.MONITOR_PORT,
        'atm.comando': nome,
      },
    });
    const ctx = trace.setSpan(context.active(), span);

    const carrier: Record<string, string> = {};
    propagation.inject(ctx, carrier);
    const meta = Object.keys(carrier).length ? `${new URLSearchParams(carrier).toString()} ` : '';
    const quadro = `${meta}${comando}\n`;

    const finalizar = (erro?: string) => {
      if (erro) span.setStatus({ code: SpanStatusCode.ERROR, message: erro });
      span.end();
    };

    return context.with(ctx, () => new Promise((resolve, reject) => {
      const client = new net.Socket();

      client.connect(this.MONITOR_PORT, this.MONITOR_HOST, () => {
        client.write(quadro);
      });

      let recebido = '';
      client.on('data', (data) => {
        recebido += data.toString();
        const fim = recebido.indexOf('\n');
        if (fim < 0) return; // resposta ainda incompleta
        const linha = recebido.slice(0, fim);
        try {
            resolve(JSON.parse(linha));
        } catch {
            resolve({ message: linha });
        }
        finalizar();
        client.destroy();
      });

      client.on('error', (err) => {
        client.destroy();
        finalizar(err.message);
        reject(new HttpException('Erro de conexão com Monitor ATM', HttpStatus.BAD_GATEWAY));
      });

      client.setTimeout(3000);
      client.on('timeout', () => {
          client.destroy();
          finalizar('timeout');
          reject(new HttpException('Timeout no Monitor ATM', HttpStatus.GATEWAY_TIMEOUT));
      });
    }));
  }
}
