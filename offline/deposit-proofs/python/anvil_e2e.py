#!/usr/bin/env python3
"""End-to-end check of the escrow storage-proof path on a local anvil chain:
deploy EscrowV3Storage -> deposit(coinId, ...) -> eth_getProof(escrow, keccak256(abi.encode(coinId,0)))
-> verify header RLP (keccak == block hash), account proof and storage proof with the same functions the
deposit-proof verifier uses -> value == keccak256(abi.encode(value, expiry, k0x, k0y, depositor)).
Also proves a never-used coinId absent. Writes data/anvil/*.json for the Java harness.
Anvil has no beacon chain, so the sync-committee half is not exercised here (that is the Sepolia part).

usage: anvil_e2e.py RPC ESCROW_ADDRESS DEPOSITOR COIN_ID VALUE_WEI EXPIRY K0X K0Y
"""
import json
import os
import sys

from builder import rpc, header_rlp_from_json
from dp_core import hx, hx32, to_hex, keccak256, mapping_slot
import verifier as V

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "anvil")


def word(n):
    return n.to_bytes(32, "big")


def main(argv):
    url, escrow, depositor, coin, value, expiry, k0x, k0y = argv
    escrow_b, coin_b = hx(escrow), hx32(coin)
    commitment = keccak256(word(int(value)) + word(int(expiry)) + word(int(k0x, 0)) + word(int(k0y, 0)) + hx(depositor).rjust(32, b"\x00"))
    blk = rpc(url, "eth_getBlockByNumber", ["latest", False])
    raw, order = header_rlp_from_json(blk)
    ex = V.verify_execution_header(hx32(blk["hash"]), raw)
    os.makedirs(OUT, exist_ok=True)
    results = {}
    for label, cid in (("deposit", coin_b), ("absent", keccak256(b"never deposited"))):
        key = mapping_slot(cid, 0)
        gp = rpc(url, "eth_getProof", [escrow, [to_hex(key)], blk["number"]])
        acct = V.verify_account(ex["state_root"], escrow_b, gp["accountProof"])
        val = V.verify_storage(acct["storage_root"], key, gp["storageProof"][0]["proof"])
        doc = {"block_hash": blk["hash"], "coin_id": to_hex(cid),
               "execution": {"header_rlp": to_hex(raw), "header_fields": order},
               "account": {"address": escrow.lower(), "proof": gp["accountProof"]},
               "storage": {"key": to_hex(key), "value": to_hex(val), "proof": gp["storageProof"][0]["proof"]}}
        json.dump(doc, open(os.path.join(OUT, "anvil_%s.json" % label), "w"), indent=1)
        results[label] = to_hex(val)
    ok = hx32(results["deposit"]) == commitment and hx32(results["absent"]) == b"\x00" * 32
    print(json.dumps({"ok": ok, "block": ex["number"], "header_fields": len(order), "commitment": to_hex(commitment),
                      "proven_deposit_slot": results["deposit"], "proven_absent_slot": results["absent"]}, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
