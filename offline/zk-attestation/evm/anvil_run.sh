#!/usr/bin/env bash
# Real transactions on a local anvil (hardfork osaka): deploy the v1 verifier + gate, send verify() and
# register() as transactions, print receipt gas. Optional: read-only Sepolia eth_estimateGas with state
# overrides (no transaction is sent) when SEPOLIA_RPC is set.
#   evm/anvil_run.sh            (writes logs/anvil_run.json)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
PORT=8561
RPC=http://127.0.0.1:$PORT
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil default account 0
TS=1794009600   # 2026-11-07 00:00 UTC, inside the proof's [t_from, t_until]
forge build --offline >/dev/null
anvil --hardfork osaka --port $PORT --timestamp $TS --silent --code-size-limit 24576 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
until cast block-number --rpc-url $RPC >/dev/null 2>&1; do sleep 0.3; done

PROOF=0x$(xxd -p fixtures/v1_proof | tr -d '\n')
PI_HEX=$(xxd -p -c 32 fixtures/v1_public_inputs | sed 's/^/0x/' | paste -sd, -)
PI="[$PI_HEX]"
PI0=$(echo "$PI_HEX" | cut -d, -f1-4 | tr -d ',' | sed 's/0x//g')
CA3H=$(cast keccak 0x$PI0)
REV=$(echo "$PI_HEX" | cut -d, -f5); BAN=$(echo "$PI_HEX" | cut -d, -f6)

dep() { # contract, args...
  local c=$1; shift
  forge create --offline --rpc-url $RPC --private-key $PK --broadcast "$c" "$@" 2>&1
}
# the generated verifier calls an external library (ZKTranscriptLib): deploy it, then link
L_OUT=$(dep src/v1/HonkVerifierV1.sol:ZKTranscriptLib)
L=$(echo "$L_OUT" | awk '/Deployed to:/{print $3}'); LTX=$(echo "$L_OUT" | awk '/Transaction hash:/{print $3}')
V_OUT=$(dep src/v1/HonkVerifierV1.sol:HonkVerifier --libraries src/v1/HonkVerifierV1.sol:ZKTranscriptLib:$L)
V=$(echo "$V_OUT" | awk '/Deployed to:/{print $3}'); VTX=$(echo "$V_OUT" | awk '/Transaction hash:/{print $3}')
G_OUT=$(dep src/ZkOtkGate.sol:ZkOtkGate --constructor-args $V $CA3H $REV $BAN 202601)
G=$(echo "$G_OUT" | awk '/Deployed to:/{print $3}'); GTX=$(echo "$G_OUT" | awk '/Transaction hash:/{print $3}')
gas() { cast receipt --rpc-url $RPC "$1" gasUsed; }
st() { cast receipt --rpc-url $RPC "$1" --json | jq -r .status; }

CALL_OK=$(cast call --rpc-url $RPC $V "verify(bytes,bytes32[])(bool)" $PROOF "$PI")
T1=$(cast send --rpc-url $RPC --private-key $PK --gas-limit 16000000 $V "verify(bytes,bytes32[])" $PROOF "$PI" --json | jq -r .transactionHash)
T2=$(cast send --rpc-url $RPC --private-key $PK --gas-limit 16000000 $G "register(bytes,bytes32[])" $PROOF "$PI" --json | jq -r .transactionHash)
CALLDATA=$(cast calldata "verify(bytes,bytes32[])" $PROOF "$PI")
NB=$(( (${#CALLDATA} - 2) / 2 ))
NZ=$(echo -n "${CALLDATA:2}" | fold -w2 | grep -vc '^00' || true)
KH=$(cast call --rpc-url $RPC $G "check(bytes,bytes32[])(bytes32)" $PROOF "$PI")
cat > logs/anvil_run.json <<EOF
{"hardfork": "osaka", "anvil": "$(anvil --version | head -1)",
 "verifier": "$V", "verifier_runtime_bytes": $(( ($(cast code --rpc-url $RPC $V | wc -c) - 3) / 2 )),
 "library": "$L", "library_runtime_bytes": $(( ($(cast code --rpc-url $RPC $L | wc -c) - 3) / 2 )),
 "deploy_library_gas": $(gas $LTX), "deploy_verifier_gas": $(gas $VTX), "deploy_gate_gas": $(gas $GTX),
 "eth_call_verify": "$CALL_OK",
 "tx_verify_gas": $(gas $T1), "tx_verify_status": "$(st $T1)",
 "tx_register_gas": $(gas $T2), "tx_register_status": "$(st $T2)",
 "verify_calldata_bytes": $NB, "verify_calldata_nonzero_bytes": $NZ,
 "gate_check_keyHash": "$KH"}
EOF
cat logs/anvil_run.json

if [ -n "${SEPOLIA_RPC:-}" ]; then
  # Read-only: put the anvil-deployed runtime code at the same addresses on Sepolia via state override,
  # with the gate's storage (trustedCa3[ca3h]=1, revRoot, banRoot, minPatch) and estimate gas.
  VCODE=$(cast code --rpc-url $RPC $V); GCODE=$(cast code --rpc-url $RPC $G); LCODE=$(cast code --rpc-url $RPC $L)
  SLOT_CA3=$(cast index bytes32 $CA3H 0)
  ONE=0x0000000000000000000000000000000000000000000000000000000000000001
  P2=0x$(printf '%064x' 202601)
  OV=$(jq -nc --arg l $L --arg lc $LCODE --arg v $V --arg vc $VCODE --arg g $G --arg gc $GCODE --arg s0 $SLOT_CA3 --arg one $ONE \
        --arg rev $REV --arg ban $BAN --arg p $P2 \
        '{($l): {code: $lc}, ($v): {code: $vc}, ($g): {code: $gc, stateDiff: {($s0): $one,
          "0x0000000000000000000000000000000000000000000000000000000000000001": $rev,
          "0x0000000000000000000000000000000000000000000000000000000000000002": $ban,
          "0x0000000000000000000000000000000000000000000000000000000000000003": $p}}}')
  FROM=0x03a62B04aBe69f382bd7582f492be735B1dDb47B
  TXV=$(jq -nc --arg f $FROM --arg t $V --arg d $CALLDATA '{from:$f,to:$t,data:$d}')
  DREG=$(cast calldata "register(bytes,bytes32[])" $PROOF "$PI")
  TXG=$(jq -nc --arg f $FROM --arg t $G --arg d $DREG '{from:$f,to:$t,data:$d}')
  EV=$(cast rpc --rpc-url "$SEPOLIA_RPC" eth_estimateGas "$TXV" latest "$OV" | tr -d '"')
  EG=$(cast rpc --rpc-url "$SEPOLIA_RPC" eth_estimateGas "$TXG" latest "$OV" | tr -d '"')
  CV=$(cast rpc --rpc-url "$SEPOLIA_RPC" eth_call "$TXV" latest "$OV" | tr -d '"')
  BLK=$(cast block-number --rpc-url "$SEPOLIA_RPC")
  echo "{\"sepolia_block\": $BLK, \"estimate_verify_tx\": $((EV)), \"estimate_register_tx\": $((EG)), \"eth_call_verify_result\": \"$CV\"}" | tee logs/sepolia_estimate.json
fi
