#!/bin/bash
# =============================================================================
# Script de deploy Fluvius → VPS
# Execute na sua maquina local: bash deploy-to-vps.sh
#
# Variaveis de ambiente:
#   VPS_HOST  — IP ou hostname da VPS (default: 191.252.212.61)
#   VPS_USER  — usuario SSH (default: deploy)
#   SSHPASS   — senha SSH (lida do ambiente, nao coloque aqui!)
# =============================================================================
set -eo pipefail

VPS_USER="${VPS_USER:-deploy}"
VPS_HOST="${VPS_HOST:-191.252.212.61}"
VPS_DIR="/opt/fluvius"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAR_FILE="/tmp/fluvius-deploy.tar.gz"

if [ -z "$SSHPASS" ]; then
  echo "ERRO: defina a variavel SSHPASS com a senha SSH antes de rodar."
  echo "  export SSHPASS=sua-senha && bash deploy-to-vps.sh"
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

# --- Passo 4: Extrair e configurar .env na VPS ---
echo ""
echo ">>> [4/5] Extraindo arquivos e configurando .env na VPS..."
$SSH $VPS_USER@$VPS_HOST "
  set -e
  mkdir -p $VPS_DIR
  cd $VPS_DIR
  tar xzf /tmp/fluvius-deploy.tar.gz
  rm /tmp/fluvius-deploy.tar.gz

  # Copia o .env de producao se ainda nao existe
  if [ ! -f .env ]; then
    if [ -f .env.production ]; then
      cp .env.production .env
      echo 'AVISO: .env criado a partir de .env.production. Revise as variaveis!'
    else
      echo 'AVISO: .env nao encontrado. Crie manualmente em $VPS_DIR/.env'
    fi
  else
    echo 'INFO: .env existente mantido (nao sobrescrito).'
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
echo "  Manager:    https://chat.fluvius.finderbit.com.br/manager"
echo ""
echo "  Proximos passos:"
echo "  1. Acesse https://fluvius.finderbit.com.br e crie a conta admin do Chatwoot"
echo "  2. Va em Configuracoes -> Perfil -> Token de Acesso e copie o token"
echo "  3. Acesse /super_admin -> Platform Apps -> crie um app e copie o token"
echo "  4. Atualize CHATWOOT_USER_ACCESS_TOKEN e CHATWOOT_PLATFORM_TOKEN no .env da VPS"
echo "  5. Rode: ssh $VPS_USER@$VPS_HOST 'cd $VPS_DIR && docker compose -f docker-compose.prod.yml up -d'"
echo ""
echo "  Para acompanhar os logs na VPS:"
echo "  ssh $VPS_USER@$VPS_HOST 'cd $VPS_DIR && docker compose -f docker-compose.prod.yml logs -f'"
echo "========================================"

# Limpar arquivo temporario local
rm -f "$TAR_FILE"
