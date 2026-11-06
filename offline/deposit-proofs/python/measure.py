#!/usr/bin/env python3
"""Measure DepositProof / cache / update sizes (JSON, gzip, and an exact compact binary encoding defined
below) and Python verification time per stage. Writes data/measurements.json.

Compact binary encoding (a proposal; the verifier today reads JSON):
  LCHeader   = slot u64 | proposer u64 | parent 32 | state 32 | body 32 | execution_block_hash 32 | execution_branch 11x32   (496 B)
  Finality   = attested LCHeader | finalized LCHeader | finality_branch 9x32 | bits 64 | signature 96 | signature_slot u64     (1448 B)
  Update     = Finality | next_sync_committee 512x48 + 48 | next_sync_committee_branch 11x32                                  (26424 B)
  Proof      = version u8 | n_updates u8 | Update* | Finality | u16 len + header RLP | u8 n + (u16 len + node)* account |
               u8 n + (u16 len + node)* storage
  Address, storage key and value are omitted: the recipient knows the escrow, computes the key from coinId and
  compares the commitment it recomputes from the coin header.
  Cache      = u8 version | anchor root 32 | anchor slot u64 | u8 n | (period u64 | 512x48 | 48)*
"""
import gzip
import json
import os
import struct
import sys
import time

import config as C
import verifier as V
from dp_core import hx, hx32

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")


def lc_header(h):
    b = h["beacon"]
    out = struct.pack("<QQ", int(b["slot"]), int(b["proposer_index"])) + hx32(b["parent_root"]) + hx32(b["state_root"]) + hx32(b["body_root"])
    out += hx32(h["execution_block_hash"]) + b"".join(hx32(x) for x in h["execution_branch"])
    return out


def finality(u):
    sa = u["sync_aggregate"]
    return (lc_header(u["attested_header"]) + lc_header(u["finalized_header"]) + b"".join(hx32(x) for x in u["finality_branch"])
            + hx(sa["sync_committee_bits"]) + hx(sa["sync_committee_signature"]) + struct.pack("<Q", int(u["signature_slot"])))


def update(u):
    nsc = u["next_sync_committee"]
    return (finality(u) + b"".join(hx(p) for p in nsc["pubkeys"]) + hx(nsc["aggregate_pubkey"])
            + b"".join(hx32(x) for x in u["next_sync_committee_branch"]))


def nodes(lst):
    return bytes([len(lst)]) + b"".join(struct.pack("<H", len(hx(n))) + hx(n) for n in lst)


def proof_bin(p):
    parts = {
        "header": bytes([1, len(p["updates"])]),
        "updates": b"".join(update(u) for u in p["updates"]),
        "finality_update": finality(p["finality_update"]),
        "execution_header_rlp": struct.pack("<H", len(hx(p["execution"]["header_rlp"]))) + hx(p["execution"]["header_rlp"]),
        "account_proof": nodes(p["account"]["proof"]),
        "storage_proof": nodes(p["storage"]["proof"]),
    }
    return parts


def cache_bin(c):
    out = bytes([1]) + hx32(c["anchor"]["root"]) + struct.pack("<Q", int(c["anchor"]["header"]["slot"])) + bytes([len(c["committees"])])
    for cm in c["committees"]:
        out += struct.pack("<Q", cm["period"]) + b"".join(hx(p) for p in cm["pubkeys"]) + hx(cm["aggregate_pubkey"])
    return out


def jsizes(obj):
    mini = json.dumps(obj, separators=(",", ":")).encode()
    return {"json_minified": len(mini), "json_gzip": len(gzip.compress(mini, 9))}


def main():
    m = {"proofs": {}, "caches": {}, "updates": {}, "python_timing": {}}
    for name in ["proof_weth_balance.json", "proof_absent_coin.json", "proof_weth_balance_stepped.json"] + \
            sorted(f for f in os.listdir(DATA) if f.startswith("proof_boundary")):
        p = json.load(open(os.path.join(DATA, name)))
        parts = proof_bin(p)
        b = b"".join(parts.values())
        drop = {k: v for k, v in p.items() if k != "meta"}
        m["proofs"][name] = {**jsizes(drop), "binary_total": len(b), "binary_gzip": len(gzip.compress(b, 9)),
                             "binary_parts": {k: len(v) for k, v in parts.items()},
                             "account_nodes": len(p["account"]["proof"]), "storage_nodes": len(p["storage"]["proof"]),
                             "n_updates": len(p["updates"])}
    for name in ["cache_now.json", "cache_1403_stale.json"]:
        c = json.load(open(os.path.join(DATA, name)))
        b = cache_bin(c)
        m["caches"][name] = {**jsizes(c), "binary": len(b), "committees": [x["period"] for x in c["committees"]],
                             "binary_per_committee": 8 + 512 * 48 + 48}
    ups = json.load(open(os.path.join(DATA, "raw", "updates_1403_1405.json")))
    for u in ups:
        d = u["data"]
        per = C.period_at_slot(int(d["attested_header"]["beacon"]["slot"]))
        m["updates"]["period_%d" % per] = {"api_json_bytes": len(json.dumps(u, separators=(",", ":"))),
                                           **jsizes(d), "binary": len(update(d))}
    # Python timing (py_ecc pure-Python BLS dominates)
    cache = json.load(open(os.path.join(DATA, "cache_now.json")))
    stale = json.load(open(os.path.join(DATA, "cache_1403_stale.json")))
    for label, cch, pname in [("inclusion_cached", cache, "proof_weth_balance.json"),
                              ("absent_cached", cache, "proof_absent_coin.json"),
                              ("stepped_2_updates", stale, "proof_weth_balance_stepped.json")]:
        p = json.load(open(os.path.join(DATA, pname)))
        runs = []
        for _ in range(3):
            t = []
            t0 = time.perf_counter()
            V.verify_deposit_proof(cch, p, hx(p["account"]["address"]), hx32(p["storage"]["key"]), timings=t)
            tot = time.perf_counter() - t0
            bls = sum(x[1] for x in t)
            runs.append((tot, bls))
        runs.sort()
        tot, bls = runs[1]
        m["python_timing"][label] = {"total_s": round(tot, 3), "bls_s": round(bls, 3), "non_bls_ms": round((tot - bls) * 1000, 1),
                                     "bls_calls": len(t), "runs": 3, "statistic": "median", "lib": "py_ecc 8.0.0 (pure Python)"}
    json.dump(m, open(os.path.join(DATA, "measurements.json"), "w"), indent=1)
    print(json.dumps(m, indent=1))


if __name__ == "__main__":
    sys.exit(main())
