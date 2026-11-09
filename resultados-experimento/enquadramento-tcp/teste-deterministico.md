Comandos enviados: 3 (CMD_REFILL:100, CMD_REFILL:200, CMD_REFILL:300)

| Fronteiras dos segmentos | Leitor antigo | Leitor novo |
|---|---:|---:|
| 1 mensagem por segmento (caso feliz) | 3/3 ok | 3/3 ok |
| 3 mensagens no mesmo segmento (coalescencia) | 1/3 ERRO | 3/3 ok |
| segmentos de 7 bytes (fragmentacao) | 0/3 ERRO | 3/3 ok |
| segmentos de 1 byte (pior caso) | 0/3 ERRO | 3/3 ok |
