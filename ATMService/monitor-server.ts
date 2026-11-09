import './tracing';
import net from 'net';
import dgram from 'dgram';
import { context, trace, SpanKind } from '@opentelemetry/api';
import { anexarContexto, extrairContexto, criarLeitorDeLinhas, FIM_DE_MENSAGEM } from './contexto-tcp';

// Um servidor TCP cru nao e coberto pela auto-instrumentacao (ela so cria spans de conexao
// de saida): os spans abaixo sao manuais, com o contexto lido do quadro (contexto-tcp.ts).
const tracer = trace.getTracer('atm-monitor');

const atms: any = {};
const atmSockets: Record<string, net.Socket> = {};

const udpServer = dgram.createSocket('udp4');
udpServer.on('message', (msg, rinfo) => {
    const data = JSON.parse(msg.toString());
    atms[data.id] = {
        ...data,
        ip: rinfo.address,
        lastSeen: new Date().toLocaleTimeString()
    };
});
udpServer.bind(6000, () => console.log(' Monitor UDP rodando na porta 6000'));

const tcpServerATM = net.createServer((socket) => {
    socket.on('data', criarLeitorDeLinhas((msg) => {
        if (msg.startsWith('REGISTER:')) {
            const id = msg.split(':')[1];
            atmSockets[id] = socket;
            console.log(` ATM ${id} conectado via TCP pronto para comandos.`);
        }
    }));
});
tcpServerATM.listen(6001, () => console.log('🔌 TCP (ATMs) rodando na porta 6001'));

// Repassa um comando ao ATM pela conexao persistente (mensagem de mao unica), com o contexto
function enviarAoAtm(id: string, comando: string) {
    const span = tracer.startSpan(`tcp ${comando.split(':')[0]} send`, {
        kind: SpanKind.PRODUCER,
        attributes: { 'network.transport': 'tcp', 'atm.id': id, 'atm.comando': comando.split(':')[0] },
    });
    atmSockets[id].write(anexarContexto(comando, trace.setSpan(context.active(), span)));
    span.end();
}

const tcpServerGateway = net.createServer((socket) => {
    // Cada resposta tambem e uma linha: o gateway le ate o '\n' (respostas grandes podem
    // chegar em varios segmentos)
    const responder = (obj: unknown) => socket.write(JSON.stringify(obj) + FIM_DE_MENSAGEM);

    socket.on('data', criarLeitorDeLinhas((linha) => {
        const { ctx, comando: command } = extrairContexto(linha);
        const nome = command.split(':')[0];
        const span = tracer.startSpan(`tcp ${nome}`, {
            kind: SpanKind.SERVER,
            attributes: { 'network.transport': 'tcp', 'server.port': 6002, 'atm.comando': nome },
        }, ctx);

        context.with(trace.setSpan(ctx, span), () => {
            if (command === 'GET_ALL') {
                responder(atms);
            }
            else if (command.startsWith('BLOCK:')) {
                const id = command.split(':')[1];
                span.setAttribute('atm.id', id);

                if (atmSockets[id] && !atmSockets[id].destroyed) {
                    enviarAoAtm(id, 'CMD_LOCK');

                    if (atms[id]) {
                        atms[id].status = 'BLOCKED';
                        atms[id].lastSeen = Date.now();
                        console.log(`[MONITOR] Status do ${id} forçado para BLOCKED manualmente.`);
                    }

                    responder({ status: 'Bloqueio enviado' });
                } else {
                    span.setAttribute('atm.resultado', 'offline');
                    responder({ status: 'ATM Offline' });
                }
            }
            else if (command.startsWith('ABASTECER:')) {
                const partes = command.split(':');
                const id = partes[1];
                const valor = partes[2];
                span.setAttribute('atm.id', id);

                if (atmSockets[id] && !atmSockets[id].destroyed) {
                    enviarAoAtm(id, `CMD_REFILL:${valor}`);
                    responder({ status: 'Abastecimento enviado' });
                } else {
                    span.setAttribute('atm.resultado', 'offline');
                    responder({ status: 'ATM Offline' });
                }
            }
        });
        span.end();
    }));
});
tcpServerGateway.listen(6002, () => console.log('TCP (Gateway) rodando na porta 6002'));
