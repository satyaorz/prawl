#!/usr/bin/env bash
# Re-run the deposit-proof work.
#   ./run_all.sh          offline: gindex derivation, Python vectors, Java (JVM) harness, forge tests, anvil e2e
#   ./run_all.sh online   first rebuild cache + proofs from live Sepolia (overwrites data/*.json), then offline
set -euo pipefail
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
PY="$PWD/.venv/bin/python"
LODESTAR=https://lodestar-sepolia.chainsafe.io
NIMBUS=http://unstable.sepolia.beacon-api.nimbus.team
WETH=0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9
HOLDER=0x9487c16a8fc309050690fff1bc8479708f08b96e

if [ "${1:-}" = "online" ]; then
    cd python
    "$PY" builder.py cache --beacon $LODESTAR --beacon2 $NIMBUS --out ../data/cache_now.json
    P=$("$PY" -c 'import json; print(json.load(open("../data/cache_now.json"))["committees"][0]["period"])')
    SLOT=$(( (P - 2) * 8192 ))
    ROOT=$(curl -s $NIMBUS/eth/v1/beacon/headers/$SLOT | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["data"]["root"])')
    "$PY" builder.py cache --beacon $NIMBUS --checkpoint $ROOT --no-next --out ../data/cache_1403_stale.json   # name kept: "stale" = 2 periods old
    COMMON="--beacon $LODESTAR --rpc https://0xrpc.io/sep --rpc2 https://sepolia.rpc.thirdweb.com --address $WETH"
    "$PY" builder.py proof $COMMON --mapping-key $HOLDER --mapping-slot 3 --recipient-cache ../data/cache_now.json --out ../data/proof_weth_balance.json
    COIN=0x$("$PY" -c 'import os; print(os.urandom(32).hex())'); echo $COIN > ../data/absent_coin_id.txt
    "$PY" builder.py proof $COMMON --coin-id $COIN --recipient-cache ../data/cache_now.json --out ../data/proof_absent_coin.json
    "$PY" builder.py proof $COMMON --mapping-key $HOLDER --mapping-slot 3 --recipient-cache ../data/cache_1403_stale.json --out ../data/proof_weth_balance_stepped.json
    curl -s "$LODESTAR/eth/v1/beacon/light_client/updates?start_period=$((P-2))&count=3" > ../data/raw/updates_1403_1405.json
    "$PY" -c 'import json; print(json.load(open("../data/cache_now.json"))["anchor"]["root"])' > ../data/raw/bootstrap_anchor_now.root
    curl -s $NIMBUS/eth/v1/beacon/light_client/bootstrap/$(cat ../data/raw/bootstrap_anchor_now.root) > ../data/raw/bootstrap_anchor_now.json
    echo "NOTE: solidity/test PY_COIN/PY_KEY stay a fixed vector from the 2026-11-06 data set." >&2
    cd ..
fi

echo "== gindex derivation";        (cd python && "$PY" gindex.py)
echo "== vectors + Python verifier"; (cd python && "$PY" make_vectors.py && "$PY" test_verifier.py | tail -8)
echo "== Solidity storage layout";   (cd solidity && forge test 2>&1 | tail -3 && forge inspect EscrowV3Storage storageLayout | grep deposits)
echo "== anvil end-to-end";          solidity/anvil_e2e.sh
echo "== Java (JVM) verifier";       java/run_jvm_test.sh | grep -E '^(PASS|FAIL) [A-Za-z(]|TIMING|ALL PASS|FAILURES|d8 OK'
echo "== measurements";              (cd python && "$PY" measure.py > /dev/null && echo "data/measurements.json written")
