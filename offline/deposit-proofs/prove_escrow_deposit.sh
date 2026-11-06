#!/usr/bin/env bash
# Prove a real escrow-v3 deposit on Sepolia and verify it offline (Python, then Java).
#   ./prove_escrow_deposit.sh COIN_ID VALUE_WEI EXPIRY K0X K0Y DEPOSITOR [recipient_cache.json]
# The expected slot value is recomputed here as keccak256(abi.encode(value, expiry, k0x, k0y, depositor)),
# exactly what a recipient does from the coin header. The deposit must be finalized (~15 min after inclusion).
set -euo pipefail
cd "$(dirname "$0")"
ESCROW=${ESCROW:-0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5}
COIN=$1 VALUE=$2 EXPIRY=$3 K0X=$4 K0Y=$5 DEPOSITOR=$6 CACHE=${7:-data/cache_now.json}
EXPECT=$(cast keccak "$(cast abi-encode 'f(uint256,uint64,uint256,uint256,address)' "$VALUE" "$EXPIRY" "$K0X" "$K0Y" "$DEPOSITOR")")
OUT=data/proof_escrow_v3_${COIN:2:16}.json
echo "storage key $(cast index bytes32 "$COIN" 0)  expected value $EXPECT"
.venv/bin/python python/builder.py proof --beacon ${BEACON:-http://unstable.sepolia.beacon-api.nimbus.team} --rpc https://0xrpc.io/sep \
    --rpc2 https://sepolia.rpc.thirdweb.com --address "$ESCROW" --coin-id "$COIN" --recipient-cache "$CACHE" --out "$OUT"
.venv/bin/python python/verifier.py --cache "$CACHE" --proof "$OUT" --address "$ESCROW" --coin-id "$COIN" --expect "$EXPECT"
echo "Java: DepositProof.verify(Cache.fromJson($CACHE), $OUT, ESCROW, escrowStorageKey(coinId), $EXPECT, now)"
