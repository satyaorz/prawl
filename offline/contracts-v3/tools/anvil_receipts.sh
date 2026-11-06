#!/usr/bin/env bash
# Full-transaction gas (receipts) on `anvil --hardfork osaka` for the SYNTHETIC v3 vectors, plus:
#  * an explicit EIP-7825 check (anvil 1.5.1 does not enforce the 2^24 per-tx gas cap, so we check receipts
#    ourselves and also show that anvil accepts a tx with gas limit 30,000,000);
#  * an eth_getProof of deposits[coinId] (slot-0 mapping) verified independently by tools/verify_storage_proof.py.
# The escrow is deployed normally and its runtime code placed at 0x...0E5C70 (the address the vectors were
# signed for) with anvil_setCode; its constructor writes no storage, so this is equivalent to deploying there.
# Usage: tools/anvil_receipts.sh [port]     (run from escrow_v3/, after the fixture + script/EncodeCalldata.s.sol)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${1:-18762}
R=http://127.0.0.1:$PORT
PY=../../seam_a_uncopyable/.venv/bin/python
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil dev key #0 (local test chain only)
ESCROW=0x00000000000000000000000000000000000E5C70
SINK=0x00000000000000000000000000000000005111C0
J=fixtures/v3_synthetic.json
CAP=16777216
mkdir -p logs

anvil --hardfork osaka --port "$PORT" --timestamp 1793966400 --silent > logs/anvil.log 2>&1 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
until cast chain-id --rpc-url "$R" >/dev/null 2>&1; do sleep 0.3; done

