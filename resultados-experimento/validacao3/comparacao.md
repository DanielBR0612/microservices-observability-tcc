# Resultado do experimento de overhead

Diretorio: `C:/Users/pichau/documents/faculdade/projeto-dsd/resultados-experimento/validacao3`  
Linha de base: `sem-otel`. Valores = mediana entre repeticoes; overhead = (config - base) / base; p = Mann-Whitney bicaudal exato entre as repeticoes.

Parametros: 2 repeticoes por configuracao, 2 iteracoes/s, 20s por rodada, aquecimento 10s.

## Latencia por protocolo

| Serie | Metrica | sem-otel (ms) | otel-100 (ms) | overhead otel-100 | p otel-100 |
|---|---|---:|---:|---:|---:|
| SOAP | p50 | 142.03 ± 3.00 | 144.35 ± 1.68 | +1.6% | 0.667 |
| SOAP | p95 | 214.75 ± 6.10 | 220.22 ± 10.38 | +2.5% | 0.667 |
| SOAP | p99 | 386.87 ± 181.74 | 255.39 ± 42.21 | -34.0% | 0.667 |
| REST | p50 | 18.35 ± 1.53 | 21.15 ± 3.38 | +15.2% | 0.667 |
| REST | p95 | 38.95 ± 3.97 | 46.77 ± 9.42 | +20.1% | 0.667 |
| REST | p99 | 52.27 ± 2.38 | 61.88 ± 6.79 | +18.4% | 0.333 |
| gRPC | p50 | 5.91 ± 0.52 | 7.62 ± 1.01 | +28.9% | 0.333 |
| gRPC | p95 | 8.99 ± 0.18 | 15.59 ± 4.75 | +73.3% | 0.333 |
| gRPC | p99 | 10.27 ± 1.37 | 21.95 ± 7.42 | +113.7% | 0.333 |
| TCP | p50 | 2.66 ± 0.27 | 3.66 ± 0.45 | +37.8% | 0.333 |
| TCP | p95 | 6.27 ± 0.70 | 9.46 ± 1.16 | +50.7% | 0.333 |
| TCP | p99 | 8.21 ± 1.40 | 18.00 ± 4.05 | +119.2% | 0.333 |
| WebSocket (handshake) | p50 | 0.72 ± 0.09 | 0.78 ± 0.07 | +7.4% | 0.667 |
| WebSocket (handshake) | p95 | 1.00 ± 0.14 | 1.30 ± 0.44 | +30.3% | 0.667 |
| WebSocket (handshake) | p99 | 1.33 ± 0.31 | 1.91 ± 0.66 | +43.8% | 0.667 |
| AMQP notificacao PIX | p50 | 127.00 ± 8.49 | 135.75 ± 10.96 | +6.9% | 0.667 |
| AMQP notificacao PIX | p95 | 150.50 ± 27.58 | 179.57 ± 31.93 | +19.3% | 0.667 |
| AMQP notificacao PIX | p99 | 165.30 ± 25.31 | 206.07 ± 62.32 | +24.7% | 0.667 |
| AMQP notificacao TED | p50 | 92.50 ± 4.95 | 98.25 ± 7.42 | +6.2% | 0.667 |
| AMQP notificacao TED | p95 | 111.50 ± 16.26 | 124.70 ± 29.27 | +11.8% | 0.667 |
| AMQP notificacao TED | p99 | 130.00 ± 16.40 | 142.81 ± 50.64 | +9.9% | 1.000 |
| Total HTTP | p50 | 79.21 ± 2.94 | 81.78 ± 2.05 | +3.2% | 0.667 |
| Total HTTP | p95 | 206.06 ± 5.70 | 192.44 ± 28.80 | -6.6% | 1.000 |
| Total HTTP | p99 | 237.67 ± 1.33 | 240.68 ± 29.57 | +1.3% | 1.000 |

## Vazao e erros

