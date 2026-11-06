#!/usr/bin/env bash
# The demo stack, set up so a PHONE on the same network can use it for a spike:
# our Tor gateway advertises this laptop's LAN address (not 127.0.0.1), the site is built with that
# gateway address, and the site is served on localhost:4173. The phone reaches the page through
# `adb reverse` (so it is a secure "localhost", which passkeys need) and the gateway over Wi-Fi UDP.
#
#   scripts/phone-spike-up.sh            # start (stops a running demo stack first)
#   scripts/demo-down.sh                 # stop
#
# On the laptop, UDP 25931 must be allowed from the phone: the script prints the firewalld command.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
IP=${PRAWL_GATEWAY_ADVERTISE:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)}
[[ $IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not tell this laptop's LAN address; set PRAWL_GATEWAY_ADVERTISE=<ip>"; exit 1; }
DEV=$(ip -4 route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
echo "LAN address $IP on $DEV"

scripts/demo-down.sh || true
PRAWL_GATEWAY_ADVERTISE=$IP gateway/start.sh
scripts/demo-up.sh
echo
echo "gateway for the phone: $(cat .local/gateway/kps-address)"
echo
echo "1. allow the phone to reach the gateway (once; needs root):"
echo "     sudo firewall-cmd --add-port=25931/udp   # temporary, gone at the next reload or reboot"
echo "2. for each phone on USB:    adb -s <serial> reverse tcp:4173 tcp:4173"
echo "3. on the phone, on Wi-Fi in the SAME network as this laptop ($IP), open Chrome at  http://localhost:4173"
echo "   then Create wallet; note the Tor boot time, any passkey error (PRF), and 'synced in'."
echo "   (Mobile data will not reach $IP.)"
