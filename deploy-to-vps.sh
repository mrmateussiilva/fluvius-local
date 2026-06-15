#!/bin/bash
# =============================================================================
# Script de deploy Fluvius → VPS
# Execute na sua maquina local: bash deploy-to-vps.sh
#
# Variaveis de ambiente:
#   VPS_HOST  — IP ou hostname da VPS (default: 191.252.212.61)
#   VPS_USER  — usuario SSH (default: deploy; use root se nao houver usuario deploy)
#   SSHPASS   — senha SSH (lida do ambiente, nao coloque aqui!)
#   ENV_FILE  — arquivo de ambiente para enviar (default: .env.production ou .env)
# =============================================================================
set -eo pipefail

VPS_USER="${VPS_USER:-deploy}"
VPS_HOST="${VPS_HOST:-191.252.212.61}"
VPS_DIR="/opt/fluvius"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAR_FILE="/tmp/fluvius-deploy.tar.gz"
ENV_SOURCE="${ENV_FILE:-}"

if [ -z "$SSHPASS" ]; then
  echo "ERRO: defina a variavel SSHPASS com a senha SSH antes de rodar."
  echo "  export SSHPASS=sua-senha && bash deploy-to-vps.sh"
  exit 1
fi

if [ -z "$ENV_SOURCE" ]; then
  if [ -f "$PROJECT_DIR/.env.production" ]; then
    ENV_SOURCE="$PROJECT_DIR/.env.production"
  elif [ -f "$PROJECT_DIR/.env" ]; then
    ENV_SOURCE="$PROJECT_DIR/.env"
  fi
fi

if [ -z "$ENV_SOURCE" ] || [ ! -f "$ENV_SOURCE" ]; then
  echo "ERRO: informe um arquivo .env valido."
  echo "  ENV_FILE=/caminho/.env.production SSHPASS=sua-senha bash deploy-to-vps.sh"
  exit 1
fi

SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o BatchMode=no"
SCP="sshpass -e scp -o StrictHostKeyChecking=no -o BatchMode=no"

echo ""
echo "========================================"
echo "  Fluvius Deploy → $VPS_USER@$VPS_HOST"
echo "========================================"
echo ""

# --- Passo 1: Verificar conexao e Docker na VPS ---
echo ">>> [1/5] Verificando conexao e Docker na VPS..."
$SSH $VPS_USER@$VPS_HOST "echo 'SSH OK' && docker --version && docker compose version" || {
  echo "ERRO: Falha ao conectar ou Docker nao encontrado na VPS."
  exit 1
}

# --- Passo 2: Empacotar projeto localmente ---
echo ""
echo ">>> [2/5] Empacotando arquivos localmente..."
rm -f "$TAR_FILE"
tar czf "$TAR_FILE" \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./node_modules' \
  --exclude='./backups' \
  --exclude='./chatwoot-custom/node_modules' \
  --exclude='./internal-chat/node_modules' \
  -C "$PROJECT_DIR" .
echo "Pacote criado: $TAR_FILE ($(du -sh $TAR_FILE | cut -f1))"

# --- Passo 3: Enviar o pacote via SCP ---
echo ""
echo ">>> [3/5] Enviando pacote para a VPS via SCP..."
$SSH $VPS_USER@$VPS_HOST "mkdir -p $VPS_DIR"
$SCP "$TAR_FILE" "$VPS_USER@$VPS_HOST:/tmp/fluvius-deploy.tar.gz"
$SCP "$ENV_SOURCE" "$VPS_USER@$VPS_HOST:/tmp/fluvius.env"

# --- Passo 4: Extrair e configurar .env na VPS ---
echo ""
echo ">>> [4/5] Extraindo arquivos e configurando .env na VPS..."
$SSH $VPS_USER@$VPS_HOST "
  set -e
  mkdir -p $VPS_DIR
  cd $VPS_DIR
  tar xzf /tmp/fluvius-deploy.tar.gz
  rm /tmp/fluvius-deploy.tar.gz

  if [ -f /tmp/fluvius.env ]; then
    if [ -f .env ]; then
      cp .env .env.backup.\$(date +%Y%m%d-%H%M%S)
      echo 'INFO: backup do .env anterior criado.'
    fi
    cp /tmp/fluvius.env .env
    rm /tmp/fluvius.env
    chmod 600 .env
    echo 'INFO: .env atualizado a partir do arquivo local informado.'
  else
    echo 'ERRO: /tmp/fluvius.env nao encontrado.'
    exit 1
  fi

  if [ \"\$(id -u)\" = \"0\" ]; then
    cp $VPS_DIR/Caddyfile /etc/caddy/Caddyfile
    systemctl reload caddy
    echo 'INFO: Caddyfile aplicado.'
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n cp $VPS_DIR/Caddyfile /etc/caddy/Caddyfile 2>/dev/null && \
    sudo -n systemctl reload caddy 2>/dev/null && \
    echo 'INFO: Caddyfile aplicado.' || \
    echo 'AVISO: nao foi possivel aplicar o Caddyfile automaticamente.'
  fi

  echo 'Arquivos extraidos:'
  ls -la $VPS_DIR/
"

# --- Passo 5: Subir a stack ---
echo ""
echo ">>> [5/5] Baixando imagens e subindo a stack na VPS..."
echo "    (Isso pode levar varios minutos para baixar as imagens...)"
$SSH $VPS_USER@$VPS_HOST "
  set -e
  cd $VPS_DIR
  echo 'Baixando imagens Docker...'
  docker compose -f docker-compose.prod.yml pull --ignore-buildable || true
  echo 'Subindo containers...'
  docker compose -f docker-compose.prod.yml up -d
  echo 'Configurando Fluvius e Manager automaticamente...'
  bash scripts/auto-configure-production.sh
  echo ''
  echo 'Status dos containers:'
  docker compose -f docker-compose.prod.yml ps
"

echo ""
echo "========================================"
echo "  Deploy concluido!"
echo ""
echo "  Fluvius:   https://fluvius.finderbit.com.br"
echo "  Evolution:  https://evolution.fluvius.finderbit.com.br"
echo "  Manager:    https://chat.fluvius.finderbit.com.br/manager"
echo ""
echo "  Para acompanhar os logs na VPS:"
echo "  ssh $VPS_USER@$VPS_HOST 'cd $VPS_DIR && docker compose -f docker-compose.prod.yml logs -f'"
echo "========================================"

# Limpar arquivo temporario local
rm -f "$TAR_FILE"
