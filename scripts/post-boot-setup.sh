#!/usr/bin/env bash
set -euo pipefail

VPS_DIR="${VPS_DIR:-/opt/fluvius}"

echo "post-boot-setup agora usa configuracao automatica baseada no .env."
exec bash "$VPS_DIR/scripts/auto-configure-production.sh"
