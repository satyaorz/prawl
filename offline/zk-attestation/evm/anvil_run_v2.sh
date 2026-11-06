#!/usr/bin/env bash
# Real transactions on a local anvil (hardfork osaka) for the UNIFIED gate: deploy both generated verifiers (v1 RKP, v2
# factory) + ZkOtkGate, send the v2 verify() and gate.registerKind(2, ...) as transactions, plus registerKind(1, ...)
# for comparison, print receipt gas. Optional: read-only Sepolia eth_estimateGas with state overrides (no tx sent)
# when SEPOLIA_RPC is set.   evm/anvil_run_v2.sh   (writes logs/anvil_run_v2.json)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
PORT=8562
RPC=http://127.0.0.1:$PORT
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil default account 0
TS=1794009600   # 2026-11-07 00:00 UTC, inside both proofs' [t_from, t_until]
forge build --offline >/dev/null
anvil --hardfork osaka --port $PORT --timestamp $TS --silent --code-size-limit 24576 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
until cast block-number --rpc-url $RPC >/dev/null 2>&1; do sleep 0.3; done

hexw() { xxd -p -c 32 "$1" | sed 's/^/0x/' | paste -sd, -; }
PROOF1=0x$(xxd -p fixtures/v1_proof | tr -d '\n');  PI1_HEX=$(hexw fixtures/v1_public_inputs); PI1="[$PI1_HEX]"
PROOF2=0x$(xxd -p fixtures/v2_proof | tr -d '\n');  PI2_HEX=$(hexw fixtures/v2_public_inputs); PI2="[$PI2_HEX]"
anchor() { cast keccak 0x$(echo "$1" | cut -d, -f1-4 | tr -d ',' | sed 's/0x//g'); }
A1=$(anchor "$PI1_HEX"); A2=$(anchor "$PI2_HEX")
REV=$(echo "$PI1_HEX" | cut -d, -f5); BAN=$(echo "$PI1_HEX" | cut -d, -f6)

dep() { local c=$1; shift; forge create --offline --rpc-url $RPC --private-key $PK --broadcast "$c" "$@" 2>&1; }
addr() { awk '/Deployed to:/{print $3}'; }
txh() { awk '/Transaction hash:/{print $3}'; }
L1_OUT=$(dep src/v1/HonkVerifierV1.sol:ZKTranscriptLib); L1=$(echo "$L1_OUT" | addr)
V1_OUT=$(dep src/v1/HonkVerifierV1.sol:HonkVerifier --libraries src/v1/HonkVerifierV1.sol:ZKTranscriptLib:$L1); V1=$(echo "$V1_OUT" | addr)
L2_OUT=$(dep src/v2/HonkVerifierV2.sol:ZKTranscriptLib); L2=$(echo "$L2_OUT" | addr); L2TX=$(echo "$L2_OUT" | txh)
V2_OUT=$(dep src/v2/HonkVerifierV2.sol:HonkVerifier --libraries src/v2/HonkVerifierV2.sol:ZKTranscriptLib:$L2); V2=$(echo "$V2_OUT" | addr); V2TX=$(echo "$V2_OUT" | txh)
G_OUT=$(dep src/ZkOtkGate.sol:ZkOtkGate --constructor-args $V1 $A1 $REV $BAN 202601); G=$(echo "$G_OUT" | addr); GTX=$(echo "$G_OUT" | txh)
cast send --rpc-url $RPC --private-key $PK $G "setFactoryVerifier(address)" $V2 >/dev/null
cast send --rpc-url $RPC --private-key $PK $G "setAnchor(bytes32,bool)" $A2 true >/dev/null
gas() { cast receipt --rpc-url $RPC "$1" gasUsed; }
st() { cast receipt --rpc-url $RPC "$1" --json | jq -r .status; }

