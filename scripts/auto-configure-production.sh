#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-/opt/fluvius}"
ENV_FILE="${ENV_FILE:-$VPS_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
COMPOSE="docker compose -f $COMPOSE_FILE"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE nao encontrado."
  exit 1
fi

cd "$VPS_DIR"

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

CHATWOOT_ADMIN_EMAIL="${CHATWOOT_ADMIN_EMAIL:-$(get_env_var CHATWOOT_ADMIN_EMAIL admin@fluvius.local)}"
CHATWOOT_ADMIN_PASSWORD="${CHATWOOT_ADMIN_PASSWORD:-$(get_env_var CHATWOOT_ADMIN_PASSWORD)}"
CHATWOOT_ADMIN_NAME="${CHATWOOT_ADMIN_NAME:-$(get_env_var CHATWOOT_ADMIN_NAME "Fluvius Admin")}"
CHATWOOT_ACCOUNT_NAME="${CHATWOOT_ACCOUNT_NAME:-$(get_env_var CHATWOOT_ACCOUNT_NAME "Fluvius Admin")}"
CHATWOOT_PLATFORM_APP_NAME="${CHATWOOT_PLATFORM_APP_NAME:-$(get_env_var CHATWOOT_PLATFORM_APP_NAME "Fluvius Provisioner")}"

if [ -z "$CHATWOOT_ADMIN_PASSWORD" ]; then
  echo "ERRO: defina CHATWOOT_ADMIN_PASSWORD no .env."
  exit 1
fi

set_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

echo ""
echo "========================================="
echo "  Fluvius — Configuracao automatica"
echo "========================================="
echo ""

if [ "$(get_env_var ALLOW_PRIVATE_WEBHOOK_URLS false)" != "true" ]; then
  echo ">>> [0/4] Habilitando webhooks internos do Docker..."
  set_env_var "ALLOW_PRIVATE_WEBHOOK_URLS" "true"
  $COMPOSE up -d --force-recreate chatwoot sidekiq
  echo ""
fi

echo ">>> [1/4] Aguardando Fluvius ficar pronto..."
for attempt in $(seq 1 60); do
  if $COMPOSE exec -T chatwoot bundle exec rails runner 'puts "ready"' >/dev/null 2>&1; then
    echo "  Fluvius pronto."
    break
  fi
  if [ "$attempt" = "60" ]; then
    echo "ERRO: Fluvius nao ficou pronto a tempo."
    exit 1
  fi
  sleep 5
done

echo ""
echo ">>> [2/4] Criando admin, conta e tokens do Fluvius..."
BOOTSTRAP_OUTPUT="$(
  $COMPOSE exec -T \
    -e BOOTSTRAP_ADMIN_EMAIL="$CHATWOOT_ADMIN_EMAIL" \
    -e BOOTSTRAP_ADMIN_PASSWORD="$CHATWOOT_ADMIN_PASSWORD" \
    -e BOOTSTRAP_ADMIN_NAME="$CHATWOOT_ADMIN_NAME" \
    -e BOOTSTRAP_ACCOUNT_NAME="$CHATWOOT_ACCOUNT_NAME" \
    -e BOOTSTRAP_PLATFORM_APP_NAME="$CHATWOOT_PLATFORM_APP_NAME" \
    chatwoot bundle exec rails runner '
admin_email = ENV.fetch("BOOTSTRAP_ADMIN_EMAIL")
admin_password = ENV.fetch("BOOTSTRAP_ADMIN_PASSWORD")
admin_name = ENV.fetch("BOOTSTRAP_ADMIN_NAME")
account_name = ENV.fetch("BOOTSTRAP_ACCOUNT_NAME")
platform_app_name = ENV.fetch("BOOTSTRAP_PLATFORM_APP_NAME")

account = Account.find_or_create_by!(name: account_name)

user = User.find_or_initialize_by(email: admin_email)
user.name = admin_name
user.password = admin_password
user.password_confirmation = admin_password
user.confirmed_at ||= Time.current if user.respond_to?(:confirmed_at)
user.save!

AccountUser.find_or_create_by!(account: account, user: user) do |account_user|
  account_user.role = :administrator
end

app = PlatformApp.find_or_create_by!(name: platform_app_name)
user_token = user.access_token || AccessToken.create!(owner: user)
platform_token = app.access_token || AccessToken.create!(owner: app)

Redis::Alfred.delete(Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING) if defined?(Redis::Alfred)

puts "ACCOUNT_ID=#{account.id}"
puts "CHATWOOT_USER_ACCESS_TOKEN=#{user_token.token}"
puts "CHATWOOT_PLATFORM_TOKEN=#{platform_token.token}"
'
)"

ACCOUNT_ID="$(printf '%s\n' "$BOOTSTRAP_OUTPUT" | awk -F= '/^ACCOUNT_ID=/{print $2}' | tail -1)"
USER_TOKEN="$(printf '%s\n' "$BOOTSTRAP_OUTPUT" | awk -F= '/^CHATWOOT_USER_ACCESS_TOKEN=/{print $2}' | tail -1)"
PLATFORM_TOKEN="$(printf '%s\n' "$BOOTSTRAP_OUTPUT" | awk -F= '/^CHATWOOT_PLATFORM_TOKEN=/{print $2}' | tail -1)"

if [ -z "$ACCOUNT_ID" ] || [ -z "$USER_TOKEN" ] || [ -z "$PLATFORM_TOKEN" ]; then
  echo "ERRO: nao foi possivel extrair tokens do Fluvius."
  echo "$BOOTSTRAP_OUTPUT"
  exit 1
fi

set_env_var "CHATWOOT_ACCOUNT_ID" "$ACCOUNT_ID"
set_env_var "CHATWOOT_USER_ACCESS_TOKEN" "$USER_TOKEN"
set_env_var "CHATWOOT_PLATFORM_TOKEN" "$PLATFORM_TOKEN"

echo "  Tokens gravados no .env."

echo ""
echo ">>> [3/4] Reiniciando servicos que dependem dos tokens..."
$COMPOSE up -d internal-chat

echo ""
echo ">>> [4/4] Aplicando branding Fluvius..."
BRAND_URL="$(get_env_var CHATWOOT_FRONTEND_URL https://fluvius.finderbit.com.br)" \
COMPOSE_FILE="$COMPOSE_FILE" \
  bash "$VPS_DIR/scripts/apply-fluvius-branding.sh" || \
  echo "  AVISO: branding falhou; verifique logs do Fluvius."

echo ""
echo "Configuracao automatica concluida."
echo "Admin Fluvius: $CHATWOOT_ADMIN_EMAIL"
echo "Manager: $(get_env_var INTERNAL_CHAT_PUBLIC_URL https://chat.fluvius.finderbit.com.br)/manager"
