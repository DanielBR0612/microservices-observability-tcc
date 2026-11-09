package com.example.BancoCoreSoap.service;

import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import java.util.HashMap;
import java.util.Map;
import java.util.logging.Logger;
import java.time.Instant; // Importante

@Service
public class NotificationService {

    private static final Logger logger = Logger.getLogger(NotificationService.class.getName());
    private static final String FILA = "notificacoes.transferencias";

    @Autowired
    private RabbitTemplate rabbitTemplate;

    // Fornecido pelo opentelemetry-spring-boot-starter (no-op quando OTEL_SDK_DISABLED=true)
    @Autowired
    private OpenTelemetry openTelemetry;

    private final ObjectMapper objectMapper = new ObjectMapper();

    // Publica notificação de transferência na fila RabbitMQ
    public void publishTransferenceNotification(String destinatarioId, java.math.BigDecimal valor, String tipo) {
        // Propagacao manual de contexto: o starter do OpenTelemetry nao instrumenta o
        // RabbitTemplate, entao a mensagem sairia sem traceparent e o consumo viraria um
        // trace orfao. Cria-se um span PRODUCER e o contexto dele e injetado nos headers AMQP.
        Span span = openTelemetry.getTracer("banco-soap.notificacoes")
            .spanBuilder(FILA + " publish")
            .setSpanKind(SpanKind.PRODUCER)
            .setAttribute("messaging.system", "rabbitmq")
            .setAttribute("messaging.destination.name", FILA)
            .setAttribute("messaging.operation.type", "publish")
            .startSpan();

        try (Scope ignored = span.makeCurrent()) {
            Map<String, Object> notification = new HashMap<>();

            notification.put("contaDestino", destinatarioId);
            notification.put("destinatarioId", destinatarioId); // Mantém compatibilidade

            notification.put("valor", valor);
            notification.put("tipo", tipo);

            notification.put("timestamp", Instant.now().toString());

            // Envia para a fila (RabbitMQ), com o contexto de trace nos headers da mensagem
            rabbitTemplate.convertAndSend(
                FILA,
                objectMapper.writeValueAsString(notification),
                mensagem -> {
                    openTelemetry.getPropagators().getTextMapPropagator().inject(
                        Context.current(),
                        mensagem.getMessageProperties(),
                        (props, chave, valorHeader) -> props.setHeader(chave, valorHeader));
                    return mensagem;
                }
            );

            // Unico ponto de publicacao: o ws-service consome a fila e entrega via WebSocket
            logger.info("[RabbitMQ] Notificação enfileirada para: " + destinatarioId);

        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR);
            logger.severe("[NotificationService] Erro ao publicar: " + e.getMessage());
            e.printStackTrace();
        } finally {
            span.end();
        }
    }
}
