#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-$(pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$VPS_DIR/docker-compose.prod.yml}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-internal-chat}"
UPDATE_SCOPE="${UPDATE_SCOPE:-service}"
RUN_AUTO_CONFIGURE="${RUN_AUTO_CONFIGURE:-false}"
FORCE="${FORCE:-false}"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "ERRO: comando nao encontrado: $name" >&2
    exit 1
  fi
}

cd "$VPS_DIR"

require_command git
require_command docker

if [ ! -d .git ]; then
  echo "ERRO: $VPS_DIR nao e um repositorio git." >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "ERRO: compose nao encontrado: $COMPOSE_FILE" >&2
  exit 1
fi

if [ "$FORCE" != "true" ] && [ -n "$(git status --porcelain)" ]; then
  echo "ERRO: existem mudancas locais no repositorio da VPS." >&2
  echo "Revise com: git status" >&2
  echo "Se tiver certeza, rode com FORCE=true." >&2
  exit 1
fi

if [ -f .env ]; then
  mkdir -p backups
  backup="backups/env.backup.$(date +%Y%m%d-%H%M%S)"
  cp .env "$backup"
  chmod 600 "$backup" 2>/dev/null || true
  echo "Backup do .env criado: $backup"
else
  echo "AVISO: .env nao encontrado em $VPS_DIR"
fi

echo ""
echo "Atualizando codigo..."
echo "Diretorio: $VPS_DIR"
echo "Remote/branch: $REMOTE/$BRANCH"
git fetch "$REMOTE" "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only "$REMOTE" "$BRANCH"

echo ""
if [ "$UPDATE_SCOPE" = "full" ] || [ "$SERVICE" = "all" ]; then
  echo "Atualizacao completa da stack"
  echo "Baixando imagens externas..."
  compose pull --ignore-buildable || true
  echo "Rebuild dos servicos buildaveis..."
  compose build chatwoot sidekiq internal-chat
  echo "Subindo stack completa..."
  compose up -d
else
  echo "Rebuild/restart do servico: $SERVICE"
  compose build "$SERVICE"
  compose up -d "$SERVICE"
fi

if [ "$RUN_AUTO_CONFIGURE" = "true" ]; then
  echo ""
  echo "Rodando auto-configure-production..."
  VPS_DIR="$VPS_DIR" ENV_FILE="$VPS_DIR/.env" COMPOSE_FILE="$COMPOSE_FILE" \
    bash scripts/auto-configure-production.sh
fi

echo ""
echo "Status dos containers:"
compose ps

echo ""
echo "Health do internal-chat:"
if command -v curl >/dev/null 2>&1; then
  curl -fsS http://127.0.0.1:4000/manager/api/health || true
  echo ""
else
  echo "curl nao encontrado; pulando healthcheck HTTP."
fi

echo ""
if [ "$UPDATE_SCOPE" = "full" ] || [ "$SERVICE" = "all" ]; then
  echo "Logs recentes da stack:"
  compose logs --tail=80 chatwoot sidekiq internal-chat evolution
else
  echo "Logs recentes do $SERVICE:"
  compose logs --tail=80 "$SERVICE"
fi

echo ""
echo "Update concluido."
