#!/bin/bash
# =============================================================================
# Script de Setup Pós-Boot — Fluvius VPS
#
# Execute na VPS DEPOIS que o Chatwoot já subiu e você criou a conta admin:
#
#   1. Acesse https://fluvius.finderbit.com.br e crie a conta administrador
#   2. Vá em Configurações → Perfil → Token de Acesso à API, copie o token
#   3. Acesse https://fluvius.finderbit.com.br/super_admin → Platform Apps
#      → New Platform App → copie o Access Token gerado
#   4. Execute este script:
#      CHATWOOT_TOKEN=seu-token PLATFORM_TOKEN=seu-platform-token bash scripts/post-boot-setup.sh
# =============================================================================
set -eo pipefail

VPS_DIR="${VPS_DIR:-/opt/fluvius}"
COMPOSE="docker compose -f $VPS_DIR/docker-compose.prod.yml"

# Recebe os tokens via argumento ou variável de ambiente
CHATWOOT_TOKEN="${CHATWOOT_USER_ACCESS_TOKEN:-$1}"
PLATFORM_TOKEN="${CHATWOOT_PLATFORM_TOKEN:-$2}"

if [ -z "$CHATWOOT_TOKEN" ] || [ -z "$PLATFORM_TOKEN" ]; then
  echo ""
  echo "ERRO: Forneça os dois tokens."
  echo ""
  echo "Uso:"
  echo "  CHATWOOT_USER_ACCESS_TOKEN=xxx CHATWOOT_PLATFORM_TOKEN=yyy bash scripts/post-boot-setup.sh"
  echo ""
  echo "Como obter:"
  echo "  1. Token de usuário: Chatwoot → Configurações → Perfil → Token de Acesso à API"
  echo "  2. Platform token: Chatwoot → /super_admin → Platform Apps → New Platform App"
  echo ""
  exit 1
fi

ENV_FILE="$VPS_DIR/.env"

echo ""
echo "========================================="
echo "  Fluvius — Setup Pós-Boot"
echo "========================================="
echo ""

# --- Atualizar .env com os tokens ---
echo ">>> [1/4] Atualizando tokens no .env..."

# Função para setar ou adicionar uma variável no .env
set_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

set_env_var "CHATWOOT_USER_ACCESS_TOKEN" "$CHATWOOT_TOKEN"
set_env_var "CHATWOOT_PLATFORM_TOKEN" "$PLATFORM_TOKEN"

echo "  ✓ Tokens salvos no .env"

# --- Reiniciar o internal-chat para pegar os tokens ---
echo ""
echo ">>> [2/4] Reiniciando internal-chat com os novos tokens..."
cd "$VPS_DIR"
$COMPOSE up -d internal-chat
sleep 5
echo "  ✓ internal-chat reiniciado"

# --- Aplicar branding Fluvius ---
echo ""
echo ">>> [3/4] Aplicando branding Fluvius..."
bash "$VPS_DIR/scripts/apply-fluvius-branding.sh" && echo "  ✓ Branding aplicado" || echo "  ⚠ Branding falhou (pode ser normal se o Chatwoot ainda está iniciando)"

# --- Verificar saúde do sistema ---
echo ""
echo ">>> [4/4] Verificando saúde dos serviços..."
sleep 3

check_url() {
  local name="$1"
  local url="$2"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
  if [ "$status" = "200" ] || [ "$status" = "301" ] || [ "$status" = "302" ]; then
    echo "  ✓ $name ($status)"
  else
    echo "  ✗ $name ($status) — pode ainda estar iniciando"
  fi
}

CHATWOOT_URL=$(grep "^CHATWOOT_FRONTEND_URL=" "$ENV_FILE" | cut -d= -f2-)
EVOLUTION_URL=$(grep "^EVOLUTION_SERVER_URL=" "$ENV_FILE" | cut -d= -f2-)
CHAT_URL=$(grep "^INTERNAL_CHAT_PUBLIC_URL=" "$ENV_FILE" | cut -d= -f2-)

check_url "Chatwoot" "${CHATWOOT_URL:-https://fluvius.finderbit.com.br}"
check_url "Evolution API" "${EVOLUTION_URL:-https://evolution.fluvius.finderbit.com.br}"
check_url "Manager" "${CHAT_URL:-https://chat.fluvius.finderbit.com.br}/manager"

echo ""
echo "========================================="
echo "  Setup concluído!"
echo ""
echo "  Acesse o Manager para criar o primeiro cliente:"
echo "  ${CHAT_URL:-https://chat.fluvius.finderbit.com.br}/manager"
echo "========================================="
