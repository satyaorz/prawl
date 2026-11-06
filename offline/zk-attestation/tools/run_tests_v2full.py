#!/usr/bin/env python3
"""Witness tests for circuits/v2_full_chain (design B, whole chain in-circuit) on the REAL Samsung chains. -> tests/results_v2full.json"""
import json, os, re, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import chains
SA = chains.SEAM_A
SB = f"{SA}/device_run/otk_sb.pem"; C1 = f"{SA}/phone_vectors_v1/mint_c1.json"
C2 = f"{SA}/phone_vectors_v1/mint_c2.json"; E1 = f"{SA}/phone_vectors_v2_onchain/mint_e1.json"
CASES = [
    ("full_pos_otk_sb", ["--chain", SB, "--min-patch", "202601"], "accept"),
    ("full_pos_mint_c1", ["--chain", C1, "--min-patch", "202601"], "accept"),
    ("full_neg_cheat_mint_c2", ["--chain", C2], "reject"),
    ("full_neg_cheat_mint_e1", ["--chain", E1], "reject"),
    ("full_neg_tamper_ak_cert", ["--chain", SB, "--mutate", "tamper_ak"], "reject"),
    ("full_neg_tamper_int_cert", ["--chain", SB, "--mutate", "tamper_int"], "reject"),
    ("full_neg_tamper_leaf_ucl", ["--chain", SB, "--mutate", "tamper_ucl"], "reject"),
    ("full_neg_revoked_ak", ["--chain", SB, "--revoke-ak"], "reject"),
    ("full_neg_revoked_int", ["--chain", SB, "--revoke-int"], "reject"),
]
pkg = os.path.join(ROOT, "circuits", "v2_full_chain"); res = []
for name, argv, exp in CASES:
    toml = os.path.join(ROOT, "inputs", "v2b", name + ".toml")
    g = subprocess.run([sys.executable, os.path.join(HERE, "gen_inputs_v2full.py")] + argv + ["--out", toml], capture_output=True, text=True)
    assert g.returncode == 0, g.stderr[-500:]
    t0 = time.time()
    e = subprocess.run(["nargo", "execute", "--prover-name", os.path.relpath(toml[:-5], pkg), "--skip-brillig-constraints-check", f"case_{name}"],
                       cwd=pkg, capture_output=True, text=True)
    out = e.stdout + e.stderr; got = "accept" if e.returncode == 0 else "reject"
    m = re.search(r"Assertion failed: ([^\n]+)|'([^']+)'", out); msg = (m.group(1) or m.group(2)) if (m and got == "reject") else ""
    res.append(dict(case=name, expected=exp, got=got, ok=got == exp, detail=msg, execute_s=round(time.time() - t0, 2)))
    print(f"full {name:28s} expected={exp:6s} got={got:6s} {'PASS' if got == exp else 'FAIL'}  {msg}", flush=True)
json.dump(res, open(os.path.join(ROOT, "tests", "results_v2full.json"), "w"), indent=1)
print(sum(r["ok"] for r in res), "/", len(res), "as expected")
