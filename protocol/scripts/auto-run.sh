#!/usr/bin/env bash
# Watches the keeper burner for funding; the moment it has ETH:
#   1. splits gas to the two demo wallets
#   2. deploys the full batch stack (tokens, V4 pool, wrappers, batcher)
#   3. runs one complete confidential round (encrypted deposits → settle → withdraw)
#   4. batch-config.json is published — the website's Transparency tab goes live
cd "$(dirname "$0")/.." || exit 1

KEEPER=$(grep '^PROTOCOL_PRIVATE_KEY' .env | cut -d= -f2)
RPC=$(grep -E '^SEPOLIA_RPC_URL|^RPC_URL_SEPOLIA' ../.env.local | head -1 | cut -d= -f2)
ADDR=$(cast wallet address --private-key "$KEEPER" 2>/dev/null | tail -1)

log() { echo "[$(date +%H:%M:%S)] $*"; }
log "Auto-runner watching $ADDR (need ≥0.3 ETH: deploy ~0.1, demo ~0.05, buffer)"

while true; do
  BAL=$(cast balance --rpc-url "$RPC" "$ADDR" 2>/dev/null | cut -d. -f1)
  if [ "${BAL:-0}" -ge 100000000000000000 ]; then
    log "FUNDED (${BAL} wei) — starting pipeline"
    break
  fi
  sleep 20
done

# 1. Split gas to alice/bob
ALICE=$(grep '^DEMO_KEY_ALICE' .env | cut -d= -f2)
BOB=$(grep '^DEMO_KEY_BOB' .env | cut -d= -f2)
A_ADDR=$(cast wallet address --private-key "$ALICE" 2>/dev/null | tail -1)
B_ADDR=$(cast wallet address --private-key "$BOB" 2>/dev/null | tail -1)
log "Sending 0.05 ETH to alice ($A_ADDR) and bob ($B_ADDR)"
cast send --rpc-url "$RPC" --private-key "$KEEPER" "$A_ADDR" --value 0.05ether --json > /dev/null 2>&1 && log "alice funded"
cast send --rpc-url "$RPC" --private-key "$KEEPER" "$B_ADDR" --value 0.05ether --json > /dev/null 2>&1 && log "bob funded"

# 2. Deploy
log "=== DEPLOYING BATCH STACK ==="
node scripts/deploy-stack.mjs || { log "DEPLOY FAILED"; exit 1; }

# 3. Demo round (min round 60s → settles ~1 min after deposits)
log "=== RUNNING DEMO ROUND ==="
VEIL_MIN_ROUND_SECONDS=60 node scripts/demo-round.mjs || { log "DEMO FAILED"; exit 1; }

log "=== PIPELINE COMPLETE — Transparency tab is now live ==="
