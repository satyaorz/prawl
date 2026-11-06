#!/usr/bin/env python3
"""Prover.toml for circuits/v2_full_chain (DESIGN B: P-384 + RSA-4096 verified in-circuit) from a REAL Samsung chain.
  gen_inputs_v2full.py --chain FILE [--select S] [--mutate tamper_ak|tamper_int|tamper_ucl] [--revoke-ak] [--revoke-int]
                       [--t-from N] [--t-until N] [--min-patch N] --out Prover.toml
"""
import argparse, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chains, poseidon2, gen_inputs as gi, allowlist as al
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

P = poseidon2.P
CERT_N = 448


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chain", required=True)
    ap.add_argument("--select")
    ap.add_argument("--mutate", default="")
    ap.add_argument("--revoke-ak", action="store_true")
    ap.add_argument("--revoke-int", action="store_true")
    ap.add_argument("--t-from", type=int, default=261106000000)
    ap.add_argument("--t-until", type=int, default=261117000000)
    ap.add_argument("--min-patch", type=int, default=0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    gi.ZERO_PAD = False
    _, ch = gi.pick_chain(a.chain, a.select)
    leaf, ak, inter = ch[0], ch[1], ch[2]
    tbs = leaf.tbs_certificate_bytes
    if a.mutate == "tamper_ucl":
        tbs = gi.mutate_leaf(tbs, a.mutate)
    atbs, itbs = ak.tbs_certificate_bytes, inter.tbs_certificate_bytes
    if a.mutate == "tamper_ak":
        b = bytearray(atbs); b[len(b) - 20] ^= 1; atbs = bytes(b)
    if a.mutate == "tamper_int":
        b = bytearray(itbs); b[len(b) - 20] ^= 1; itbs = bytes(b)
    lsig = gi.sig_bytes(leaf)
    r, s = decode_dss_signature(ak.signature)
    f = al.vet_factory_chain(ak, inter)          # for serials / key / h_A only
    rev = gi.revocation_serials()
    if a.revoke_ak: rev.append(f["ak_serial"])
    if a.revoke_int: rev.append(f["int_serial"])
    rt = gi.GapTree(rev, 11)
    h_a = al.h_a(f)
    bt = gi.GapTree([rng.randrange(1, P - 1) for _ in range(3)], 11)
    rlo, rhi, ridx, rpath = rt.witness(f["ak_serial"])
    ilo, ihi, iidx, ipath = rt.witness(f["int_serial"])
    blo, bhi, bidx, bpath = bt.witness(h_a)
    d = {"leaf_tbs": gi.pad(tbs, gi.LEAF_N), "leaf_len": len(tbs), "leaf_sig": lsig,
         "ak_tbs": gi.pad(atbs, CERT_N), "ak_len": len(atbs),
         "ak_sig_r": list(r.to_bytes(48, "big")), "ak_sig_s": list(s.to_bytes(48, "big")),
         "int_tbs": gi.pad(itbs, CERT_N), "int_len": len(itbs), "int_sig": list(inter.signature),
         "rev_lo": rlo, "rev_hi": rhi, "rev_index": ridx, "rev_path": rpath,
         "irev_lo": ilo, "irev_hi": ihi, "irev_index": iidx, "irev_path": ipath,
         "ban_lo": blo, "ban_hi": bhi, "ban_index": bidx, "ban_path": bpath,
         "rho_a": rng.randrange(1, P), "rho_r": rng.randrange(1, P),
         "anchor": [3, 0, 0, 0], "rev_root": rt.root, "ban_root": bt.root,
         "t_from": a.t_from, "t_until": a.t_until, "min_patch": a.min_patch}
    gi.write_toml(a.out, d)
    print("ok")


if __name__ == "__main__":
    main()
