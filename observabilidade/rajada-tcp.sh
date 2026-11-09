#!/usr/bin/env bash
# Teste de rajada do enquadramento TCP: N abastecimentos simultaneos para o mesmo ATM.
# Compara quantas requisicoes o gateway aceitou com quantos comandos o atm-cluster processou
# (log "CAIXA ABASTECIDO") e mede a cobertura dos traces na janela.
#
# Uso (Git Bash, na raiz do projeto): bash observabilidade/rajada-tcp.sh <nome> [N] [paralelismo]
# Saida: resultados-experimento/enquadramento-tcp/<nome>/
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"; cd "$RAIZ"
NOME="$1"; N="${2:-300}"; P="${3:-50}"; ATM="ATM-CENTRO-01"
DIR="resultados-experimento/enquadramento-tcp/$NOME"; mkdir -p "$DIR"

t0=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
seq 1 "$N" | xargs -P "$P" -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8000/atms/refill \
  -H 'Content-Type: application/json' -d "{\"id\":\"$ATM\",\"valor\":1}" > "$DIR/http.txt"
sleep 8
t1=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
echo "$t0 $t1" > "$DIR/janela.txt"

aceitas=$(grep -c '^20' "$DIR/http.txt")
processados=$(docker logs --since "$t0" --until "$t1" atm-cluster 2>&1 | grep "$ATM" | grep -c 'ABASTECIDO')
node observabilidade/cobertura-traces.js --inicio "$t0" --fim "$t1" --saida "$DIR" > "$DIR/cobertura.txt" 2>&1
cob=$(grep -E '"POST /atms/refill"' "$DIR/cobertura-fluxos.csv" | cut -d, -f4,5,6)

{
  echo "{\"nome\":\"$NOME\",\"requisicoes\":$N,\"paralelismo\":$P,\"http_2xx\":$aceitas,"
  echo " \"comandos_processados_no_atm\":$processados,\"perdidos\":$((aceitas - processados)),"
  echo " \"cobertura_refill(traces,completos,pct)\":\"$cob\"}"
} > "$DIR/resumo.json"
cat "$DIR/resumo.json"
