#!/usr/bin/env sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-postgres}" -d "${CHATWOOT_POSTGRES_DB:-chatwoot}" \
  | gzip > "$BACKUP_DIR/chatwoot-$TIMESTAMP.sql.gz"

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-postgres}" -d "${EVOLUTION_POSTGRES_DB:-evolution}" \
  | gzip > "$BACKUP_DIR/evolution-$TIMESTAMP.sql.gz"

echo "Backups created in $BACKUP_DIR"
