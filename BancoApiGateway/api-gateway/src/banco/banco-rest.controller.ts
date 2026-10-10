import { Controller, Get, Post, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiParam, ApiQuery } from '@nestjs/swagger';
import { BancoRestApiService } from '../banco-rest-api/banco-rest-api.service';
import { NotificationsService } from '../notifications/notifications.service';

@ApiTags('banco-rest') 
@Controller('banco/rest')
export class BancoRestController {
    constructor(
        private readonly restService: BancoRestApiService,
        private readonly notificationsService: NotificationsService,
    ) {}

    @Post('clientes/:id/chaves-pix') 
    @ApiOperation({ summary: 'Cria uma nova chave Pix para um cliente' }) 
    @ApiParam({ name: 'id', description: 'ID do cliente no banco de dados', example: 1 }) 
    @ApiBody({ description: 'Dados da nova chave Pix', schema: { example: { chave: "usuario@email.com", tipoChave: "EMAIL", tipoConta: "CORRENTE" } } })
    async criarChavePix(@Param('id') id: number, @Body() body: any) {
        const dados = await this.restService.criarChavePix(id, body);

        return {
            data: dados,
            links: {
                listar_chaves: {
                    href: `http://localhost:3000/banco/rest/clientes/${id}/chaves-pix`,
                    method: 'GET',
                    title: 'Ver todas as chaves deste cliente'
                },
                receber_pix: {
                    href: `http://localhost:3000/banco/rest/pix`,
                    method: 'POST',
                    title: 'Utilizar a chave para receber valores'
                }
            }
        };
    }
    
    @Post('pix')
    @ApiOperation({ summary: 'Realiza transferência PIX' })
    @ApiBody({ schema: { example: { contaOrigem: 190612, chaveDestino: "190612", valor: 100.50 } } })
    async realizarPix(@Body() body: any) {
        const payload = {

            numeroContaOrigem: body.contaOrigem, 
            
            chaveDestino: body.chaveDestino,
            
            valor: Number(body.valor),
            
            tipo: 'PIX' 
        };

        const dados = await this.restService.realizarPix(payload);

        console.log('DEBUG PIX RESPONSE:', dados);

        // Notificar destinatário via NotificationsService (não bloqueante)
        this.notificationsService.notificarTransacao({
            contaDestino: String(dados.numeroContaDestino ?? body.chaveDestino ?? body.contaDestino ?? ''), 
            valor: Number(body.valor), 
            tipo: 'PIX',
            timestamp: new Date().toISOString()
        });

        return {
            data: dados,
            links: {
                ver_extrato: {
                    href: `http://localhost:3000/banco/rest/extrato?conta=${body.contaOrigem}`,
                    method: 'GET',
                    title: 'Consultar extrato atualizado',
                },
                nova_transferencia: {
                    href: `http://localhost:3000/banco/rest/pix`,
                    method: 'POST',
                    title: 'Realizar outro PIX',
                },
            },
        };
    }

    @Get('clientes/:numeroConta/chaves-pix')
    @ApiOperation({ summary: 'Lista todas as chaves pix de um cliente' })
    @ApiParam({ name: 'numeroConta', example: 1 })
    async getChavesPix(@Param('numeroConta') numeroConta: string) {
        const dados = await this.restService.getChavesPix(numeroConta); 

        return {
            data: dados,
            links: {
                criar_nova_chave: {
                    href: `http://localhost:3000/banco/rest/clientes/${numeroConta}/chaves-pix`,
                    method: 'POST',
                    title: 'Cadastrar nova chave'
                }
            }
        };
    }

    @Get('extrato')
    @ApiOperation({ summary: 'Consulta extrato da conta' })
    @ApiQuery({ name: 'conta', description: 'Número da conta para busca', example: '190612' })
    async getExtrato(@Query('conta') numeroConta: string) {
        if (!numeroConta) throw new BadRequestException('Informe a conta (?conta=...)');
        
        const dados = await this.restService.getExtrato(numeroConta);

        return {
            data: dados,
            links: {
                realizar_pix: {
                    href: `http://localhost:3000/banco/rest/pix`,
                    method: 'POST',
                    title: 'Fazer um PIX'
                },
                ver_saldo_legado: {
                    href: `http://localhost:3000/banco/soap/saldo?conta=${numeroConta}`,
                    method: 'GET',
                    title: 'Confirmar saldo no sistema legado'
                }
            }
        };
    }
}