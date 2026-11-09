# Correção do enquadramento TCP (2026-11-09)

**Origem:** no T4 (`../propagadores/`), um trace de abastecimento ficou sem o span do `atm-cluster`, e o cluster tinha processado **59 comandos para 60 requisições**. Causa: o protocolo de texto dos ATMs não delimitava mensagens, e cada lado tratava cada evento `data` do socket como um comando completo. TCP entrega um **fluxo de bytes**: duas mensagens podem chegar no mesmo segmento (coalescência) e uma pode chegar em vários (fragmentação).

**Correção:** cada mensagem passou a ser **uma linha terminada em `\n`**, nos dois sentidos e nos dois canais TCP. Quem lê acumula os bytes e só processa linhas completas (`criarLeitorDeLinhas` em `ATMService/contexto-tcp.ts`). O contexto de trace foi para o início da linha, separado do comando por um espaço:

```
antes:   traceparent=00-...-01\nCMD_REFILL:500          (sem terminador)
depois:  traceparent=00-...-01 CMD_REFILL:500\n
```

| Canal | Mudança |
|---|---|
| gateway → `atm-monitor` (6002) | comando como linha; a **resposta** também virou linha, e o gateway lê até o `\n` (respostas grandes, como `GET_ALL` com muitos ATMs, podiam chegar em pedaços e quebrar o `JSON.parse`) |
| `atm-cluster` → `atm-monitor` (6001) | `REGISTER:id\n`, lido linha a linha |
| `atm-monitor` → `atm-cluster` (6001) | comandos como linha, lidos linha a linha |

## 1. Teste determinístico (mecanismo)

`ATMService/teste-enquadramento.ts`: os mesmos 3 comandos entregues com fronteiras de segmento diferentes. O leitor antigo reproduz a lógica do `atm-cluster` anterior (1 evento = 1 comando, `startsWith` + `parseInt`). Saída em `teste-deterministico.md`.

| Fronteiras dos segmentos | Leitor antigo | Leitor novo |
|---|---:|---:|
| 1 mensagem por segmento (caso feliz) | 3/3 | 3/3 |
| 3 mensagens no mesmo segmento (coalescência) | **1/3** | 3/3 |
| segmentos de 7 bytes (fragmentação) | **0/3** | 3/3 |
| segmentos de 1 byte (pior caso) | **0/3** | 3/3 |

## 2. Rajadas no sistema real (efeito)

`observabilidade/rajada-tcp.sh`: N abastecimentos simultâneos para o mesmo ATM. Compara as respostas 2xx do gateway com os comandos efetivamente processados pelo ATM (log) e mede a cobertura dos traces. O código antigo foi medido com as alterações guardadas num `git stash` e os serviços reiniciados.

| Rodada | Código | Requisições (paralelismo) | Processadas no ATM | Perdidas | Cobertura do `refill` |
|---|---|---:|---:|---:|---:|
| k6, cenário A do T4 | antigo | 60 | 59 | **1** | 98,3% |
| `antes-sem-delimitador` | antigo | 300 (50) | 299 | **1** | 99,7% |
| `antes-sem-delimitador-1000` | antigo | 1000 (200) | 1000 | 0 | 100% |
| `depois-delimitado` | novo | 300 (50) | 300 | 0 | 100% |
| `depois-delimitado-1000` | novo | 1000 (200) | 1000 | 0 | 100% |
| `k6-depois` | novo | 61 | 61 | 0 | 100% |

## Leitura

- **O defeito é real, mas raro e não determinístico.** Ele exige que duas escritas do monitor para o mesmo ATM caiam no mesmo segmento, o que depende do agendamento e não aumentou com mais concorrência (0 perdas em 1.000 com paralelismo 200). Por isso a prova do mecanismo é o teste determinístico; as rajadas mostram que ele aparece no sistema real e que some com a correção.
- **Em todas as perdas, o trace incompleto coincidiu exatamente com o comando perdido** (cobertura 98,3% e 99,7% ↔ 1 perda cada). A propagação de contexto funcionou como um detector de perda de mensagens que nenhum teste funcional pegava.
- **Mudar o enquadramento mudou o contrato do protocolo.** Depois de alterar o monitor e o cluster, o gateway ainda com o código antigo deu **timeout** em `GET /atms`: o monitor esperava o `\n`, que o gateway antigo não enviava. Cliente e servidor precisam ser atualizados juntos (D6).

## Limitações

- O código antigo foi medido em 3 rodadas, com perdas de 0 a 1. A taxa de perda não é estimável com precisão; o que se afirma é a existência do defeito e a correspondência entre perda e trace incompleto.
- O protocolo não tem confirmação de entrega (o monitor responde "Abastecimento enviado" sem saber se o ATM processou). Delimitar resolve a leitura, não a confiabilidade ponta a ponta.
