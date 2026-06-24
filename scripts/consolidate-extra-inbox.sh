#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$VPS_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
MODE="${MODE:-adopt-instance}"
APPLY="${APPLY:-false}"
FORCE="${FORCE:-false}"
OLD_EXTRA_INBOX_ID="${1:-${OLD_EXTRA_INBOX_ID:-}}"
NEW_EXTRA_INBOX_ID="${2:-${NEW_EXTRA_INBOX_ID:-}}"

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

require_numeric() {
  local label="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "ERRO: $label deve ser numerico. Recebido: ${value:-vazio}" >&2
    exit 1
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE nao encontrado." >&2
  exit 1
fi

require_numeric "OLD_EXTRA_INBOX_ID" "$OLD_EXTRA_INBOX_ID"
require_numeric "NEW_EXTRA_INBOX_ID" "$NEW_EXTRA_INBOX_ID"

if [ "$MODE" != "adopt-instance" ] && [ "$MODE" != "move-history" ] && [ "$MODE" != "move-history-to-old" ]; then
  echo "ERRO: MODE deve ser adopt-instance, move-history ou move-history-to-old. Recebido: $MODE" >&2
  exit 1
fi

POSTGRES_USER="$(get_env_var POSTGRES_USER postgres)"
CHATWOOT_POSTGRES_DB="$(get_env_var CHATWOOT_POSTGRES_DB chatwoot)"
MANAGER_ADMIN_TOKEN="$(get_env_var MANAGER_ADMIN_TOKEN '')"
MANAGER_INTERNAL_URL="${MANAGER_INTERNAL_URL:-http://127.0.0.1:4000}"

cd "$VPS_DIR"

echo ""
echo "=============================================="
echo "  Consolidar inbox extra"
echo "=============================================="
echo "Modo: $MODE"
echo "Apply: $APPLY"
echo "Old extra inbox id: $OLD_EXTRA_INBOX_ID"
echo "New extra inbox id: $NEW_EXTRA_INBOX_ID"
echo ""

summary="$(
  compose exec -T postgres psql \
    -U "$POSTGRES_USER" \
    -d "$CHATWOOT_POSTGRES_DB" \
    -At \
    -F $'\t' \
    -v ON_ERROR_STOP=1 \
    -c "
WITH old_extra AS (
  SELECT * FROM fluvius_client_inboxes WHERE id = $OLD_EXTRA_INBOX_ID
),
new_extra AS (
  SELECT * FROM fluvius_client_inboxes WHERE id = $NEW_EXTRA_INBOX_ID
),
counts AS (
  SELECT
    (SELECT count(*) FROM old_extra) AS old_exists,
    (SELECT count(*) FROM new_extra) AS new_exists,
    (SELECT client_id FROM old_extra) AS old_client_id,
    (SELECT client_id FROM new_extra) AS new_client_id,
    (SELECT inbox_id FROM old_extra) AS old_inbox_id,
    (SELECT inbox_id FROM new_extra) AS new_inbox_id,
    (SELECT instance_name FROM old_extra) AS old_instance_name,
    (SELECT instance_name FROM new_extra) AS new_instance_name,
    (SELECT count(*) FROM messages WHERE inbox_id = (SELECT inbox_id FROM old_extra)) AS old_messages,
    (SELECT count(*) FROM messages WHERE inbox_id = (SELECT inbox_id FROM new_extra)) AS new_messages,
    (SELECT count(*) FROM conversations WHERE inbox_id = (SELECT inbox_id FROM old_extra)) AS old_conversations,
    (SELECT count(*) FROM conversations WHERE inbox_id = (SELECT inbox_id FROM new_extra)) AS new_conversations,
    (
      SELECT count(*)
      FROM contact_inboxes old_ci
      INNER JOIN contact_inboxes new_ci
        ON new_ci.inbox_id = (SELECT inbox_id FROM new_extra)
       AND new_ci.source_id = old_ci.source_id
      WHERE old_ci.inbox_id = (SELECT inbox_id FROM old_extra)
        AND COALESCE(old_ci.source_id, '') <> ''
    ) AS duplicate_contact_sources
)
SELECT
  old_exists,
  new_exists,
  old_client_id,
  new_client_id,
  old_inbox_id,
  new_inbox_id,
  old_instance_name,
  new_instance_name,
  old_messages,
  new_messages,
  old_conversations,
  new_conversations,
  duplicate_contact_sources
FROM counts;
"
)"

IFS=$'\t' read -r old_exists new_exists old_client_id new_client_id old_inbox_id new_inbox_id old_instance_name new_instance_name old_messages new_messages old_conversations new_conversations duplicate_contact_sources <<< "$summary"

if [ "$old_exists" != "1" ] || [ "$new_exists" != "1" ]; then
  echo "ERRO: registros old/new nao encontrados em fluvius_client_inboxes." >&2
  exit 1
fi

if [ "$old_client_id" != "$new_client_id" ]; then
  echo "ERRO: as inboxes pertencem a clientes diferentes ($old_client_id != $new_client_id)." >&2
  exit 1
fi

cat <<INFO
Cliente: $old_client_id
Inbox antiga: $old_inbox_id ($old_instance_name)
Inbox nova:   $new_inbox_id ($new_instance_name)
Mensagens antigas: $old_messages
Mensagens novas:   $new_messages
Conversas antigas: $old_conversations
Conversas novas:   $new_conversations
Contact sources duplicados: $duplicate_contact_sources
INFO

