import './tracing';
import net from 'net';
import dgram from 'dgram';

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
    socket.on('data', (data) => {
        const msg = data.toString();
        if (msg.startsWith('REGISTER:')) {
            const id = msg.split(':')[1];
            atmSockets[id] = socket;
            console.log(` ATM ${id} conectado via TCP pronto para comandos.`);
        }
    });
});
tcpServerATM.listen(6001, () => console.log('🔌 TCP (ATMs) rodando na porta 6001'));

const tcpServerGateway = net.createServer((socket) => {
    socket.on('data', (data) => {
        const command = data.toString();
        
        if (command === 'GET_ALL') {
            socket.write(JSON.stringify(atms));
        } 
        else if (command.startsWith('BLOCK:')) { 
            const id = command.split(':')[1];
            
            if (atmSockets[id] && !atmSockets[id].destroyed) {
                atmSockets[id].write('CMD_LOCK');
                
                if (atms[id]) {
                    atms[id].status = 'BLOCKED'; 
                    atms[id].lastSeen = Date.now(); 
                    console.log(`[MONITOR] Status do ${id} forçado para BLOCKED manualmente.`);
                }

                socket.write(JSON.stringify({ status: 'Bloqueio enviado' }));
            } else {
                socket.write(JSON.stringify({ status: 'ATM Offline' }));
            }
        }
        else if (command.startsWith('ABASTECER:')) {
            const partes = command.split(':');
            const id = partes[1];
            const valor = partes[2];

            if (atmSockets[id] && !atmSockets[id].destroyed) {
                atmSockets[id].write(`CMD_REFILL:${valor}`);
                socket.write(JSON.stringify({ status: 'Abastecimento enviado' }));
            } else {
                socket.write(JSON.stringify({ status: 'ATM Offline' }));
            }
        }
    });
});
tcpServerGateway.listen(6002, () => console.log('TCP (Gateway) rodando na porta 6002'));