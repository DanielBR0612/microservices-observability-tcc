import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import * as net from 'net';
import { context, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// TCP cru nao tem cabecalhos nem instrumentacao de protocolo: o span CLIENT e manual e o
// contexto vai numa linha de metadados antes do comando (mesmo formato de
// ATMService/contexto-tcp.ts):  traceparent=00-...-01\nGET_ALL
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
    const quadro = Object.keys(carrier).length
      ? `${new URLSearchParams(carrier).toString()}\n${comando}`
      : comando;

    const finalizar = (erro?: string) => {
      if (erro) span.setStatus({ code: SpanStatusCode.ERROR, message: erro });
      span.end();
    };

    return context.with(ctx, () => new Promise((resolve, reject) => {
      const client = new net.Socket();

      client.connect(this.MONITOR_PORT, this.MONITOR_HOST, () => {
        client.write(quadro);
      });

      client.on('data', (data) => {
        try {
            resolve(JSON.parse(data.toString()));
        } catch {
            resolve({ message: data.toString() });
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
