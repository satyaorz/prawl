#!/usr/bin/env bash
# Stop the gateway started by gateway/start.sh, by its recorded PID only, and
# confirm the UDP port is closed.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
G=$ROOT/.local/gateway
PORT=${PRAWL_GATEWAY_PORT:-25931}
[ -f "$G/gateway.pid" ] || { echo "no pid file; nothing to stop"; exit 0; }
PID=$(cat "$G/gateway.pid")
if tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q "tor-js-gateway -c $G/config.json5"; then
  kill -TERM "$PID"
  for _ in $(seq 1 40); do [ -e "/proc/$PID" ] || break; sleep 0.25; done
  [ -e "/proc/$PID" ] && { echo "still alive after 10 s"; exit 1; }
fi
rm -f "$G/gateway.pid"
if ss -uln | grep -q ":$PORT "; then echo "UDP $PORT still open"; exit 3; fi
echo "gateway stopped, UDP $PORT closed"
