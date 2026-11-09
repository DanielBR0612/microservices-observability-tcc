# Descobertas do projeto: diário para o artigo (TCC)

Este arquivo reúne **o que foi descoberto ao longo do trabalho**, inclusive o que não está no código nem nos CSVs: por que algo quebrou, o que surpreendeu e o que cada resultado permite afirmar no artigo. O detalhe metodológico e as tabelas completas estão em [`METODOLOGIA.md`](METODOLOGIA.md); aqui fica a síntese, organizada pelos objetivos do artigo.

Artigo: *Estudo Comparativo de Desempenho e Observabilidade em Microsserviços: REST, gRPC e Mensageria* (IFRN, TADS).

---

## 1. Tese central (uma frase)

> **O protocolo muda pouco quanto a observabilidade custa, mas muda muito se ela funciona e quanto esforço exige para funcionar.**

- **Custo:** a instrumentação acrescenta menos de 1,5 ms na mediana em todos os protocolos. Esse custo só é mensurável nos protocolos rápidos (gRPC, TCP) e se concentra na cauda (p99).
- **Funcionamento:** com auto-instrumentação, REST, SOAP e gRPC têm 100% de cobertura; AMQP e TCP têm 0%.
- **Esforço:** para levar AMQP e TCP a 100%, o esforço vai de 1 linha de configuração a ~78 linhas em 3 serviços com mudança no formato do protocolo.

---

## 2. Descobertas por objetivo específico do artigo

### OE1: propagação de contexto e pontos de ruptura

| Protocolo | Portador do contexto | Cobertura (auto) | Cobertura (após propagação manual) |
|---|---|---:|---:|
| REST | header HTTP `traceparent` | 100% | — |
| SOAP | o mesmo header HTTP (o envelope SOAP não é usado) | 100% | — |
| gRPC | metadata da chamada | 100% | — |
| AMQP | headers da mensagem, **mas o produtor não escrevia** | 0% | **100%** |
| TCP cru | **nenhum**; foi criado no payload | 0% | **100%** |
| WebSocket | só o handshake; frames não têm cabeçalho | não rastreado | não tratado |

- **D1. A ruptura no AMQP estava no produtor, não no consumidor.** O `ws-service` (amqplib) já era auto-instrumentado e criava o span de consumo, mas os produtores Spring (`RabbitTemplate`) publicavam sem `traceparent`. Cada mensagem virava **um trace órfão** (241 por rodada de 60 s). *Afirmação para o artigo:* a propagação exige injeção **e** extração; a auto-instrumentação de um lado não compensa a omissão do outro.
- **D2. Os 92,3% (SOAP) e 75% (REST) da primeira medição não eram falhas desses protocolos.** Todo fluxo síncrono tinha 100%; só a TED e o PIX caíam para 0%, porque dependem do salto AMQP até o `ws-service`. Cuidado ao reportar cobertura agregada por protocolo: ela mistura saltos diferentes.
- **D3. A cobertura é determinística.** Foi idêntica em todas as repetições, em todas as execuções e com 10% de amostragem (a decisão tomada no gateway é respeitada a jusante). Não precisa de estatística; é um resultado estrutural.
- **D4. Com 10% de amostragem, os órfãos do AMQP também caíam para ~10%**, porque cada consumo órfão virava uma raiz nova e era amostrado de forma independente. Um detalhe que mostra como a amostragem interage com a propagação quebrada.

### OE2: complexidade da instrumentação (automática × manual)

**Escala de esforço observada:**

| Nível | Protocolos | O que foi preciso |
|---|---|---|
| 0, automático | REST, SOAP, gRPC | nada além do SDK/agente |
| 1, configuração | AMQP no `rest-api` (Kotlin, Micrometer) | `spring.rabbitmq.template.observation-enabled=true` (**1 linha**) |
| 2, código no produtor | AMQP no `banco-soap` (Java, starter OTel 2.30) | span PRODUCER + injeção via `MessagePostProcessor` (**~31 linhas**, 6 imports) |
| 3, mudar o protocolo | TCP (gateway, `atm-monitor`, `atm-cluster`) | enquadramento novo + spans manuais nos dois lados (**~78 linhas**, 3 serviços, 4 arquivos) |

