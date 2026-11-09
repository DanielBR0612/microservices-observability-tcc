#!/usr/bin/env bash
# Experimento A/B do custo da observabilidade (OpenTelemetry) por protocolo.
#
# Para cada configuracao de instrumentacao, recria os servicos, aquece o sistema e roda o
# k6 com taxa de chegada constante REPS vezes, gravando latencia (por protocolo), uso de
# CPU/memoria de cada servico e, quando ha traces, a cobertura medida no Jaeger.
#
# Configuracoes:
#   sem-otel   OpenTelemetry desligado em todos os servicos (linha de base)
#   otel-100   OpenTelemetry ligado, 100% das requisicoes rastreadas
#   otel-10    OpenTelemetry ligado, amostragem de 10% (parent-based, decidida no gateway)
#
# Uso (Git Bash, na raiz do projeto, com Docker Desktop rodando e os jars do Spring compilados):
#   bash observabilidade/experimento-overhead.sh
#   REPS=3 TAXA=2 DURACAO=60s CONFIGS="sem-otel otel-100" bash observabilidade/experimento-overhead.sh
#
# Ordem: a sequencia de configuracoes e executada CICLOS vezes, invertida a cada ciclo
# (ABC, CBA, ABC...), com REPS repeticoes por configuracao em cada ciclo. Isso evita que
# um efeito de ordem (banco crescendo, aquecimento do host, temperatura) seja confundido
# com o efeito da instrumentacao. Total por configuracao = CICLOS x REPS repeticoes.
#
# Ao final roda observabilidade/agregar-experimento.js e grava os CSVs em $SAIDA.
# Ao terminar, deixa o ambiente na configuracao otel-100 (padrao do projeto).

set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

REPS="${REPS:-3}"                 # repeticoes por configuracao em cada ciclo
CICLOS="${CICLOS:-2}"             # ciclos de configuracoes (ordem alternada)
TAXA="${TAXA:-2}"                 # iteracoes por segundo (cada iteracao ~22 requisicoes)
DURACAO="${DURACAO:-60s}"
AQUECIMENTO="${AQUECIMENTO:-20s}" # rodada descartada apos cada reinicio (JIT, pools, caches)
PAUSA="${PAUSA:-10}"              # segundos entre repeticoes
CONFIGS="${CONFIGS:-sem-otel otel-100 otel-10}"
SAIDA="${SAIDA:-$RAIZ/resultados-experimento/$(date +%Y%m%d-%H%M%S)}"

SOAP_JAR="$RAIZ/BancoCoreSOAP/target/demo-0.0.1-SNAPSHOT.jar"
REST_JAR="$RAIZ/BancoRestApi/target/BancoRestApi-1.0-SNAPSHOT.jar"
CONTAINERS="container_gateway container_ws container_comprovantes atm-monitor projeto-dsd-rabbitmq projeto-dsd-jaeger-1"
SERVICOS_COMPOSE="jaeger ws-service comprovantes-service atm-monitor atm-cluster gateway"
COMPOSE=(docker compose -f docker-compose.yaml -f observabilidade/docker-compose.experimento.yaml)

# Logs do Spring em WARN: os niveis DEBUG/TRACE do application.properties (SQL, binds,
# requisicoes) custariam mais que a propria instrumentacao e esconderiam o efeito medido.
LOG_SPRING="'--logging.level.root=WARN','--logging.level.org.springframework=WARN','--logging.level.org.hibernate=WARN','--logging.level.com.zaxxer=WARN','--logging.level.com.example=WARN','--logging.level.org.example=WARN'"

export MSYS_NO_PATHCONV=1

log() { echo "[$(date +%H:%M:%S)] $*"; }
winpath() { cygpath -w "$1"; }
# Para o node: com MSYS_NO_PATHCONV=1 um caminho /c/... nao e convertido e o Node no
# Windows o leria como C:\c\...; cygpath -m gera C:/Users/... que funciona nos dois lados.
nodepath() { cygpath -m "$1"; }

[ -f "$SOAP_JAR" ] && [ -f "$REST_JAR" ] || { echo "Compile os jars do Spring antes (mvnw package)."; exit 1; }

# Trava: duas execucoes simultaneas dobrariam a carga e invalidariam as medicoes
TRAVA="$RAIZ/resultados-experimento/.em-execucao"
mkdir -p "$RAIZ/resultados-experimento"
if ! mkdir "$TRAVA" 2>/dev/null; then
  echo "Ja existe um experimento em execucao ($TRAVA). Se nao houver, apague essa pasta."; exit 1
fi
trap 'rmdir "$TRAVA" 2>/dev/null' EXIT
mkdir -p "$SAIDA"
# Caminho absoluto: o docker -v trata um caminho relativo como nome de volume e o k6 nao sobe
SAIDA="$(cd "$SAIDA" && pwd)"

