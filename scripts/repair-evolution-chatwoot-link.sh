#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$VPS_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
CHATWOOT_INTERNAL_URL="${CHATWOOT_INTERNAL_URL:-http://chatwoot:3000}"
EVOLUTION_INTERNAL_URL="${EVOLUTION_INTERNAL_URL:-http://evolution:8080}"
EVOLUTION_HOST_URL="${EVOLUTION_HOST_URL:-http://127.0.0.1:8080}"
WEBHOOK_TIMEOUT="${WEBHOOK_TIMEOUT:-30}"
INSTANCE_FILTER="${1:-}"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
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

set_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

validate_instance_name() {
  local instance_name="$1"
  if [[ ! "$instance_name" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "ERRO: nome de instancia invalido: $instance_name" >&2
    echo "Use apenas letras, numeros, ponto, underscore ou hifen." >&2
    exit 1
  fi
}

wait_for_chatwoot() {
  echo "Aguardando Fluvius ficar pronto..."
  for attempt in $(seq 1 60); do
    if compose exec -T chatwoot bundle exec rails runner 'puts "ready"' >/dev/null 2>&1; then
      echo "Fluvius pronto."
      return 0
    fi
    if [ "$attempt" = "60" ]; then
      echo "ERRO: Fluvius nao ficou pronto a tempo." >&2
      exit 1
    fi
    sleep 5
  done
}

ensure_private_webhooks_enabled() {
  local env_value
  local container_value

  env_value="$(get_env_var ALLOW_PRIVATE_WEBHOOK_URLS false)"
  container_value="$(compose exec -T chatwoot printenv ALLOW_PRIVATE_WEBHOOK_URLS 2>/dev/null | tr -d '\r' || true)"

  if [ "$env_value" = "true" ] && [ "$container_value" = "true" ]; then
    return 0
  fi

  echo "Habilitando ALLOW_PRIVATE_WEBHOOK_URLS=true e recriando Fluvius/Sidekiq..."
  set_env_var "ALLOW_PRIVATE_WEBHOOK_URLS" "true"
  compose up -d --force-recreate chatwoot sidekiq
  wait_for_chatwoot
  echo ""
}

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE nao encontrado." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERRO: curl nao encontrado na VPS." >&2
  exit 1
fi

if [ -n "$INSTANCE_FILTER" ]; then
  validate_instance_name "$INSTANCE_FILTER"
fi

POSTGRES_USER="$(get_env_var POSTGRES_USER chatwoot)"
CHATWOOT_POSTGRES_DB="$(get_env_var CHATWOOT_POSTGRES_DB chatwoot)"
EVOLUTION_API_KEY="$(get_env_var EVOLUTION_API_KEY)"
CHATWOOT_ACCOUNT_ID="$(get_env_var CHATWOOT_ACCOUNT_ID 1)"
CHATWOOT_USER_ACCESS_TOKEN="$(get_env_var CHATWOOT_USER_ACCESS_TOKEN)"

if [ -z "$EVOLUTION_API_KEY" ]; then
  echo "ERRO: EVOLUTION_API_KEY vazio no .env." >&2
  exit 1
fi

cd "$VPS_DIR"

echo ""
echo "=============================================="
echo "  Reparar Evolution -> Fluvius"
echo "=============================================="
echo "Compose: $COMPOSE_FILE"
echo "Fluvius interno: $CHATWOOT_INTERNAL_URL"
echo "Evolution interno: $EVOLUTION_INTERNAL_URL"
echo ""

ensure_private_webhooks_enabled

where_clause="WHERE instance_name IS NOT NULL AND instance_name <> ''"
if [ -n "$INSTANCE_FILTER" ]; then
  where_clause="$where_clause AND instance_name = '$INSTANCE_FILTER'"
fi

clients="$(
  compose exec -T postgres psql \
    -U "$POSTGRES_USER" \
    -d "$CHATWOOT_POSTGRES_DB" \
    -At \
    -F $'\t' \
    -v ON_ERROR_STOP=1 \
    -c "SELECT
          instance_name,
          COALESCE(chatwoot_account_id::text, ''),
          COALESCE(chatwoot_user_id::text, ''),
          COALESCE(chatwoot_user_email, ''),
          COALESCE(inbox_id::text, '')
        FROM fluvius_clients
        $where_clause
        ORDER BY id;"
)"

if [ -z "$clients" ]; then
  echo "Nenhuma instancia encontrada em fluvius_clients."
  exit 0
fi

get_user_token() {
  local user_id="$1"
  local user_email="$2"

  compose exec -T \
    -e REPAIR_USER_ID="$user_id" \
    -e REPAIR_USER_EMAIL="$user_email" \
    chatwoot bundle exec rails runner '
user = nil
user = User.find_by(id: ENV["REPAIR_USER_ID"]) if ENV["REPAIR_USER_ID"].to_s != ""
user ||= User.find_by(email: ENV["REPAIR_USER_EMAIL"]) if ENV["REPAIR_USER_EMAIL"].to_s != ""
abort "user not found" unless user
token = user.access_token || AccessToken.create!(owner: user)
puts "TOKEN=#{token.token}"
' | awk -F= '/^TOKEN=/{print $2}' | tail -1
}

set_webhook_timeout() {
  compose exec -T \
    -e REPAIR_WEBHOOK_TIMEOUT="$WEBHOOK_TIMEOUT" \
    chatwoot bundle exec rails runner '
config = InstallationConfig.where(name: "WEBHOOK_TIMEOUT").first_or_initialize
config.value = ENV.fetch("REPAIR_WEBHOOK_TIMEOUT", "30")
config.locked = false
config.save!
GlobalConfig.clear_cache if defined?(GlobalConfig)
puts "WEBHOOK_TIMEOUT=#{config.value}"
'
}

update_inbox_webhook() {
  local inbox_id="$1"
  local webhook_url="$2"

  if [ -z "$inbox_id" ]; then
    echo "  AVISO: inbox_id vazio; webhook da inbox nao foi atualizado."
    return 0
  fi

  compose exec -T \
    -e REPAIR_INBOX_ID="$inbox_id" \
    -e REPAIR_WEBHOOK_URL="$webhook_url" \
    chatwoot bundle exec rails runner '
inbox = Inbox.find_by(id: ENV.fetch("REPAIR_INBOX_ID"))
abort "inbox not found" unless inbox
channel = inbox.channel
abort "inbox channel has no webhook_url" unless channel.respond_to?(:webhook_url=)
channel.update!(webhook_url: ENV.fetch("REPAIR_WEBHOOK_URL"))
puts "inbox=#{inbox.id} webhook_url=#{channel.webhook_url}"
'
}

repair_instance() {
  local instance_name="$1"
  local account_id="$2"
  local user_id="$3"
  local user_email="$4"
  local inbox_id="$5"
  local user_token="$CHATWOOT_USER_ACCESS_TOKEN"
  local webhook_url="$EVOLUTION_INTERNAL_URL/chatwoot/webhook/$instance_name"
  local payload
  local response_file
  local status

  validate_instance_name "$instance_name"
  account_id="${account_id:-$CHATWOOT_ACCOUNT_ID}"

  echo ">>> Instancia: $instance_name"

  if [ -n "$user_id" ] || [ -n "$user_email" ]; then
    user_token="$(get_user_token "$user_id" "$user_email")"
  fi

  if [ -z "$account_id" ] || [ -z "$user_token" ]; then
    echo "  ERRO: account_id ou token vazio; pulando instancia."
    return 1
  fi

  payload="$(printf '{"enabled":true,"accountId":"%s","token":"%s","url":"%s","signMsg":true,"signDelimiter":"\\n","reopenConversation":true,"conversationPending":false,"importContacts":true,"importMessages":true,"daysLimitImportMessages":365}' \
    "$account_id" "$user_token" "$CHATWOOT_INTERNAL_URL")"

  response_file="$(mktemp)"
  status="$(curl -sS \
    -o "$response_file" \
    -w '%{http_code}' \
    -X POST "$EVOLUTION_HOST_URL/chatwoot/set/$instance_name" \
    -H "apikey: $EVOLUTION_API_KEY" \
    -H "Content-Type: application/json" \
    --data "$payload")"

  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "  ERRO: Evolution retornou HTTP $status em /chatwoot/set/$instance_name" >&2
    sed 's/^/  /' "$response_file" >&2 || true
    rm -f "$response_file"
    return 1
  fi
  rm -f "$response_file"

  echo "  Evolution Fluvius URL: $CHATWOOT_INTERNAL_URL"
  update_inbox_webhook "$inbox_id" "$webhook_url"
  echo "  Fluvius inbox webhook: $webhook_url"
  echo ""
}

set_webhook_timeout
echo ""

while IFS=$'\t' read -r instance_name account_id user_id user_email inbox_id; do
  repair_instance "$instance_name" "$account_id" "$user_id" "$user_email" "$inbox_id"
done <<< "$clients"

echo "Reparo concluido. Envie uma mensagem de teste e acompanhe:"
echo "docker compose -f $COMPOSE_FILE logs --tail=120 evolution"
