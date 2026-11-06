#!/usr/bin/env bash
# Redeem a phone-signed Prawl v3 redemption bundle on-chain.
#   tools/sepolia_redeem.sh <redeem3_*.json> --rpc <url> [--simulate-only] [--depositor 0x..]
# Re-verifies the whole bundle in Python (tools/bundles_to_foundry.walk: every signature, strict DER, conservation,
# output->key binding, REDEEM target), builds redeem(Header, Spend[], Redemption) calldata with `cast calldata`,
# checks the on-chain state (deposit commitment, not yet redeemed, inside expiry + grace, coin state), simulates
# with `cast call`, and only then sends. Prints the receipt gas and the payout balance change.
# It refuses to send a submission that would NOT pay (simulation returns false = the bundle conflicts with a
# recorded spend, i.e. it would freeze the coin) unless ALLOW_FREEZE=1.
# The transaction carries no value; it only goes to $ESCROW. Anyone may submit a redemption; the payout is fixed
# by the phone's signature.
set -euo pipefail
source "$(dirname "$0")/sepolia_lib.sh"
DEPOSITOR_OVERRIDE=()
ARGV=()
while [ $# -gt 0 ]; do
  case "$1" in --depositor) DEPOSITOR_OVERRIDE=(--depositor "$2"); shift 2 ;; *) ARGV+=("$1"); shift ;; esac
done
parse_common "${ARGV[@]}"
[ ${#ARGS[@]} -eq 1 ] || die "usage: sepolia_redeem.sh <redeem3_*.json> --rpc <url> [--simulate-only] [--depositor 0x..]"
BUNDLE=${ARGS[0]}

load_fields redeem "$BUNDLE" "${DEPOSITOR_OVERRIDE[@]}"
echo "coin ${F[COIN_ID]}: redeem ${F[AMOUNT]} wei to ${F[PAYOUT]} (path of ${F[DEPTH]} spend(s) + the phone's REDEEM); bundle verified in Python"
check_chain_and_escrow
SENDER=$(sender_address)

COMMIT=$(commitment "${F[VALUE]}" "${F[EXPIRY]}" "${F[K0X]}" "${F[K0Y]}" "${F[DEPOSITOR]}")
GOT=$(cast call "$ESCROW" "deposits(bytes32)(bytes32)" "${F[COIN_ID]}" --rpc-url "$RPC")
[ "$GOT" != "0x0000000000000000000000000000000000000000000000000000000000000000" ] || die "coin not deposited at $ESCROW"
[ "$GOT" = "$COMMIT" ] || die "deposits[coinId] $GOT != commitment of this bundle's header $COMMIT (wrong depositor/value/expiry/k0?)"
NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
GRACE=$(cast call "$ESCROW" "grace()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
[ "$NOW" -lt $(( ${F[EXPIRY]} + GRACE )) ] || die "redemption window closed (now $NOW >= expiry + grace $(( ${F[EXPIRY]} + GRACE )))"
read -r PAID FROZEN CLOSED <<< "$(cast call "$ESCROW" "coins(bytes32)(uint128,bool,bool)" "${F[COIN_ID]}" --rpc-url "$RPC" | awk '{print $1}' | tr '\n' ' ')"
echo "coin state before: paid $PAID wei, frozen $FROZEN, closed $CLOSED"
RID=$(cast keccak "$(cast abi-encode "f(bytes32,uint256)" "${F[TIP_DIGEST]}" "${F[TIP_INDEX]}")")
[ "$(cast call "$ESCROW" "redeemed(bytes32)(bool)" "$RID" --rpc-url "$RPC")" = false ] || die "this REDEEM output was already paid (redemption id $RID)"

CD=$(cast calldata "$REDEEM_SIG" "${F[ARG_HEADER]}" "${F[ARG_PATH]}" "${F[ARG_REDEMPTION]}")
echo "calldata ${#CD} hex chars ($(( ${#CD} / 2 - 1 )) bytes)"
if ! SIM=$(cast call --from "$SENDER" "$ESCROW" "$CD" --rpc-url "$RPC" 2>&1); then
  die "simulation reverted: $(decode_revert "$SIM")"
fi
case "$SIM" in
  0x0000000000000000000000000000000000000000000000000000000000000001) echo "simulation OK: redeem returns true (pays)" ;;
  0x0000000000000000000000000000000000000000000000000000000000000000)
    echo "SIMULATION RETURNS FALSE: this bundle conflicts with a spend already recorded on-chain (equivocation); sending it would freeze the coin and pay nothing"
    [ "${ALLOW_FREEZE:-0}" = 1 ] || die "not sending (set ALLOW_FREEZE=1 to submit it as equivocation evidence)" ;;
  *) die "unexpected simulation result $SIM" ;;
