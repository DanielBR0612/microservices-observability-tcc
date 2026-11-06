package com.example.BancoCoreSoap.service;

import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.Map;
import java.util.logging.Logger;
import java.time.Instant; // Importante

@Service
public class NotificationService {

    private static final Logger logger = Logger.getLogger(NotificationService.class.getName());

    @Autowired
    private RabbitTemplate rabbitTemplate;

    private final ObjectMapper objectMapper = new ObjectMapper();

    // Publica notificação de transferência na fila RabbitMQ
    public void publishTransferenceNotification(String destinatarioId, java.math.BigDecimal valor, String tipo) {
        try {
            Map<String, Object> notification = new HashMap<>();
            
            notification.put("contaDestino", destinatarioId);
            notification.put("destinatarioId", destinatarioId); // Mantém compatibilidade
            
            notification.put("valor", valor);
            notification.put("tipo", tipo);
            
            notification.put("timestamp", Instant.now().toString());

            // Envia para a fila (RabbitMQ)
            rabbitTemplate.convertAndSend(
                "notificacoes.transferencias",
                objectMapper.writeValueAsString(notification)
            );

            // Unico ponto de publicacao: o ws-service consome a fila e entrega via WebSocket
            logger.info("[RabbitMQ] Notificação enfileirada para: " + destinatarioId);

        } catch (Exception e) {
            logger.severe("[NotificationService] Erro ao publicar: " + e.getMessage());
            e.printStackTrace();
        }
    }
}