import './tracing';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import express from 'express';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import cors from 'cors'; 
import amqp from 'amqplib';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

app.use(cors({ origin: '*' })); 
app.use(express.json()); 

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

type ClientId = string;
const clients = new Map<ClientId, WebSocket>();

//Setup RabbitMQ
let channel: amqp.Channel;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const NOTIFICATION_QUEUE = process.env.RABBITMQ_NOTIFICATION_QUEUE || 'notificacoes.transferencias';
const DEAD_LETTER_QUEUE = 'notificacoes.transferencias.dlq'; 

async function connectRabbitMQ() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Configura a fila principal com Dead Letter Exchange
    await channel.assertExchange('notificacoes.dlx', 'direct', { durable: true });
    await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await channel.bindQueue(DEAD_LETTER_QUEUE, 'notificacoes.dlx', DEAD_LETTER_QUEUE);

    // Fila principal com TTL e Dead Letter
    await channel.assertQueue(NOTIFICATION_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'notificacoes.dlx',
        'x-dead-letter-routing-key': DEAD_LETTER_QUEUE,
        'x-message-ttl': 86400000, 
      },
    });

    console.log('[RabbitMQ] Conectado e filas configuradas');

    // Inicia consumo de mensagens
    consumeNotifications();

    connection.on('error', (err) => {
      console.error('[RabbitMQ] Erro de conexão:', err);
      setTimeout(() => connectRabbitMQ(), 5000); 
    });
  } catch (error) {
    console.error('[RabbitMQ] Falha ao conectar:', error);
    setTimeout(() => connectRabbitMQ(), 5000);
  }
}

async function consumeNotifications() {
  if (!channel) return;

  await channel.consume(NOTIFICATION_QUEUE, async (msg) => {
    if (!msg) return;

    try {
      const content = JSON.parse(msg.content.toString());
      
      const alvo = content.contaDestino || content.destinatarioId;

      if (!alvo) {
        console.error('[Queue] ❌ Mensagem sem conta de destino. Descartando.');
        channel.ack(msg); // Tira da fila pra não travar
        return;
      }

      console.log(`[Queue] Processando notificação para: ${alvo}`);

      const ws = clients.get(alvo);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: 'nova-transacao',
            data: content, // Envia o payload completo
          }),
        );
        console.log(`[WS] ✅ Notificação entregue ao cliente ${alvo}`);
        channel.ack(msg); // Remove da fila (Sucesso)
      } else {
        console.log(`[WS] 💤 Cliente ${alvo} offline/desconectado.`);
        
        setTimeout(() => {
            try {
                channel.nack(msg, false, true); 
                console.log(`[Queue] Mensagem re-enfileirada para ${alvo} (tentativa futura)`);
            } catch (e) {
                // Caso o canal tenha fechado nesse meio tempo
            }
        }, 5000); 
      }
    } catch (error) {
      console.error('[Queue] Erro crítico ao processar mensagem:', error);
      // Se deu erro de parse ou algo grave, não adianta tentar de novo
      channel.nack(msg, false, false); 
    }
  });
}

app.post('/notify', async (req: Request, res: Response) => {
  // Ajustado para receber contaDestino também
  const { contaDestino, destinatarioId, valor, tipo } = req.body;
  
  const target = contaDestino || destinatarioId;

  if (!target || !valor || !tipo) {
    return res.status(400).json({ error: 'Dados incompletos. Informe contaDestino.' });
  }

  try {
    const notification = {
      contaDestino: target, // Padronizando
      valor,
      tipo,
      timestamp: new Date().toISOString(),
    };

    channel.sendToQueue(NOTIFICATION_QUEUE, Buffer.from(JSON.stringify(notification)), {
      persistent: true, 
      contentType: 'application/json',
    });

    console.log(`[NOTIFY] Notificação enfileirada para ${target}`);
    res.status(200).json({ ok: true, message: 'Notificação enfileirada' });
  } catch (error) {
    console.error('[NOTIFY] Erro ao enfileirar:', error);
    res.status(500).json({ error: 'Falha ao enfileirar notificação' });
  }
});

// Endpoint auxiliar para reprocessar DLQ (uso manual)
app.post('/admin/reprocess-dlq', async (req: Request, res: Response) => {
  try {
    const messages = await channel.get(DEAD_LETTER_QUEUE);
    if (messages) {
      await channel.sendToQueue(NOTIFICATION_QUEUE, messages.content, { persistent: true });
      channel.ack(messages);
      console.log('[Admin] Mensagem movida de DLQ para fila principal');
      res.json({ success: true });
    } else {
      res.json({ message: 'DLQ vazia' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro ao reprocessar' });
  }
});

// Ciclo de vida do WebSocket
wss.on('connection', (socket, request) => {
  console.log('[WS] Nova tentativa de conexão...');

  const url = new URL(request.url ?? '', 'http://localhost');
  const token = url.searchParams.get('token');
  
  const secret = process.env.WS_JWT_SECRET || 'secret'; // Use a mesma chave do Gateway!

  let clienteId: string | null = null;

  if (!token) {
    console.log('[WS] Conexão recusada: Sem token');
    socket.close(1008, 'Token Obrigatório');
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    
    // Pega o ID da conta do payload (campo 'sub' ou 'conta')
    clienteId = payload.sub || payload.conta as string;
    
    if (!clienteId) {
       console.log('[WS] Conexão recusada: Token sem ID');
       socket.close(1008, 'Token sem ID de conta');
       return;
    }
    
    console.log(`[WS] Cliente Autenticado e Conectado: ${clienteId}`);
    clients.set(clienteId, socket);
    
    // Feedback visual pro front
    socket.send(JSON.stringify({ event: 'info', message: 'Conectado ao WebSocket!' }));

    socket.on('close', () => {
      console.log(`[WS] Cliente ${clienteId} desconectou`);
      clients.delete(clienteId as string);
    });

  } catch (err) {
    console.error('JWT inválido:', (err as Error).message);
    socket.close(1008, 'Token Inválido');
    return;
  }
});

//Inialização 
const PORT = Number(process.env.PORT || 8083);

connectRabbitMQ().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serviço de Notificações rodando na porta ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  });
});