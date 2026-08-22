import './tracing';
import net from 'net';
import dgram from 'dgram';

const MONITOR_HOST = process.env.MONITOR_HOST || 'localhost';
const PORTA_UDP = 6000; 
const PORTA_TCP = 6001; 

console.log(` Iniciando Cluster de ATMs apontando para: ${MONITOR_HOST}`);

class ATMClient {
    private id: string;
    private dinheiro: number;
    private tcpClient: net.Socket;
    private udpClient: dgram.Socket;
    private ativo: boolean = true;
    private udpInterval: NodeJS.Timeout | null = null;

    constructor(id: string, dinheiroInicial: number) {
        this.id = id;
        this.dinheiro = dinheiroInicial;
        this.tcpClient = new net.Socket();
        this.udpClient = dgram.createSocket('udp4');
    }

    public iniciar() {
        if (!this.ativo) return;
        
        console.log(`[${this.id}] 🏧 Inicializando sistemas...`);
        this.conectarTCP();
        this.iniciarLoopUDP();
    }

    private conectarTCP() {
        this.tcpClient.connect(PORTA_TCP, MONITOR_HOST, () => {
            console.log(`[${this.id}] 🔌 Conectado ao servidor via TCP.`);
            this.tcpClient.write(`REGISTER:${this.id}`);
        });

        this.tcpClient.on('data', (data) => {
            const comando = data.toString();
            
            if (comando === 'CMD_LOCK') {
                this.bloquearMaquina();
            }
            else if (comando.startsWith('CMD_REFILL:')) {
                const novoValor = parseInt(comando.split(':')[1]);
                this.dinheiro = this.dinheiro + novoValor;
                console.log(`[${this.id}] CAIXA ABASTECIDO! Novo saldo: R$ ${novoValor}`);
            }
        });

        this.tcpClient.on('error', (err) => {
            console.error(`[${this.id}]  Erro TCP (Servidor offline?): ${err.message}`);
        });

        this.tcpClient.on('close', () => {
            if (this.ativo) console.log(`[${this.id}] 🔌 Desconectado do servidor.`);
        });
    }

    private iniciarLoopUDP() {
        this.udpInterval = setInterval(() => {
            if (!this.ativo) return;

            if (Math.random() > 0.7) {
                this.dinheiro -= 20; 
            }

            const payload = JSON.stringify({
                id: this.id,
                status: 'ONLINE',
                dinheiro: this.dinheiro
            });

            this.udpClient.send(payload, PORTA_UDP, MONITOR_HOST, (err) => {
                if (err) console.error(`[${this.id}] Falha ao enviar UDP`);
            });

        }, 2000 + Math.random() * 1000);
    }

    private bloquearMaquina() {
        this.ativo = false; 
        
        console.error(`\n[${this.id}] COMANDO DE BLOQUEIO RECEBIDO!`);
        
        const payloadFinal = JSON.stringify({
            id: this.id,
            status: 'BLOCKED', 
            dinheiro: this.dinheiro
        });

        this.udpClient.send(payloadFinal, PORTA_UDP, MONITOR_HOST, () => {
             console.log(`[${this.id}] 📤 Status final 'BLOCKED' enviado.`);
             
             if (this.udpInterval) clearInterval(this.udpInterval);
             this.tcpClient.destroy();
             this.udpClient.close();
             console.error(`[${this.id}]  Terminal desligado.\n`);
        });
    }
}

const atm1 = new ATMClient('ATM-CENTRO-01', 50000);
const atm2 = new ATMClient('ATM-SHOPPING-02', 85000);
const atm3 = new ATMClient('ATM-AEROPORTO-03', 120000);

setTimeout(() => atm1.iniciar(), 1000);
setTimeout(() => atm2.iniciar(), 2000);
setTimeout(() => atm3.iniciar(), 3000);

setInterval(() => {}, 10000);