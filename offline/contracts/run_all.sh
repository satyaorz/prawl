#!/usr/bin/env bash
# Re-run everything in this folder. Needs: forge/anvil 1.5.1 (solc 0.8.28 is fetched/used by forge),
# ../.venv with `cryptography` (already present). No phone access is needed: the phone data is in ../phone_vectors_v1.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

echo "== 1. phone JSON -> Foundry fixtures (re-verifies every real signature in Python)"
../.venv/bin/python tools/vectors_to_foundry.py | tee fixtures/converter_output.txt
../.venv/bin/python tools/vectors_v2_to_foundry.py | tee fixtures/converter_v2_output.txt
../.venv/bin/python tools/make_leaked_keybox.py

echo "== 2. tests (osaka)"
forge test -vv --offline 2>&1 | tee logs/forge_test_osaka.log | grep -E "PASS|FAIL|Suite result|  "

echo "== 3. gas report"
forge test --offline --gas-report > logs/forge_gas_report.log 2>&1; grep -E "Function Name|redeem|deposit|finalize|proveEquivocation|cacheIssuer|registerAttestationKey|bond|slash" logs/forge_gas_report.log

echo "== 4. EIP-7883 comparison (prague = before Fusaka's MODEXP repricing)"
FOUNDRY_PROFILE=prague forge test --offline --match-test "test_gas_p384_unhinted|test_gas_modexp" -vv 2>&1 | tee logs/forge_prague_compare.log | grep -E "UNHINTED|MODEXP|cap"

echo "== 5. anvil (--hardfork osaka) receipts"
PORT=${PORT:-18645}
anvil --hardfork osaka --port "$PORT" --silent > logs/anvil.log 2>&1 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
until cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1; do sleep 0.5; done
# anvil's well-known dev key #0 (local test chain only)
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/AnvilGas.s.sol --rpc-url "http://127.0.0.1:$PORT" --offline --broadcast --slow > logs/anvil_script.log 2>&1
../.venv/bin/python tools/receipts_table.py broadcast/AnvilGas.s.sol/31337/run-latest.json | tee logs/anvil_receipts.txt

echo "== 6. anvil receipts for the v2 real-phone vectors (r1 tip-auth redeem at 0x...0E5C70, e1 equivocation)"
kill $APID 2>/dev/null || true
tools/anvil_v2.sh $((PORT + 1)) | tee logs/anvil_v2_receipts.txt