- **D5. O esforço depende da biblioteca de tracing, não só do protocolo.** O mesmo salto AMQP custou 1 linha num serviço e ~31 no outro, só porque um usa Micrometer Tracing e o outro o starter do OpenTelemetry. Em sistemas poliglotas, a heterogeneidade das **ferramentas** pesa tanto quanto a dos **protocolos**.
- **D6. Em TCP cru, a observabilidade vira parte do contrato da aplicação.** Não existe onde pôr o contexto: foi preciso inventar uma linha de metadados (`traceparent=...\n<comando>`). Cliente e servidor precisam evoluir juntos, e um cliente legado do protocolo teria de ser compatível. Esse acoplamento não existe nos protocolos com cabeçalhos.
- **D7. Ter o SDK iniciado não significa estar instrumentado.** O `atm-monitor` logava "OpenTelemetry inicializado" e nunca exportou um span: a auto-instrumentação do `net` só cobre conexões de **saída**, e um servidor TCP cru não gera spans.
- **D8. A configuração falha em silêncio.** Antes de qualquer medição, 4 defeitos desligavam ou distorciam a telemetria sem nenhum erro visível:
  1. exportador OTLP com `grpc://` em vez de `http://` (gateway e ATMService): nenhum span exportado;
  2. serviço Python com as bibliotecas instaladas, mas iniciado sem `opentelemetry-instrument`;
  3. container do Jaeger com `OTEL_SERVICE_NAME=comprovantes-service`, publicando os próprios spans com esse nome. **Parecia** que o serviço Python estava instrumentado;
  4. `ws-service` iniciando o SDK duas vezes (instrumentação duplicada).

  *Afirmação para o artigo:* um painel com "todos os serviços aparecendo" não prova instrumentação correta. A cobertura precisa ser **medida** (traces completos e órfãos), não presumida.
- **D9. Propagadores: o projeto só usa W3C Trace Context.** O artigo cita B3; ou se testa a incompatibilidade (teste T4, pendente), ou se remove a menção.

### OE3: segurança na camada de telemetria

Teste T2 feito em 2026-11-09 (METODOLOGIA 9.7; evidências em `resultados-experimento/seguranca/`).

- **D14. A URL é o canal de vazamento.** Em 25.526 spans, o número da conta aparece em 488 (`url.full`, `url.path`, `url.query`, `http.url`), porque a API o coloca na rota (`/clientes/{numeroConta}/chaves-pix`) e na query (`/extrato?conta=`). Corpo e cabeçalhos não são capturados por padrão, então **senha, JWT do `Authorization`, CPF, valores e chave Pix não vazaram**. *Afirmação para o artigo:* o risco depende mais do desenho da API (o que vai na URL) do que da ferramenta de tracing.
- **D15. O JWT do WebSocket escapou por acaso.** O token vai na URL do handshake (`/ws?token=...`), mas o handshake não gera span no `ws-service`. A falta de instrumentação (uma limitação no OE1) evitou um vazamento no OE3: se o WebSocket fosse rastreado, o token iria para `url.query` como a conta foi. Instrumentar mais aumenta a superfície de exposição.
- **D16. O SQL vem sanitizado, mas expõe o esquema.** O `db.statement` usa `?` no lugar dos valores, porém revela tabelas e colunas (`clientes.cpf`, `usuario.password_hash`). As credenciais de banco e broker não aparecem (`postgresql://localhost:5433`, `amqp://rabbitmq:5672`).
- **D17. Metadados de infraestrutura e dados pessoais indiretos:** IP do cliente (`client.address`) e user agent em todos os spans de servidor HTTP; `host.name`, SO, caminhos e a linha de comando completa do processo (`process.command_line`) nos recursos Java. Hoje não há segredos na linha de comando, mas qualquer `--senha=...` passado por argumento iria para a telemetria.
- **D18. O `traceparent` externo é uma fronteira de confiança aberta.** Com o amostrador `parentbased`, **quem chama decide**:
  1. o cliente escolhe o trace id de requisições internas (adotado com um pai inexistente, e chega até o `atm-monitor`);
  2. o cliente **apaga do rastreamento** as próprias ações: 5 logins com senha errada e flag `00` geraram **0 traces**, com o sistema em 100% de amostragem;
  3. o cliente **força a gravação**: com o gateway em 0% de amostragem, 20 de 20 requisições com flag `01` forjada foram gravadas (contra 0 de 20 sem o cabeçalho). Isso permite inflar o custo do backend de traces (memória do Jaeger ~10× entre 10% e 100%).

  *Afirmação para o artigo:* o mesmo mecanismo que garante traces completos *dentro* do sistema (respeitar a decisão do pai) vira um vetor de controle na *borda*. Na borda, o contexto externo deve ser descartado ou virar *span link*.
