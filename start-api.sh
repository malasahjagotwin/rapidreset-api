#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-${SERVER_PORT:-3295}}"
HOST="${HOST:-0.0.0.0}"
CLIENT_TOKEN="${CLIENT_TOKEN:-}"

for bin in node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing dependency: $bin" >&2; exit 1; }
done

cd "$(dirname "$0")"

if [ ! -f method.json ]; then
  echo "method.json not found next to this script" >&2
  exit 1
fi

echo "starting orchestrator on $HOST:$PORT"
PORT="$PORT" HOST="$HOST" CLIENT_TOKEN="$CLIENT_TOKEN" exec node index.js
