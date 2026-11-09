# Metodologia: impacto da observabilidade em diferentes protocolos

Este documento descreve como o projeto avalia o rastreamento distribuído (OpenTelemetry + Jaeger) nos protocolos usados pelo sistema bancário: SOAP, REST, gRPC, AMQP, WebSocket e TCP/UDP. Ele descreve as perguntas, as métricas, o procedimento experimental, as ferramentas e as ameaças à validade.

> Estado: a cobertura (eixo 1) e o overhead (eixo 2) são automatizados, e o experimento completo dos dois foi executado em 2026-11-07 (seção 9.4). O diagnóstico (eixo 3) tem um protocolo definido aqui, mas é executado manualmente e ainda não foi feito. As seções 9.1 a 9.3 trazem achados de rodadas exploratórias.

---

## 1. Pergunta de pesquisa

**Como o protocolo de comunicação entre serviços afeta a observabilidade obtida com rastreamento distribuído?**

A pergunta se divide em quatro:

| Eixo | Pergunta | Métrica principal |
|---|---|---|
| 1. Cobertura | O contexto de trace atravessa o protocolo? | % de traces completos por fluxo |
| 2. Overhead | Quanto custa instrumentar cada protocolo? | Δ latência (p50/p95/p99), Δ CPU, Δ memória |
| 3. Diagnóstico | Com os traces dá para localizar uma falha injetada? | Rubrica de diagnóstico (seção 6) |
| 4. Fidelidade e custo | O que o trace mede bate com o que o cliente sente? Quanto dado é gerado? | latência k6 vs. duração do span; spans/transação |

---

## 2. Sistema sob teste

```
                 HTTP/JSON                       SOAP/HTTP
k6 ─────────────▶ api-gateway (NestJS) ─────────────────────▶ banco-soap (Java/Spring)  ─┐
                    │  │  │                        REST/HTTP                               │ AMQP
                    │  │  └─────────────────────────────────▶ rest-api  (Kotlin/Spring) ─┤ (RabbitMQ)
                    │  │                           gRPC                                  ▼
                    │  └────────────────────────────────────▶ comprovantes (Python)    ws-service (Node)
                    │                              TCP                                     │ WebSocket
                    └───────────────────────────────────────▶ atm-monitor (Node) ◀─UDP─ atm-cluster
k6 ◀────────────────────────────────────────────────────────────────────────────────────────┘
```

### Instrumentação por serviço

| Serviço | Linguagem | Como é instrumentado | Exporta para |
|---|---|---|---|
| api-gateway | Node/NestJS | `@opentelemetry/sdk-node` + auto-instrumentations (`src/tracing.ts`) | OTLP gRPC :4317 |
| banco-soap | Java/Spring Boot 3 | `opentelemetry-spring-boot-starter` 2.30 | OTLP HTTP :4318 |
| rest-api | Kotlin/Spring Boot 3.3 | Micrometer Tracing + bridge OTel | OTLP HTTP :4318 |
| comprovantes-service | Python | `opentelemetry-instrument` (distro + instrumentação grpc) | OTLP gRPC :4317 |
| ws-service | Node | `NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register` | OTLP HTTP :4318 |
| atm-monitor / atm-cluster | Node | `@opentelemetry/sdk-node` (`ATMService/tracing.ts`) | OTLP gRPC :4317 |

### Como o contexto deveria viajar em cada protocolo

| Protocolo | Portador do contexto | Suporte da auto-instrumentação |
|---|---|---|
| REST | header HTTP `traceparent` (W3C) | automático nos dois lados |
| SOAP | o mesmo header (SOAP é transportado por HTTP) | automático; o envelope SOAP não é usado |
| gRPC | metadata da chamada | automático (grpc-js no cliente, grpc no servidor Python) |
| AMQP | headers da mensagem | depende de instrumentar o produtor (Spring AMQP) e o consumidor (amqplib) |
| WebSocket | só o handshake HTTP; frames não têm cabeçalho | não há propagação por mensagem |
| TCP/UDP cru | não existe padrão; seria preciso pôr o contexto no payload | nenhum |

---

## 3. Carga de trabalho (k6)

O script `script.js` executa, em cada iteração, uma transação de negócio completa que passa por todos os protocolos:

1. **SOAP:** cria 2 clientes e 2 contas, faz login (JWT emitido pelo gateway após `autenticar` no SOAP), consulta o saldo, altera a senha e faz uma TED.
2. **REST:** cria uma chave Pix, lista as chaves, faz um PIX e consulta o extrato.
3. **WebSocket + AMQP:** o destinatário abre o WebSocket antes do PIX e da TED, e o script mede o tempo até a notificação chegar.
4. **gRPC:** gera o comprovante em PDF.
5. **TCP:** lista, abastece e bloqueia ATMs (o bloqueio usa um id inexistente).

Cada requisição recebe as tags **`protocolo`** (`SOAP`, `REST`, `gRPC`, `TCP`, `WebSocket`, `infra`) e **`operacao`**, por exemplo `TED`, `PIX` ou `login`. Assim:

