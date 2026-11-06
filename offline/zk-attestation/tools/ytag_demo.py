#!/usr/bin/env python3
"""End-to-end check of the double-spend tag against a REAL v1 proof's public outputs.

1. Reads the v1 public inputs written by bb (bench/out/v1_ca3/p12/public_inputs): 17 x 32-byte fields
   [ca3_key x4, rev_root, ban_root, t_from, t_until, min_patch, K x4, C_A.x, C_A.y, C_r.x, C_r.y].
2. Recomputes h_A, r and the commitments from the witness secrets (gen_inputs --meta, same seed) and checks
   they equal the proof's outputs.
3. Simulates one honest payment (tag verifies), then a double spend with two different v3 spend messages
   signed by the same coin key, and extracts h_A from the two tags.
Prints sizes and (Python) timings. Usage: ytag_demo.py [public_inputs] [meta.json]
"""
import json, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import ytag

pub = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "bench", "out", "v1_ca3", "p12", "public_inputs")
meta_p = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "inputs", "v1_bench.meta.json")
if not os.path.exists(meta_p):
    OP = os.path.join(ROOT, "..", "seam_a_uncopyable", "device_run_oneplus", "otk_tee.pem")
    subprocess.check_call([sys.executable, os.path.join(HERE, "gen_inputs.py"), "v1", "--chain", OP, "--min-patch", "202601",
                           "--out", "/dev/null", "--meta", meta_p], stdout=subprocess.DEVNULL)
meta = json.load(open(meta_p))
raw = open(pub, "rb").read()
f = [int.from_bytes(raw[32 * i:32 * i + 32], "big") for i in range(len(raw) // 32)]
assert len(f) == 17, len(f)
K = f[9:13]
C_A, C_r = (f[13], f[14]), (f[15], f[16])
h_a, r = int(meta["h_a"], 16), int(meta["r_tag"], 16)
rho_a, rho_r = int(meta["rho_a"], 16), int(meta["rho_r"], 16)
out = {"public_inputs_fields": len(f), "K_matches_leaf": [hex(x) for x in K] == meta["K_limbs"]}
out["C_A_matches_python"] = ytag.commit(h_a, rho_a) == C_A
out["C_r_matches_python"] = ytag.commit(r, rho_r) == C_r

coin = "c" * 64
m1 = f"PRAWL-OTK-v3|11155111|70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5|{coin}|1794000000|1|{'a' * 64}|{'1' * 64}".encode()
m2 = m1.replace(b"|" + b"1" * 64, b"|" + b"2" * 64)
t0 = time.perf_counter(); y1, s1 = ytag.pay_tag(h_a, r, rho_a, rho_r, C_A, C_r, m1); t_pay = time.perf_counter() - t0
t0 = time.perf_counter(); ok1 = ytag.check_tag(C_A, C_r, m1, y1, s1); t_chk = time.perf_counter() - t0
out["honest_tag_verifies"] = ok1
out["tag_on_other_message_verifies"] = ytag.check_tag(C_A, C_r, m2, y1, s1)
y_bad = (y1 + 1) % ytag.Q
out["wrong_y_verifies"] = ytag.check_tag(C_A, C_r, m1, y_bad, s1)
y2, s2 = ytag.pay_tag(h_a, r, rho_a, rho_r, C_A, C_r, m2)
out["second_spend_tag_verifies"] = ytag.check_tag(C_A, C_r, m2, y2, s2)
t0 = time.perf_counter()
h_ext, r_ext = ytag.extract(ytag.challenge(m1), y1, ytag.challenge(m2), y2)
t_ext = time.perf_counter() - t0
out["extracted_h_A_equals_in_circuit_h_A"] = h_ext == h_a
out["extracted_r_equals_r"] = r_ext == r
out["tag_bytes_uncompressed"] = 32 + 64 + 32
out["tag_bytes_compressed_point"] = 32 + 33 + 32
out["python_ms"] = {"pay_tag": round(t_pay * 1e3, 1), "check_tag": round(t_chk * 1e3, 1), "extract": round(t_ext * 1e3, 3)}
print(json.dumps(out, indent=1))
assert all(out[k] for k in ("K_matches_leaf", "C_A_matches_python", "C_r_matches_python", "honest_tag_verifies",
                            "second_spend_tag_verifies", "extracted_h_A_equals_in_circuit_h_A"))
assert not out["tag_on_other_message_verifies"] and not out["wrong_y_verifies"]
