#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_URL="${WEBHOOK_URL:-${N8N_WEBHOOK_URL:-https://n8n.corrigeja.com.br/webhook/chatwoot-events}}"
WEBHOOK_NAME="${WEBHOOK_NAME:-Fluvius n8n events}"
ACCOUNT_ID="${ACCOUNT_ID:-1}"

docker compose exec -T chatwoot env \
  WEBHOOK_URL_VALUE="${WEBHOOK_URL}" \
  WEBHOOK_NAME_VALUE="${WEBHOOK_NAME}" \
  ACCOUNT_ID_VALUE="${ACCOUNT_ID}" \
  bundle exec rails runner "
    account_id = ENV.fetch('ACCOUNT_ID_VALUE').to_i
    url = ENV.fetch('WEBHOOK_URL_VALUE')
    name = ENV.fetch('WEBHOOK_NAME_VALUE')

    webhook = Webhook.where(account_id: account_id, url: url).first_or_initialize
    webhook.name = name if webhook.respond_to?(:name=)
    webhook.webhook_type = 'account_type' if webhook.respond_to?(:webhook_type=)
    webhook.subscriptions = %w[
      conversation_created
      conversation_updated
      conversation_status_changed
      message_created
      message_updated
      contact_created
      contact_updated
    ]
    webhook.save!

    puts({ id: webhook.id, account_id: webhook.account_id, url: webhook.url, subscriptions: webhook.subscriptions }.to_json)
  "