- o resumo do k6 mostra `http_req_duration{protocolo:X}`, `http_req_failed{protocolo:X}` e `http_reqs{protocolo:X}`;
- o JSON bruto (`--out json`) permite recortar por operação;
- `ws_notificacao_latencia_ms{tipo:PIX|TED}` mede o caminho assíncrono backend → RabbitMQ → ws-service → WebSocket;
- `ws_connecting{protocolo:WebSocket}` mede o handshake.

Os checks validam a corretude de ponta a ponta: saldo final = inicial − PIX − TED, notificação recebida exatamente uma vez, PDF válido etc. Uma rodada em que os checks falham não deve entrar na análise de desempenho.

### Modelo de carga

- **`MODO=vus`** (padrão): VUs fixos com 1s de think time. É útil para testes funcionais.
- **`MODO=taxa`**: executor `constant-arrival-rate`, com `TAXA` iterações por segundo e sem think time. **É o modo usado para medir overhead.** Com VUs fixos, um sistema mais lento recebe menos requisições (*coordinated omission*), o que esconde o overhead; com taxa constante, a carga oferecida é a mesma em todas as configurações. O resumo registra `dropped_iterations`: se não for zero, o sistema não deu conta da taxa e a rodada precisa ser analisada à parte.

---

## 4. Eixo 1: cobertura de rastreamento

**Ferramenta:** `observabilidade/cobertura-traces.js`

O script lê a API de consulta do Jaeger (`/api/v3/traces`) numa janela de tempo, junta os spans de todos os serviços por `traceId` e, para cada trace iniciado no gateway, identifica o fluxo pela rota do span raiz. Depois compara os serviços presentes com os **serviços esperados** para aquele fluxo (tabela `FLUXOS` no script). Por exemplo, a TED espera `api-gateway + banco-soap + ws-service`, porque o salto até o ws-service é feito por AMQP.

**Métricas:**

- **Cobertura (%)** = traces com todos os serviços esperados / traces do fluxo.
- **Ausentes:** quais serviços faltam e em que proporção. Isso aponta o salto (protocolo) em que o contexto se perdeu.
- **Traces órfãos:** traces cuja raiz não está no gateway (ex.: o consumo AMQP no ws-service virando um trace novo). Órfãos indicam propagação quebrada: o trabalho foi rastreado, mas desconectado da requisição que o causou.
- **Spans por trace e profundidade:** volume e granularidade do dado gerado (eixo 4).
- **Duração do span raiz vs. tempo no serviço de destino** (spans SERVER/CONSUMER): base para o eixo 4.

```bash
node observabilidade/cobertura-traces.js --inicio 2026-11-06T01:08:41Z --fim 2026-11-06T01:16:41Z --saida resultados-k6/cobertura
```

**Experimento de "antes e depois":** para protocolos sem propagação automática (AMQP, TCP), meça a cobertura, implemente a propagação manualmente (injetar `traceparent` nos headers da mensagem, ou um campo no payload TCP) e meça de novo, incluindo o overhead (eixo 2). A diferença quantifica o esforço que cada protocolo exige para ser observável.

---

## 5. Eixo 2: overhead da instrumentação

**Ferramentas:** `observabilidade/experimento-overhead.sh` (execução) e `observabilidade/agregar-experimento.js` (análise).

### Configurações (variável independente)

| Config | O que muda |
|---|---|
| `sem-otel` (linha de base) | `OTEL_SDK_DISABLED=true` nos serviços Node, Python e no starter Java; `MANAGEMENT_TRACING_ENABLED=false` no rest-api; o Python roda sem `opentelemetry-instrument` |
| `otel-100` | Tudo ligado, 100% rastreado (`parentbased_always_on`) |
| `otel-10` | Amostragem de 10% decidida no gateway (`parentbased_traceidratio`, 0.1), seguida pelos serviços a jusante |

As variáveis entram pelo `docker-compose.yaml` (`${OTEL_SDK_DISABLED:-false}` etc.) e, nos serviços Spring que rodam no host, pelo ambiente do processo Java.

### Variáveis dependentes

- Latência p50, p95 e p99 **por protocolo** (k6), vazão e taxa de erro.
- CPU média (núcleos) de cada serviço durante a rodada: Δ do contador do cgroup nos containers, e Δ de `TotalProcessorTime` nos processos Java do host.
- Memória de cada serviço ao fim da rodada.
- Cobertura e número de traces (configs com OTel).

### Procedimento

A sequência de configurações é executada **CICLOS** vezes, com a ordem **invertida a cada ciclo** (ABC, CBA, ABC…). Sem isso, um efeito de ordem (banco de dados crescendo, aquecimento do host, outro processo competindo por CPU) ficaria confundido com o efeito da instrumentação. Em cada ciclo, para cada configuração:

