#!/usr/bin/env bash
# Roda uma rodada de carga do k6 e grava a janela de tempo e o resumo, para o eixo 3
# (diagnostico com injecao de falhas). A falha e injetada/removida fora deste script.
#
# Uso (Git Bash, na raiz do projeto):  bash observabilidade/rodada-falha.sh <nome> [duracao]
# Saida: resultados-experimento/falhas/<nome>/{janela.txt,k6.txt}
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
NOME="$1"; DURACAO="${2:-30s}"
DIR="resultados-experimento/falhas/$NOME"; mkdir -p "$DIR"

# fila limpa: mensagens antigas reentregues gerariam traces de outra janela
curl -s -o /dev/null -u guest:guest -X DELETE "localhost:15672/api/queues/%2F/notificacoes.transferencias/contents"
t0=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
# --no-deps: sem ele o compose religa as dependencias do k6 (gateway, comprovantes...) e
# desfaz a falha injetada (container parado) no inicio da rodada
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps -e MODO=taxa -e TAXA=2 -e DURACAO="$DURACAO" -e CHECAR_JAEGER=0 \
  k6 run /scripts/script.js > "$DIR/k6.txt" 2>&1
echo $? > "$DIR/k6-exit.txt"
sleep 8 # flush dos exportadores OTLP
t1=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
echo "$t0 $t1" > "$DIR/janela.txt"
echo "[$NOME] janela $t0 .. $t1  k6 exit=$(cat "$DIR/k6-exit.txt")"
grep -E "checks_succeeded|http_req_failed\.\.|✗" "$DIR/k6.txt" | head -12
