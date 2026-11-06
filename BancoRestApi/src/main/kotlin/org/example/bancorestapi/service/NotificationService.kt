package org.example.bancorestapi.service

import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Service
import com.fasterxml.jackson.databind.ObjectMapper
import java.math.BigDecimal
import java.time.Instant
import java.util.logging.Logger

@Service
class NotificationService {

    @Autowired
    private lateinit var rabbitTemplate: RabbitTemplate

    private val objectMapper = ObjectMapper()
    private val logger = Logger.getLogger(NotificationService::class.java.name)

    /**
     * Publica notificação de transferência na fila RabbitMQ
     */
    fun publishTransferenceNotification(contaDestino: String, valor: BigDecimal, tipo: String) {
        val destinatarioId = contaDestino
        try {
            // O ws-service indexa os clientes WebSocket pelo numero da conta (sub do JWT)
            val notification = mapOf(
                "contaDestino" to contaDestino,
                "destinatarioId" to contaDestino,
                "valor" to valor,
                "tipo" to tipo,
                "timestamp" to Instant.now().toString()
            )

            // Publica na fila
            rabbitTemplate.convertAndSend(
                "notificacoes.transferencias",
                objectMapper.writeValueAsString(notification)
            )

            // Unico ponto de publicacao: o ws-service consome a fila e entrega via WebSocket
            logger.info("[RabbitMQ] Notificação enfileirada para: $destinatarioId")

        } catch (e: Exception) {
            logger.severe("[NotificationService] Erro ao publicar: ${e.message}")
            e.printStackTrace()
        }
    }
}
