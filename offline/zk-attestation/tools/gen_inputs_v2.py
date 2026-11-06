#!/usr/bin/env python3
"""Build Prover.toml witnesses for circuit v2_factory from REAL Samsung StrongBox factory chains, plus negatives.

  gen_inputs_v2.py --chain FILE [--select S] [--mutate M] [--att-from FILE] [--allow MODE]
                   [--revoke-ak] [--revoke-int] [--ban-own] [--t-from N] [--t-until N] [--min-patch N]
                   --out Prover.toml [--meta meta.json]

Mutations (leaf level, shared with v0/v1): tamper_challenge, tamper_ucl, high_s, truncated_len, pad_garbage, trailing_garbage.
v2-specific:
  --att-from FILE  the prover presents ANOTHER real chain's attestation key A' (listed in the allow-list, so membership
                   passes) while the leaf is signed by the Samsung AK  -> "leaf not signed by A"
  --mutate wrong_ak_bit  flip one bit of A.x (membership path of the real entry no longer fits)
  --allow MODE     real (default): list = the vetted Samsung entry (+ synthetic filler batches)
                   without: list WITHOUT the Samsung key (+ filler)  -> "attestation key not in allow-list"
                   attacker: list = attacker-chosen entries incl. the presented key (circuit accepts; the VERIFIER must
                   reject the unregistered allow_root; see evm/test/VerifyV2.t.sol and tools/anchor_demo.py)
  --resign         (synthetic) leaf TBS re-signed by a software key listed in an ATTACKER allow-list (implies --allow attacker)
  --revoke-ak / --revoke-int  add the AK / intermediate serial to Google's revocation list
"""
import argparse, json, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chains, poseidon2, gen_inputs as gi, allowlist as al

P = poseidon2.P
REAL_INDEX = 37      # position of the real Samsung batch entry in the allow-list (arbitrary; shows path handling)
N_FILLER = 200       # synthetic other-batch entries (random hashes, no certificates), only to give the tree some body


