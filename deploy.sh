#!/usr/bin/env bash
# deploy.sh — one-time server setup + deploy script
# Run on Ubuntu 24.04 as root (or with sudo)
set -euo pipefail

# Lifecycle commands can run without root after the unified deployment exists.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE=(node)
# Parse dotenv as data through Node; never execute credential values as shell code.
load_engine_config() {
  NODE=(node)
  if [ -f "$1/.env" ]; then NODE+=("--env-file=$1/.env"); fi
  KNOWLEDGE_ENGINE_ENABLED="$("${NODE[@]}" -p 'process.env.KNOWLEDGE_ENGINE_ENABLED || "true"')"
  KNOWLEDGE_ENGINE_HOME="$("${NODE[@]}" -p 'process.env.KNOWLEDGE_ENGINE_HOME || ""')"
  KNOWLEDGE_ENGINE_BUNDLE="$("${NODE[@]}" -p 'process.env.KNOWLEDGE_ENGINE_BUNDLE || ""')"
}
stop_engine_supervisor() {
  if command -v pm2 >/dev/null && pm2 describe remote-ops-knowledge-engine >/dev/null 2>&1; then
    pm2 stop remote-ops-knowledge-engine
  fi
}
if [[ "${1:-}" = engine-* ]]; then load_engine_config "$SCRIPT_DIR"; fi
case "${1:-}" in
  engine-status) exec "${NODE[@]}" "$SCRIPT_DIR/scripts/knowledge-engine.mjs" status ;;
  engine-stop|engine-backup|engine-restore)
    # Stop the PM2 supervisor too; signaling only its child would cause a restart.
    stop_engine_supervisor
    "${NODE[@]}" "$SCRIPT_DIR/scripts/knowledge-engine.mjs" stop
    case "$1" in
      engine-backup) exec "${NODE[@]}" "$SCRIPT_DIR/scripts/knowledge-engine.mjs" backup ;;
      engine-restore) exec "${NODE[@]}" "$SCRIPT_DIR/scripts/knowledge-engine.mjs" restore "${2:?Provide the backup directory}" ;;
    esac
    exit 0 ;;
  engine-start|engine-restart)
    if command -v pm2 >/dev/null; then
      pm2 startOrRestart "$SCRIPT_DIR/ecosystem.config.cjs" --only remote-ops-knowledge-engine --update-env
      exec "${NODE[@]}" "$SCRIPT_DIR/scripts/knowledge-engine.mjs" wait
    fi
    exec "${NODE[@]}" "$SCRIPT_DIR/scripts/knowledge-engine.mjs" "${1#engine-}" ;;
esac
APP_DIR="${APP_DIR:-/opt/remote-ops-platform}"
WORKSPACE_DIR="/workspace"
SSH_KEYS_DIR="$WORKSPACE_DIR/.ssh-keys"

echo "=== 1. Installing system dependencies ==="
apt-get update -q
apt-get install -y -q curl git openssh-client nginx openssl python3

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
npm --prefix frontend install --include=dev

echo "=== 4. Building ==="
npm run build

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
  chmod 600 .env
fi
# Node may have just been installed and .env may have just been generated.
# Resolve configuration from the actual deployment directory for this run.
load_engine_config "$APP_DIR"

echo "=== 6. Installing the private knowledge engine ==="
# Build on a separate Linux worker with scripts/knowledge-engine/build.sh.
# Reuse that verified bundle here, or preserve the already installed release.
if [ "${KNOWLEDGE_ENGINE_ENABLED:-true}" != "false" ]; then
  if [ -n "${KNOWLEDGE_ENGINE_BUNDLE:-}" ]; then
    stop_engine_supervisor
    "${NODE[@]}" scripts/knowledge-engine.mjs stop
    "${NODE[@]}" scripts/knowledge-engine.mjs install --bundle "$KNOWLEDGE_ENGINE_BUNDLE"
  elif [ ! -f "${KNOWLEDGE_ENGINE_HOME:-$APP_DIR/runtime/knowledge-engine}/engine.json" ]; then
    echo 'Set KNOWLEDGE_ENGINE_BUNDLE to the prebuilt verified bundle before deployment.' >&2
    echo 'Build it with: bash scripts/knowledge-engine/build.sh /path/to/dedicated/build' >&2
    exit 1
  fi
else
  # Removing the engine from the ecosystem configuration does not stop an
  # already managed PM2 process. Honor disablement without deleting its state.
  stop_engine_supervisor
  if [ -f "${KNOWLEDGE_ENGINE_HOME:-$APP_DIR/runtime/knowledge-engine}/engine.json" ]; then
    "${NODE[@]}" scripts/knowledge-engine.mjs stop
  fi
fi

echo "=== 7. Starting with PM2 ==="
mkdir -p logs
if [ "${KNOWLEDGE_ENGINE_ENABLED:-true}" != "false" ]; then
  pm2 startOrRestart ecosystem.config.cjs --only remote-ops-knowledge-engine --update-env
  "${NODE[@]}" scripts/knowledge-engine.mjs wait
fi
# startOrReload starts fresh services and refreshes existing ones. Keep Relay
# serving until the private engine is ready to accept its bootstrap requests.
pm2 startOrReload ecosystem.config.cjs --only remote-ops-web,remote-ops-mcp --update-env
pm2 save
pm2 startup | tail -1 | bash || true

echo "=== 8. Nginx config ==="
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
