#!/usr/bin/env bash
# Stop what scripts/demo-up.sh started, by recorded PID only.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PIDF=$ROOT/.local/preview.pid
if [ -f "$PIDF" ]; then
  PID=$(cat "$PIDF")
  if tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q "vite.js preview"; then kill "$PID"; echo "preview stopped"; fi
  rm -f "$PIDF"
fi
"$ROOT/gateway/stop.sh"