def build_list(f_real, include_real, extra_fields=None):
    t = al.SparseTree()
    idx = {}
    fill = al.synthetic_filler(N_FILLER)
    pos = [i for i in range(N_FILLER + 4) if i != REAL_INDEX]
    for i, h in zip(pos, fill):
        t.set(i, h)
    if include_real:
        t.set(REAL_INDEX, al.entry_hash(f_real)); idx["real"] = REAL_INDEX
    if extra_fields is not None:
        j = max(pos) + 1
        t.set(j, al.entry_hash(extra_fields)); idx["extra"] = j
    return t, idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chain", required=True)
    ap.add_argument("--select")
    ap.add_argument("--mutate", default="")
    ap.add_argument("--att-from")
    ap.add_argument("--allow", default="real", choices=["real", "without", "attacker"])
    ap.add_argument("--resign", action="store_true", help="synthetic: leaf re-signed by a software key A' listed in an attacker allow-list")
    ap.add_argument("--anchor-kind", type=int, default=2, help="negative test: anchor[0] != 2")
    ap.add_argument("--revoke-ak", action="store_true")
    ap.add_argument("--revoke-int", action="store_true")
    ap.add_argument("--ban-own", action="store_true")
    ap.add_argument("--ban-dummies", type=int, default=3)
    ap.add_argument("--t-from", type=int, default=261106000000)
    ap.add_argument("--t-until", type=int, default=261117000000)
    ap.add_argument("--min-patch", type=int, default=0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--rev-depth", type=int, default=11)
    ap.add_argument("--ban-depth", type=int, default=11)
    ap.add_argument("--leaf-n", type=int, default=gi.LEAF_N)
    ap.add_argument("--out", required=True)
    ap.add_argument("--meta")
    a = ap.parse_args()
    gi.ZERO_PAD = False
    rng = random.Random(a.seed)

    lab, ch = gi.pick_chain(a.chain, a.select)
    leaf, ak, inter = ch[0], ch[1], ch[2]
    try:
        f_real = al.vet_factory_chain(ak, inter)   # the REAL chain is fully vetted off-circuit (P-384 + RSA-4096)
        vet_error = None
    except al.VetError as e:
        # not a factory chain (e.g. an RKP chain): vetting refuses it, so no honest allow-list holds its key.
        # For circuit-level tests list the Samsung reference batch and present this chain's own AK fields.
        vet_error = str(e)
        _, ref = gi.pick_chain(os.path.join(chains.SEAM_A, "device_run", "otk_sb.pem"), None)
        f_real = al.vet_factory_chain(ref[1], ref[2])
        f_own = dict(ak_serial=ak.serial_number, int_serial=inter.serial_number, ax=chains.pub_xy(ak)[0], ay=chains.pub_xy(ak)[1],
                     nb=al.utc_int(ak.not_valid_before_utc), na=al.utc_int(ak.not_valid_after_utc))
    tbs = leaf.tbs_certificate_bytes
    if a.mutate in ("tamper_challenge", "tamper_ucl"):
        tbs = gi.mutate_leaf(tbs, a.mutate)
    lsig = gi.sig_bytes(leaf, lows=True)
    if a.mutate == "high_s":       # force the equally valid (r, n-s) high-s twin, whatever the phone produced
        r_ = int.from_bytes(bytes(lsig[:32]), "big"); s_ = int.from_bytes(bytes(lsig[32:]), "big")
        lsig = list(r_.to_bytes(32, "big") + (chains.P256_N - s_).to_bytes(32, "big"))
    kx, ky = chains.pub_xy(leaf)
    meta = {"chain": lab, "mutate": a.mutate, "leaf_len": len(tbs), "K_limbs": [hex(v) for v in gi.limbs(kx) + gi.limbs(ky)]}

    # the key the prover PRESENTS as A
    pres = dict(f_real) if vet_error is None else f_own
    extra = None
    if a.att_from:
        _, ch2 = gi.pick_chain(a.att_from, None)
        # another real chain's attestation key (an RKP key): put it in the list as an entry so membership holds
        pres = dict(ak_serial=ch2[1].serial_number, int_serial=ch2[2].serial_number,
                    ax=chains.pub_xy(ch2[1])[0], ay=chains.pub_xy(ch2[1])[1],
                    nb=al.utc_int(ch2[1].not_valid_before_utc), na=al.utc_int(ch2[1].not_valid_after_utc))
        extra = pres
    if a.resign:
        import synth
        atk = synth.key(0xA77AC3E5)
        rx, ry = synth.xy(atk)
        lsig = synth.sign_lows(atk, tbs)
        pres = dict(ak_serial=0xDEADBEEF, int_serial=0xFEED, ax=rx, ay=ry, nb=f_real["nb"], na=f_real["na"])
        a.allow = "attacker"
    if a.mutate == "wrong_ak_bit":
        pres = dict(pres); ax = bytearray(pres["ax"]); ax[31] ^= 1; pres["ax"] = bytes(ax)
    if a.allow == "attacker":
        # attacker builds his own tree around the key he presents (no filler, no vetting)
        t = al.SparseTree(); t.set(0, al.entry_hash(pres)); idx = {"real": 0}
        pres_idx = 0
    else:
        t, idx = build_list(f_real, include_real=(a.allow == "real"), extra_fields=extra)
        pres_idx = idx.get("extra", idx.get("real", REAL_INDEX))
    allow_root = t.root
    allow_path = t.path(pres_idx)

    rev = gi.revocation_serials()
    if a.revoke_ak:
        rev.append(pres["ak_serial"])
    if a.revoke_int:
        rev.append(pres["int_serial"])
    rt = gi.GapTree(rev, a.rev_depth)
    h_a = al.h_a(pres)
    ban = [rng.randrange(1, P - 1) for _ in range(a.ban_dummies)]
    if a.ban_own:
        ban.append(h_a)
    bt = gi.GapTree(ban, a.ban_depth)
    rlo, rhi, ridx, rpath = rt.witness(pres["ak_serial"])
    ilo, ihi, iidx, ipath = rt.witness(pres["int_serial"])
    blo, bhi, bidx, bpath = bt.witness(h_a)
    rho_a, rho_r = rng.randrange(1, P), rng.randrange(1, P)
    r_tag = poseidon2.hash_([gi.DS_R] + gi.limbs(bytes(lsig[:32])))
    d = {"leaf_tbs": gi.pad(tbs, a.leaf_n), "leaf_len": len(tbs), "leaf_sig": lsig,
         "att_x": list(pres["ax"]), "att_y": list(pres["ay"]),
         "ak_serial": pres["ak_serial"], "int_serial": pres["int_serial"], "ak_nb": pres["nb"], "ak_na": pres["na"],
         "allow_index": pres_idx, "allow_path": allow_path,
         "rev_lo": rlo, "rev_hi": rhi, "rev_index": ridx, "rev_path": rpath,
         "irev_lo": ilo, "irev_hi": ihi, "irev_index": iidx, "irev_path": ipath,
         "ban_lo": blo, "ban_hi": bhi, "ban_index": bidx, "ban_path": bpath,
         "rho_a": rho_a, "rho_r": rho_r,
         "anchor": [a.anchor_kind, allow_root, 0, 0], "rev_root": rt.root, "ban_root": bt.root,
         "t_from": a.t_from, "t_until": a.t_until, "min_patch": a.min_patch}
    gi.post_mutate(d, a.mutate)
    gi.write_toml(a.out, d)
    meta.update({"allow_root": hex(allow_root), "allow_index": pres_idx, "rev_root": hex(rt.root), "ban_root": hex(bt.root),
                 "ak_serial": hex(pres["ak_serial"]), "int_serial": hex(pres["int_serial"]), "nb": pres["nb"], "na": pres["na"],
                 "h_A": hex(h_a), "r_tag": hex(r_tag), "rho_a": hex(rho_a), "rho_r": hex(rho_r),
                 "t_from": a.t_from, "t_until": a.t_until, "min_patch": a.min_patch,
                 "rev_entries": len(set(rev)), "allow_filler": N_FILLER, "vet_error": vet_error})
    if a.meta:
        json.dump(meta, open(a.meta, "w"), indent=1)
    print(json.dumps({k: v for k, v in meta.items() if k in ("chain", "mutate", "leaf_len", "ak_serial", "allow_root")}))


if __name__ == "__main__":
    main()