q() { "$PY" -c "import json,sys;d=json.load(open('$J'))
for k in sys.argv[1].split('.'): d=d[int(k)] if k.isdigit() else d[k]
print(d)" "$1"; }
row() { "$PY" -c "import json,sys;r=json.load(sys.stdin);g=int(r['gasUsed'],16)
print(f\"{sys.argv[1]:34s} {sys.argv[2]:>7s} {g:>10d} {int(r['status'],16):>6d}  {'OK' if g < $CAP else 'OVER 2^24'}\")" "$1" "$2"; }

echo "chain id $(cast chain-id --rpc-url "$R"), hardfork osaka, genesis timestamp $(cast block 0 --field timestamp --rpc-url "$R")"
BYTECODE=$(forge inspect --offline src/PrawlEscrowV3.sol:PrawlEscrowV3 bytecode)
ARGS=$(cast abi-encode "c(uint256,uint256,address,bool)" 604800 5184000 $SINK false)
DEPLOY=$(cast send --json --private-key $PK --rpc-url "$R" --create "${BYTECODE}${ARGS#0x}")
DEPLOYED=$(echo "$DEPLOY" | "$PY" -c "import json,sys;print(json.load(sys.stdin)['contractAddress'])")
cast rpc anvil_setCode $ESCROW "$(cast code "$DEPLOYED" --rpc-url "$R")" --rpc-url "$R" >/dev/null
printf "%-34s %7s %10s %6s\n" "transaction" "data B" "gasUsed" "status"
echo "$DEPLOY" | row "deploy PrawlEscrowV3" "$(( (${#BYTECODE} + ${#ARGS}) / 2 - 2 ))"

DEP=$(q coins.tree.depositor)
cast rpc anvil_impersonateAccount "$DEP" --rpc-url "$R" >/dev/null
cast rpc anvil_setBalance "$DEP" 0x3635C9ADC5DEA00000 --rpc-url "$R" >/dev/null # 1000 ETH
for c in gas_d0_f2 gas_d1_f2 gas_d1_f4 gas_d2_f2 gas_d2_f4 gas_d3_f2 gas_d3_f4 gas_d16_f2 tree eq eq0; do
  OUT=$(cast send --json --unlocked --from "$DEP" --rpc-url "$R" $ESCROW "deposit(bytes32,uint64,uint256,uint256)" \
        "$(q coins.$c.coinId)" "$(q coins.$c.expiry)" "$(q coins.$c.k0x)" "$(q coins.$c.k0y)" --value "$(q coins.$c.value)")
  echo "$OUT" | row "deposit $c" 132
done
for n in gas_d0_f2 gas_d1_f2 gas_d1_f2_sib gas_d1_f4 gas_d1_f4_sib gas_d2_f2 gas_d2_f2_sib gas_d2_f4 gas_d2_f4_sib \
         gas_d3_f2 gas_d3_f2_sib gas_d3_f4 gas_d3_f4_sib gas_d16_f2 tree_gina2a eq_cat eq_dan prove_eq0; do
  CD=$(cat logs/calldata/$n.hex)
  OUT=$(cast send --json --private-key $PK --rpc-url "$R" $ESCROW "$CD")
  label="redeem $n"; [ "$n" = prove_eq0 ] && label="proveEquivocation eq0 (genesis)"
  [ "$n" = eq_dan ] && label="redeem eq_dan (DETECTS equivocation)"
  echo "$OUT" | row "$label" "$(( ${#CD} / 2 - 1 ))"
done
echo "eq frozen: $(cast call $ESCROW 'coins(bytes32)(uint128,bool,bool)' "$(q coins.eq.coinId)" --rpc-url "$R" | tr '\n' ' ')"

echo
echo "== EIP-7825 (2^24 = $CAP per tx): anvil 1.5.1 does not enforce it"
OUT=$(cast send --json --private-key $PK --rpc-url "$R" --gas-limit 30000000 0x000000000000000000000000000000000000dEaD --value 1)
echo "$OUT" | "$PY" -c "import json,sys;r=json.load(sys.stdin);print('  a transfer with gas limit 30,000,000 was mined, status', int(r['status'],16), '-> the cap must be checked by us (receipts above)')"

echo
echo "== eth_getProof of deposits[coinId] for coin 'tree' (storage slot 0 mapping)"
CID=$(q coins.tree.coinId)
SLOT=$(cast index bytes32 "$CID" 0)
echo "  storage key keccak256(abi.encode(coinId, uint256(0))) = $SLOT"
cast proof $ESCROW "$SLOT" --rpc-url "$R" > logs/proof_tree.json
ROOT=$(cast block latest --field stateRoot --rpc-url "$R")
echo "  block $(cast block-number --rpc-url "$R") stateRoot $ROOT"
"$PY" tools/verify_storage_proof.py logs/proof_tree.json "$ROOT" $ESCROW "$CID" "$(q coins.tree.value)" \
  "$(q coins.tree.expiry)" "$(q coins.tree.k0x)" "$(q coins.tree.k0y)" "$DEP" | sed 's/^/  /'

# ---------------------------------------------------------------------------------------------------------
# REAL phone v3 redemption (fixtures/v3_phone.json): the phones signed for chain 11155111 and escrow 0x...0E5C70,
# so a second anvil runs with --chain-id 11155111.
if [ -f fixtures/v3_phone.json ]; then
  kill $APID 2>/dev/null || true
  PORT2=$((PORT + 1)); R=http://127.0.0.1:$PORT2; J=fixtures/v3_phone.json
  anvil --hardfork osaka --port "$PORT2" --chain-id 11155111 --timestamp 1793966400 --silent > logs/anvil_phone.log 2>&1 &
  APID=$!
  until cast chain-id --rpc-url "$R" >/dev/null 2>&1; do sleep 0.3; done
  echo
  echo "== REAL phone v3 vectors on anvil --chain-id $(cast chain-id --rpc-url "$R") (escrow runtime at $ESCROW)"
  DEPLOY=$(cast send --json --private-key $PK --rpc-url "$R" --create "${BYTECODE}${ARGS#0x}")
  DEPLOYED=$(echo "$DEPLOY" | "$PY" -c "import json,sys;print(json.load(sys.stdin)['contractAddress'])")
  cast rpc anvil_setCode $ESCROW "$(cast code "$DEPLOYED" --rpc-url "$R")" --rpc-url "$R" >/dev/null
  DEP=$(q coins.s.depositor)
  cast rpc anvil_impersonateAccount "$DEP" --rpc-url "$R" >/dev/null
  cast rpc anvil_setBalance "$DEP" 0x3635C9ADC5DEA00000 --rpc-url "$R" >/dev/null
  printf "%-34s %7s %10s %6s\n" "transaction" "data B" "gasUsed" "status"
  cast send --json --unlocked --from "$DEP" --rpc-url "$R" $ESCROW "deposit(bytes32,uint64,uint256,uint256)" \
    "$(q coins.s.coinId)" "$(q coins.s.expiry)" "$(q coins.s.k0x)" "$(q coins.s.k0y)" --value "$(q coins.s.value)" | row "deposit s (REAL phone coin)" 132
  for f in logs/calldata/phone_*.hex; do
    CD=$(cat "$f")
    cast send --json --private-key $PK --rpc-url "$R" $ESCROW "$CD" | row "redeem REAL $(basename "$f" .hex | cut -c7-26)" "$(( ${#CD} / 2 - 1 ))"
  done
  echo "payout 0x...0B0B00 balance: $(cast balance 0x00000000000000000000000000000000000B0B00 --rpc-url "$R") wei"
fi
