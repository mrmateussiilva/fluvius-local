#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$VPS_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
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

validate_instance_name() {
  local instance_name="$1"
  if [[ ! "$instance_name" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "ERRO: nome de instancia invalido: $instance_name" >&2
    echo "Use apenas letras, numeros, ponto, underscore ou hifen." >&2
    exit 1
  fi
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

count_update() {
  local database="$1"
  shift
  psql_db "$database" -At "$@" | tr -d '[:space:]'
}

repair_instance() {
  local instance_name="$1"
  local account_id="$2"
  local instance_id
  local conversation_ids
  local message_ids
  local fixed_conversations=0
  local fixed_messages=0
  local fixed_contact_sources=0

  validate_instance_name "$instance_name"
  echo ">>> Instancia: $instance_name"

  instance_id="$(
    psql_db "$EVOLUTION_POSTGRES_DB" -At \
      -v instance_name="$instance_name" \
      -c 'SELECT id FROM "Instance" WHERE name = :'\''instance_name'\'' LIMIT 1;'
  )"

  if [ -z "$instance_id" ]; then
    echo "  AVISO: instancia nao encontrada no banco Evolution."
    echo ""
    return 0
  fi

  conversation_ids="$(
    psql_db "$EVOLUTION_POSTGRES_DB" -At \
      -v instance_id="$instance_id" \
      -c 'SELECT DISTINCT "chatwootConversationId"
          FROM "Message"
          WHERE "instanceId" = :'\''instance_id'\''
            AND COALESCE("chatwootConversationId", 0) > 0
          ORDER BY 1;'
  )"

  while IFS= read -r conversation_id; do
    [ -n "$conversation_id" ] || continue
    [[ "$conversation_id" =~ ^[0-9]+$ ]] || continue

    local exists
    exists="$(
      psql_db "$CHATWOOT_POSTGRES_DB" -At \
        -v conversation_id="$conversation_id" \
        -v account_id="$account_id" \
        -c 'SELECT 1
            FROM conversations
            WHERE id = :conversation_id::bigint
              AND (NULLIF(:'\''account_id'\'', '\'''\'' ) IS NULL OR account_id = NULLIF(:'\''account_id'\'', '\'''\'' )::bigint)
            LIMIT 1;'
    )"

    if [ "$exists" = "1" ]; then
      continue
    fi

    local updated
    updated="$(
      count_update "$EVOLUTION_POSTGRES_DB" \
        -v instance_id="$instance_id" \
        -v conversation_id="$conversation_id" \
        -c 'WITH fixed AS (
              UPDATE "Message"
              SET
                "chatwootMessageId" = NULL,
                "chatwootInboxId" = NULL,
                "chatwootConversationId" = NULL,
                "chatwootContactInboxSourceId" = NULL,
                "chatwootIsRead" = false
              WHERE "instanceId" = :'\''instance_id'\''
                AND "chatwootConversationId" = :conversation_id::bigint
              RETURNING 1
            )
            SELECT COUNT(*) FROM fixed;'
    )"
    fixed_conversations=$((fixed_conversations + updated))
    echo "  Conversa apagada no Fluvius: $conversation_id; referencias limpas em $updated mensagens."
  done <<< "$conversation_ids"

  message_ids="$(
    psql_db "$EVOLUTION_POSTGRES_DB" -At \
      -v instance_id="$instance_id" \
      -c 'SELECT DISTINCT "chatwootMessageId"
          FROM "Message"
          WHERE "instanceId" = :'\''instance_id'\''
            AND COALESCE("chatwootMessageId", 0) > 0
          ORDER BY 1;'
  )"

  while IFS= read -r message_id; do
    [ -n "$message_id" ] || continue
    [[ "$message_id" =~ ^[0-9]+$ ]] || continue

    local exists
    exists="$(
      psql_db "$CHATWOOT_POSTGRES_DB" -At \
        -v message_id="$message_id" \
        -v account_id="$account_id" \
        -c 'SELECT 1
            FROM messages
            WHERE id = :message_id::bigint
              AND (NULLIF(:'\''account_id'\'', '\'''\'' ) IS NULL OR account_id = NULLIF(:'\''account_id'\'', '\'''\'' )::bigint)
            LIMIT 1;'
    )"

    if [ "$exists" = "1" ]; then
      continue
    fi

    local updated
    updated="$(
      count_update "$EVOLUTION_POSTGRES_DB" \
        -v instance_id="$instance_id" \
        -v message_id="$message_id" \
        -c 'WITH fixed AS (
              UPDATE "Message"
              SET
                "chatwootMessageId" = NULL,
                "chatwootIsRead" = false
              WHERE "instanceId" = :'\''instance_id'\''
                AND "chatwootMessageId" = :message_id::bigint
              RETURNING 1
            )
            SELECT COUNT(*) FROM fixed;'
    )"
    fixed_messages=$((fixed_messages + updated))
  done <<< "$message_ids"

  fixed_contact_sources="$(
    count_update "$EVOLUTION_POSTGRES_DB" \
      -v instance_id="$instance_id" \
      -c 'WITH fixed AS (
            UPDATE "Message"
            SET "chatwootContactInboxSourceId" = NULL
            WHERE "instanceId" = :'\''instance_id'\''
              AND "chatwootContactInboxSourceId" IS NOT NULL
              AND COALESCE("chatwootConversationId", 0) = 0
            RETURNING 1
          )
          SELECT COUNT(*) FROM fixed;'
  )"

  echo "  Resumo: mensagens com conversa orfa=$fixed_conversations, mensagens orfas=$fixed_messages, contact source limpo=$fixed_contact_sources"
  echo ""
}

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE nao encontrado." >&2
  exit 1
fi

if [ -n "$INSTANCE_FILTER" ]; then
  validate_instance_name "$INSTANCE_FILTER"
fi

POSTGRES_USER="$(get_env_var POSTGRES_USER chatwoot)"
CHATWOOT_POSTGRES_DB="$(get_env_var CHATWOOT_POSTGRES_DB chatwoot)"
EVOLUTION_POSTGRES_DB="$(get_env_var EVOLUTION_POSTGRES_DB evolution)"

cd "$VPS_DIR"

where_clause="WHERE instance_name IS NOT NULL AND instance_name <> ''"
if [ -n "$INSTANCE_FILTER" ]; then
  where_clause="$where_clause AND instance_name = '$INSTANCE_FILTER'"
fi

clients="$(
  psql_db "$CHATWOOT_POSTGRES_DB" \
    -At \
    -F $'\t' \
    -c "SELECT
          instance_name,
          COALESCE(chatwoot_account_id::text, '')
        FROM fluvius_clients
        $where_clause
        ORDER BY id;"
)"

if [ -z "$clients" ]; then
  echo "Nenhuma instancia encontrada em fluvius_clients."
  exit 0
fi

echo ""
echo "======================================================="
echo "  Reparar conversas apagadas Fluvius/Evolution"
echo "======================================================="
echo "Compose: $COMPOSE_FILE"
echo ""

while IFS=$'\t' read -r instance_name account_id; do
  repair_instance "$instance_name" "$account_id"
done <<< "$clients"

echo "Reparo concluido."
echo "Agora envie uma nova mensagem pelo WhatsApp e teste responder pelo Fluvius."
echo "Se o erro persistir, reinicie a Evolution: docker compose -f $COMPOSE_FILE restart evolution"
