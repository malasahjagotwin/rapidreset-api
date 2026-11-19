#!/usr/bin/env bash
set -euo pipefail

REPO="https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main"
PORT="${PORT:-${SERVER_PORT:-3295}}"
HOST="${HOST:-0.0.0.0}"
CLIENT_TOKEN="${CLIENT_TOKEN:-}"

command -v node >/dev/null 2>&1 || { echo "missing dependency: node" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "missing dependency: curl" >&2; exit 1; }

cd "$(dirname "$0")"

echo "fetching broker files into $PWD"
curl -fsSLO "$REPO/index.js"
curl -fsSLO "$REPO/method.json"

echo "starting orchestrator on $HOST:$PORT"
PORT="$PORT" HOST="$HOST" CLIENT_TOKEN="$CLIENT_TOKEN" exec node index.js