| Serie | Metrica | sem-otel (valor) | otel-100 (valor) | overhead otel-100 | p otel-100 |
|---|---|---:|---:|---:|---:|
| SOAP | vazao_req_s | 22.96 ± 0.05 | 22.98 ± 0.15 | +0.1% | 1.000 |
| SOAP | erro_pct | 0.00 ± 0.00 | 0.00 ± 0.00 | - | 1.000 |
| REST | vazao_req_s | 7.06 ± 0.02 | 7.07 ± 0.05 | +0.1% | 1.000 |
| REST | erro_pct | 0.00 ± 0.00 | 0.00 ± 0.00 | - | 1.000 |
| gRPC | vazao_req_s | 1.77 ± 0.00 | 1.77 ± 0.01 | +0.1% | 1.000 |
| gRPC | erro_pct | 0.00 ± 0.00 | 0.00 ± 0.00 | - | 1.000 |
| TCP | vazao_req_s | 5.30 ± 0.01 | 5.30 ± 0.03 | +0.1% | 1.000 |
| TCP | erro_pct | 0.00 ± 0.00 | 0.00 ± 0.00 | - | 1.000 |
| Total HTTP | vazao_req_s | 38.85 ± 0.08 | 38.88 ± 0.25 | +0.1% | 1.000 |
| Total HTTP | erro_pct | 0.00 ± 0.00 | 0.00 ± 0.00 | - | 1.000 |

## CPU por servico (nucleos medios durante a rodada)

| Serie | Metrica | sem-otel (nucleos) | otel-100 (nucleos) | overhead otel-100 | p otel-100 |
|---|---|---:|---:|---:|---:|
| container_gateway | cpu_nucleos | 0.14 ± 0.02 | 0.22 ± 0.02 | +58.9% | 0.333 |
| container_ws | cpu_nucleos | 0.03 ± 0.00 | 0.03 ± 0.00 | +12.8% | 0.667 |
| container_comprovantes | cpu_nucleos | 0.01 ± 0.00 | 0.01 ± 0.00 | +26.2% | 0.333 |
| atm-monitor | cpu_nucleos | 0.00 ± 0.00 | 0.01 ± 0.00 | +114.2% | 0.333 |
| projeto-dsd-rabbitmq | cpu_nucleos | 0.09 ± 0.01 | 0.05 ± 0.06 | -42.7% | 0.667 |
| projeto-dsd-jaeger-1 | cpu_nucleos | 0.00 ± 0.00 | 0.01 ± 0.00 | +366.1% | 0.333 |
| banco-soap | cpu_nucleos | 2.40 ± 0.10 | 2.50 ± 0.08 | +4.2% | 0.667 |
| rest-api | cpu_nucleos | 0.11 ± 0.00 | 0.15 ± 0.02 | +32.0% | 0.333 |

## Memoria por servico (ao fim da rodada)

| Serie | Metrica | sem-otel (MB) | otel-100 (MB) | overhead otel-100 | p otel-100 |
|---|---|---:|---:|---:|---:|
| container_gateway | mem_mb | 165.90 ± 0.14 | 169.65 ± 4.03 | +2.3% | 0.333 |
| container_ws | mem_mb | 127.55 ± 1.77 | 139.50 ± 0.42 | +9.4% | 0.333 |
| container_comprovantes | mem_mb | 32.85 ± 1.48 | 42.75 ± 2.62 | +30.1% | 0.333 |
| atm-monitor | mem_mb | 208.95 ± 0.49 | 209.30 ± 1.27 | +0.2% | 1.000 |
| projeto-dsd-rabbitmq | mem_mb | 236.20 ± 0.14 | 236.55 ± 0.07 | +0.1% | 0.333 |
| projeto-dsd-jaeger-1 | mem_mb | 26.45 ± 4.17 | 59.90 ± 2.97 | +126.5% | 0.333 |
| banco-soap | mem_mb | 344.65 ± 22.27 | 422.80 ± 0.85 | +22.7% | 0.333 |
| rest-api | mem_mb | 531.70 ± 106.21 | 395.00 ± 17.82 | -25.7% | 0.333 |

## Cobertura de traces (configs com OpenTelemetry)

| Protocolo | otel-100 cobertura (%) | otel-100 traces/rodada |
|---|---:|---:|
| SOAP | 92.3 | 527 |
| REST | 75.0 | 162 |
| gRPC | 100.0 | 41 |
| TCP | 0.0 | 122 |
| AMQP | 0.0 | 81 |
| orfaos | - | 81 |
