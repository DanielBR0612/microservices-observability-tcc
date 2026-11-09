# T4: incompatibilidade de formatos de propagação, W3C × B3 (2026-11-09)

**Pergunta:** o que acontece com o rastreamento quando os serviços não usam o mesmo formato de propagação de contexto? O W3C Trace Context (`traceparent`) é o padrão do OpenTelemetry; o B3 (`X-B3-TraceId`, `X-B3-SpanId`...) é o formato do Zipkin e foi o padrão do Spring Cloud Sleuth, comum em sistemas legados.

**Procedimento:** uma rodada de 30 s do k6 (2 iterações/s, OTel 100%) por cenário, com cobertura medida pelo `cobertura-traces.js`. Cada pasta tem `janela.txt`, `k6.txt`, `cobertura.json` e `cobertura-fluxos.csv`.

| Cenário | Configuração | Como |
|---|---|---|
| A | todos em W3C (padrão) | — |
| B | só o `rest-api` em **B3** (lê e escreve) | `MANAGEMENT_TRACING_PROPAGATION_TYPE=B3` |
| C | `rest-api` em **B3 + W3C** (lê e escreve os dois) | `MANAGEMENT_TRACING_PROPAGATION_TYPE=B3,W3C` |
| D | só o gateway em **B3** (a borda) | `OTEL_PROPAGATORS=b3multi` |

## Resultado: cobertura por protocolo

| Protocolo | A (W3C) | B (`rest-api` B3) | C (`rest-api` B3+W3C) | D (gateway B3) |
|---|---:|---:|---:|---:|
| SOAP | 100% | 100% | 100% | **7,7%** ¹ |
| REST | 100% | **0%** | 100% | 100% ² |
| gRPC | 100% | 100% | 100% | **0%** |
| TCP | 99,4% ³ | 100% | 100% | **0%** |
| AMQP | 100% | **50%** | 100% | **50%** |
| Traces órfãos | 0 | **305** | 0 | **781** (+180 do `atm-monitor`) |
| Checks do k6 | 100% | **100%** | 100% | **100%** |

¹ Só o fluxo `saldo [401]`, que não sai do gateway.
² O Spring Boot (Micrometer) **lê W3C, B3 e B3 multi por padrão** e escreve só W3C.
³ Ver "Achado colateral".

## Leituras

1. **A incompatibilidade é totalmente silenciosa.** Em todos os cenários quebrados, o k6 teve 100% dos checks e 0% de erros HTTP. Nenhum serviço registra erro: quem recebe um formato que não entende simplesmente inicia um trace novo.
2. **Um serviço divergente quebra os dois lados dele.** No cenário B, o `rest-api` em B3 não entendeu o `traceparent` do gateway (REST 0%, 244 órfãos) **e** escreveu B3 nos headers AMQP, que o `ws-service` não entendeu (AMQP do PIX quebrado, mais 61 órfãos). O dano se propaga pelo caminho da requisição.
3. **Os padrões das bibliotecas são assimétricos.** Com a borda em B3 (cenário D), quebraram as três stacks do OpenTelemetry (starter Java no SOAP, Python no gRPC, Node no TCP), que só aceitam W3C por padrão. O `rest-api` sobreviveu porque o Micrometer do Spring Boot aceita vários formatos na leitura. Na prática, o mesmo erro de configuração tem efeitos diferentes conforme a biblioteca de cada serviço.
4. **Propagador composto resolve.** No cenário C, o `rest-api` lendo e escrevendo B3 e W3C voltou a 100% em tudo: é o caminho de migração entre formatos. É o princípio da robustez ("seja liberal no que aceita"), que o Micrometer já aplica por padrão na leitura.

## Achado colateral: perda real de mensagem revelada pelo trace

No cenário A, o TCP deu 99,4%: 1 de 60 abastecimentos ficou sem o span do `atm-cluster`. O log do cluster mostra **59 abastecimentos processados para 60 requisições**: um comando foi **perdido**. Dois `CMD_REFILL` chegaram no mesmo segmento TCP pela conexão persistente, e como o protocolo não delimita mensagens, o ATM processou só o primeiro. O defeito é anterior à instrumentação (já existia no protocolo de texto), mas era invisível: o k6 só verifica a resposta do monitor ("Abastecimento enviado"). **Foi o trace incompleto, possível graças à propagação TCP da seção 9.6, que revelou a perda de dados.**