# ------------------------------------------------------------------ configuracao de instrumentacao
aplicar_config() {
  case "$1" in
    sem-otel)
      # OTEL_PY_WRAPPER vazio: o Python roda sem opentelemetry-instrument (sem interceptadores)
      export OTEL_SDK_DISABLED=true OTEL_TRACES_SAMPLER=parentbased_always_on OTEL_TRACES_SAMPLER_ARG=1.0 OTEL_PY_WRAPPER=
      export MANAGEMENT_TRACING_ENABLED=false MANAGEMENT_TRACING_SAMPLING_PROBABILITY=0.0 ;;
    otel-100)
      export OTEL_SDK_DISABLED=false OTEL_TRACES_SAMPLER=parentbased_always_on OTEL_TRACES_SAMPLER_ARG=1.0 OTEL_PY_WRAPPER=opentelemetry-instrument
      export MANAGEMENT_TRACING_ENABLED=true MANAGEMENT_TRACING_SAMPLING_PROBABILITY=1.0 ;;
    otel-10)
      export OTEL_SDK_DISABLED=false OTEL_TRACES_SAMPLER=parentbased_traceidratio OTEL_TRACES_SAMPLER_ARG=0.1 OTEL_PY_WRAPPER=opentelemetry-instrument
      export MANAGEMENT_TRACING_ENABLED=true MANAGEMENT_TRACING_SAMPLING_PROBABILITY=0.1 ;;
    *) echo "configuracao desconhecida: $1"; exit 1 ;;
  esac
}

# ------------------------------------------------------------------ servicos Spring (rodam no host)
pid_da_porta() { netstat -ano | awk -v p=":$1" '$1=="TCP" && $2 ~ p"$" && $4=="LISTENING" {print $5; exit}'; }

parar_spring() {
  for porta in 8080 8081; do
    local pid; pid="$(pid_da_porta $porta)"
    # Com MSYS_NO_PATHCONV=1 (exportado acima) as opcoes vao literais: /F, nao //F
    [ -n "$pid" ] && taskkill /F /PID "$pid" >/dev/null 2>&1
  done
  for _ in $(seq 1 30); do [ -z "$(pid_da_porta 8080)$(pid_da_porta 8081)" ] && return 0; sleep 1; done
  echo "Nao consegui liberar as portas 8080/8081"; return 1
}

iniciar_spring() {
  local dir="$1"
  # Start-Process cria um processo independente, que herda as variaveis OTEL_*/MANAGEMENT_*
  for alvo in "soap|$SOAP_JAR" "rest|$REST_JAR"; do
    local nome="${alvo%%|*}" jar="${alvo#*|}"
    powershell -NoProfile -Command "Start-Process java -WindowStyle Hidden -ArgumentList '-jar','$(winpath "$jar")',$LOG_SPRING -RedirectStandardOutput '$(winpath "$dir")\\$nome.log' -RedirectStandardError '$(winpath "$dir")\\$nome.err'" || return 1
  done
  for _ in $(seq 1 90); do
    local s r
    s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8080/ws/banco.wsdl)
    r=$(curl -s -o /dev/null -w '%{http_code}' localhost:8081/extrato/0)
    [ "$s" = "401" ] && [ "$r" = "200" ] && return 0
    sleep 2
  done
  echo "Spring nao subiu; veja $dir/*.log"; return 1
}

# ------------------------------------------------------------------ containers
esvaziar_filas() {
  for q in notificacoes.transferencias notificacoes.transferencias.dlq; do
    curl -s -o /dev/null -u guest:guest -X DELETE "localhost:15672/api/queues/%2F/$q/contents"
  done
}

recriar_containers() {
  # Para o consumidor antes de esvaziar: mensagens "unacked" voltariam para a fila
  "${COMPOSE[@]}" stop ws-service >/dev/null 2>&1
  esvaziar_filas
  "${COMPOSE[@]}" up -d --force-recreate $SERVICOS_COMPOSE >/dev/null 2>&1 || return 1
  for _ in $(seq 1 120); do
    local g w c
    g=$(curl -s -o /dev/null -w '%{http_code}' localhost:8000/atms)
    w=$(curl -s -o /dev/null -w '%{http_code}' localhost:8083/)
    c=$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8000/comprovantes/gerar \
          -H 'Content-Type: application/json' -d '{"tipo_transacao":"PIX","conta_origem":"1","conta_destino":"2","valor":1}')
    [ "$g" = "200" ] && [ "$w" = "404" ] && [ "$c" = "201" ] && return 0
    sleep 3
  done
  echo "containers nao ficaram prontos"; return 1
}

# ------------------------------------------------------------------ recursos (CPU acumulada e memoria)
# Uma linha por servico: servico,cpu_ms_acumulado,mem_mb
amostrar_recursos() {
  local arq="$1"
  : > "$arq"
  for c in $CONTAINERS; do
    docker exec "$c" sh -c '
      if [ -f /sys/fs/cgroup/cpu.stat ]; then
        cpu=$(awk "/usage_usec/{print \$2/1000}" /sys/fs/cgroup/cpu.stat); mem=$(cat /sys/fs/cgroup/memory.current)
      else
        cpu=$(awk "{print \$1/1000000}" /sys/fs/cgroup/cpuacct/cpuacct.usage); mem=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes)
      fi
      echo "$cpu $mem"' 2>/dev/null | awk -v n="$c" '{printf "%s,%.1f,%.1f\n", n, $1, $2/1048576}' >> "$arq"
  done
  for alvo in "banco-soap|8080" "rest-api|8081"; do
    local nome="${alvo%%|*}" pid; pid="$(pid_da_porta "${alvo#*|}")"
    [ -z "$pid" ] && continue
    # InvariantCulture: em pt-BR o PowerShell usaria virgula decimal e quebraria o CSV
    powershell -NoProfile -Command "\$p=Get-Process -Id $pid; [string]::Format([cultureinfo]::InvariantCulture,'{0},{1:F1},{2:F1}','$nome',\$p.TotalProcessorTime.TotalMilliseconds,(\$p.WorkingSet64/1MB))" >> "$arq"
  done
}

