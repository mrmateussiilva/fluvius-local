#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$VPS_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
INSTANCE_NAME="${1:-}"
REPAIR_LINK="${REPAIR_LINK:-true}"
CLEAN_ORPHANS="${CLEAN_ORPHANS:-true}"
IMPORT_HISTORY="${IMPORT_HISTORY:-true}"
RESTART_EVOLUTION="${RESTART_EVOLUTION:-false}"

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

manager_post() {
  local path="$1"
  local response_file
  local status
  local curl_args=(
    -sS
    -o
  )

  response_file="$(mktemp)"
  curl_args+=("$response_file" -w '%{http_code}' -X POST)
  if [ -n "$MANAGER_ADMIN_TOKEN" ]; then
    curl_args+=(-H "Authorization: Bearer $MANAGER_ADMIN_TOKEN")
  fi
  curl_args+=("http://127.0.0.1:4000$path")

  status="$(curl "${curl_args[@]}")"
  cat "$response_file"
  rm -f "$response_file"

  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "" >&2
    echo "ERRO: Manager retornou HTTP $status em $path" >&2
    return 1
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE nao encontrado." >&2
  exit 1
fi

if [ -z "$INSTANCE_NAME" ]; then
  echo "Uso: bash scripts/repair-whatsapp-incoming.sh NomeDaInstancia" >&2
  echo "Exemplo: bash scripts/repair-whatsapp-incoming.sh fluvius-finderbit-mq7g2k0o" >&2
  exit 1
fi

validate_instance_name "$INSTANCE_NAME"

POSTGRES_USER="$(get_env_var POSTGRES_USER chatwoot)"
CHATWOOT_POSTGRES_DB="$(get_env_var CHATWOOT_POSTGRES_DB chatwoot)"
EVOLUTION_POSTGRES_DB="$(get_env_var EVOLUTION_POSTGRES_DB evolution)"
MANAGER_ADMIN_TOKEN="$(get_env_var MANAGER_ADMIN_TOKEN)"

cd "$VPS_DIR"

echo ""
echo "======================================================="
echo "  Reparar entrada WhatsApp -> Evolution -> Fluvius"
echo "======================================================="
echo "Compose: $COMPOSE_FILE"
echo "Instancia: $INSTANCE_NAME"
echo ""

client_id="$(
  psql_db "$CHATWOOT_POSTGRES_DB" -At \
    -c "SELECT id FROM fluvius_clients WHERE instance_name = '$INSTANCE_NAME' LIMIT 1;"
)"

if [ -z "$client_id" ]; then
  echo "ERRO: cliente nao encontrado em fluvius_clients para instance_name=$INSTANCE_NAME" >&2
  exit 1
fi

instance_id="$(
  psql_db "$EVOLUTION_POSTGRES_DB" -At \
    -c "SELECT id FROM \"Instance\" WHERE name = '$INSTANCE_NAME' LIMIT 1;"
)"

if [ -z "$instance_id" ]; then
  echo "ERRO: instancia nao encontrada no banco Evolution: $INSTANCE_NAME" >&2
  exit 1
fi

echo "Cliente Manager: $client_id"
echo "Evolution instance id: $instance_id"
echo ""

echo "Ultimas mensagens registradas na Evolution:"
psql_db "$EVOLUTION_POSTGRES_DB" \
  -c "SELECT
        id,
        key->>'id' AS wa_id,
        COALESCE(key->>'remoteJidAlt', key->>'remoteJid') AS remote_jid,
        key->>'fromMe' AS from_me,
        \"messageType\",
        to_timestamp(\"messageTimestamp\") AT TIME ZONE 'UTC' AS message_utc,
        \"chatwootMessageId\",
        \"chatwootConversationId\",
        \"chatwootInboxId\"
      FROM \"Message\"
      WHERE \"instanceId\" = '$instance_id'
      ORDER BY \"messageTimestamp\" DESC, id DESC
      LIMIT 20;"
echo ""

if [ "$CLEAN_ORPHANS" = "true" ]; then
  echo "Limpando referencias orfas da Evolution..."
  bash scripts/repair-deleted-chatwoot-conversations.sh "$INSTANCE_NAME"
  echo ""
fi

if [ "$REPAIR_LINK" = "true" ]; then
  echo "Reparando link Evolution <-> Fluvius..."
  VPS_DIR="$VPS_DIR" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
    bash scripts/repair-evolution-chatwoot-link.sh "$INSTANCE_NAME"
  echo ""
fi

if [ "$IMPORT_HISTORY" = "true" ]; then
  echo "Importando/relinkando historico da Evolution para o Fluvius..."
  manager_post "/manager/api/clients/$client_id/import-history"
  echo ""
fi

if [ "$RESTART_EVOLUTION" = "true" ]; then
  echo "Reiniciando Evolution..."
  compose restart evolution
  echo ""
fi

echo "Resumo depois do reparo:"
psql_db "$EVOLUTION_POSTGRES_DB" \
  -c "SELECT
        COUNT(*) FILTER (WHERE COALESCE(key->>'fromMe', 'false') = 'false') AS incoming_total,
        COUNT(*) FILTER (
          WHERE COALESCE(key->>'fromMe', 'false') = 'false'
            AND COALESCE(\"chatwootMessageId\", 0) > 0
        ) AS incoming_com_chatwoot_message,
        COUNT(*) FILTER (
          WHERE COALESCE(key->>'fromMe', 'false') = 'false'
            AND COALESCE(\"chatwootMessageId\", 0) = 0
        ) AS incoming_sem_chatwoot_message
      FROM \"Message\"
      WHERE \"instanceId\" = '$instance_id';"

echo ""
echo "Teste agora:"
echo "1. Envie uma nova mensagem pelo WhatsApp para essa instancia."
echo "2. Recarregue a conversa no Fluvius."
echo "3. Se ainda nao aparecer, rode:"
echo "   docker compose -f $COMPOSE_FILE logs --tail=150 chatwoot"
echo "   docker compose -f $COMPOSE_FILE logs --tail=150 evolution"
