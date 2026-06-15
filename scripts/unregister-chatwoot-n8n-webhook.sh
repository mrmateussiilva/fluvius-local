#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_URL="${WEBHOOK_URL:-${N8N_WEBHOOK_URL:-https://n8n.corrigeja.com.br/webhook/fluvius-events}}"
ACCOUNT_ID="${ACCOUNT_ID:-1}"

docker compose exec -T chatwoot env \
  WEBHOOK_URL_VALUE="${WEBHOOK_URL}" \
  ACCOUNT_ID_VALUE="${ACCOUNT_ID}" \
  bundle exec rails runner "
    deleted = Webhook.where(account_id: ENV.fetch('ACCOUNT_ID_VALUE').to_i, url: ENV.fetch('WEBHOOK_URL_VALUE')).delete_all
    puts \"Deleted #{deleted} n8n webhook(s)\"
  "