- **Não testado:** propagação de `baggage` do cliente para os serviços internos (o propagador está ativo por padrão no gateway).

### OE4: diretrizes (rascunho, a partir das descobertas)

1. **Meça a cobertura, não confie no painel** (D7, D8): traces completos por fluxo e contagem de órfãos.
2. **Em mensageria, verifique os dois lados**: o produtor injeta, o consumidor extrai (D1).
3. **Padronize a biblioteca de tracing e o propagador** em sistemas poliglotas (D5, D9).
4. **Prefira protocolos com cabeçalhos**. Ao usar TCP cru, desenhe o enquadramento com espaço para metadados desde o início (D6).
5. **Use amostragem**: ela reduz o custo de cauda, de CPU e de armazenamento sem afetar a cobertura (seção 3).
6. **O tracing mostra onde, não por quê**, em falhas de transporte (D12): combine-o com métricas de rede.
7. **Não coloque dados sensíveis na URL** ou mascare `url.*` no coletor: a URL vai inteira para a telemetria (D14, D15).
8. **Trate o contexto de trace externo como entrada não confiável**: no gateway, descarte `traceparent`/`baggage` de clientes ou use *span link*; amostre na borda com um amostrador que ignore a flag remota (D18).
9. **Antes de instrumentar algo novo, audite o que ele vai exportar**: mais cobertura significa mais superfície de exposição (D15).
10. **Monitore spans ausentes, não só spans com erro**: em fluxos assíncronos, a falha aparece como um salto que deveria existir e não existe (D19).
11. **Instrumente a semântica de negócio**: resultados como "offline", "recusado" ou "sem saldo" dentro de respostas 200 precisam virar atributos ou status de erro, porque o protocolo não os conhece (D20).
12. **Limite as reentregas e use dead-letter**: retry infinito polui traces antigos e infla o armazenamento (D23).

---

## 3. Custo da instrumentação (experimento completo, 2026-11-07)

Desenho: `sem-otel` × `otel-10` × `otel-100`; 2 ciclos com ordem alternada × 3 repetições = **6 repetições por configuração**; 60 s por rodada; carga de taxa constante de 2 iterações/s (~42 req/s); Mann-Whitney exato. Dados em `resultados-experimento/completo/` e gráficos em `.../completo/graficos/`.

| Protocolo | Δ p50 (otel-100) | Δ p99 (otel-100) | Significativo? |
|---|---|---|---|
| SOAP (base 135 ms) | +0,5 ms (+0,4%) | ≈ 0 | não |
| REST (base 12 ms) | +0,6 ms (+5%) | ≈ 0 | não |
| AMQP (notificação) | +1 a 1,5 ms (~1%) | ≈ 0 | não |
| gRPC (base 5,2 ms) | +0,48 ms (+9%) | +5,4 ms (+68%) | **sim** (p = 0,002) |
| TCP (base 2,1 ms) | +0,31 ms (+15%) | +5,7 ms (+122%) | **sim** (p = 0,002) |