rodar_k6() {
  local dir="$1" duracao="$2"
  mkdir -p "$dir"
  "${COMPOSE[@]}" run --rm -e MODO=taxa -e TAXA="$TAXA" -e DURACAO="$duracao" -e CHECAR_JAEGER=0 \
    -v "$(winpath "$dir"):/exp" k6 run --summary-export=/exp/resumo.json --out json=/exp/metricas.json.gz \
    /scripts/script.js > "$dir/console.txt" 2>&1
  echo $? > "$dir/k6-exit.txt"
}

# ------------------------------------------------------------------ execucao
cat > "$SAIDA/parametros.json" <<EOF
{ "reps": $((REPS * CICLOS)), "reps_por_ciclo": $REPS, "ciclos": $CICLOS, "taxa_iter_s": $TAXA, "duracao": "$DURACAO", "aquecimento": "$AQUECIMENTO",
  "configs": "$(echo $CONFIGS)", "inicio": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(uname -a | tr -d '"')" }
EOF

log "Saida: $SAIDA"
ordem="$CONFIGS"
for ciclo in $(seq 1 "$CICLOS"); do
 log "##### ciclo $ciclo/$CICLOS: $ordem"
 for cfg in $ordem; do
  aplicar_config "$cfg"
  dcfg="$SAIDA/$cfg"; mkdir -p "$dcfg"
  dlog="$dcfg/ciclo-$ciclo"; mkdir -p "$dlog"
  log "== $cfg: reiniciando servicos (OTEL_SDK_DISABLED=$OTEL_SDK_DISABLED, amostragem=$OTEL_TRACES_SAMPLER_ARG)"
  parar_spring || exit 1
  iniciar_spring "$dlog" || exit 1
  # Garante que quem responde nas portas e o processo recem-iniciado, com esta configuracao
  grep -q "APPLICATION FAILED" "$dlog"/soap.log "$dlog"/rest.log 2>/dev/null && { echo "Spring falhou ao iniciar; veja $dlog"; exit 1; }
  recriar_containers || exit 1

  log "   aquecimento ($AQUECIMENTO)"
  rodar_k6 "$dlog/aquecimento" "$AQUECIMENTO"
  # Controle: servicos que exportaram traces (em sem-otel a lista deve ficar vazia)
  sleep 5
  curl -s localhost:16686/api/v3/services > "$dlog/jaeger-servicos.json"
  log "   servicos no Jaeger apos aquecimento: $(cat "$dlog/jaeger-servicos.json")"

  for r in $(seq 1 "$REPS"); do
    rep=$(( (ciclo - 1) * REPS + r ))
    drep="$dcfg/rep-$rep"; mkdir -p "$drep"
    sleep "$PAUSA"
    amostrar_recursos "$drep/recursos-inicio.csv"
    t0=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ); s0=$(date +%s%3N)
    rodar_k6 "$drep" "$DURACAO"
    t1=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ); s1=$(date +%s%3N)
    amostrar_recursos "$drep/recursos-fim.csv"
    echo "{\"config\":\"$cfg\",\"rep\":$rep,\"ciclo\":$ciclo,\"inicio\":\"$t0\",\"fim\":\"$t1\",\"duracao_ms\":$((s1 - s0))}" > "$drep/meta.json"

    if [ "$cfg" != "sem-otel" ]; then
      sleep 5 # flush dos exportadores OTLP (batch)
      node observabilidade/cobertura-traces.js --inicio "$t0" --fim "$t1" --saida "$(nodepath "$drep")" > "$drep/cobertura.txt" 2>&1
    fi
    log "   rep $rep ($r/$REPS do ciclo): k6 exit=$(cat "$drep/k6-exit.txt") $(grep -E 'checks_succeeded' "$drep/console.txt" | sed 's/ \+/ /g')"
  done
 done
 # inverte a ordem para o proximo ciclo
 ordem="$(echo $ordem | tr ' ' '\n' | tac | tr '\n' ' ')"
done

# Volta ao padrao do projeto: OTel ligado (100%) e containers do docker-compose.yaml normal
log "Restaurando configuracao padrao (otel-100, compose sem override)"
aplicar_config otel-100
parar_spring
mkdir -p "$SAIDA/restauracao"
iniciar_spring "$SAIDA/restauracao"
COMPOSE=(docker compose)
recriar_containers

log "Agregando resultados"
node observabilidade/agregar-experimento.js "$(nodepath "$SAIDA")"