1. Para os serviços Spring e os inicia de novo com as variáveis da configuração. Se a porta continuar ocupada pelo processo anterior, a execução aborta.
2. Para o ws-service, esvazia as filas do RabbitMQ e recria os containers (o Jaeger também, zerando os traces em memória).
3. Faz uma **rodada de aquecimento** (descartada) para JIT, pools de conexão e caches, e grava quais serviços apareceram no Jaeger (`jaeger-servicos.json`). **Controle:** em `sem-otel` a lista precisa estar vazia; se não estiver, o interruptor falhou.
4. Executa **REPS repetições** de `DURACAO` com `TAXA` iterações/s, com pausa entre elas. Em cada repetição: amostra os recursos, roda o k6, amostra os recursos de novo e, se houver OTel, mede a cobertura da janela.

Ao final, restaura a configuração padrão (`otel-100`, compose normal) e agrega os resultados. Cada configuração soma CICLOS × REPS repetições (padrão 2 × 3 = 6).

Durante a execução, não edite o `experimento-overhead.sh`: o bash lê o script aos poucos, e uma edição no meio muda o que ainda vai ser executado.

Uma trava (`resultados-experimento/.em-execucao`) impede duas execuções simultâneas. Na validação deste procedimento, uma execução interrompida continuou rodando em segundo plano e dobrou a carga durante uma das configurações: o CPU medido subiu de 30% a 50% em todos os serviços, e a latência também, com a carga do k6 idêntica. O sintoma de que algo assim aconteceu é a linha de base consumindo *mais* recursos que a configuração instrumentada.

Para não medir outra coisa no lugar da instrumentação:

- os serviços Node rodam em modo produção (`docker-compose.experimento.yaml`: `node dist/main` em vez de `nest --watch`);
- os logs dos Spring ficam em WARN, porque os níveis DEBUG/TRACE do `application.properties` (SQL, parâmetros, requisições) custam mais que a própria instrumentação.

```bash
# completo (padrao: 3 configuracoes x 2 ciclos x 3 repeticoes de 60s, 2 iteracoes/s)
# ~6 reinicios de ~4 min + 18 rodadas de ~1,5 min: cerca de 1 hora
bash observabilidade/experimento-overhead.sh

# variacoes
CICLOS=3 REPS=3 TAXA=3 DURACAO=90s bash observabilidade/experimento-overhead.sh
CONFIGS="sem-otel otel-100" bash observabilidade/experimento-overhead.sh

# reagregar um experimento existente
node observabilidade/agregar-experimento.js resultados-experimento/<data>
```

### Análise estatística

- **Unidade de observação:** a repetição, ou seja, o percentil de cada rodada. Não se agregam requisições de rodadas diferentes, porque requisições de uma mesma rodada não são independentes (compartilham estado de JIT, GC e cache).
- **Resumo:** mediana entre repetições ± desvio padrão.
- **Overhead (%)** = (mediana_config − mediana_base) / mediana_base.
- **Significância:** teste U de Mann-Whitney bicaudal, exato, entre as repetições de cada configuração e as da linha de base. É não paramétrico porque percentis de latência não são normais e *n* é pequeno. Com 6 repetições por grupo (padrão), o menor p possível é 0,002; com 5, é 0,008; com 3, é 0,1 (nunca significativo a 5%). **Use pelo menos 5 repetições por configuração.**
- **Efeito de ordem:** `latencia.csv` e `recursos.csv` têm a coluna `ciclo`. Compare as repetições de uma mesma configuração entre ciclos: se diferirem sistematicamente, há deriva no ambiente.
- Reporte também o tamanho do efeito (diferença absoluta em ms), não só o p-valor. Uma diferença de 0,3 ms pode ser estatisticamente significativa e irrelevante na prática.
- Compare **operações equivalentes** entre protocolos (ex.: TED via SOAP × PIX via REST: ambas são transferências com débito, crédito e notificação). Comparar a média "SOAP" com a média "REST" mistura operações de custo diferente (o BCrypt do login domina o SOAP).

### Arquivos gerados (`resultados-experimento/<data>/`)

| Arquivo | Conteúdo |
|---|---|
| `parametros.json` | parâmetros da execução |
| `<config>/ciclo-C/` | logs do Spring, rodada de aquecimento e `jaeger-servicos.json` (controle) daquele ciclo |
| `<config>/rep-N/meta.json` | janela de tempo, ciclo e duração da repetição |
| `<config>/rep-N/resumo.json` | resumo do k6 (todas as métricas e sub-métricas por protocolo) |
| `<config>/rep-N/metricas.json.gz` | cada requisição com suas tags (para recortes por operação) |
| `<config>/rep-N/recursos-{inicio,fim}.csv` | CPU acumulada e memória de cada serviço |
| `<config>/rep-N/cobertura.json`, `cobertura-fluxos.csv` | cobertura de traces da janela |
| `latencia.csv`, `recursos.csv`, `cobertura.csv` | dados longos, prontos para planilha, R ou Python |
| `comparacao.csv`, `comparacao.md` | mediana por configuração, overhead e p-valor |

---

## 6. Eixo 3: capacidade de diagnóstico (injeção de falhas)

