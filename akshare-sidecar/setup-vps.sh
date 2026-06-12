#!/usr/bin/env bash
# Turnkey sidecar setup for a fresh Ubuntu 22.04/24.04 VPS (Hong Kong).
#
# Usage (as a sudo-capable user):
#   curl -fsSL https://raw.githubusercontent.com/daacpunk/china-monitor/main/akshare-sidecar/setup-vps.sh -o setup-vps.sh
#   chmod +x setup-vps.sh
#   sudo AKSHARE_TOKEN='<your-token>' SIDECAR_DOMAIN='sidecar.example.com' ./setup-vps.sh
#
# - AKSHARE_TOKEN   (required)  must EXACTLY match AKSHARE_TOKEN on Railway.
# - SIDECAR_DOMAIN  (optional)  if set, installs Caddy for automatic HTTPS on
#                               that domain (point its DNS A record at this VPS
#                               first). If omitted, the sidecar is served on
#                               http://<vps-ip>:8000 (no TLS — not recommended).
set -euo pipefail

if [[ -z "${AKSHARE_TOKEN:-}" ]]; then
  echo "ERROR: set AKSHARE_TOKEN env var (must match Railway)." >&2
  exit 1
fi

echo "==> Installing Docker (if missing)…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Cloning / updating china-monitor…"
if [[ ! -d china-monitor ]]; then
  git clone https://github.com/daacpunk/china-monitor.git
fi
cd china-monitor/akshare-sidecar
git pull --ff-only || true

echo "==> Writing .env…"
cat > .env <<EOF
AKSHARE_TOKEN=${AKSHARE_TOKEN}
HOST_PORT=8000
AKSHARE_CACHE_TTL=86400
AKSHARE_CACHE_MAX=500
EOF

echo "==> Building + starting the sidecar (docker compose)…"
docker compose up -d --build

echo "==> Waiting for /health…"
for i in {1..30}; do
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1; then
    echo "    sidecar is healthy."
    break
  fi
  sleep 2
done

if [[ -n "${SIDECAR_DOMAIN:-}" ]]; then
  echo "==> Installing Caddy for HTTPS on ${SIDECAR_DOMAIN}…"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update && apt-get install -y caddy
  fi
  cat > /etc/caddy/Caddyfile <<EOF
${SIDECAR_DOMAIN} {
    reverse_proxy localhost:8000
}
EOF
  systemctl restart caddy
  echo "==> Done. Sidecar URL: https://${SIDECAR_DOMAIN}"
  echo "    Set on Railway:  AKSHARE_SIDECAR_URL=https://${SIDECAR_DOMAIN}"
else
  PUBIP="$(curl -fsS https://api.ipify.org || echo '<vps-ip>')"
  echo "==> Done (no TLS). Sidecar URL: http://${PUBIP}:8000"
  echo "    Set on Railway:  AKSHARE_SIDECAR_URL=http://${PUBIP}:8000"
  echo "    (Recommend re-running with SIDECAR_DOMAIN set for HTTPS.)"
fi

echo
echo "Verify from anywhere:"
echo "  curl -s -H 'X-AKShare-Token: <token>' <sidecar-url>/health"
echo "  curl -s -H 'X-AKShare-Token: <token>' <sidecar-url>/financials/valuation/600519"
