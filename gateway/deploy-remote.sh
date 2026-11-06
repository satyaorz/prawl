#!/usr/bin/env bash
# Install our tor-js gateway (the same unchanged v0.4.4 binary as gateway/build.sh)
# on a fresh Ubuntu 24.04 x86_64 server over SSH, e.g. AWS Lightsail or EC2.
#
#   gateway/deploy-remote.sh ubuntu@<public-ip> [public-ip]
#
# The server's firewall (Lightsail networking tab / EC2 security group) must
# allow inbound UDP on the gateway port (default 25931) and TCP 22 for SSH.
# The binary needs glibc >= 2.39, so not Amazon Linux 2023; x86_64, not ARM.
#
# Installs /usr/local/bin/tor-js-gateway, runs it as the system user
# prawl-gateway under systemd (prawl-gateway.service, restarts on failure,
# hardened), keeps its key and Tor directory cache in /var/lib/prawl-gateway,
# then prints the address for VITE_PRAWL_GATEWAY and copies the Tor bootstrap
# snapshot to .local/tor/ for the site build. Rerunning upgrades in place and
# keeps the key, so the address stays the same.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST=${1:?usage: gateway/deploy-remote.sh user@host [public-ip]}
PORT=${PRAWL_GATEWAY_PORT:-25931}
BIN=${TORJS_GATEWAY_BIN:-$ROOT/.local/bin/tor-js-gateway}
[ -x "$BIN" ] || { echo "gateway binary not found at $BIN (run gateway/build.sh)"; exit 1; }
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST")

PUBLIC_IP=${2:-$("${SSH[@]}" curl -fsS https://checkip.amazonaws.com)}
[[ $PUBLIC_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not tell the public IPv4 ($PUBLIC_IP); pass it as the 2nd argument"; exit 1; }
echo "installing on $HOST, advertising $PUBLIC_IP:$PORT"

scp -o BatchMode=yes -q "$BIN" "$HOST:/tmp/tor-js-gateway"
"${SSH[@]}" sudo PORT="$PORT" PUBLIC_IP="$PUBLIC_IP" bash -s <<'REMOTE'
set -euo pipefail
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "warning: not Ubuntu ($PRETTY_NAME); the binary needs glibc >= 2.39"
[ "$(uname -m)" = x86_64 ] || { echo "need an x86_64 server, this is $(uname -m)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq libsqlite3-0 liblzma5 libssl3t64 ca-certificates >/dev/null
id prawl-gateway >/dev/null 2>&1 || useradd --system --home-dir /var/lib/prawl-gateway --shell /usr/sbin/nologin prawl-gateway
install -d -o prawl-gateway -g prawl-gateway -m 0700 /var/lib/prawl-gateway /var/lib/prawl-gateway/data /var/lib/prawl-gateway/home
install -m 0755 /tmp/tor-js-gateway /usr/local/bin/tor-js-gateway
rm -f /tmp/tor-js-gateway
install -d -m 0755 /etc/prawl-gateway
cat > /etc/prawl-gateway/config.json5 <<JSON
{
  "data_dir": "/var/lib/prawl-gateway/data",
  "kps_port": $PORT,
  "kps_key_file": "/var/lib/prawl-gateway/data/kps.key",
  "keccak_repo": "",
  "keccak_branch": "",
  "keccak_poll_interval": 86400,
  "keccak_manual_sync_min_interval": 1800,
  "demo": false,
  "advertised_addresses": ["$PUBLIC_IP"],
  "tunnel_max": 8192,
  "tunnel_per_ip": 16,
  "tunnel_idle_timeout": 300,
  "tunnel_max_lifetime": 3600,
}
JSON
cat > /etc/systemd/system/prawl-gateway.service <<'UNIT'
[Unit]
Description=Prawl tor-js gateway (KPS, UDP)
After=network-online.target
Wants=network-online.target

[Service]
User=prawl-gateway
Group=prawl-gateway
Environment=HOME=/var/lib/prawl-gateway/home RUST_LOG=info
ExecStart=/usr/local/bin/tor-js-gateway -c /etc/prawl-gateway/config.json5 run --no-mirror
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
# AF_NETLINK is required: WebRTC lists the network interfaces over netlink to gather ICE candidates. Without it
# the gateway answers the signalling but offers no address (log: "Candidate IP could not be found", os error 97).
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
ReadWritePaths=/var/lib/prawl-gateway
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable prawl-gateway >/dev/null 2>&1
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart prawl-gateway
echo "waiting for the first Tor directory sync..."
for _ in $(seq 1 240); do
  journalctl -u prawl-gateway --since "$SINCE" --no-pager -q | grep -q "next sync in" && break
  systemctl is-active -q prawl-gateway || { journalctl -u prawl-gateway -n 40 --no-pager; exit 1; }
  sleep 0.5
done
journalctl -u prawl-gateway --since "$SINCE" --no-pager -q | grep -oE "$PUBLIC_IP:$PORT:[A-Za-z0-9_-]+" | tail -1 > /var/lib/prawl-gateway/kps-address
cp /var/lib/prawl-gateway/data/bootstrap.zip.zst /tmp/prawl-bootstrap.zip.zst && chmod 0644 /tmp/prawl-bootstrap.zip.zst
REMOTE

ADDR=$("${SSH[@]}" sudo cat /var/lib/prawl-gateway/kps-address)
[ -n "$ADDR" ] || { echo "no gateway address in the log; check: ssh $HOST journalctl -u prawl-gateway"; exit 1; }
mkdir -p "$ROOT/.local/tor" "$ROOT/.local/gateway"
scp -o BatchMode=yes -q "$HOST:/tmp/prawl-bootstrap.zip.zst" "$ROOT/.local/tor/bootstrap.zip.zst"
echo "$ADDR" > "$ROOT/.local/gateway/remote-address"
echo
echo "gateway: $ADDR"
echo "build the site with it:  VITE_PRAWL_GATEWAY=$ADDR pnpm --filter ./apps/wallet build:web"