- **D10. O custo absoluto é parecido; o relativo depende da latência base.** O mesmo meio milissegundo some numa operação SOAP de 135 ms e pesa 15% numa chamada TCP de 2 ms.
- **D11. O custo está na cauda.** Na mediana, 10% e 100% de amostragem custam quase o mesmo; na p99, a amostragem reduz o overhead em 3 a 4 vezes. *Hipótese (não demonstrada):* os hooks e a propagação de contexto rodam em toda requisição, e só a gravação e a exportação dos spans dependem da amostragem e geram picos.
- **Antes da propagação manual, o TCP pagava o maior overhead relativo com 0% de cobertura**: custo sem benefício.
- **Recursos:** CPU do gateway +33% (100%) / +21% (10%); memória do Jaeger 27 → 265 MB (100%) / 74 MB (10%), com alta variância (memória não limitada). A CPU dos serviços Java não mudou de forma mensurável (o BCrypt domina, com ~2,5 núcleos).
- **A validação inicial superestimou o overhead** (1 a 3 ms contra 0,3 a 0,6 ms), provavelmente pelo Node em modo dev e pelos logs DEBUG do Spring. Lição de método: o ambiente de medição precisa ser o de produção.

**Como escrever:** "n.s." significa *não detectado*, não *inexistente*. Diga "abaixo da sensibilidade do experimento", nunca "overhead zero".

---

## 4. Diagnóstico e limites do tracing

- **D12. Falha de transporte invisível ao tracing.** Requisições paravam ~63 s, o tempo das retransmissões de SYN do TCP (1+2+4+8+16+32 s). A causa (cliente SOAP abrindo conexões novas a cada chamada, `Connection: close`, colisão com sockets em TIME_WAIT) foi achada nos contadores do kernel e no `netstat`, **não no Jaeger**. No trace aparecia só um span longo no gateway, sem filhos. Bom exemplo para o eixo 3 (diagnóstico).
- **D13. Fidelidade:** no gRPC, o span raiz do gateway mede ~6,6 ms e o serviço Python ~2,2 ms; dois terços da latência estão no gateway. O tracing permite separar o custo do protocolo do custo das camadas intermediárias.

### Injeção de falhas (T3, 2026-11-09; METODOLOGIA 9.8, `resultados-experimento/falhas/`)

Rubrica (detecção / localização / causa, 0–2): **F1 SOAP 2/2/1 · F2 REST 2/2/2 · F3 gRPC 2/2/2 · F4 AMQP 1/1/0 · F5 TCP 1/2/1**. Sem a propagação manual, F4 e F5 seriam **0/0/0**.

- **D19. A falha assíncrona não tem erro para mostrar.** Com o consumidor isolado do broker (F4), TED e PIX responderam 200 com latência normal; o produtor publicou e o broker aceitou. O único sinal é o *buraco* no trace (o `ws-service` some depois do PRODUCER). Nem o RabbitMQ detectou (1 consumidor, 100 mensagens sem ack). *Afirmação para o artigo:* em fluxos assíncronos, a propagação transforma uma falha invisível numa falha detectável por ausência. A detecção exige conhecer a topologia esperada, e as ferramentas não alertam sobre spans que deveriam existir.
- **D20. Falha de negócio não é erro de protocolo.** Com os ATMs desligados (F5), o monitor responde 200 com "ATM Offline", e a auto-instrumentação registra sucesso. Só o atributo manual `atm.resultado=offline` (criado na propagação TCP) denuncia o problema. A semântica de erro precisa ser instrumentada; ela não vem do protocolo.
- **D21. O trace localiza; a causa depende do que a biblioteca exporta.** F1: o span de SQL apontou exatamente o INSERT lento (1,6 → 252 ms), mas não o motivo (trigger). F2: a exceção do Spring trouxe a causa inteira, inclusive o nome da função do trigger, mesmo sem spans de banco no `rest-api`. F3: o código gRPC 14 (UNAVAILABLE) e os spans de rede (`ECONNREFUSED`, `ENOTFOUND`) explicaram a indisponibilidade.
- **D22. O cliente pode não perceber o que o trace mostra.** Na F1, 100% dos checks do k6 passaram: a TED ficou 6,5× mais lenta, e só a latência denunciava. O inverso também ocorre: na F4/F5, o cliente percebe (notificação não chega, ATM offline) e o trace parece normal.
- **D23. A reentrega infinita gera traces que nunca terminam.** Mensagens para destinatários offline voltam à fila a cada 5 s (`nack` + `requeue`), e cada tentativa acrescenta um span CONSUMER com erro **ao trace original**: uma janela com 60 TEDs mostrou 110 traces de TED. É ruído de diagnóstico e de custo de armazenamento criado pela política de retry, não pela instrumentação.