if [ "$APPLY" != "true" ]; then
  cat <<INFO

Dry-run concluido. Nada foi alterado.
Para aplicar:
  MODE=$MODE APPLY=true $0 $OLD_EXTRA_INBOX_ID $NEW_EXTRA_INBOX_ID

Modos:
  adopt-instance       usa a instancia nova na inbox antiga e preserva as conversas antigas
  move-history         move mensagens/conversas da inbox antiga para a nova
  move-history-to-old  move mensagens/conversas da inbox nova para a antiga
INFO
  exit 0
fi

if { [ "$MODE" = "move-history" ] || [ "$MODE" = "move-history-to-old" ]; } && [ "$duplicate_contact_sources" != "0" ] && [ "$FORCE" != "true" ]; then
  echo "ERRO: existem contact_inboxes duplicados entre as inboxes. Use MODE=adopt-instance ou resolva manualmente." >&2
  exit 1
fi

if [ "$MODE" = "move-history" ] && [ "$new_messages" != "0" ] && [ "$FORCE" != "true" ]; then
  echo "ERRO: a inbox nova ja tem mensagens. Use FORCE=true somente se voce aceitou misturar historicos." >&2
  exit 1
fi

if [ "$MODE" = "adopt-instance" ]; then
  compose exec -T postgres psql \
    -U "$POSTGRES_USER" \
    -d "$CHATWOOT_POSTGRES_DB" \
    -v ON_ERROR_STOP=1 \
    -P pager=off \
    -c "
BEGIN;

CREATE TEMP TABLE fluvius_consolidate_new_values AS
SELECT instance_name, status, phone
FROM fluvius_client_inboxes
WHERE id = $NEW_EXTRA_INBOX_ID;

UPDATE channel_api
SET webhook_url = 'http://evolution:8080/chatwoot/webhook/' || (SELECT instance_name FROM fluvius_consolidate_new_values)
WHERE id = (
  SELECT inboxes.channel_id
  FROM inboxes
  INNER JOIN fluvius_client_inboxes old_extra ON old_extra.inbox_id = inboxes.id
  WHERE old_extra.id = $OLD_EXTRA_INBOX_ID
    AND inboxes.channel_type = 'Channel::Api'
);

UPDATE fluvius_client_inboxes
SET instance_name = instance_name || '-superseded-' || id::text,
    integration_status = 'superseded',
    integration_last_error = 'Consolidated into preserved extra inbox',
    updated_at = NOW()
WHERE id = $NEW_EXTRA_INBOX_ID;

UPDATE fluvius_client_inboxes old_extra
SET instance_name = (SELECT instance_name FROM fluvius_consolidate_new_values),
    status = (SELECT status FROM fluvius_consolidate_new_values),
    phone = COALESCE((SELECT phone FROM fluvius_consolidate_new_values), old_extra.phone),
    integration_status = 'ok',
    integration_last_checked_at = NOW(),
    integration_last_error = NULL,
    integration_repaired_at = NOW(),
    updated_at = NOW()
WHERE old_extra.id = $OLD_EXTRA_INBOX_ID;

COMMIT;
"

  if [ -n "$MANAGER_ADMIN_TOKEN" ]; then
    echo "Reaplicando vinculo Evolution/Fluvius na inbox preservada..."
    response_file="$(mktemp)"
    status="$(curl -sS \
      -o "$response_file" \
      -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer $MANAGER_ADMIN_TOKEN" \
      "$MANAGER_INTERNAL_URL/manager/api/clients/$old_client_id/inboxes/$OLD_EXTRA_INBOX_ID/integration/repair" || true)"
    if [ "$status" -ge 200 ] 2>/dev/null && [ "$status" -lt 300 ]; then
      sed 's/^/  /' "$response_file" || true
    else
      echo "AVISO: reparo via Manager falhou (HTTP ${status:-curl_error}). Rode manualmente o reparo da inbox preservada." >&2
      sed 's/^/  /' "$response_file" >&2 || true
    fi
    rm -f "$response_file"
  else
    echo "AVISO: MANAGER_ADMIN_TOKEN vazio; rode o reparo da inbox preservada pelo Manager." >&2
  fi
elif [ "$MODE" = "move-history" ]; then
  compose exec -T postgres psql \
    -U "$POSTGRES_USER" \
    -d "$CHATWOOT_POSTGRES_DB" \
    -v ON_ERROR_STOP=1 \
    -P pager=off \
    -c "
BEGIN;
UPDATE messages SET inbox_id = $new_inbox_id WHERE inbox_id = $old_inbox_id;
UPDATE conversations SET inbox_id = $new_inbox_id WHERE inbox_id = $old_inbox_id;
UPDATE contact_inboxes SET inbox_id = $new_inbox_id WHERE inbox_id = $old_inbox_id;
COMMIT;
"
else
  compose exec -T postgres psql \
    -U "$POSTGRES_USER" \
    -d "$CHATWOOT_POSTGRES_DB" \
    -v ON_ERROR_STOP=1 \
    -P pager=off \
    -c "
BEGIN;
UPDATE messages SET inbox_id = $old_inbox_id WHERE inbox_id = $new_inbox_id;
UPDATE conversations SET inbox_id = $old_inbox_id WHERE inbox_id = $new_inbox_id;
UPDATE contact_inboxes SET inbox_id = $old_inbox_id WHERE inbox_id = $new_inbox_id;
COMMIT;
"
fi

echo "Consolidacao aplicada. Rode o reparo da integracao no registro preservado e teste envio."
