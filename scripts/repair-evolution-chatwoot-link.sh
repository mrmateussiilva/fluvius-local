#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$VPS_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
CHATWOOT_INTERNAL_URL="${CHATWOOT_INTERNAL_URL:-http://chatwoot:3000}"
EVOLUTION_INTERNAL_URL="${EVOLUTION_INTERNAL_URL:-http://evolution:8080}"
EVOLUTION_HOST_URL="${EVOLUTION_HOST_URL:-http://127.0.0.1:8080}"
MANAGER_INTERNAL_URL="${MANAGER_INTERNAL_URL:-http://127.0.0.1:4000}"
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
MANAGER_ADMIN_TOKEN="$(get_env_var MANAGER_ADMIN_TOKEN)"

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
          kind,
          record_id,
          client_id,
          instance_name,
          COALESCE(chatwoot_account_id::text, ''),
          COALESCE(chatwoot_user_id::text, ''),
          COALESCE(chatwoot_user_email, ''),
          COALESCE(inbox_id::text, '')
        FROM (
          SELECT
            'main' AS kind,
            id AS record_id,
            id AS client_id,
            instance_name,
            chatwoot_account_id,
            chatwoot_user_id,
            chatwoot_user_email,
            inbox_id
          FROM fluvius_clients
          UNION ALL
          SELECT
            'extra' AS kind,
            i.id AS record_id,
            i.client_id,
            i.instance_name,
            c.chatwoot_account_id,
            c.chatwoot_user_id,
            c.chatwoot_user_email,
            i.inbox_id
          FROM fluvius_client_inboxes i
          INNER JOIN fluvius_clients c ON c.id = i.client_id
        ) targets
        $where_clause
        ORDER BY kind, client_id, record_id;"
)"

if [ -z "$clients" ]; then
  echo "Nenhuma instancia encontrada em fluvius_clients ou fluvius_client_inboxes."
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

manager_repair_client() {
  local client_id="$1"
  local response_file
  local status
  local curl_args=(-sS -o)

  response_file="$(mktemp)"
  curl_args+=("$response_file" -w '%{http_code}' -X POST)
  if [ -n "$MANAGER_ADMIN_TOKEN" ]; then
    curl_args+=(-H "Authorization: Bearer $MANAGER_ADMIN_TOKEN")
  fi
  curl_args+=("$MANAGER_INTERNAL_URL/manager/api/clients/$client_id/integration/repair")

  status="$(curl "${curl_args[@]}" || true)"
  if [ "$status" -ge 200 ] 2>/dev/null && [ "$status" -lt 300 ]; then
    sed 's/^/  /' "$response_file" || true
    rm -f "$response_file"
    return 0
  fi

  echo "  AVISO: Manager repair indisponivel ou falhou (HTTP ${status:-curl_error}); usando fallback." >&2
  sed 's/^/  /' "$response_file" >&2 || true
  rm -f "$response_file"
  return 1
}

manager_repair_extra_inbox() {
  local client_id="$1"
  local record_id="$2"
  local response_file
  local status
  local curl_args=(-sS -o)

  response_file="$(mktemp)"
  curl_args+=("$response_file" -w '%{http_code}' -X POST)
  if [ -n "$MANAGER_ADMIN_TOKEN" ]; then
    curl_args+=(-H "Authorization: Bearer $MANAGER_ADMIN_TOKEN")
  fi
  curl_args+=("$MANAGER_INTERNAL_URL/manager/api/clients/$client_id/inboxes/$record_id/integration/repair")

  status="$(curl "${curl_args[@]}" || true)"
  if [ "$status" -ge 200 ] 2>/dev/null && [ "$status" -lt 300 ]; then
    sed 's/^/  /' "$response_file" || true
    rm -f "$response_file"
    return 0
  fi

  echo "  AVISO: Manager repair da inbox extra falhou (HTTP ${status:-curl_error}); usando fallback." >&2
  sed 's/^/  /' "$response_file" >&2 || true
  rm -f "$response_file"
  return 1
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
  local kind="$1"
  shift
  local record_id="$1"
  local client_id="$2"
  local instance_name="$3"
  local account_id="$4"
  local user_id="$5"
  local user_email="$6"
  local inbox_id="$7"
  local user_token="$CHATWOOT_USER_ACCESS_TOKEN"
  local webhook_url="$EVOLUTION_INTERNAL_URL/chatwoot/webhook/$instance_name"
  local payload
  local response_file
  local status

  validate_instance_name "$instance_name"
  account_id="${account_id:-$CHATWOOT_ACCOUNT_ID}"

  echo ">>> Instancia: $instance_name"

  if [ "$kind" = "extra" ]; then
    if manager_repair_extra_inbox "$client_id" "$record_id"; then
      echo "  Reparo via Manager da inbox extra concluido."
      echo ""
      return 0
    fi
  else
    if manager_repair_client "$client_id"; then
      echo "  Reparo via Manager concluido."
      echo ""
      return 0
    fi
  fi

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

while IFS=$'\t' read -r kind record_id client_id instance_name account_id user_id user_email inbox_id; do
  repair_instance "$kind" "$record_id" "$client_id" "$instance_name" "$account_id" "$user_id" "$user_email" "$inbox_id"
done <<< "$clients"

echo "Reparo concluido. Envie uma mensagem de teste e acompanhe:"
echo "docker compose -f $COMPOSE_FILE logs --tail=120 evolution"
