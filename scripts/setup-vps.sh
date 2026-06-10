#!/bin/bash
# =============================================================================
# Setup Inicial da VPS — Instala Docker, Caddy, cria usuário deploy
# Execute como ROOT na VPS: bash setup-vps.sh
# Testado em: Ubuntu 22.04 / 24.04
# =============================================================================
set -eo pipefail

echo ""
echo "========================================="
echo "  Fluvius — Setup Inicial da VPS"
echo "========================================="
echo ""

# --- Verificar se é root ---
if [ "$(id -u)" -ne 0 ]; then
  echo "ERRO: Execute como root (sudo bash setup-vps.sh)"
  exit 1
fi

# --- Atualizar pacotes ---
echo ">>> [1/6] Atualizando pacotes..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git unzip software-properties-common apt-transport-https ca-certificates gnupg lsb-release sshpass
echo "  ✓ Pacotes atualizados"

# --- Criar usuário deploy ---
echo ""
echo ">>> [2/6] Criando usuário 'deploy'..."
if id deploy &>/dev/null; then
  echo "  INFO: Usuário 'deploy' já existe"
else
  useradd -m -s /bin/bash deploy
  echo "  ✓ Usuário 'deploy' criado"
fi
cat > /etc/sudoers.d/deploy-fluvius <<'SUDOERS'
deploy ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/local/bin/docker, /usr/bin/cp /opt/fluvius/Caddyfile /etc/caddy/Caddyfile, /usr/bin/systemctl reload caddy, /usr/bin/systemctl restart caddy
SUDOERS
chmod 440 /etc/sudoers.d/deploy-fluvius
usermod -aG docker deploy 2>/dev/null || true

# --- Instalar Docker ---
echo ""
echo ">>> [3/6] Instalando Docker..."
if command -v docker &>/dev/null; then
  echo "  INFO: Docker já instalado ($(docker --version))"
else
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "  ✓ Docker instalado"
fi

# --- Instalar Docker Compose plugin (v2) ---
if docker compose version &>/dev/null; then
  echo "  INFO: Docker Compose já instalado"
else
  apt-get install -y docker-compose-plugin
  echo "  ✓ Docker Compose instalado"
fi

# --- Instalar Caddy ---
echo ""
echo ">>> [4/6] Instalando Caddy..."
if command -v caddy &>/dev/null; then
  echo "  INFO: Caddy já instalado ($(caddy version))"
else
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
  echo "  ✓ Caddy instalado"
fi

# --- Configurar Caddy ---
echo ""
echo ">>> [5/6] Configurando Caddy..."
mkdir -p /opt/fluvius
if [ -f /opt/fluvius/Caddyfile ]; then
  cp /opt/fluvius/Caddyfile /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl restart caddy
  echo "  ✓ Caddy configurado com /opt/fluvius/Caddyfile"
else
  echo "  AVISO: /opt/fluvius/Caddyfile não encontrado ainda."
  echo "  Após o deploy, rode: cp /opt/fluvius/Caddyfile /etc/caddy/Caddyfile && systemctl restart caddy"
fi

# --- Criar diretório e permissões ---
echo ""
echo ">>> [6/6] Preparando diretório /opt/fluvius..."
mkdir -p /opt/fluvius
chown -R deploy:deploy /opt/fluvius
chmod 755 /opt/fluvius
echo "  ✓ /opt/fluvius pronto"

# --- Firewall ---
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp   2>/dev/null || true
  ufw allow 80/tcp   2>/dev/null || true
  ufw allow 443/tcp  2>/dev/null || true
  ufw --force enable 2>/dev/null || true
  echo "  ✓ Firewall: portas 22, 80, 443 abertas"
fi

echo ""
echo "========================================="
echo "  Setup da VPS concluído!"
echo ""
echo "  Próximo passo: rode o deploy na sua máquina local:"
echo "  export SSHPASS=sua-senha && bash deploy-to-vps.sh"
echo "========================================="