Para cada protocolo, injete uma falha conhecida durante uma rodada do k6. Em seguida, uma pessoa que **não sabe qual falha foi injetada** tenta localizá-la usando apenas o Jaeger.

| # | Protocolo | Falha | Como injetar |
|---|---|---|---|
| F1 | SOAP | latência de 500 ms numa operação | `Thread.sleep(500)` em `realizarTransferenciaTED` |
| F2 | REST | erro 500 intermitente | lançar exceção em 20% dos PIX |
| F3 | gRPC | serviço indisponível | `docker stop container_comprovantes` |
| F4 | AMQP | consumidor parado | `docker stop container_ws` (as mensagens se acumulam) |
| F5 | TCP | ATM desconectado | `docker stop atm-cluster` |
| F6 | rede | perda de pacotes no transporte | `tc qdisc add dev eth0 root netem loss 5%` no container do gateway |

**Rubrica por falha** (0 = não, 1 = parcial, 2 = sim):

1. **Detecção:** o trace mostra que algo está errado (status de erro, duração anômala)?
2. **Localização:** dá para apontar o serviço ou salto responsável?
3. **Causa:** os atributos e eventos do span explicam o motivo (mensagem de exceção, código gRPC, SQL)?
4. **Tempo até a causa:** em minutos, cronometrado.

**Hipótese:** F1–F3 são diagnosticáveis porque a propagação funciona; F4 e F5 aparecem como "requisição bem-sucedida" no gateway, porque a falha está depois de um salto não propagado; F6 aparece só como latência no cliente, sem causa. A seção 9 traz um caso real do tipo F6.

---

## 7. Eixo 4: fidelidade e custo dos dados

- **Fidelidade:** compare a latência medida pelo cliente (k6, por operação) com a duração do span raiz no gateway e com o tempo no serviço de destino (`raiz_p50_ms` e `destino_p50_ms` do script de cobertura):
  - k6 − raiz = rede k6↔gateway + filas antes do gateway;
  - raiz − destino = trabalho no gateway + rede gateway↔serviço.

  O que o tracing não enxerga aparece nessas diferenças.
- **Custo:** spans por trace e por transação de negócio, número de traces por segundo, e (opcional) bytes recebidos pelo Jaeger (`docker stats` de rede do container do Jaeger) por configuração.

---

## 8. Ameaças à validade

| Ameaça | Efeito | Mitigação |
|---|---|---|
| Os Spring rodam no host Windows, acessados por `host.docker.internal`; os demais serviços estão na rede do Docker | caminho de rede diferente por protocolo (SOAP/REST × gRPC/TCP) | comparar o overhead *relativo* de cada protocolo com ele mesmo; idealmente, voltar os Spring para o compose |
| Toda requisição do k6 entra por HTTP no gateway | a latência do "gRPC" inclui a camada HTTP do gateway | usar o tempo no serviço de destino (spans) para isolar o salto |
| Lógica de negócio diferente por operação (BCrypt, geração de PDF) | domina a latência e mascara o protocolo | comparar operações equivalentes; reportar por operação |
| Gerador de carga, serviços e Jaeger na mesma máquina | competem por CPU | taxa moderada; verificar `dropped_iterations`; registrar o hardware |
| Jaeger em memória | os traces somem ao reiniciar; uso de memória cresce | o Jaeger é recriado a cada configuração; a cobertura é lida logo após cada rodada |
| Amostragem `otel-10` com poucos traces | cobertura com variância alta | usar rodadas mais longas para essa config |
| Versões de pacotes não fixadas (Python OTel, imagens `latest`) | resultados podem mudar entre execuções | registrar as versões (`pip list`, `docker images`) junto dos resultados |
| Mensagens antigas na fila geram traces de consumo repetidos (redelivery a cada 5s) | inflam os órfãos | filas esvaziadas antes de cada configuração |
| Deriva do ambiente ao longo da execução (banco cresce a cada iteração, host aquece, processos em segundo plano) | efeito de ordem confundido com o da instrumentação | ciclos com ordem alternada; coluna `ciclo` para verificar |
| Banco de dados não é zerado entre configurações | tabelas e índices maiores nas últimas rodadas | ordem alternada; opcionalmente recriar o volume `pg_data` antes do experimento |

---

## 9. Achados até aqui

### 9.1 Falhas de configuração que desligavam a telemetria em silêncio

Antes da coleta, foram encontradas e corrigidas quatro falhas. Nenhuma delas gerava erro visível:

1. **api-gateway** e **ATMService**: o exportador OTLP gRPC estava configurado com `url: 'grpc://jaeger:4317'`. O esquema esperado é `http://`, e nenhum span era exportado.
2. **comprovantes-service** (Python): o serviço não estava instrumentado. As bibliotecas estavam no `requirements.txt`, mas o processo era iniciado com `python server.py`.
3. **Jaeger**: o container tinha `OTEL_SERVICE_NAME=comprovantes-service` e publicava os próprios spans de consulta com esse nome. Na interface parecia que o serviço Python estava instrumentado.
4. **ws-service**: o OpenTelemetry era iniciado duas vezes (`NODE_OPTIONS --require .../register` e `import './tracing'`), instrumentando as bibliotecas em dobro.

