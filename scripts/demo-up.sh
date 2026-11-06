#!/usr/bin/env bash
# Everything for a local demo, fresh: our own Tor gateway (and a new Tor
# bootstrap), the RAILGUN pool snapshot brought up to the current block (so a
# new wallet opens in seconds), a production build, and a preview server on
# http://localhost:4173 (stable: no dev-server reloads mid-demo).
# Stop it all with scripts/demo-down.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PORT=${PRAWL_PREVIEW_PORT:-4173}
PIDF=$ROOT/.local/preview.pid

echo "== gateway"
gateway/start.sh
echo "== pool snapshot (resumes from the last one)"
node packages/railgun/scripts/build-snapshot.mjs | tail -2
echo "== build"
pnpm --filter ./apps/wallet build | tail -2
echo "== preview"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  echo "preview already running (pid $(cat "$PIDF"))"
else
  # Background the server itself (not a subshell), so the PID is vite's and nothing keeps our stdout open.
  cd "$ROOT/apps/wallet"
  setsid nohup node node_modules/vite/bin/vite.js preview --port "$PORT" --strictPort > "$ROOT/.local/preview.log" 2>&1 < /dev/null &
  echo $! > "$PIDF"
  cd "$ROOT"
  for _ in $(seq 1 40); do curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break; sleep 0.25; done
fi
curl -fsS -o /dev/null "http://localhost:$PORT/" || { echo "preview did not start; see .local/preview.log"; exit 1; }
echo
echo "ready: http://localhost:$PORT  (passkeys need \"localhost\", not 127.0.0.1)"
