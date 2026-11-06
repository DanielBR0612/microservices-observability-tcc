import { Controller, Get, Post, Body, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody } from '@nestjs/swagger';
import { BancoCoreSoapService } from '../banco-core-soap/banco-core-soap.service';
import { AuthGuard } from '@nestjs/passport';

@ApiTags('banco-soap')
@Controller('banco/soap')
export class BancoSoapController {
  constructor(
    private readonly soapService: BancoCoreSoapService,
  ) {}

    @UseGuards(AuthGuard('jwt'))
    @Get('saldo')
    @ApiOperation({ summary: 'Consulta saldo (Legado)' })
    async getSaldo(@Request() req) {
      const contaDoToken = req.user.conta; 
    
      console.log(`Usuário autenticado consultando saldo: ${contaDoToken}`);

      const dados = await this.soapService.chamarServico('consultarSaldo', { numeroConta: contaDoToken });

      return {
        data: dados,
        links: {
            realizar_ted: {
                href: `http://localhost:3000/banco/soap/TED`,
                method: 'POST',
                title: 'Transferir valor via TED'
            },
            criar_chave_pix: {
                href: `http://localhost:3000/banco/rest/clientes/1/chaves-pix`, 
                method: 'POST',
                title: 'Cadastrar nova chave Pix (Serviço REST)'
            },
            alterar_senha: {
                href: `http://localhost:3000/banco/soap/alterarSenha`,
                method: 'POST',
                title: 'Alterar senha de acesso'
            }
        }
      };
    }

    @Post('TED')
    @ApiOperation({ summary: 'Realizar transferência TED' })
    @ApiBody({ schema: { example: { contaOrigem: "190612", contaDestino: "123456", valor: 100 } } })
    async realizarTED(@Body() body: any) {
      const dados = await this.soapService.chamarServico('realizarTransferenciaTED', body);

      // A notificacao ao destinatario e publicada no RabbitMQ pelo BancoCoreSOAP

      return {
        data: dados,
        links: {
          ver_novo_saldo: {
            href: `http://localhost:3000/banco/soap/saldo?conta=${body.contaOrigem}`,
            method: 'GET',
            title: 'Consultar saldo atualizado',
          },
          nova_ted: {
            href: `http://localhost:3000/banco/soap/TED`,
            method: 'POST',
            title: 'Realizar outra transferência',
          },
        },
      };
    }

    @Post('criarCliente')
    @ApiOperation({ summary: 'Criar Cliente' })
    @ApiBody({ schema: { example: { nome: "Daniel Braga", cpf: "12345678901"} } })
    async criarCliente(@Body() body: any) {
      const dados = await this.soapService.chamarServico('criarCliente', body);

      return {
        data: dados,
        links: {
            criar_conta: {
                href: `http://localhost:3000/banco/soap/criarConta`,
                method: 'POST',
                title: 'Criar conta bancária para este cliente'
            }
        }
      };
    }

    @Post('criarConta')
    @ApiOperation({ summary: 'Criar Conta' })
    @ApiBody({ schema: { example: { clienteId: 1, numeroConta: "190612", saldoInicial: 2000} } })
    async criarConta(@Body() body: any) {
      const dados = await this.soapService.chamarServico('criarConta', body);

      return {
        data: dados,
        links: {
            ver_saldo: {
                href: `http://localhost:3000/banco/soap/saldo?conta=${body.numeroConta}`,
                method: 'GET',
                title: 'Ver saldo da nova conta'
            },
            realizar_ted: {
                href: `http://localhost:3000/banco/soap/TED`,
                method: 'POST',
                title: 'Realizar primeira transferência'
            }
        }
      };
    }

    @Post('alterarSenha')
    @ApiOperation({ summary: 'Alterar Senha' })
    @ApiBody({ schema: { example: { numeroConta: "190612", senhaAntiga: "senha123", senhaNova: "senha321"} } })
    async alterarSenha(@Body() body: any) {
      const dados = await this.soapService.chamarServico('alterarSenhaAcesso', body);

      return {
        data: dados,
        links: {
            ver_saldo: {
                href: `http://localhost:3000/banco/soap/saldo?conta=${body.numeroConta}`,
                method: 'GET',
                title: 'Voltar para consulta de saldo'
            }
        }
      };
    }
}