**Implicação para o trabalho:** a observabilidade pode falhar em silêncio. Um painel com "todos os serviços aparecendo" não garante que estão instrumentados corretamente, e por isso a cobertura precisa ser medida, não presumida.

### 9.2 Matriz de cobertura (rodada exploratória, 2026-11-06 01:08–01:16 UTC, 16 iterações)

| Protocolo | Cobertura | Observação |
|---|---:|---|
| SOAP | 100% (fluxos síncronos) | o `traceparent` HTTP atravessa o SOAP sem tocar no envelope |
| REST | 100% (fluxos síncronos) | idem |
| gRPC | 100% | propagado pela metadata depois que o serviço Python foi instrumentado |
| AMQP | **0%** | o consumo no ws-service vira trace órfão (`notificacoes.transferencias process`); falta verificar se a quebra está no produtor (Spring não injeta o header) ou no consumidor (amqplib não extrai) |
| TCP | **0%** | o trace termina no gateway; o `atm-monitor` não gera spans (servidor TCP cru não é instrumentado) |
| WebSocket | não rastreado | o handshake (upgrade HTTP) não gera span no ws-service; os frames não carregam contexto |

Volume: cerca de 18 a 26 spans por trace no gateway, inclusive em operações triviais de ~4 ms (ATM), porque a auto-instrumentação do NestJS gera spans de middleware e handler.

A matriz foi confirmada no experimento completo (seção 9.4), com resultado idêntico em todas as repetições. Os 92,3% (SOAP) e 75% (REST) agregados por protocolo não são falhas parciais desses protocolos: todos os fluxos síncronos têm 100%, e só a TED e o PIX caem para 0%, porque esperam o `ws-service` depois de um salto AMQP.

### 9.3 Caso real de falha invisível ao tracing (tipo F6)

Em rodadas do k6, algumas requisições ficavam paradas exatamente cerca de 63 s, o tempo das retransmissões de SYN do TCP (1+2+4+8+16+32 s). A causa foi encontrada pelos contadores do kernel (`TCPSynRetrans` em `/proc/net/netstat`) e pelo `netstat` no Windows (414 conexões em TIME_WAIT na porta do SOAP), não pelo Jaeger:

- o strong-soap envia `Connection: close` e o gateway baixava o WSDL a cada chamada, abrindo duas conexões novas por operação;
- portas de origem reutilizadas colidiam com conexões em TIME_WAIT, e o SYN era descartado.

A correção foi reutilizar o client SOAP e usar keep-alive. No trace, a requisição aparecia apenas como um span longo no gateway, sem nenhum filho: o tracing mostra *onde* o tempo foi gasto, mas não *por quê*, quando o problema está na camada de transporte.

### 9.4 Experimento completo de overhead e cobertura (2026-11-07)

**Execução:** `sem-otel`, `otel-10` e `otel-100`; 2 ciclos com ordem alternada × 3 repetições = **6 repetições por configuração**; 60 s por rodada, 2 iterações/s, aquecimento de 20 s. Resultados em `resultados-experimento/completo/`.

**Validade da execução:** as 36 repetições terminaram com k6 `exit=0`, 100% dos checks, 0% de erros HTTP e `dropped_iterations` = 0. A vazão foi idêntica nas três configurações (~42,3 req/s), então a carga oferecida foi a mesma. No controle, o Jaeger ficou vazio em `sem-otel` nos dois ciclos. Com n = 6 por grupo, o menor p possível é 0,002.

#### Latência (mediana entre repetições; Δ em relação a `sem-otel`)

| Protocolo | base p50 | Δ p50 otel-10 | Δ p50 otel-100 | base p99 | Δ p99 otel-10 | Δ p99 otel-100 |
|---|---:|---:|---:|---:|---:|---:|
| SOAP | 135,4 ms | +0,8 ms (+0,6%) n.s. | +0,5 ms (+0,4%) n.s. | 212,7 ms | n.s. | n.s. |
| REST | 12,4 ms | +0,7 ms (+5,2%) n.s. | +0,6 ms (+5,1%) n.s. | 32,2 ms | n.s. | n.s. |
| gRPC | 5,22 ms | +0,41 ms (+7,8%) p=0,002 | +0,48 ms (+9,1%) p=0,002 | 7,96 ms | +1,3 ms (+17%) p=0,009 | +5,4 ms (+68%) p=0,002 |
| TCP | 2,11 ms | +0,28 ms (+13%) p=0,002 | +0,31 ms (+15%) p=0,002 | 4,67 ms | +1,7 ms (+36%) p=0,004 | +5,7 ms (+122%) p=0,002 |
| WebSocket (handshake) | 0,63 ms | n.s. | n.s. | 1,09 ms | n.s. | n.s. |
| AMQP notificação PIX | 105 ms | +1 ms (+1%) n.s. | +1 ms (+1%) n.s. | 128 ms | n.s. | n.s. |
| AMQP notificação TED | 81,5 ms | +1 ms (+1,2%) n.s. | +1,5 ms (+1,8%) n.s. | 97,7 ms | n.s. | n.s. |

