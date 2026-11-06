#!/usr/bin/env python3
"""Positive and negative witness tests for v2_factory on the REAL Samsung S25 Ultra StrongBox chains.

Same method as run_tests.py: build inputs/v2/<case>.toml, `nargo execute`, compare accept/reject with the expectation,
record the failing assertion. A rejected witness means no proof can be made. Writes tests/results_v2.json.
Run:  python tools/run_tests_v2.py [substring-filter]
"""
import json, os, re, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import chains

PY = sys.executable
SA = chains.SEAM_A
SB = f"{SA}/device_run/otk_sb.pem"                      # Samsung S25U StrongBox, usageCountLimit=1 in strongBoxEnforced
C1 = f"{SA}/phone_vectors_v1/mint_c1.json"
R1 = f"{SA}/phone_vectors_v2_onchain/mint_r1.json"
C2 = f"{SA}/phone_vectors_v1/mint_c2.json"             # real multi-use cheat key (no usageCountLimit)
E1 = f"{SA}/phone_vectors_v2_onchain/mint_e1.json"     # real multi-use cheat key (no usageCountLimit)
V3B2 = f"{chains.RAW}/v3/phone_vectors/pay3_s_bob2.json"
OP = f"{SA}/device_run_oneplus/otk_tee.pem"            # OnePlus TEE, RKP chain (for v2 it is not a factory chain)
STEE = f"{SA}/device_run/otk_tee.pem"                   # Samsung TEE, RKP chain, limit only in software

CASES = [
    ("pos_samsung_strongbox_otk_sb", ["--chain", SB, "--min-patch", "202601"], "accept"),
    ("pos_samsung_mint_c1", ["--chain", C1, "--min-patch", "202601"], "accept"),
    ("pos_samsung_mint_r1", ["--chain", R1, "--min-patch", "202601"], "accept"),
    ("pos_v3_vector_samsung_bob2", ["--chain", V3B2, "--select", "path[0]", "--min-patch", "202601"], "accept"),
    ("neg_cheat_key_mint_c2", ["--chain", C2], "reject"),
    ("neg_cheat_key_mint_e1", ["--chain", E1], "reject"),
    ("neg_tamper_ucl", ["--chain", SB, "--mutate", "tamper_ucl"], "reject"),
    ("neg_tamper_challenge", ["--chain", SB, "--mutate", "tamper_challenge"], "reject"),
    ("neg_high_s", ["--chain", SB, "--mutate", "high_s"], "reject"),
    ("neg_truncated_len", ["--chain", SB, "--mutate", "truncated_len"], "reject"),
    ("neg_sha_pad_garbage", ["--chain", SB, "--mutate", "pad_garbage"], "reject"),
    ("neg_wrong_ak_other_real_key_in_list", ["--chain", SB, "--att-from", OP], "reject"),
    ("neg_wrong_ak_bit_flipped", ["--chain", SB, "--mutate", "wrong_ak_bit"], "reject"),
    ("neg_key_not_on_allowlist", ["--chain", SB, "--allow", "without"], "reject"),
    ("neg_revoked_ak_serial", ["--chain", SB, "--revoke-ak"], "reject"),
    ("neg_revoked_intermediate_serial", ["--chain", SB, "--revoke-int"], "reject"),
    ("neg_banned_ak", ["--chain", SB, "--ban-own"], "reject"),
    ("neg_chain_expires_before_t_until", ["--chain", SB, "--t-until", "341001000000"], "reject"),
    ("neg_chain_not_yet_valid", ["--chain", SB, "--t-from", "240101000000"], "reject"),
    ("neg_patch_below_policy", ["--chain", SB, "--min-patch", "202611"], "reject"),
    ("neg_oneplus_rkp_chain_not_factory", ["--chain", OP, "--allow", "without"], "reject"),
    ("neg_samsung_tee_rkp_chain", ["--chain", STEE, "--allow", "without"], "reject"),
    ("neg_anchor_kind_is_v1", ["--chain", SB, "--anchor-kind", "1"], "reject"),
    # the circuit ALONE accepts a self-made allow-list; the verifier must reject the unregistered allow_root
    ("acc_attacker_allowlist_real_leaf", ["--chain", SB, "--allow", "attacker"], "accept"),
    ("acc_attacker_allowlist_software_resigned_leaf", ["--chain", SB, "--resign"], "accept"),
]


def main():
    only = sys.argv[1:]
    d = os.path.join(ROOT, "inputs", "v2")
    os.makedirs(d, exist_ok=True)
    pkg = os.path.join(ROOT, "circuits", "v2_factory")
    res = []
    for name, argv, exp in CASES:
        if only and not any(o in name for o in only):
            continue
        toml = os.path.join(d, name + ".toml")
        meta = os.path.join(d, name + ".meta.json")
        g = subprocess.run([PY, os.path.join(HERE, "gen_inputs_v2.py")] + argv + ["--out", toml, "--meta", meta],
                           capture_output=True, text=True)
        if g.returncode != 0:
            res.append(dict(circuit="v2", case=name, expected=exp, got="GENERATOR-ERROR", ok=False, detail=g.stderr[-400:]))
            print(name, "GENERATOR ERROR", g.stderr[-400:]); continue
        rel = os.path.relpath(toml[:-5], pkg)
        t0 = time.time()
        e = subprocess.run(["nargo", "execute", "--prover-name", rel, f"case_{name}"], cwd=pkg, capture_output=True, text=True)
        dt = time.time() - t0
        out = e.stdout + e.stderr
        got = "accept" if e.returncode == 0 else "reject"
        msg = ""
        if got == "reject":
            m = re.search(r"'([^']+)'", out)
            msg = m.group(1) if m else next((ln.strip() for ln in out.splitlines() if "error" in ln.lower()), "")
        else:
            for ln in out.splitlines():
                if "Circuit output" in ln:
                    msg = ln.split("Circuit output:")[1].strip()[:80] + "..."
        try:
            ve = json.load(open(meta)).get("vet_error")
        except Exception:
            ve = None
        if ve:
            msg += f"  [off-circuit vetting also refuses this chain: {ve}]"
        ok = got == exp
        res.append(dict(circuit="v2_factory", case=name, expected=exp, got=got, ok=ok, detail=msg, gen=g.stdout.strip(),
                        execute_s=round(dt, 3)))
        print(f"v2 {name:48s} expected={exp:6s} got={got:6s} {'PASS' if ok else 'FAIL'}  {msg}", flush=True)
    path = os.path.join(ROOT, "tests", "results_v2.json" if not only else "results_v2_partial.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(res, open(path, "w"), indent=1)
    bad = [r for r in res if not r.get("ok")]
    print(f"{len(res) - len(bad)}/{len(res)} cases as expected")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
