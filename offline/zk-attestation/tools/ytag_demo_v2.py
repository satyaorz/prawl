#!/usr/bin/env python3
"""Double-spend tag on the REAL v2 (Samsung StrongBox, allow-list) proof's public outputs, plus the batch-ban consequence.
Reuses ytag_demo.py (same checks) after mapping the v2 meta keys, then shows what the extracted h_A means for v2:
it equals the allow-list entry's h_A, i.e. it names the whole factory batch that shares the attestation key."""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
SB = os.path.join(ROOT, "..", "seam_a_uncopyable", "device_run", "otk_sb.pem")
meta_p = os.path.join(ROOT, "inputs", "v2_bench.meta.json")
subprocess.check_call([sys.executable, os.path.join(HERE, "gen_inputs_v2.py"), "--chain", SB, "--min-patch", "202601",
                       "--out", "/dev/null", "--meta", meta_p], stdout=subprocess.DEVNULL)
m = json.load(open(meta_p)); m["h_a"] = m["h_A"]
tmp = meta_p + ".demo"; json.dump(m, open(tmp, "w"))
pub = os.path.join(ROOT, "bench", "out", "v2_factory", "p12", "public_inputs")
r = subprocess.run([sys.executable, os.path.join(HERE, "ytag_demo.py"), pub, tmp], capture_output=True, text=True)
print(r.stdout, r.stderr[-500:])
lst = json.load(open(os.path.join(ROOT, "inputs", "v2", "allowlist_real.json")))
print("extracted h_A names allow-list entry:", [e["ak_serial"] for e in lst["entries"] if e["h_A"] == m["h_A"]],
      "(= every phone whose factory chain uses this attestation key)")
os.remove(tmp)
sys.exit(r.returncode)