---

## 5. Lições de método (ameaças descobertas na prática)

| Problema encontrado | Efeito | Como foi resolvido |
|---|---|---|
| `SAIDA` relativo no script | o `docker -v` tratou o caminho como nome de volume, o k6 não subiu e todas as rodadas deram exit=1 em ~20 s | o script converte para caminho absoluto |
| Execução interrompida que continuou em segundo plano | carga em dobro numa configuração: a linha de base consumia **mais** CPU que a instrumentada | trava `.em-execucao` |
| `nest --watch` travado depois de ~34 h | o gateway não respondia e 95% das requisições falhavam | `docker compose restart gateway` antes de medir |
| `atm-cluster` sem reconectar após reinício do monitor | o check "ATM abastecer enviado" falhou | reiniciar o `atm-cluster` |
| Aquecimento de 20 s | a latência do REST cai a cada repetição (JVM não aquecida) | usar `AQUECIMENTO=60s` na próxima |
| Logs DEBUG/TRACE do Spring | custavam mais que a instrumentação | logs em WARN durante o experimento |
| Deriva ambiental entre ciclos | o ciclo 2 foi mais lento em tudo | ordem alternada (ABC/CBA) e coluna `ciclo` |
| Git Bash converte `/scripts` em `C:/Program Files/Git/scripts` | o k6 não achava o script | `MSYS_NO_PATHCONV=1` no `docker compose run` |
| `docker compose run k6` religa as dependências do k6 | desfez a falha F3 (container parado) 0,6 s depois do início da janela, e o resultado parecia "falha invisível" | `--no-deps` no `rodada-falha.sh` |
| Parar o `ws-service` derruba também o WebSocket | o k6 deixa de executar TED/PIX e não há o que diagnosticar | F4 refeita como partição consumidor–broker (`iptables`) |
| Kernel do Docker Desktop/WSL2 sem `netem` | F6 (`tc netem`) impossível | usar um proxy de falhas (Toxiproxy) |
| Mensagens sem ack voltam à fila ao reiniciar o consumidor | ciclo de reentrega a cada 5 s, poluindo as janelas seguintes | parar o consumidor, esvaziar a fila e religar |
| `MSYS_NO_PATHCONV=1` quebra o `mvnw` | o Maven não iniciava | não exportar a variável ao compilar |

**Checklist antes de medir:** k6 com `exit=0` e 100% de checks; `dropped_iterations` = 0; Jaeger vazio em `sem-otel`; gateway e ATMs respondendo.

---

## 6. Inconsistências a corrigir no texto do artigo

1. A **tabela de Resultados** descreve serviços que não existem como descrito:
   - `ComprovantesService` é **gRPC em Python**, não um worker AMQP;
   - `ATMService` é **TypeScript com TCP/UDP**, não Java/Python com REST/gRPC;
   - `BancoRestApi` é **Kotlin**;
   - quem publica no RabbitMQ são **os Spring (SOAP e REST)**, não o gateway;
   - `BancoCliente` **não tem OpenTelemetry**;
   - "o RabbitMQ transporta o contexto" só passou a ser verdade depois da correção (D1).
2. Há um `\documentclass` e um `\begin{document}` **dentro** da seção de Resultados, e o LaTeX não compila assim.
3. O título cita "REST, gRPC e Mensageria", mas o estudo cobre também SOAP, WebSocket e TCP/UDP.
4. O resumo diz "análise qualitativa", mas há resultados quantitativos com teste estatístico.
5. B3 é citado e não é usado (D9).
6. Os placeholders de Trabalhos Relacionados e de Materiais e Métodos ainda vêm do modelo (clínica médica, COVID).

---

## 7. Testes: feitos e pendentes

