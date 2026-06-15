#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ADMIN_EMAIL="${CHATWOOT_BOOTSTRAP_ADMIN_EMAIL:-admin@fluvius.local}"
ADMIN_PASSWORD="${CHATWOOT_BOOTSTRAP_ADMIN_PASSWORD:-Admin123!}"
ACCOUNT_NAME="${CHATWOOT_BOOTSTRAP_ACCOUNT_NAME:-Fluvius Admin}"
PLATFORM_APP_NAME="${CHATWOOT_BOOTSTRAP_PLATFORM_APP_NAME:-Fluvius Provisioner}"

echo "Bootstrapping Fluvius local admin and tokens..."

OUTPUT="$(
  docker compose exec -T \
    -e BOOTSTRAP_ADMIN_EMAIL="$ADMIN_EMAIL" \
    -e BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    -e BOOTSTRAP_ACCOUNT_NAME="$ACCOUNT_NAME" \
    -e BOOTSTRAP_PLATFORM_APP_NAME="$PLATFORM_APP_NAME" \
    chatwoot bundle exec rails runner '
admin_email = ENV.fetch("BOOTSTRAP_ADMIN_EMAIL")
admin_password = ENV.fetch("BOOTSTRAP_ADMIN_PASSWORD")
account_name = ENV.fetch("BOOTSTRAP_ACCOUNT_NAME")
platform_app_name = ENV.fetch("BOOTSTRAP_PLATFORM_APP_NAME")

account = Account.find_or_create_by!(name: account_name)
user = User.find_or_initialize_by(email: admin_email)
user.name = account_name
if user.encrypted_password.blank?
  user.password = admin_password
  user.password_confirmation = admin_password
end
user.confirmed_at ||= Time.current if user.respond_to?(:confirmed_at)
user.save!

AccountUser.find_or_create_by!(account: account, user: user) do |account_user|
  account_user.role = :administrator
end

app = PlatformApp.find_or_create_by!(name: platform_app_name)
user_token = user.access_token || AccessToken.create!(owner: user)
platform_token = app.access_token || AccessToken.create!(owner: app)

Redis::Alfred.delete(Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)

puts "ACCOUNT_ID=#{account.id}"
puts "ADMIN_EMAIL=#{admin_email}"
puts "ADMIN_PASSWORD=#{admin_password}"
puts "CHATWOOT_USER_ACCESS_TOKEN=#{user_token.token}"
puts "CHATWOOT_PLATFORM_TOKEN=#{platform_token.token}"
'
)"

echo "$OUTPUT"

ACCOUNT_ID="$(printf '%s\n' "$OUTPUT" | awk -F= '/^ACCOUNT_ID=/{print $2}' | tail -1)"
USER_TOKEN="$(printf '%s\n' "$OUTPUT" | awk -F= '/^CHATWOOT_USER_ACCESS_TOKEN=/{print $2}' | tail -1)"
PLATFORM_TOKEN="$(printf '%s\n' "$OUTPUT" | awk -F= '/^CHATWOOT_PLATFORM_TOKEN=/{print $2}' | tail -1)"

if [[ -z "$ACCOUNT_ID" || -z "$USER_TOKEN" || -z "$PLATFORM_TOKEN" ]]; then
  echo "Failed to extract bootstrap tokens from Fluvius output." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo ".env not found. Create it before running this script." >&2
  exit 1
fi

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

set_env CHATWOOT_ACCOUNT_ID "$ACCOUNT_ID"
set_env CHATWOOT_USER_ACCESS_TOKEN "$USER_TOKEN"
set_env CHATWOOT_PLATFORM_TOKEN "$PLATFORM_TOKEN"

docker compose up -d internal-chat

echo "Fluvius bootstrap complete."
echo "Admin: ${ADMIN_EMAIL}"
echo "Password: ${ADMIN_PASSWORD}"
