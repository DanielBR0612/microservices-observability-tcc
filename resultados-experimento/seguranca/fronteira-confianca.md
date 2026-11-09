# T2b: fronteira de confiança do contexto de trace (2026-11-09)

**Pergunta:** um cliente externo, sem nenhuma credencial especial, consegue controlar o rastreamento interno enviando o cabeçalho `traceparent` (W3C Trace Context) ao gateway?

**Ambiente:** gateway NestJS com auto-instrumentação Node (propagadores padrão: `tracecontext,baggage`), amostrador `parentbased_*`, demais serviços com OTel ligado. Requisições enviadas com `curl` direto ao gateway (`localhost:8000`), como faria qualquer cliente da API pública.

## Teste 1: o gateway adota um trace escolhido pelo cliente?

```
traceparent: 00-c0ffeea9f5fe9767d2748009086ed640-0e928b1a145ecd17-01
GET /atms  ->  HTTP 200
```

**Resultado:** o trace `c0ffeea9f5fe9767d2748009086ed640` foi gravado com 20 spans, em `api-gateway` e `atm-monitor`. A raiz do gateway (`GET /atms`) aponta como pai o span `0e928b1a145ecd17`, **que não existe**: foi inventado pelo cliente. O identificador externo atravessou o gateway e chegou a um serviço interno, inclusive pelo salto TCP com propagação manual.

**Implicação:** o cliente escolhe o trace id de requisições internas. Isso permite ligar requisições de vítimas diferentes a um mesmo trace, poluir buscas e correlações e, se o trace id for usado em outro lugar (logs, IDs de correlação devolvidos ao cliente), prever ou colidir identificadores.

## Teste 2: o cliente consegue apagar as próprias ações do rastreamento?

Amostragem do sistema: **100%** (`parentbased_always_on`).

```
5 x  POST /auth/login {conta: 190612, senha: "errada"}
     traceparent: 00-dead00a71bb0d67e2e7793f9290ee521-0e928b1a145ecd17-00   (flag 00 = nao amostrar)
     -> HTTP 401 (x5)

1 x  POST /auth/login {conta: 190612, senha: "errada"}   (controle, sem traceparent)
     -> HTTP 401
```

**Resultado:**

| Requisição | Traces gravados |
|---|---:|
| 5 logins com senha errada e flag `00` | **0** (Jaeger: "No traces found") |
| 1 login com senha errada sem cabeçalho (controle) | 1 |

**Implicação:** mesmo com 100% de amostragem, um cliente pode **suprimir do rastreamento** as próprias requisições, por exemplo uma sequência de tentativas de login, porque o amostrador `parentbased` respeita a decisão de quem chama. Se o tracing for usado como trilha de investigação, essa trilha é controlável pelo atacante.

## Teste 3: o cliente consegue forçar a gravação (amplificar o custo)?

Gateway recriado com amostragem de **0%** (`parentbased_traceidratio`, `0.0`), depois restaurado.

| Requisição (`GET /atms`) | Traces gravados |
|---|---:|
| 20 sem `traceparent` | **0** |
| 20 com `traceparent` forjado, flag `01` | **20** |

**Implicação:** a política de amostragem do servidor não vale para quem envia a flag `01`. Como o experimento de overhead mostrou que a memória do Jaeger cresce ~10× entre 10% e 100% de amostragem (74 → 265 MB), um cliente pode inflar deliberadamente o custo e o volume do backend de traces (negação de serviço da observabilidade).

## Não testado

- **Baggage:** o propagador `baggage` também está ativo por padrão no gateway, então um cabeçalho `baggage` do cliente seria repassado aos serviços internos (dados arbitrários do cliente em cabeçalhos internos). Não foi verificado experimentalmente.

## Mitigações (para as diretrizes do artigo)

1. **Não confiar no contexto vindo de fora:** no ponto de entrada (gateway), descartar o `traceparent`/`baggage` externo e iniciar um trace novo, ou registrar o externo apenas como *span link*, não como pai.
2. **Amostrar na borda com amostrador próprio:** usar um amostrador que ignore a flag remota em requisições externas (por exemplo, `traceidratio` sem `parentbased` no gateway).
3. **Limitar e filtrar `baggage`** que entra pela borda.
4. Em proxies ou API gateways de infraestrutura, remover esses cabeçalhos das requisições de clientes não confiáveis.
