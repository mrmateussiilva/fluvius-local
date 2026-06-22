#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$VPS_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
SINCE="${SINCE:-5m}"
LIMIT="${LIMIT:-20}"
INSTANCE_FILTER="${1:-${INSTANCE_NAME:-}}"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

section() {
  echo ""
  echo "========== $1 =========="
}

get_env_var() {
  local key="$1"
  local fallback="${2:-}"
  local value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "${value:-$fallback}"
}

psql_db() {
  local database="$1"
  shift
  compose exec -T postgres psql \
    -U "$POSTGRES_USER" \
    -d "$database" \
    -v ON_ERROR_STOP=1 \
    "$@"
}

measure_url() {
  local label="$1"
  shift
  printf '%-28s ' "$label"
  curl -sS -o /dev/null -w 'http=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n' "$@" || true
}

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE nao encontrado." >&2
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERRO: LIMIT deve ser numerico. Valor recebido: $LIMIT" >&2
  exit 1
fi

if [ -n "$INSTANCE_FILTER" ] && ! [[ "$INSTANCE_FILTER" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "ERRO: nome de instancia invalido: $INSTANCE_FILTER" >&2
  echo "Use apenas letras, numeros, ponto, underscore ou hifen." >&2
  exit 1
fi

POSTGRES_USER="$(get_env_var POSTGRES_USER postgres)"
CHATWOOT_POSTGRES_DB="$(get_env_var CHATWOOT_POSTGRES_DB chatwoot)"
EVOLUTION_POSTGRES_DB="$(get_env_var EVOLUTION_POSTGRES_DB evolution)"
EVOLUTION_API_KEY="$(get_env_var EVOLUTION_API_KEY '')"

cd "$VPS_DIR"

section "Resumo"
echo "Diretorio: $VPS_DIR"
echo "Compose: $COMPOSE_FILE"
echo "Janela de logs: $SINCE"
echo "Limite de linhas SQL: $LIMIT"
if [ -n "$INSTANCE_FILTER" ]; then
  echo "Filtro de instancia: $INSTANCE_FILTER"
fi
date -Is

section "Host"
uptime || true
free -h || true
df -h / /var/lib/docker 2>/dev/null || df -h || true

section "Containers"
compose ps || true
echo ""
docker stats --no-stream || true

section "Latencia HTTP local"
measure_url "Chatwoot /" http://127.0.0.1:3000/
measure_url "Internal health" http://127.0.0.1:4000/health
measure_url "Manager health" http://127.0.0.1:4000/manager/api/health
if [ -n "$EVOLUTION_API_KEY" ]; then
  measure_url "Evolution instances" -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8080/instance/fetchInstances
else
  echo "Evolution instances        pulado: EVOLUTION_API_KEY vazio"
fi

section "Sidekiq filas"
compose exec -T chatwoot bundle exec rails runner '
require "json"
require "sidekiq/api"
payload = {
  queues: Sidekiq::Queue.all.map { |q| { name: q.name, size: q.size, latency_seconds: q.latency.round(2) } },
  scheduled: Sidekiq::ScheduledSet.new.size,
  retry: Sidekiq::RetrySet.new.size,
  dead: Sidekiq::DeadSet.new.size,
  processes: Sidekiq::ProcessSet.new.map { |p| { busy: p["busy"], concurrency: p["concurrency"], queues: p["queues"] } }
}
puts JSON.pretty_generate(payload)
' || true

section "Ultimas mensagens no Chatwoot"
psql_db "$CHATWOOT_POSTGRES_DB" -P pager=off -c "
SELECT
  id,
  account_id,
  inbox_id,
  conversation_id,
  message_type,
  status,
  to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
  round(extract(epoch FROM (now() - created_at))) AS age_seconds,
  COALESCE(source_id, '') AS source_id,
  left(replace(COALESCE(content, ''), E'\n', ' '), 90) AS content
FROM messages
WHERE private = false
ORDER BY id DESC
LIMIT $LIMIT;
" || true

section "Ultimas mensagens enviadas por agentes"
psql_db "$CHATWOOT_POSTGRES_DB" -P pager=off -c "
SELECT
  id,
  account_id,
  inbox_id,
  conversation_id,
  status,
  to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
  round(extract(epoch FROM (now() - created_at))) AS age_seconds,
  COALESCE(source_id, '') AS source_id,
  left(replace(COALESCE(content, ''), E'\n', ' '), 90) AS content
FROM messages
WHERE private = false
  AND message_type = 1
ORDER BY id DESC
LIMIT $LIMIT;
" || true

section "Webhooks das inboxes API"
psql_db "$CHATWOOT_POSTGRES_DB" -P pager=off -c "
SELECT
  inboxes.id,
  inboxes.account_id,
  inboxes.name,
  channel_api.webhook_url
FROM inboxes
INNER JOIN channel_api
  ON channel_api.id = inboxes.channel_id
 AND inboxes.channel_type = 'Channel::Api'
ORDER BY inboxes.id DESC
LIMIT $LIMIT;
" || true

section "Ultimas mensagens na Evolution"
instance_where=""
if [ -n "$INSTANCE_FILTER" ]; then
  instance_where="AND i.name = '$INSTANCE_FILTER'"
fi
psql_db "$EVOLUTION_POSTGRES_DB" -P pager=off -c "
SELECT
  m.id,
  i.name AS instance,
  COALESCE(m.key->>'remoteJidAlt', m.key->>'remoteJid') AS remote_jid,
  m.key->>'fromMe' AS from_me,
  m.\"messageType\",
  m.\"chatwootMessageId\",
  to_char(to_timestamp(m.\"messageTimestamp\"), 'YYYY-MM-DD HH24:MI:SS') AS message_time,
  round(extract(epoch FROM (now() - to_timestamp(m.\"messageTimestamp\")))) AS age_seconds
FROM \"Message\" m
INNER JOIN \"Instance\" i ON i.id = m.\"instanceId\"
WHERE COALESCE(m.key->>'remoteJidAlt', m.key->>'remoteJid') <> 'status@broadcast'
  $instance_where
ORDER BY m.\"messageTimestamp\" DESC, m.id DESC
LIMIT $LIMIT;
" || true

section "Logs recentes relevantes"
compose logs --since="$SINCE" chatwoot sidekiq evolution internal-chat 2>/dev/null \
  | grep -Ei 'error|warn|timeout|failed|message|webhook|chatwoot|evolution|sidekiq|conversation|outgoing|send' \
  | tail -200 || true

section "Como usar"
cat <<'INFO'
1. Envie uma mensagem manual de agente pelo Chatwoot.
2. Rode este script imediatamente.
3. Compare:
   - "Ultimas mensagens enviadas por agentes": confirma quando o Chatwoot gravou a mensagem.
   - "Ultimas mensagens na Evolution": confirma se a Evolution recebeu/vinculou perto do mesmo horario.
   - "Sidekiq filas": se latency_seconds ou size estiver alto, o atraso esta na fila.
   - "Latencia HTTP local": se Evolution ou Chatwoot demoram, o gargalo e no servico local.

Exemplos:
  ./scripts/diagnose-message-delay.sh
  SINCE=10m LIMIT=40 ./scripts/diagnose-message-delay.sh
  SINCE=10m ./scripts/diagnose-message-delay.sh NomeDaInstancia
INFO
