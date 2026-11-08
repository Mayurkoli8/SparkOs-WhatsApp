#!/bin/bash
# Google Compute Engine startup script for the WhatsApp worker. Runs as root on every boot:
# the first boot installs everything, later boots pull the latest code and restart (so a reboot also updates).
# Settings come from instance metadata: internal-api-key, ghl-client-id, ghl-provider-id, token-refresh-url,
# and optionally inbound-type. The token encryption key is generated here once and never leaves the VM.
set -euo pipefail

meta() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1" 2>/dev/null || true; }
attr() { meta "instance/attributes/$1"; }
log() { echo "WA-BRIDGE: $*"; }

APP_DIR=/opt/wa-bridge
REPO=https://github.com/Mayurkoli8/SparkOs-WhatsApp.git

if ! swapon --show | grep -q /swapfile; then
  log "adding 2 GB swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null || ! command -v git >/dev/null; then
  log "installing git and Docker"
  apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null
  command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
fi

mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR/SparkOs-WhatsApp/.git" ]; then
  log "cloning $REPO"
  git clone --depth 1 "$REPO" "$APP_DIR/SparkOs-WhatsApp"
else
  log "pulling latest code"
  git -C "$APP_DIR/SparkOs-WhatsApp" pull --ff-only || log "git pull failed; keeping the current code"
fi

cd "$APP_DIR/SparkOs-WhatsApp/worker/deploy"
IP=$(meta instance/network-interfaces/0/access-configs/0/external-ip)
DOMAIN="${IP//./-}.sslip.io"

if [ ! -f .env ]; then
  log "writing .env"
  umask 077
  cat > .env <<EOF
WORKER_DOMAIN=$DOMAIN
INTERNAL_API_KEY=$(attr internal-api-key)
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
GHL_CLIENT_ID=$(attr ghl-client-id)
GHL_CONVERSATION_PROVIDER_ID=$(attr ghl-provider-id)
GHL_INBOUND_TYPE=$(attr inbound-type || true)
TOKEN_REFRESH_URL=$(attr token-refresh-url)
EOF
else
  # Keep the hostname in step with the VM's address (it only changes after a stop/start).
  sed -i "s/^WORKER_DOMAIN=.*/WORKER_DOMAIN=$DOMAIN/" .env
fi

log "building and starting containers"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null || true
log "READY https://$DOMAIN"
