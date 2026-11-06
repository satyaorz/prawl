#!/usr/bin/env bash
# Real transaction receipts on a local anvil (Prague) node for the lock-witness slasher.
set -e
cd "$(dirname "$0")/contracts"
anvil --port 8547 --hardfork prague > /dev/null 2>&1 &
APID=$!
trap "kill $APID" EXIT
sleep 2
forge script script/AnvilGas.s.sol --rpc-url http://127.0.0.1:8547 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --slow > /dev/null
python3 - <<'PY' | tee ../anvil_receipts.log
import json
d=json.load(open("broadcast/AnvilGas.s.sol/31337/run-latest.json"))
for tx,r in zip(d["transactions"],d["receipts"]):
    fn=tx.get("function") or tx["transactionType"]
    print(f'{(fn or "")[:60]:60s} calldata={(len(tx["transaction"]["input"])-2)//2:6d} B  gasUsed={int(r["gasUsed"],16):8d}')
PY
