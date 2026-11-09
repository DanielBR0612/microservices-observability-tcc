# T3: diagnóstico com injeção de falhas (2026-11-09)

**Pergunta (eixo 3):** olhando **só os traces**, dá para detectar uma falha, localizar onde ela está e explicar a causa? E isso depende do protocolo?

**Procedimento:** uma rodada de base sem falha; depois, para cada falha, injeção → rodada de 30 s do k6 (2 iterações/s, OTel 100%, com a propagação AMQP e TCP das seções 9.5 e 9.6) → remoção. O `observabilidade/diagnostico-falhas.js` compara cada janela com a base, por fluxo: taxa de traces com erro, latência do span raiz, span com erro mais profundo (com a mensagem disponível), span cujo tempo próprio mais cresceu e serviços que sumiram do trace. Cada pasta tem `janela.txt`, `k6.txt` e `diagnostico.json`.

## Falhas injetadas

| # | Protocolo | Falha | Injeção | Pasta |
|---|---|---|---|---|
| F1 | SOAP | consulta lenta na TED | trigger `pg_sleep(0,25)` em cada INSERT de TED na tabela `transacao` | `F1-soap-lentidao/` |
| F2 | REST | erro intermitente no PIX | trigger com `RAISE EXCEPTION` em ~10% dos INSERTs de PIX | `F2-rest-erro/` |
| F3 | gRPC | serviço indisponível | `docker stop container_comprovantes` | `F3-grpc-indisponivel/` |
| F4 | AMQP | consumidor isolado do broker | `iptables DROP` da porta 5672 no namespace de rede do `ws-service` | `F4-amqp-consumidor/` |
| F5 | TCP | ATMs desconectados | `docker stop atm-cluster` | `F5-tcp-atm/` |
| F6 | rede | latência e perda | `tc netem`: **não executável**, o kernel do Docker Desktop/WSL2 não tem o módulo `netem` | `F6-rede-nao-injetada/` (vale como 2ª base) |

## O que os traces mostraram

| # | Sintoma no cliente (k6) | Evidência no trace |
|---|---|---|
| F1 | **nenhum check falhou**; só ficou mais lento | raiz da TED: p50 91 → **591 ms**. O span `banco-soap CLIENT INSERT banco_dsd.transacao` foi de 1,6 → **252 ms** de tempo próprio. O SQL aparece; o trigger e o `pg_sleep` não |
| F2 | 23% dos PIX falharam (HTTP 500) | 22,8% dos traces com erro. Span `rest-api SERVER http post /pix/transferir` com `JpaSystemException: could not execute statement [ERROR: falha injetada F2...] [insert into transacao ...]`, incluindo o nome da função do trigger |
| F3 | 100% dos comprovantes falharam | 100% com erro. Span gRPC CLIENT do gateway com `rpc.grpc.status_code=14` (UNAVAILABLE); spans de rede com `ECONNREFUSED 172.18.0.6:50051` e `ENOTFOUND comprovantes-service`; o `comprovantes-service` some do trace |
| F4 | notificações não chegaram (WebSocket) | **0% de erro, latência normal.** TED e PIX respondem 200. Único sinal: o `ws-service` **some** do trace depois do span PRODUCER. O RabbitMQ também não detectou: continuou com `consumidores=1` e 100 mensagens "entregues, sem ack" |
| F5 | "ATM abastecer enviado" falhou (HTTP 200 com `ATM Offline`) | **0% de erro.** O `atm-cluster` some do trace; o span `atm-monitor tcp ABASTECER` tem `atm.resultado=offline` (61 de 61), um atributo que **só existe por causa da instrumentação manual** (seção 9.6), com status OK |

## Rubrica (0 = não, 1 = parcial, 2 = sim)

| # | Protocolo | Detecção | Localização | Causa | Total |
|---|---|:-:|:-:|:-:|:-:|
| F1 | SOAP (lentidão) | 2 | 2 | 1 | 5 |
| F2 | REST (erro) | 2 | 2 | 2 | 6 |
| F3 | gRPC (indisponível) | 2 | 2 | 2 | 6 |
| F4 | AMQP (consumidor) | 1 | 1 | 0 | 2 |
| F5 | TCP (ATM) | 1 | 2 | 1 | 4 |
| F6 | rede | — | — | — | não injetada; o caso real da seção 9.3 (retransmissões de SYN) daria 2 / 1 / 0 |

Critérios usados:
- **Detecção:** 2 = o trace marca erro ou a latência da raiz muda claramente; 1 = só um sinal indireto (span ausente, atributo de negócio); 0 = nada muda.
- **Localização:** 2 = aponta o serviço e a operação; 1 = só a região ou o salto; 0 = não aponta.
- **Causa:** 2 = os atributos ou eventos explicam o motivo; 1 = parcial; 0 = nenhuma.

### Contrafactual: sem a propagação manual (estado antes das seções 9.5 e 9.6)

| # | Com propagação | Sem propagação | Por quê |
|---|:-:|:-:|---|
| F4 | 1 / 1 / 0 | **0 / 0 / 0** | o `ws-service` nunca fazia parte do trace da TED/PIX, então sua ausência não era um sinal |
| F5 | 1 / 2 / 1 | **0 / 0 / 0** | o `atm-monitor` não gerava spans; o trace terminava no gateway em todos os casos |

*Inferido pela estrutura dos traces medida antes da propagação (seção 9.4), sem uma nova execução.*

## Limitações

- **Avaliação não cega.** A rubrica foi aplicada por quem injetou as falhas. O protocolo original (seção 6 da METODOLOGIA) prevê um avaliador que não sabe qual falha foi injetada. As janelas em `*/janela.txt` permitem repetir a avaliação às cegas no Jaeger.
- **F6 não executada** por limitação do ambiente. Alternativa: um proxy de falhas (por exemplo, Toxiproxy) entre o gateway e um backend.
- **Uma rodada por falha** (30 s, ~60 traces por fluxo). Os sinais foram nítidos (0% → 23% / 100% de erro; 91 → 591 ms), mas não houve repetição.
- **Ruído de erros esperados:** os 401 propositais do k6 (login inválido, saldo sem token) aparecem como spans de erro no gateway em todas as janelas.
