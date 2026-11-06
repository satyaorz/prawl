#!/usr/bin/env bash
# DRY RUN of the Sepolia flow against a LOCAL anvil fork of Sepolia. Nothing is sent to the real network:
# every transaction goes to http://127.0.0.1:$PORT (anvil --fork-url). Reads from real Sepolia are only those the
# fork makes, plus read-only eth_call/eth_estimateGas at the end (no transaction).
#   tools/sepolia_dryrun.sh [sepolia-rpc] [port]
# Steps: fork + compare the deployed escrow's code with this source build; mint a SYNTHETIC coin for the real
# escrow address (gen_vectors.py --coin-for-escrow, phone file format); refusal cases; deposit; 3 redemptions;
# repeat attempts; read-only gas estimates on real Sepolia with a state override.
set -euo pipefail
cd "$(dirname "$0")/.."
UPSTREAM=${1:-https://ethereum-sepolia-rpc.publicnode.com}
PORT=${2:-18790}
LOCAL=http://127.0.0.1:$PORT
PY=../../seam_a_uncopyable/.venv/bin/python
ESCROW=0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5
OUT=vectors/sepolia_dryrun
mkdir -p logs "$OUT"

# fork a few blocks behind the head: public nodes may not serve state for the newest block yet
FORK_BLOCK=$(( $(cast block-number --rpc-url "$UPSTREAM") - 5 ))
anvil --fork-url "$UPSTREAM" --fork-block-number "$FORK_BLOCK" --hardfork osaka --port "$PORT" --silent \
  > logs/anvil_sepolia_fork.log 2>&1 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
UP=0
for _ in $(seq 1 120); do
  if cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1; then UP=1; break; fi
  kill -0 $APID 2>/dev/null || break
  sleep 0.5
done
[ $UP = 1 ] || { echo "anvil fork did not start:"; cat logs/anvil_sepolia_fork.log; exit 1; }
echo "== fork: chain $(cast chain-id --rpc-url "$LOCAL"), forked at block $(cast block-number --rpc-url "$LOCAL"), timestamp $(cast block latest --field timestamp --rpc-url "$LOCAL"), local EVM rules: osaka (anvil 1.5.1 has no later fork)"
DEPLOYER=$(cast wallet address --keystore "$HOME/.prawl-offline-keys/deployer" --password-file "$HOME/.prawl-offline-keys/deployer.pw")
echo "   sender (keystore) $DEPLOYER, balance $(cast balance "$DEPLOYER" --rpc-url "$LOCAL" --ether) ETH (forked state)"

echo "== deployed code vs this source: deploy the same build with the same constructor args from the deployer (fork only, impersonated)"
cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$LOCAL" >/dev/null
ARGS=$(cast abi-encode "c(uint256,uint256,address,bool)" 86400 2592000 "$DEPLOYER" false)
NEW=$(cast send --json --unlocked --from "$DEPLOYER" --rpc-url "$LOCAL" --create "$(forge inspect --offline src/PrawlEscrowV3.sol:PrawlEscrowV3 bytecode)${ARGS#0x}" \
      | "$PY" -c "import json,sys;print(json.load(sys.stdin)['contractAddress'])")
cast rpc anvil_stopImpersonatingAccount "$DEPLOYER" --rpc-url "$LOCAL" >/dev/null
# the fork's deployer nonce moved by one; harmless (local only)
if [ "$(cast code "$NEW" --rpc-url "$LOCAL")" = "$(cast code $ESCROW --rpc-url "$LOCAL")" ]; then
  echo "   runtime code at $ESCROW is byte-identical to src/PrawlEscrowV3.sol built here (incl. immutables)"
else echo "   WARNING: deployed runtime code differs from this build"; fi

echo "== mint a SYNTHETIC coin for the real escrow (phone mint3/pay3/redeem3 format)"
NOW=$(cast block latest --field timestamp --rpc-url "$LOCAL")
"$PY" tools/gen_vectors.py --coin-for-escrow $ESCROW --chain-id 11155111 --depositor "$DEPLOYER" \
  --expiry $((NOW + 7 * 86400)) --value 1000000000000000 --label sd --out "$OUT"

echo "== refusal cases (each must be REFUSED, nothing sent)"
refuse() { if "$@" > /tmp/dry_$$.log 2>&1; then echo "   UNEXPECTED SUCCESS: $*"; cat /tmp/dry_$$.log; exit 1; else echo "   refused as expected: $(grep REFUSED /tmp/dry_$$.log | head -1)"; fi; rm -f /tmp/dry_$$.log; }
refuse tools/sepolia_deposit.sh vectors/phone_run3/mint3_s.json --rpc "$LOCAL"        # phone_run3: placeholder escrow
"$PY" tools/gen_vectors.py --coin-for-escrow $ESCROW --chain-id 11155111 --depositor 0x00000000000000000000000000000000000a11ce \
  --expiry $((NOW + 7 * 86400)) --label other --out "$OUT/other_depositor" > /dev/null
refuse tools/sepolia_deposit.sh "$OUT/other_depositor/mint3_other.json" --rpc "$LOCAL"  # depositor != sender
refuse tools/sepolia_redeem.sh "$OUT/redeem3_sd_charlie.json" --rpc "$LOCAL"           # not deposited yet
refuse tools/sepolia_deposit.sh "$OUT/mint3_sd.json" --rpc http://127.0.0.1:1 --simulate-only    # unreachable RPC

echo "== deposit (sent to the LOCAL fork with the keystore)"
B0=$(cast balance $ESCROW --rpc-url "$LOCAL")
tools/sepolia_deposit.sh "$OUT/mint3_sd.json" --rpc "$LOCAL" | sed 's/^/   /'
refuse tools/sepolia_deposit.sh "$OUT/mint3_sd.json" --rpc "$LOCAL"                     # second deposit

echo "== redemptions"
for who in charlie bob alice; do
  echo "-- redeem3_sd_$who.json"
  tools/sepolia_redeem.sh "$OUT/redeem3_sd_$who.json" --rpc "$LOCAL" | sed 's/^/   /'
done
refuse tools/sepolia_redeem.sh "$OUT/redeem3_sd_bob.json" --rpc "$LOCAL"                # second redemption
B1=$(cast balance $ESCROW --rpc-url "$LOCAL")
echo "   escrow balance $B0 -> $B1 (net $("$PY" -c "import sys;print(int(sys.argv[1])-int(sys.argv[2]))" "$B1" "$B0") wei: deposit in, all three REDEEM outputs out)"

echo "== READ-ONLY estimates on the REAL Sepolia RPC (Sepolia's own fee schedule; nothing sent; state override for the redemptions)"
kill $APID 2>/dev/null || true
tools/sepolia_estimate.sh --rpc "$UPSTREAM" "$OUT/mint3_sd.json" "$OUT/redeem3_sd_charlie.json" "$OUT/redeem3_sd_bob.json" \
  "$OUT/redeem3_sd_alice.json" | sed 's/^/   /'
