#!/usr/bin/env python3
"""Run every vector in data/vectors/manifest.json through the Python verifier, plus Python-only
checks that patch code constants. Writes data/vectors/python_results.json. Exit 1 on any mismatch."""
import json
import os
import sys
import time

import config as C
import dp_core
import verifier as V
from dp_core import hx, hx32, ProofError

HERE = os.path.dirname(os.path.abspath(__file__))
VEC = os.path.join(HERE, "..", "data", "vectors")


def run_vector(v, cache_cache={}):
    if v["cache"] not in cache_cache:
        cache_cache[v["cache"]] = json.load(open(os.path.join(VEC, v["cache"])))
    cache = cache_cache[v["cache"]]
    proof = json.load(open(os.path.join(VEC, v["proof"])))
    key = hx32(v["key"]) if v["key"] else hx32(proof["storage"]["key"])
    exp = hx32(v["expected_value"]) if v["expected_value"] else None
    mp = v["min_participants"] or C.MIN_PARTICIPANTS
    t0 = time.perf_counter()
    try:
        res = V.verify_deposit_proof(cache, proof, hx(v["address"]), key, exp, mp, now=v["now"])
        return "accept", res, None, time.perf_counter() - t0
    except ProofError as e:
        return "reject", None, str(e), time.perf_counter() - t0
    except Exception as e:  # noqa: BLE001 - malformed input must also be a rejection, but flag it
        return "reject", None, "UNEXPECTED %s: %s" % (type(e).__name__, e), time.perf_counter() - t0


def patched_fork_test():
    """Real committee + real signature, but the verifier believes the signing epoch is Fulu."""
    cache = json.load(open(os.path.join(VEC, "cache_now.json")))
    proof = json.load(open(os.path.join(VEC, "proof_weth_balance.json")))
    saved = list(C.FORK_SCHEDULE)
    out = {}
    for label, version in [("fulu_0x90000075", "90000075"), ("electra_0x90000074", "90000074"), ("correct_gloas_0x90000076", "90000076")]:
        C.FORK_SCHEDULE[-1] = (C.FORK_SCHEDULE[-1][0], bytes.fromhex(version))
        try:
            V.verify_deposit_proof(cache, proof, hx(proof["account"]["address"]), hx32(proof["storage"]["key"]))
            out[label] = "accept"
        except ProofError as e:
            out[label] = "reject: " + str(e)
        finally:
            C.FORK_SCHEDULE[:] = saved
    return out


def main():
    manifest = json.load(open(os.path.join(VEC, "manifest.json")))
    results, bad = [], 0
    for v in manifest:
        got, res, err, dt = run_vector(v)
        ok = got == v["expect"] and (err is None or not err.startswith("UNEXPECTED"))
        bad += not ok
        print("%-44s expect=%-6s got=%-6s %s %6.2fs  %s" % (v["name"], v["expect"], got, "PASS" if ok else "FAIL", dt,
                                                            (err or "value=%s block=%s" % (res["value"], res["block_number"]))[:110]))
        results.append({"name": v["name"], "expect": v["expect"], "got": got, "error": err,
                        "value": res and res["value"], "block_number": res and res["block_number"], "seconds": round(dt, 3)})
    pf = patched_fork_test()
    print("patched fork version on real data:", json.dumps(pf, indent=1))
    pf_ok = pf["correct_gloas_0x90000076"] == "accept" and pf["fulu_0x90000075"].startswith("reject") and pf["electra_0x90000074"].startswith("reject")
    bad += not pf_ok
    json.dump({"vectors": results, "patched_fork_real_data": pf}, open(os.path.join(VEC, "python_results.json"), "w"), indent=1)
    print("%d/%d vectors as expected; patched-fork test %s" % (len(manifest) - (bad - (not pf_ok)), len(manifest), "PASS" if pf_ok else "FAIL"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