esac
EST=$(cast estimate --from "$SENDER" "$ESCROW" "$CD" --rpc-url "$RPC")
echo "estimated gas $EST"
if [ "$SIMULATE_ONLY" = 1 ]; then echo "--simulate-only: not sending"; exit 0; fi

R=$(cast send --json --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE" --rpc-url "$RPC" "$ESCROW" "$CD")
STATUS=$(echo "$R" | receipt_field status)
echo "tx $(echo "$R" | receipt_field transactionHash)  status $STATUS  gasUsed $(echo "$R" | receipt_field gasUsed)  block $(echo "$R" | receipt_field blockNumber)"
[ "$STATUS" = 1 ] || die "redeem transaction failed"
# Public RPCs load-balance across nodes that may lag: pin every read to the receipt's block (after) and the
# block before it (before), waiting until the node serving us has that block.
BN=$(echo "$R" | receipt_field blockNumber); wait_block "$BN"
FEE=$("$PY" -c "import sys;print(int(sys.argv[1])*int(sys.argv[2]))" "$(echo "$R" | receipt_field gasUsed)" "$(echo "$R" | receipt_field effectiveGasPrice)")
B0=$(cast balance "${F[PAYOUT]}" --block $((BN-1)) --rpc-url "$RPC")
O0=$(cast call "$ESCROW" "owed(address)(uint256)" "${F[PAYOUT]}" --block $((BN-1)) --rpc-url "$RPC" | awk '{print $1}')
B1=$(cast balance "${F[PAYOUT]}" --block "$BN" --rpc-url "$RPC")
O1=$(cast call "$ESCROW" "owed(address)(uint256)" "${F[PAYOUT]}" --block "$BN" --rpc-url "$RPC" | awk '{print $1}')
if [ "$(echo "${F[PAYOUT]}" | tr A-F a-f)" = "$(echo "$SENDER" | tr A-F a-f)" ]; then
  B1=$("$PY" -c "import sys;print(int(sys.argv[1])+int(sys.argv[2]))" "$B1" "$FEE"); echo "payout is the sender: adding back the tx fee $FEE wei"
fi
DELTA=$("$PY" -c "import sys;print(int(sys.argv[1])-int(sys.argv[2]))" "$B1" "$B0")
ODELTA=$("$PY" -c "import sys;print(int(sys.argv[1])-int(sys.argv[2]))" "$O1" "$O0")
echo "payout ${F[PAYOUT]}: balance $B0 -> $B1 (+$DELTA wei), owed +$ODELTA wei; expected +${F[AMOUNT]} wei"
read -r PAID FROZEN CLOSED <<< "$(cast call "$ESCROW" "coins(bytes32)(uint128,bool,bool)" "${F[COIN_ID]}" --block "$BN" --rpc-url "$RPC" | awk '{print $1}' | tr '\n' ' ')"
echo "coin state after: paid $PAID wei, frozen $FROZEN, closed $CLOSED"
"$PY" -c "import sys;sys.exit(0 if int(sys.argv[1])+int(sys.argv[2])==int(sys.argv[3]) else 1)" "$DELTA" "$ODELTA" "${F[AMOUNT]}" \
  && echo "PAID: payout received exactly the redeemed amount" || die "payout change does not equal the redeemed amount"
