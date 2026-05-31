#!/bin/bash
VPS_PASS="1234"
export SSHPASS="$VPS_PASS"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no"

echo "=== STATUS DA VPS ==="
$SSH deploy@191.252.212.61 "
echo '--- ARQUIVOS ---'
ls /opt/fluvius/ 2>&1
echo ''
echo '--- .env ---'
test -f /opt/fluvius/.env && echo 'SIM' || echo 'NAO'
echo ''
echo '--- CONTAINERS ---'
docker ps -a 2>&1
echo ''
echo '--- PORTAS ---'
ss -tlnp 2>&1 | grep -E ':80|:443|:3000'
echo ''
echo '--- /etc/ld.so.preload ---'
cat /etc/ld.so.preload 2>&1
"
