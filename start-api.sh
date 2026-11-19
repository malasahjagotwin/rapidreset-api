#!/usr/bin/env bash
set -euo pipefail

REPO="https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main"
PORT="${PORT:-${SERVER_PORT:-3295}}"
HOST="${HOST:-0.0.0.0}"
CLIENT_TOKEN="${CLIENT_TOKEN:-}"
API_TOKEN="${API_TOKEN:-}"

BROKER_FILES=(
  index.js
  method.json
  package.json
  src/app.js
  src/core/config.js
  src/core/methods.js
  src/core/state.js
  src/core/validation.js
  src/ui/console.js
  src/broker/ndjson.js
  src/broker/jobs.js
  src/broker/scheduler.js
  src/broker/workers.js
  src/broker/worker-socket.js
  src/broker/worker-signal.js
  src/http/respond.js
  src/http/routes.js
  src/http/docs.js
  src/http/server.js
)

command -v node >/dev/null 2>&1 || { echo "missing dependency: node" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "missing dependency: curl" >&2; exit 1; }

cd "$(dirname "$0")"

echo "fetching broker files into $PWD"
for file in "${BROKER_FILES[@]}"; do
  mkdir -p "$(dirname "$file")"
  curl -fsSL "$REPO/$file" -o "$file"
done

echo "starting orchestrator on $HOST:$PORT"
PORT="$PORT" HOST="$HOST" CLIENT_TOKEN="$CLIENT_TOKEN" API_TOKEN="$API_TOKEN" exec node index.js