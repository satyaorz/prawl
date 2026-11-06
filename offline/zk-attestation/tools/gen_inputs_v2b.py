#!/usr/bin/env python3
"""Witnesses for the design-B primitive benchmarks, from the REAL Samsung StrongBox chain (device_run/otk_sb.pem).

  gen_inputs_v2b.py p384  --out Prover.toml   AK certificate signature (ecdsa-with-SHA256) under the P-384 intermediate key
  gen_inputs_v2b.py rsa   --out Prover.toml   intermediate certificate signature (sha256WithRSA) under the Google RSA-4096 root
  gen_inputs_v2b.py rsa-consts                prints the Noir constants (modulus, Barrett parameter) of the pinned root

Also writes Noir-ready constants for circuits/v2b_rsa4096/src/root.nr with `rsa-consts --out FILE`.
"""
import argparse, hashlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chains, allowlist as al
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

SB = os.path.join(chains.SEAM_A, "device_run", "otk_sb.pem")


def tlist(b):
    return "[" + ", ".join(f'"{x}"' for x in b) + "]"


def limbs120(v, n):
    return [(v >> (120 * i)) & ((1 << 120) - 1) for i in range(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["p384", "rsa", "rsa-consts"])
    ap.add_argument("--out")
    a = ap.parse_args()
    ch = chains.load_chains(SB)[0][1]
    ak, inter = ch[1], ch[2]
    root = al.pinned_root()
    if a.what == "p384":
        n = inter.public_key().public_numbers()
        r, s = decode_dss_signature(ak.signature)
        e = hashlib.sha256(ak.tbs_certificate_bytes).digest()
        d = {"qx": list(n.x.to_bytes(48, "big")), "qy": list(n.y.to_bytes(48, "big")),
             "r": list(r.to_bytes(48, "big")), "s": list(s.to_bytes(48, "big")), "e": list(e.rjust(48, b"\0"))}
        open(a.out, "w").write("".join(f"{k} = {tlist(v)}\n" for k, v in d.items()))
    elif a.what == "rsa":
        h = hashlib.sha256(inter.tbs_certificate_bytes).digest()
        d = {"sig": list(inter.signature), "digest": list(h)}
        assert len(inter.signature) == 512
        open(a.out, "w").write("".join(f"{k} = {tlist(v)}\n" for k, v in d.items()))
    else:
        N = root.public_key().public_numbers().n
        e = root.public_key().public_numbers().e
        assert e == 65537 and N.bit_length() == 4096
        red = (1 << (2 * 4096 + 6)) // N       # bignum: redc_param = floor(2^(2*MOD_BITS + BARRETT_OVERFLOW_BITS) / modulus)
        L = 35
        def arr(v): return "[" + ", ".join(hex(x) for x in limbs120(v, L)) + "]"
        txt = (f"// Google hardware attestation RSA-4096 root, serial f92009e853b6b045 (pinned). e = {e}.\n"
               f"pub global ROOT_MODULUS: [u128; 35] = {arr(N)};\n"
               f"pub global ROOT_REDC: [u128; 35] = {arr(red)};\n")
        if a.out:
            open(a.out, "w").write(txt)
        else:
            print(txt)


if __name__ == "__main__":
    main()
