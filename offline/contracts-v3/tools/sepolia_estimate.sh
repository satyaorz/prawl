#!/usr/bin/env bash
# READ-ONLY gas estimates on the REAL Sepolia RPC (its own fee schedule, which anvil cannot emulate). Sends nothing:
# only eth_estimateGas / eth_call. For a redemption of a coin that is not deposited there, a state override
# puts the coin's commitment into deposits[coinId] (storage slot keccak256(abi.encode(coinId, 0))) and gives the
# escrow enough balance, so the estimate is that of a FIRST redemption (all path keys new).
#   tools/sepolia_estimate.sh --rpc <sepolia-rpc> <mint3_*.json> [redeem3_*.json ...]
set -euo pipefail
source "$(dirname "$0")/sepolia_lib.sh"
parse_common "$@"
MINT=${ARGS[0]}
load_fields mint "$MINT"
SENDER=$(sender_address)
echo "RPC chain $(cast chain-id --rpc-url "$RPC"), block $(cast block-number --rpc-url "$RPC") (READ-ONLY: estimates and eth_call only)"
DEP=$(cast estimate --from "$SENDER" --value "${F[VALUE]}" "$ESCROW" "deposit(bytes32,uint64,uint256,uint256)" \
      "${F[COIN_ID]}" "${F[EXPIRY]}" "${F[K0X]}" "${F[K0Y]}" --rpc-url "$RPC")
echo "deposit                         estimated gas $DEP"
for B in "${ARGS[@]:1}"; do
  unset F; declare -A F
  load_fields redeem "$B"
  COMMIT=$(commitment "${F[VALUE]}" "${F[EXPIRY]}" "${F[K0X]}" "${F[K0Y]}" "${F[DEPOSITOR]}")
  SLOT=$(cast index bytes32 "${F[COIN_ID]}" 0)
  CD=$(cast calldata "$REDEEM_SIG" "${F[ARG_HEADER]}" "${F[ARG_PATH]}" "${F[ARG_REDEMPTION]}")
  OV="{\"$ESCROW\":{\"balance\":\"$(cast to-hex "${F[VALUE]}")\",\"stateDiff\":{\"$SLOT\":\"$COMMIT\"}}}"
  TX="{\"from\":\"$SENDER\",\"to\":\"$ESCROW\",\"data\":\"$CD\"}"
  RET=$(cast rpc eth_call "$TX" latest "$OV" --rpc-url "$RPC" | tr -d '"')
  EST=$(cast rpc eth_estimateGas "$TX" latest "$OV" --rpc-url "$RPC" | tr -d '"')
  echo "redeem $(basename "$B") (depth ${F[DEPTH]}): eth_call returns $RET (1 = pays), estimated gas $(cast to-dec "$EST")"
done