n.s. = p > 0,05. No TCP p99, os grupos não se sobrepõem: a maior p99 de `sem-otel` foi 5,6 ms e a menor de `otel-100`, 8,1 ms.

#### Recursos (só os efeitos com p ≤ 0,05)

| Serviço | Métrica | sem-otel | otel-10 | otel-100 |
|---|---|---:|---:|---:|
| api-gateway | CPU (núcleos) | 0,13 | 0,16 (+21%) | 0,17 (+33%) |
| comprovantes (Python) | CPU / memória | 0,01 / 34 MB | +15% / +21% | +19% / +28% |
| atm-monitor | CPU | < 0,01 | +77% | +81% (valor absoluto desprezível) |
| ws-service | memória | 130 MB | +10% | +10% |
| banco-soap | memória | 444 MB | n.s. | +6,6% |
| Jaeger | memória | 27 MB | 74 MB (+171%) | 265 MB (+877%) |

A CPU dos serviços Java não mudou de forma mensurável: o BCrypt consome ~2,5 núcleos no `banco-soap` e domina qualquer custo da instrumentação.

#### Cobertura

Idêntica à da seção 9.2 e estável entre repetições: SOAP, REST e gRPC com 100% nos fluxos síncronos; AMQP e TCP com 0%; exatamente um trace órfão por mensagem AMQP (241 por rodada em `otel-100`). Em `otel-10`, o número de traces cai para ~1/10 e a cobertura se mantém (92% / 74%), ou seja, a decisão de amostragem tomada no gateway é respeitada a jusante.

#### Conclusões

1. **O custo absoluto da instrumentação é parecido entre os protocolos (menos de 1 ms na mediana), mas o peso relativo dele depende da latência base.** Ele só é estatisticamente detectável nos protocolos rápidos (gRPC, TCP). Em SOAP, REST e AMQP, fica abaixo da variação natural de operações de 12 a 135 ms.
2. **O custo está na cauda.** Na mediana, o overhead quase não muda entre 10% e 100% de amostragem; na p99, a amostragem reduz o overhead em 3 a 4 vezes. Uma explicação plausível, que estes dados não demonstram: os hooks da auto-instrumentação e a propagação de contexto rodam em toda requisição, amostrada ou não, e só a gravação e a exportação dos spans (batch, GC) dependem da amostragem e geram picos esporádicos.
3. **Protocolos sem propagação pagam o custo sem receber observabilidade.** O TCP tem o maior overhead relativo e 0% de cobertura: o custo vem dos spans do gateway, não do salto rastreado.
4. **O custo de recursos se concentra no gateway (CPU) e no backend de traces (memória).** O backend é o custo que mais cresce com o volume, e é o principal argumento a favor da amostragem.
5. **As rodadas de validação superestimaram o overhead.** Nelas o p50 subia de 1 a 3 ms, contra 0,3 a 0,6 ms aqui. A diferença provavelmente vem do Node em modo produção e dos logs do Spring em WARN, o que confirma que esses cuidados eram necessários.

#### Limitações observadas nesta execução

- **Aquecimento curto para o REST:** em todas as configurações, o p50 do REST cai a cada repetição de um mesmo bloco (ex.: 14,4 → 13,0 → 12,5 ms), sinal de que 20 s de aquecimento não bastam para a JVM do `rest-api`. Isso afeta igualmente as três configurações e não enviesa a comparação, mas aumenta a variância e pode esconder um efeito pequeno no REST. Numa próxima execução, use `AQUECIMENTO=60s`.
- **Deriva entre ciclos:** pequena (~0,2 ms no gRPC do `sem-otel` do ciclo 2). Ela deixa a linha de base mais lenta, ou seja, joga contra a hipótese de overhead e não explica o efeito encontrado.
- **Tudo na mesma máquina:** os valores absolutos valem para este hardware; o que se generaliza é a comparação relativa entre os protocolos e entre as taxas de amostragem.

### 9.5 Propagação manual de contexto no AMQP: antes e depois (2026-11-09)

**Diagnóstico.** A quebra estava no **produtor**, não no consumidor. A auto-instrumentação do `amqplib` no `ws-service` já criava o span de consumo (`notificacoes.transferencias process`) e tentava extrair o contexto dos headers da mensagem, mas os dois produtores Spring publicavam pelo `RabbitTemplate` sem injetar `traceparent`. Resultado: um trace órfão por mensagem.

**Correção.** Cada produtor usa uma stack de tracing diferente, e cada uma pediu uma solução de natureza diferente:

