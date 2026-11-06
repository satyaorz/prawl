#!/usr/bin/env bash
# Deposit a phone-minted Prawl v3 coin into the escrow.
#   tools/sepolia_deposit.sh <mint3_*.json> --rpc <url> [--simulate-only]
# Reads the phone's mint file (coinId, expiry, value wei, k0x/k0y, depositor, chainId, escrow), checks that k0 is
# the key of the genesis certificate in the file, and sends deposit(coinId, expiry, k0x, k0y){value} from the
# keystore account. It REFUSES unless: the RPC chain id and escrow address are the ones in the header, the header
# depositor equals the keystore address (the commitment includes msg.sender), the coin is not yet deposited,
# now < expiry <= now + maxLifetime, and the balance covers the value. Afterwards it reads deposits[coinId] back
# and compares it with keccak256(abi.encode(value, expiry, k0x, k0y, depositor)) recomputed locally.
set -euo pipefail
source "$(dirname "$0")/sepolia_lib.sh"
parse_common "$@"
[ ${#ARGS[@]} -eq 1 ] || die "usage: sepolia_deposit.sh <mint3_*.json> --rpc <url> [--simulate-only]"
MINT=${ARGS[0]}

load_fields mint "$MINT"
echo "coin ${F[COIN_ID]}: ${F[VALUE]} wei, expiry ${F[EXPIRY]}, k0 hash ${F[K0_HASH]}, depositor ${F[DEPOSITOR]}"
check_chain_and_escrow
SENDER=$(sender_address)
[ "$(lc "${F[DEPOSITOR]}")" = "$(lc "$SENDER")" ] \
  || die "header depositor ${F[DEPOSITOR]} != sender $SENDER: the commitment would not match the coin header"

NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
MAXL=$(cast call "$ESCROW" "maxLifetime()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
[ "${F[EXPIRY]}" -gt "$NOW" ] || die "coin already expired (expiry ${F[EXPIRY]} <= now $NOW)"
[ "${F[EXPIRY]}" -le $((NOW + MAXL)) ] || die "expiry ${F[EXPIRY]} beyond now + maxLifetime ($((NOW + MAXL)))"
[ $(( ${F[EXPIRY]} - NOW )) -ge 3600 ] || echo "WARNING: less than 1 hour of lifetime left; recipients will refuse it"

COMMIT=$(commitment "${F[VALUE]}" "${F[EXPIRY]}" "${F[K0X]}" "${F[K0Y]}" "${F[DEPOSITOR]}")
EXISTING=$(cast call "$ESCROW" "deposits(bytes32)(bytes32)" "${F[COIN_ID]}" --rpc-url "$RPC")
if [ "$EXISTING" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
  [ "$EXISTING" = "$COMMIT" ] && die "coin already deposited (deposits[coinId] already equals this coin's commitment)"
  die "coinId already used by a different deposit ($EXISTING)"
fi
BAL=$(cast balance "$SENDER" --rpc-url "$RPC")
"$PY" -c "import sys; sys.exit(0 if int(sys.argv[1]) > int(sys.argv[2]) else 1)" "$BAL" "${F[VALUE]}" \
  || die "sender balance $BAL wei does not cover the value ${F[VALUE]} wei"

DEP_SIG="deposit(bytes32,uint64,uint256,uint256)"
DEP_ARGS=("${F[COIN_ID]}" "${F[EXPIRY]}" "${F[K0X]}" "${F[K0Y]}")
if ! SIM=$(cast call --from "$SENDER" --value "${F[VALUE]}" "$ESCROW" "$DEP_SIG" "${DEP_ARGS[@]}" --rpc-url "$RPC" 2>&1); then
  die "simulation reverted: $(decode_revert "$SIM")"
fi
EST=$(cast estimate --from "$SENDER" --value "${F[VALUE]}" "$ESCROW" "$DEP_SIG" "${DEP_ARGS[@]}" --rpc-url "$RPC")
echo "simulation OK (eth_call), estimated gas $EST"
if [ "$SIMULATE_ONLY" = 1 ]; then echo "--simulate-only: not sending"; exit 0; fi

R=$(cast send --json --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE" --rpc-url "$RPC" \
      --value "${F[VALUE]}" "$ESCROW" "$DEP_SIG" "${DEP_ARGS[@]}")
echo "tx $(echo "$R" | receipt_field transactionHash)  status $(echo "$R" | receipt_field status)  gasUsed $(echo "$R" | receipt_field gasUsed)  block $(echo "$R" | receipt_field blockNumber)"
[ "$(echo "$R" | receipt_field status)" = 1 ] || die "deposit transaction failed"

BN=$(echo "$R" | receipt_field blockNumber); wait_block "$BN"
GOT=$(cast call "$ESCROW" "deposits(bytes32)(bytes32)" "${F[COIN_ID]}" --block "$BN" --rpc-url "$RPC")
SLOT=$(cast index bytes32 "${F[COIN_ID]}" 0)
echo "deposits[coinId] read back: $GOT"
echo "recomputed commitment:      $COMMIT   keccak256(abi.encode(value, expiry, k0x, k0y, depositor))"
echo "storage key (for the deposit proof): keccak256(abi.encode(coinId, 0)) = $SLOT -> $(cast storage "$ESCROW" "$SLOT" --block "$BN" --rpc-url "$RPC")"
[ "$GOT" = "$COMMIT" ] && echo "MATCH: the coin is backed by this deposit" || die "MISMATCH between deposits[coinId] and the commitment"
