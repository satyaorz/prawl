#!/usr/bin/env bash
# Start our own tor-js gateway (unchanged v0.4.4 binary) for local development.
#
# - All state lives in .local/gateway (key, Tor directory cache, logs).
# - Advertises 127.0.0.1 only. The binary has no bind-address option, so the
#   UDP listener binds every interface: stop it with gateway/stop.sh when done.
# - Waits for the first directory sync, then copies the snapshot to
#   .local/tor/bootstrap.zip.zst, which the wallet serves at /tor/bootstrap.zip.zst,
#   and writes the gateway address to .local/gateway/kps-address.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=${TORJS_GATEWAY_BIN:-$ROOT/.local/bin/tor-js-gateway}
G=$ROOT/.local/gateway
PORT=${PRAWL_GATEWAY_PORT:-25931}

[ -x "$BIN" ] || { echo "gateway binary not found at $BIN (run gateway/build.sh)"; exit 1; }
mkdir -p "$G/data" "$G/home" "$G/logs" "$ROOT/.local/tor"
if [ -f "$G/gateway.pid" ] && kill -0 "$(cat "$G/gateway.pid")" 2>/dev/null; then
  echo "gateway already running (pid $(cat "$G/gateway.pid"))"; exit 0
fi
if ss -uln | grep -q ":$PORT "; then echo "UDP $PORT already in use"; exit 1; fi

cat > "$G/config.json5" <<JSON
{
  "data_dir": "$G/data",
  "kps_port": $PORT,
  "kps_key_file": "$G/data/kps.key",
  "keccak_repo": "",
  "keccak_branch": "",
  "keccak_poll_interval": 86400,
  "keccak_manual_sync_min_interval": 1800,
  "demo": false,
  "advertised_addresses": ["127.0.0.1"],
  "tunnel_max": 8192,
  "tunnel_per_ip": 16,
  "tunnel_idle_timeout": 300,
  "tunnel_max_lifetime": 3600,
}
JSON

LOG=$G/logs/gateway.log
touch "$LOG"
# A sync either writes a new snapshot or finds the consensus unchanged; both end with "next sync in".
N0=$(grep -c "next sync in" "$LOG" || true)
env -u GITHUB_TOKEN HOME="$G/home" XDG_CONFIG_HOME="$G/home/.config" XDG_DATA_HOME="$G/home/.local/share" \
  XDG_CACHE_HOME="$G/home/.cache" XDG_STATE_HOME="$G/home/.local/state" RUST_LOG=${RUST_LOG:-info} \
  setsid nohup "$BIN" -c "$G/config.json5" run --no-mirror >> "$LOG" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$G/gateway.pid"
echo "started pid $PID, waiting for first directory sync..."
for _ in $(seq 1 240); do
  [ "$(grep -c "next sync in" "$LOG" || true)" -gt "$N0" ] && break
  kill -0 "$PID" 2>/dev/null || { echo "gateway exited; see $LOG"; exit 1; }
  sleep 0.5
done
cp "$G/data/bootstrap.zip.zst" "$ROOT/.local/tor/bootstrap.zip.zst"
grep -oE "127\.0\.0\.1:$PORT:[A-Za-z0-9_-]+" "$LOG" | tail -1 > "$G/kps-address"
echo "gateway: $(cat "$G/kps-address")"