| # | Teste | Objetivo | Estado | Evidência |
|---|---|---|---|---|
| — | Matriz de cobertura por protocolo | OE1 | feito | seções 9.2 e 9.4 |
| — | Overhead sem-otel × otel-10 × otel-100 | custo | feito | `resultados-experimento/completo/`, seção 9.4 |
| T1a | Propagação manual AMQP (antes/depois) | OE1, OE2 | feito: 0% → 100%, órfãos → 0 | commit `e5cfe0c`, seção 9.5 |
| T1b | Propagação manual TCP (antes/depois) | OE1, OE2 | feito: 0% → 100% | commit `8e60fe8`, seção 9.6 |
| T1c | Overhead da propagação AMQP + TCP | custo | **pendente** | `CONFIGS="sem-otel otel-100" SAIDA=resultados-experimento/propagacao` |
| T2a | Auditoria de dados sensíveis nos spans | OE3 | feito: conta na URL vaza; senha/JWT/CPF não | `observabilidade/auditoria-telemetria.js`, `resultados-experimento/seguranca/vazamento/`, seção 9.7 |
| T2b | `traceparent` forjado (adoção, supressão, amplificação) | OE3 | feito: os três confirmados | `resultados-experimento/seguranca/fronteira-confianca.md`, seção 9.7 |
| T2c | Baggage do cliente chegando aos serviços internos | OE3 | pendente | — |
| T2d | Mitigação na borda (descartar contexto externo) e novo teste | OE3, OE4 | pendente, opcional | — |
| T3 | Injeção de falhas F1–F5 | OE1 (eficácia) | feito (avaliação não cega; F6 inviável no WSL2) | `resultados-experimento/falhas/`, seção 9.8 |
| T3b | Avaliação cega da rubrica por outra pessoa, usando as janelas gravadas | OE1 | pendente, recomendado | `resultados-experimento/falhas/*/janela.txt` |
| T3c | F6 com proxy de falhas (Toxiproxy) entre o gateway e um backend | OE1 | pendente, opcional | — |
| T4 | Incompatibilidade de propagadores W3C × B3 | OE2, OE4 | pendente | — |
| T5 | Tabela de esforço de instrumentação por serviço e linguagem | OE2 | parcial (seção 2 deste arquivo) | — |
| — | UDP (heartbeat dos ATMs) | OE1 | não tratado | — |
| — | WebSocket (contexto nos frames) | OE1 | não tratado | — |

---

## 8. Frases prontas para o artigo

- "A observabilidade obtida com rastreamento distribuído depende menos do custo de instrumentar cada protocolo, que foi inferior a 1,5 ms na mediana em todos os casos, do que da existência de um portador de contexto e de instrumentação para ele."
- "A ausência de propagação não gera erros: o consumo assíncrono continua rastreado, porém desconectado da requisição que o originou, o que só é detectável medindo traces órfãos."
- "O mesmo salto AMQP exigiu desde uma linha de configuração até cerca de trinta linhas de código, conforme a biblioteca de rastreamento do serviço produtor, o que indica que, em sistemas poliglotas, a heterogeneidade das ferramentas é um fator tão relevante quanto a dos protocolos."
- "Em protocolos sem cabeçalhos, como TCP cru, tornar a comunicação observável exigiu alterar o formato das mensagens, transformando a observabilidade em parte do contrato entre os serviços."
- "O rastreamento indicou onde o tempo foi gasto, mas não por quê, quando a causa estava na camada de transporte."
- "As auto-instrumentações não capturaram corpos nem cabeçalhos, mas trataram a URL como metadado inofensivo: o número da conta, presente na rota da API, foi exportado em 488 de 25.526 spans."
- "Nas falhas injetadas em protocolos síncronos, o rastreamento permitiu detectar, localizar e, em dois de três casos, explicar a causa; nas falhas após saltos assíncronos ou de protocolo próprio, as requisições apareceram como bem-sucedidas, e a falha só foi perceptível pela ausência de um span esperado, sinal que existe apenas quando o contexto é propagado."
- "Com o amostrador baseado no pai, a decisão de rastrear pertence a quem chama: um cliente externo conseguiu suprimir do rastreamento as próprias tentativas de login, mesmo com amostragem de 100%, e forçar a gravação de todas as suas requisições com amostragem de 0%."
