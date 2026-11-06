#!/usr/bin/env python3
"""Positive and negative witness tests for v0_leaf and v1_ca3 on real chains (+ synthetic parser attacks).

For each case: build inputs/<circuit>/<case>.toml, run `nargo execute`, compare accept/reject with the
expectation, and record the circuit's failing assertion message. A rejected witness means no proof can be
made (UltraHonk soundness); proof-level tampering is tested separately in bench/prove_verify.sh.
Writes tests/results.json and prints a table.
"""
import json, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import chains

PY = sys.executable
SA = chains.SEAM_A
OP = f"{SA}/device_run_oneplus/otk_tee.pem"
OP2 = f"{SA}/device_run_oneplus/otk_count2.pem"
SB = f"{SA}/device_run/otk_sb.pem"
STEE = f"{SA}/device_run/otk_tee.pem"
C2 = f"{SA}/phone_vectors_v1/mint_c2.json"
E1 = f"{SA}/phone_vectors_v2_onchain/mint_e1.json"
V3B1 = f"{chains.RAW}/v3/phone_vectors/pay3_s_bob1.json"

CASES = [
    # circuit, name, generator argv, expected
    ("v0", "pos_oneplus_tee_rkp", ["--chain", OP], "accept"),
    ("v0", "pos_samsung_strongbox_factory", ["--chain", SB], "accept"),
    ("v0", "pos_v3_vector_oneplus", ["--chain", V3B1, "--select", "path[0]"], "accept"),
    ("v0", "neg_tamper_challenge", ["--chain", OP, "--mutate", "tamper_challenge"], "reject"),
    ("v0", "neg_tamper_usagecount", ["--chain", OP, "--mutate", "tamper_ucl"], "reject"),
    ("v0", "neg_high_s", ["--chain", OP, "--mutate", "high_s"], "reject"),
    ("v0", "neg_wrong_key_samsung_rkp", ["--chain", OP, "--att-from", STEE], "reject"),
    ("v0", "neg_multiuse_oneplus_count2", ["--chain", OP2], "reject"),
    ("v0", "neg_swonly_samsung_tee", ["--chain", STEE], "reject"),
    ("v0", "neg_cheat_key_mint_c2", ["--chain", C2], "reject"),
    ("v0", "neg_cheat_key_mint_e1", ["--chain", E1], "reject"),
    ("v0", "neg_truncated_len", ["--chain", OP, "--mutate", "truncated_len"], "reject"),
    ("v0", "neg_sha_pad_garbage", ["--chain", OP, "--mutate", "pad_garbage"], "reject"),
    ("v0", "neg_sha_trailing_garbage", ["--chain", OP, "--mutate", "trailing_garbage"], "reject"),
    ("v0", "synth_resign_any_key", ["SYNTH", "resign"], "accept"),
    ("v0", "synth_inject_ucl_in_challenge", ["SYNTH", "inject_ucl"], "reject"),
    ("v1", "pos_oneplus_tee_rkp", ["--chain", OP, "--min-patch", "202601"], "accept"),
    ("v1", "pos_v3_vector_oneplus", ["--chain", V3B1, "--select", "path[0]"], "accept"),
    ("v1", "neg_swonly_samsung_tee_rkp", ["--chain", STEE, "--t-from", "261106000000", "--t-until", "261113000000"], "reject"),
    ("v1", "neg_multiuse_oneplus_count2", ["--chain", OP2], "reject"),
    ("v1", "neg_revoked_attkey", ["--chain", OP, "--revoke-own"], "reject"),
    ("v1", "neg_banned_attkey", ["--chain", OP, "--ban-own"], "reject"),
    ("v1", "neg_expired_window", ["--chain", OP, "--t-until", "261118000000"], "reject"),
    ("v1", "neg_not_yet_valid", ["--chain", OP, "--t-from", "261102000000"], "reject"),
    ("v1", "neg_patch_below_policy", ["--chain", OP, "--min-patch", "202606"], "reject"),
    ("v1", "neg_wrong_ca3_key", ["--chain", OP, "--mutate", "wrong_ca3"], "reject"),
    ("v1", "neg_tamper_attcert", ["--chain", OP, "--mutate", "tamper_attcert"], "reject"),
    ("v1", "neg_tamper_challenge", ["--chain", OP, "--mutate", "tamper_challenge"], "reject"),
    ("v1", "synth_inject_spki_in_attcert", ["SYNTH", "inject_spki"], "reject"),
]

CIRC = {"v0": "v0_leaf", "v1": "v1_ca3"}


def main():
    only = sys.argv[1:]
    res = []
    for circ, name, argv, exp in CASES:
        if only and circ not in only:
            continue
        d = os.path.join(ROOT, "inputs", circ)
        os.makedirs(d, exist_ok=True)
        toml = os.path.join(d, name + ".toml")
        if argv[0] == "SYNTH":
            g = subprocess.run([PY, os.path.join(HERE, "synth.py"), argv[1], "--out", toml], capture_output=True, text=True)
        else:
            g = subprocess.run([PY, os.path.join(HERE, "gen_inputs.py"), circ] + argv + ["--out", toml],
                               capture_output=True, text=True)
        if g.returncode != 0:
            res.append(dict(circuit=circ, case=name, expected=exp, got="GENERATOR-ERROR", detail=g.stderr[-400:]))
            print(name, "GENERATOR ERROR", g.stderr[-400:]); continue
        pkg = os.path.join(ROOT, "circuits", CIRC[circ])
        rel = os.path.relpath(toml[:-5], pkg)
        t0 = time.time()
        e = subprocess.run(["nargo", "execute", "--prover-name", rel, f"case_{name}"], cwd=pkg, capture_output=True, text=True)
        dt = time.time() - t0
        out = (e.stdout + e.stderr)
        got = "accept" if e.returncode == 0 else "reject"
        msg = ""
        if got == "reject":
            for ln in out.splitlines():
                if "Failed constraint" in ln or "Assertion failed" in ln or "error:" in ln.lower() or "Cannot satisfy" in ln:
                    msg = ln.strip(); break
            # prefer the quoted assertion message
            import re
            m = re.search(r"'([^']+)'", out)
            if m: msg = m.group(1)
        else:
            for ln in out.splitlines():
                if "Circuit output" in ln:
                    msg = ln.split("Circuit output:")[1].strip()[:80] + "..."
        ok = got == exp
        res.append(dict(circuit=circ, case=name, expected=exp, got=got, ok=ok, detail=msg, gen=g.stdout.strip(),
                        execute_s=round(dt, 3)))
        print(f"{circ} {name:36s} expected={exp:6s} got={got:6s} {'PASS' if ok else 'FAIL'}  {msg}")
    os.makedirs(os.path.join(ROOT, "tests"), exist_ok=True)
    path = os.path.join(ROOT, "tests", "results.json" if not only else f"results_{'_'.join(only)}.json")
    json.dump(res, open(path, "w"), indent=1)
    bad = [r for r in res if not r.get("ok")]
    print(f"{len(res) - len(bad)}/{len(res)} cases as expected")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
