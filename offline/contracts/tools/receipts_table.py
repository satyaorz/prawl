#!/usr/bin/env python3
"""Print gasUsed from a forge broadcast file (anvil receipts), one row per transaction."""
import json, sys

run = json.load(open(sys.argv[1]))
rcpt = {r["transactionHash"]: r for r in run["receipts"]}
print(f"{'#':>2}  {'function':42s} {'calldata B':>10s} {'gasUsed':>10s} status")
for i, tx in enumerate(run["transactions"]):
    r = rcpt.get(tx["hash"], {})
    fn = tx.get("function") or ("deploy " + (tx.get("contractName") or "?"))
    data = tx["transaction"].get("input") or tx["transaction"].get("data") or "0x"
    print(f"{i:>2}  {fn[:42]:42s} {len(data) // 2 - 1:>10d} {int(r.get('gasUsed', '0x0'), 16):>10d} {r.get('status')}")