| Produtor | Stack de tracing | Solução | Esforço |
|---|---|---|---|
| `rest-api` (Kotlin) | Micrometer Tracing + bridge OTel | Ativar a observação do Spring AMQP: `spring.rabbitmq.template.observation-enabled=true`. O `RabbitTemplate` passa a criar um span PRODUCER e a injetar o `traceparent`. | **1 linha de configuração**, nenhum código |
| `banco-soap` (Java) | `opentelemetry-spring-boot-starter` 2.30 | O starter não instrumenta o `RabbitTemplate`. Código manual em `NotificationService`: criar um span PRODUCER com atributos `messaging.*` e injetar o contexto nos headers AMQP com o `TextMapPropagator`, por meio de um `MessagePostProcessor`. | **~31 linhas de código** (6 imports), acoplamento à API do OpenTelemetry no serviço de negócio |
| `ws-service` (Node, consumidor) | auto-instrumentação Node | Nenhuma: a extração já era automática | 0 |

**Resultado** (carga k6 de 30 s, 2 iterações/s, OTel 100%; checks 100%, 0% de erros HTTP):

| Métrica | Antes (seção 9.4) | Depois |
|---|---:|---:|
| Cobertura AMQP (TED e PIX até o `ws-service`) | 0% | **100%** |
| Cobertura agregada do fluxo SOAP / REST | 92,3% / 75,0% | **100% / 100%** |
| Traces órfãos por rodada | 1 por mensagem | **0** |
| Spans por trace: TED / PIX | 26 / 18 | 28 / 20 (+ PRODUCER, + CONSUMER ligado) |

A árvore de spans ficou contínua, com o consumo como filho direto da publicação:

```
TED: api-gateway SERVER → banco-soap SERVER → banco-soap PRODUCER (manual)    → ws-service CONSUMER
PIX: api-gateway SERVER → rest-api SERVER  → rest-api PRODUCER (Micrometer)  → ws-service CONSUMER
```

**Achados para o artigo:**

1. **A limitação era da instrumentação, não do protocolo.** O AMQP tem onde carregar o contexto (headers da mensagem); faltava alguém escrevê-lo. Depois da correção, o AMQP ficou tão rastreável quanto HTTP e gRPC.
2. **O esforço depende da stack, não do protocolo.** O mesmo salto AMQP custou 1 linha de configuração em um serviço e ~31 linhas de código no outro, só porque os dois usam bibliotecas de tracing diferentes. Em um sistema poliglota, a heterogeneidade das ferramentas pesa tanto quanto a dos protocolos.
3. **A quebra era silenciosa e assimétrica.** O consumidor estava instrumentado e gerava spans, o que dava a impressão de que o AMQP estava rastreado. Só a medição de cobertura (órfãos) mostrou a ruptura, o mesmo padrão das falhas da seção 9.1.
4. **Basta um lado ser omisso para quebrar.** A propagação exige injeção no produtor **e** extração no consumidor. A auto-instrumentação de um lado não compensa a ausência do outro.

**Pendente:** medir o overhead da propagação com o experimento completo (`CONFIGS="sem-otel otel-100"`), comparando com a seção 9.4, em especial a métrica `AMQP notificacao PIX/TED`.

### 9.6 Propagação manual de contexto no TCP: antes e depois (2026-11-09)

**Diagnóstico.** O fluxo dos ATMs tem dois saltos TCP: gateway → `atm-monitor` (porta 6002, uma conexão por comando, com resposta) e `atm-monitor` → `atm-cluster` (porta 6001, conexão persistente, comandos de mão única). Diferente do AMQP, aqui faltava tudo:

- **não havia portador:** o protocolo é texto puro (`GET_ALL`, `BLOCK:id`, `ABASTECER:id:valor`), sem cabeçalhos nem metadados;
- **não havia spans no destino:** a auto-instrumentação do módulo `net` só cria spans de *conexão de saída* (`tcp.connect`). Um servidor TCP cru não gera span nenhum, e por isso o `atm-monitor` nunca apareceu no Jaeger, mesmo com o SDK iniciado.

**Correção.** Foi preciso **estender o protocolo da aplicação**: o contexto viaja numa linha de metadados antes do comando, codificada como query string (análogo a um cabeçalho HTTP):

```
traceparent=00-<trace-id>-<span-id>-01
ABASTECER:ATM-CENTRO-01:500
```

Sem OpenTelemetry, o carrier sai vazio e o comando é enviado exatamente como antes. O receptor aceita os dois formatos, o que mantém a compatibilidade e deixa a linha de base do experimento inalterada.

| Ponto | O que foi feito | Linhas efetivas |
|---|---|---:|
| `api-gateway` (`atm.service.ts`) | span CLIENT manual + injeção do contexto no quadro | 28 |
| `ATMService/contexto-tcp.ts` (novo) | enquadramento: `anexarContexto` / `extrairContexto` com o propagador W3C | 13 |
| `atm-monitor` (`monitor-server.ts`) | extração + span SERVER por comando + span PRODUCER ao repassar ao ATM | 26 |
| `atm-cluster` (`atm-cluster.ts`) | extração + span CONSUMER ao receber o comando | 11 |
| **Total** | 3 serviços, 4 arquivos, mudança no formato do protocolo | **~78** |