CALL_OK=$(cast call --rpc-url $RPC $V2 "verify(bytes,bytes32[])(bool)" $PROOF2 "$PI2")
T1=$(cast send --rpc-url $RPC --private-key $PK --gas-limit 16000000 $V2 "verify(bytes,bytes32[])" $PROOF2 "$PI2" --json | jq -r .transactionHash)
T2=$(cast send --rpc-url $RPC --private-key $PK --gas-limit 16000000 $G "registerKind(uint8,bytes,bytes32[])" 2 $PROOF2 "$PI2" --json | jq -r .transactionHash)
T3=$(cast send --rpc-url $RPC --private-key $PK --gas-limit 16000000 $G "registerKind(uint8,bytes,bytes32[])" 1 $PROOF1 "$PI1" --json | jq -r .transactionHash)
CALLDATA=$(cast calldata "verify(bytes,bytes32[])" $PROOF2 "$PI2")
NB=$(( (${#CALLDATA} - 2) / 2 ))
NZ=$(echo -n "${CALLDATA:2}" | fold -w2 | grep -vc '^00' || true)
KH=$(cast call --rpc-url $RPC $G "checkKind(uint8,bytes,bytes32[])(bytes32)" 2 $PROOF2 "$PI2")
cat > logs/anvil_run_v2.json <<EOJ
{"hardfork": "osaka", "anvil": "$(anvil --version | head -1)",
 "v2_verifier": "$V2", "v2_verifier_runtime_bytes": $(( ($(cast code --rpc-url $RPC $V2 | wc -c) - 3) / 2 )),
 "v2_library_runtime_bytes": $(( ($(cast code --rpc-url $RPC $L2 | wc -c) - 3) / 2 )),
 "deploy_v2_library_gas": $(gas $L2TX), "deploy_v2_verifier_gas": $(gas $V2TX), "deploy_gate_gas": $(gas $GTX),
 "eth_call_verify_v2": "$CALL_OK",
 "tx_verify_v2_gas": $(gas $T1), "tx_verify_v2_status": "$(st $T1)",
 "tx_registerKind2_gas": $(gas $T2), "tx_registerKind2_status": "$(st $T2)",
 "tx_registerKind1_gas": $(gas $T3), "tx_registerKind1_status": "$(st $T3)",
 "verify_calldata_bytes": $NB, "verify_calldata_nonzero_bytes": $NZ,
 "gate_checkKind2_keyHash": "$KH"}
EOJ
cat logs/anvil_run_v2.json

if [ -n "${SEPOLIA_RPC:-}" ]; then
  # Read-only: put the anvil-deployed runtime code at the same addresses on Sepolia via state override, with the gate's
  # storage (slot 0 trustedCa3[A1], trustedCa3[A2]; 1 revRoot; 2 banRoot; 3 minPatch; 5 factoryVerifier) and estimate gas.
  VCODE1=$(cast code --rpc-url $RPC $V1); VCODE2=$(cast code --rpc-url $RPC $V2); GCODE=$(cast code --rpc-url $RPC $G)
  LCODE1=$(cast code --rpc-url $RPC $L1); LCODE2=$(cast code --rpc-url $RPC $L2)
  S1=$(cast index bytes32 $A1 0); S2=$(cast index bytes32 $A2 0)
  ONE=0x0000000000000000000000000000000000000000000000000000000000000001
  P2=0x$(printf '%064x' 202601)
  FV=0x000000000000000000000000$(echo ${V2#0x})
  OV=$(jq -nc --arg l1 $L1 --arg lc1 $LCODE1 --arg l2 $L2 --arg lc2 $LCODE2 --arg v1 $V1 --arg vc1 $VCODE1 --arg v2 $V2 --arg vc2 $VCODE2 \
        --arg g $G --arg gc $GCODE --arg s1 $S1 --arg s2 $S2 --arg one $ONE --arg rev $REV --arg ban $BAN --arg p $P2 --arg fv $FV \
        '{($l1): {code: $lc1}, ($l2): {code: $lc2}, ($v1): {code: $vc1}, ($v2): {code: $vc2},
          ($g): {code: $gc, stateDiff: {($s1): $one, ($s2): $one,
          "0x0000000000000000000000000000000000000000000000000000000000000001": $rev,
          "0x0000000000000000000000000000000000000000000000000000000000000002": $ban,
          "0x0000000000000000000000000000000000000000000000000000000000000003": $p,
          "0x0000000000000000000000000000000000000000000000000000000000000005": $fv}}}')
  FROM=0x03a62B04aBe69f382bd7582f492be735B1dDb47B
  TXV=$(jq -nc --arg f $FROM --arg t $V2 --arg d $CALLDATA '{from:$f,to:$t,data:$d}')
  DREG=$(cast calldata "registerKind(uint8,bytes,bytes32[])" 2 $PROOF2 "$PI2")
  TXG=$(jq -nc --arg f $FROM --arg t $G --arg d $DREG '{from:$f,to:$t,data:$d}')
  EV=$(cast rpc --rpc-url "$SEPOLIA_RPC" eth_estimateGas "$TXV" latest "$OV" | tr -d '"')
  EG=$(cast rpc --rpc-url "$SEPOLIA_RPC" eth_estimateGas "$TXG" latest "$OV" | tr -d '"')
  CV=$(cast rpc --rpc-url "$SEPOLIA_RPC" eth_call "$TXV" latest "$OV" | tr -d '"')
  BLK=$(cast block-number --rpc-url "$SEPOLIA_RPC")
  echo "{\"sepolia_block\": $BLK, \"estimate_verify_v2_tx\": $((EV)), \"estimate_registerKind2_tx\": $((EG)), \"eth_call_verify_result\": \"$CV\"}" | tee logs/sepolia_estimate_v2.json
fi
