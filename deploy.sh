#!/usr/bin/env bash
# deploy.sh — one-time server setup + deploy script
# Run on Ubuntu 24.04 as root (or with sudo)
set -euo pipefail

APP_DIR="/opt/remote-ops-platform"
WORKSPACE_DIR="/workspace"
SSH_KEYS_DIR="$WORKSPACE_DIR/.ssh-keys"

echo "=== 1. Installing system dependencies ==="
apt-get update -q
apt-get install -y -q curl git openssh-client nginx

# Node.js 20 LTS via NodeSource
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
fi

# PM2
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

echo "=== 2. Creating workspace directories ==="
mkdir -p "$WORKSPACE_DIR" "$SSH_KEYS_DIR"
chmod 700 "$SSH_KEYS_DIR"

echo "=== 3. Installing Node dependencies ==="
cd "$APP_DIR"
npm install --production=false

echo "=== 4. Building ==="
npm run build
# Build frontend
cd frontend && npm install && npm run build && cd ..

echo "=== 5. Setting up .env ==="
if [ ! -f .env ]; then
  cp .env.example .env
  # Generate random secrets
  JWT_SECRET=$(openssl rand -base64 32)
  MCP_SECRET=$(openssl rand -base64 32)
  sed -i "s|change-this-to-a-strong-random-secret-at-least-32-chars|$JWT_SECRET|g" .env
  sed -i "s|change-this-to-another-strong-secret|$MCP_SECRET|g" .env
  sed -i "s|WORKSPACE_ROOT=/workspace|WORKSPACE_ROOT=$WORKSPACE_DIR|g" .env
  sed -i "s|SSH_KEYS_DIR=/workspace/.ssh-keys|SSH_KEYS_DIR=$SSH_KEYS_DIR|g" .env
  echo ".env created with random secrets. Review it:"
  cat .env
fi

echo "=== 6. Starting with PM2 ==="
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup | tail -1 | bash || true

echo "=== 7. Nginx config ==="
cp nginx.conf /etc/nginx/sites-available/remote-ops
ln -sf /etc/nginx/sites-available/remote-ops /etc/nginx/sites-enabled/remote-ops
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "=== Done! ==="
echo "Web:  http://$(hostname -I | awk '{print $1}'):3000"
echo "MCP:  http://$(hostname -I | awk '{print $1}'):3001/mcp"
echo ""
echo "Edit nginx.conf and set your domain + SSL cert, then: nginx -t && systemctl reload nginx"
