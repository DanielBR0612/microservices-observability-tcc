import { Injectable, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { soap } from 'strong-soap';
import * as http from 'http';

@Injectable()
export class BancoCoreSoapService {
  private wsdlUrl: string;

  private usuario = 'admin';
  private senha = 'senha123';
  private basicAuth = 'Basic ' + Buffer.from(`${this.usuario}:${this.senha}`).toString('base64');

  // Reaproveita conexoes TCP com o SOAP. Abrir uma conexao nova por chamada para
  // host.docker.internal fazia alguns SYN se perderem e a requisicao travava ~63s.
  private agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

  // O client (e o WSDL) e criado uma unica vez e reutilizado em todas as chamadas
  private clientPromise: Promise<any> | null = null;

  constructor() {
    const soapEnv = process.env.SOAP_URL || 'http://localhost:8081';
    const base = soapEnv.replace(/\/$/, '');
    this.wsdlUrl = `${base}/ws/banco.wsdl`;
  }

  private getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = new Promise((resolve, reject) => {
        const options = {
          wsdl_headers: { Authorization: this.basicAuth },
          wsdl_options: { agent: this.agent },
        };

        soap.createClient(this.wsdlUrl, options, (err, client) => {
          if (err) return reject(err);

          client.addHttpHeader('Authorization', this.basicAuth);
          client.setSecurity(new soap.WSSecurity(this.usuario, this.senha));
          resolve(client);
        });
      });

      // Se falhar (ex.: SOAP ainda subindo), tenta baixar o WSDL de novo na proxima chamada
      this.clientPromise.catch(() => { this.clientPromise = null; });
    }
    return this.clientPromise;
  }

  async chamarServico(acao: string, payload: any): Promise<any> {
    let client;
    try {
      client = await this.getClient();
    } catch (err) {
      console.error('[SOAP] Erro ao baixar WSDL:', err);
      throw new InternalServerErrorException('Erro ao conectar no serviço de banco.');
    }

    return new Promise((resolve, reject) => {
        const nomeWrapper = `${acao}Request`;

        const args = {
          [nomeWrapper]: {
            ...payload,
            $attributes: {
               xmlns: 'http://www.example.com/demo/banco'
            }
          }
        };

        console.log(`[SOAP REQUEST] Método: ${acao} | Enviando:`, JSON.stringify(args, null, 2));

        client[acao](args, (err, result, envelope, soapHeader) => {

          if (err) {
            console.error('[SOAP ERROR]:', err);
            return reject(new InternalServerErrorException('Erro SOAP: ' + err.message));
          }

          if (!result) {
            return reject(new NotFoundException('Conta não encontrada ou retorno vazio do Java.'));
          }

          const nomeResponse = `${acao}Response`;
          let dadosFinais = result;

          if (result[nomeResponse]) {
            dadosFinais = result[nomeResponse];
          } else if (result.return) {
            dadosFinais = result.return;
          }

          resolve(dadosFinais);
        // strong-soap envia "Connection: close" por padrao, o que anula o keep-alive
        }, { agent: this.agent }, { Connection: 'keep-alive' });
    });
  }
}
