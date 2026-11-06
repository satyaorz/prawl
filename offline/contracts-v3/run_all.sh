#!/usr/bin/env bash
# Re-run everything in escrow_v3. Needs forge/anvil 1.5.1 (solc 0.8.28) and the seam_a venv with `cryptography`.
# No phone is needed. Logs land in logs/.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-../../seam_a_uncopyable/.venv/bin/python}
mkdir -p logs logs/calldata

echo "== 1. SYNTHETIC vectors (software P-256 keys, phone bundle format) -> Foundry fixture (re-verified in Python)"
"$PY" tools/gen_vectors.py | tee logs/gen_vectors.txt
"$PY" tools/bundles_to_foundry.py | tee logs/bundles_to_foundry.txt
if [ -d vectors/phone_run3 ]; then
  echo "   REAL phone v3 bundles (vectors/phone_run3, copied from android_test/relay3); depositor = stand-in 0x...0A11CE"
  "$PY" tools/bundles_to_foundry.py --in vectors/phone_run3 --out fixtures/v3_phone.json \
    --depositor 0x00000000000000000000000000000000000A11CE | tee logs/bundles_to_foundry_phone.txt
fi

echo "== 2. sizes and storage layout"
forge build --offline --sizes 2>&1 | grep -E "PrawlEscrowV3|DeviceBondRegistry|Contract" | tee logs/sizes.txt
forge inspect --offline src/PrawlEscrowV3.sol:PrawlEscrowV3 storageLayout | tee logs/storage_layout.txt

echo "== 3. tests (osaka)"
forge test --offline -vv 2>&1 | tee logs/forge_test.log | grep -E "^\[(PASS|FAIL|SKIP)|Suite result"

cp logs/gas_forge.md logs/gas_forge_exec.md; cp logs/gas_forge_misc.md logs/gas_forge_misc_exec.md

echo "== 4. phone-format smoke test: the same bundles WITHOUT _test, converted with --depositor, generic replay"
SIM=$(mktemp -d)
"$PY" - "$SIM" <<'EOF'
import json, glob, os, sys
for f in glob.glob("vectors/synthetic/*.json"):
    b = json.load(open(f)); b.pop("_test", None)
    json.dump(b, open(os.path.join(sys.argv[1], os.path.basename(f).replace("redeem_", "redeem3_").replace("pay_", "pay3_")), "w"))
EOF
"$PY" tools/bundles_to_foundry.py --in "$SIM" --out fixtures/_phone_sim.json --depositor 0x00000000000000000000000000000000000A11CE > logs/phone_sim_convert.txt
V3_FIXTURE=fixtures/_phone_sim.json forge test --offline --match-test test_generic_phoneFixture -vv 2>&1 | tee logs/phone_sim_replay.log \
  | grep -E "^\[(PASS|FAIL)|redemptions paid|messages rebuilt|equivocations proven"
rm -rf "$SIM" fixtures/_phone_sim.json

echo "== 5. gas report"
forge test --offline --gas-report --match-contract "GasReportTest|AttestedEscrowTest|GasTest" > logs/forge_gas_report.log 2>&1
sed -n '/src\/PrawlEscrowV3.sol:PrawlEscrowV3 Contract/,/^$/p' logs/forge_gas_report.log | grep -E "Function Name|deposit|redeem|proveEquivocation|reclaim|withdrawOwed|Deployment|^\| [0-9]"
# --gas-report runs tests in isolation: lastCallGas then includes the 21k base + calldata (= a full transaction)
mv logs/gas_forge.md logs/gas_forge_isolated_tx.md; mv logs/gas_forge_misc.md logs/gas_forge_misc_isolated_tx.md
echo "-- execution gas (callee side):"; cat logs/gas_forge_exec.md logs/gas_forge_misc_exec.md
echo "-- the same calls as full transactions (forge isolation mode):"; cat logs/gas_forge_isolated_tx.md

echo "== 6. anvil (--hardfork osaka) receipts, 2^24 check, eth_getProof of deposits[coinId]"
forge script script/EncodeCalldata.s.sol --offline > logs/encode_calldata.log 2>&1
tools/anvil_receipts.sh "${PORT:-18762}" | tee logs/anvil_receipts.txt
