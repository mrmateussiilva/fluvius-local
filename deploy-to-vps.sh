#!/bin/bash
# =============================================================================
# Script de deploy Fluvius → VPS
# Execute na sua maquina local: bash deploy-to-vps.sh
# =============================================================================
set -eo pipefail

VPS_USER="deploy"
VPS_HOST="191.252.212.61"
VPS_PASS="1234"
VPS_DIR="/home/deploy/fluvius"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAR_FILE="/tmp/fluvius-deploy.tar.gz"

export SSHPASS="$VPS_PASS"
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

# --- Passo 4: Extrair e configurar .env na VPS ---
echo ""
echo ">>> [4/5] Extraindo arquivos e configurando .env na VPS..."
$SSH $VPS_USER@$VPS_HOST "
  set -e
  cd $VPS_DIR
  tar xzf /tmp/fluvius-deploy.tar.gz
  rm /tmp/fluvius-deploy.tar.gz
  cp .env.production .env
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
  docker compose -f docker-compose.prod.yml pull
  echo 'Subindo containers...'
  docker compose -f docker-compose.prod.yml up -d
  echo ''
  echo 'Status dos containers:'
  docker compose -f docker-compose.prod.yml ps
"

echo ""
echo "========================================"
echo "  Deploy concluido!"
echo ""
echo "  Chatwoot:   https://fluvius.finderbit.com.br"
echo "  Evolution:  https://evolution.fluvius.finderbit.com.br"
echo "  Chat:       https://chat.fluvius.finderbit.com.br"
echo ""
echo "  Para acompanhar os logs na VPS:"
echo "  cd $VPS_DIR"
echo "  docker compose -f docker-compose.prod.yml logs -f"
echo "========================================"

# Limpar arquivo temporario local
rm -f "$TAR_FILE"
