#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${1:-Finderbit}"

if [[ ! "${INSTANCE_NAME}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid instance name: ${INSTANCE_NAME}" >&2
  echo "Use only letters, numbers, dot, underscore or dash." >&2
  exit 1
fi

CHATWOOT_WEBHOOK_URL="http://evolution:8080/chatwoot/webhook/${INSTANCE_NAME}"
WEBHOOK_TIMEOUT="${WEBHOOK_TIMEOUT:-30}"

echo "Updating Fluvius API inbox webhook to ${CHATWOOT_WEBHOOK_URL}"
docker compose exec -T postgres psql -U postgres -d chatwoot \
  -v ON_ERROR_STOP=1 \
  -c "UPDATE channel_api
      SET webhook_url = '${CHATWOOT_WEBHOOK_URL}'
      WHERE webhook_url LIKE '%/chatwoot/webhook/${INSTANCE_NAME}'
         OR id = 1;
      SELECT id, webhook_url FROM channel_api;"

echo "Setting Fluvius WEBHOOK_TIMEOUT=${WEBHOOK_TIMEOUT}"
docker compose exec -T chatwoot bundle exec rails runner "
  config = InstallationConfig.where(name: 'WEBHOOK_TIMEOUT').first_or_initialize
  config.value = ENV.fetch('WEBHOOK_TIMEOUT', '${WEBHOOK_TIMEOUT}')
  config.locked = false
  config.save!
  GlobalConfig.clear_cache
  puts \"WEBHOOK_TIMEOUT=#{GlobalConfig.get_value('WEBHOOK_TIMEOUT')}\"
"

echo "Done."