**Resultado** (carga k6 de 30 s, 2 iterações/s, OTel 100%; checks 100%, 0% de erros HTTP):

| Fluxo | Antes | Depois | Spans/trace (antes → depois) |
|---|---:|---:|---:|
| `GET /atms` | 0% | **100%** | 18 → 20 |
| `POST /atms/refill` | 0% | **100%** | 18 → 22 |
| `POST /atms/block` | 0% | **100%** | 18 → 20 |

Árvore do abastecimento, contínua pelos dois saltos:

```
api-gateway SERVER → api-gateway CLIENT (tcp ABASTECER) → atm-monitor SERVER → atm-monitor PRODUCER → atm-cluster CONSUMER
```

Com as seções 9.5 e 9.6, **todos os protocolos rastreados do sistema chegaram a 100% de cobertura e zero órfãos.**

#### Comparação do esforço: AMQP × TCP

| | AMQP (9.5) | TCP (9.6) |
|---|---|---|
| Portador de contexto | já existe (headers da mensagem) | **não existe**; foi preciso criá-lo no payload |
| Spans no destino | automáticos (auto-instrumentação do `amqplib`) | **manuais** (servidor TCP cru não é instrumentado) |
| Lado receptor | nenhuma mudança | extração manual em 2 serviços |
| Esforço | 1 linha de configuração (Micrometer) a ~31 linhas (starter OTel), só no produtor | ~78 linhas em 3 serviços + um novo módulo |
| Mudança de contrato | nenhuma | **o formato do protocolo mudou**: os dois lados precisam conhecer o enquadramento |

**Achados para o artigo:**

1. **Escala de esforço por protocolo.** HTTP/SOAP/gRPC: zero (automático). AMQP: o portador existe, falta só usá-lo (configuração ou poucas linhas). TCP: falta o portador e a instrumentação, então é preciso desenhar um enquadramento e instrumentar os dois lados. O esforço cresce com o quanto o protocolo se afasta de um modelo com cabeçalhos.
2. **Em TCP cru, a observabilidade vira parte do contrato da aplicação.** Não dá para "ligar" o tracing sem mudar o formato das mensagens. Cliente e servidor precisam evoluir juntos, e qualquer outro cliente do protocolo (por exemplo, um ATM legado) teria de ser compatível com a linha de metadados. É um acoplamento que não existe nos protocolos com cabeçalhos.
3. **A ausência de spans engana.** O `atm-monitor` tinha o SDK do OpenTelemetry inicializado ("OpenTelemetry inicializado" no log) e mesmo assim não exportava nada. Ter o SDK carregado não garante instrumentação: depende de existir instrumentação para a biblioteca de transporte usada.
4. **Limitação do enquadramento:** o protocolo não tinha delimitação de mensagens, e a linha de metadados herda isso. Se dois comandos chegarem no mesmo pacote TCP na conexão persistente, o parse falha, como já falharia antes. Em produção, o protocolo precisaria de um delimitador ou de um prefixo de tamanho.

**Pendente:** medir o overhead da propagação TCP no experimento completo, junto com o do AMQP.

---

## 10. Reprodução

Pré-requisitos: Docker Desktop, Java 21, Node 18+, Git Bash.

```bash
# 1. compilar os servicos Spring
cd BancoCoreSOAP && ./mvnw -q -DskipTests package && ./mvnw -q -DskipTests -f ../BancoRestApi/pom.xml package && cd ..

# 2. subir a infraestrutura e os servicos
docker compose up -d db rabbitmq jaeger ws-service atm-monitor atm-cluster comprovantes-service gateway
java -jar BancoCoreSOAP/target/demo-0.0.1-SNAPSHOT.jar &      # porta 8080
java -jar BancoRestApi/target/BancoRestApi-1.0-SNAPSHOT.jar & # porta 8081

# 3. teste funcional (todos os checks devem passar)
docker compose run --rm k6

# 4. cobertura de uma janela
node observabilidade/cobertura-traces.js --inicio <ISO> --fim <ISO>

# 5. experimento de overhead completo
bash observabilidade/experimento-overhead.sh
```

Interface do Jaeger: http://localhost:16686. Escolha o serviço `api-gateway`, a operação e a janela de tempo da rodada, e use "Compare" para comparar traces de configurações diferentes.

## 11. Arquivos

| Caminho | Papel |
|---|---|
| `script.js` | carga k6 com tags `protocolo`/`operacao` e modos `vus`/`taxa` |
| `observabilidade/cobertura-traces.js` | eixo 1: cobertura e órfãos a partir do Jaeger |
| `observabilidade/experimento-overhead.sh` | eixo 2: execução do A/B |
| `observabilidade/agregar-experimento.js` | eixo 2: CSVs, overhead e Mann-Whitney |
| `observabilidade/docker-compose.experimento.yaml` | serviços Node em modo produção durante o experimento |
| `docker-compose.yaml` | variáveis `OTEL_SDK_DISABLED`, `OTEL_TRACES_SAMPLER(_ARG)` e `OTEL_PY_WRAPPER` |
