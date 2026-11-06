#!/usr/bin/env python3
"""Build Prover.toml witnesses for circuits v0_leaf / v1_ca3 from REAL attestation chains, plus negative variants.

  gen_inputs.py v0 --chain FILE [--select SUBSTR] [--mutate M] [--att-from FILE] --out Prover.toml
  gen_inputs.py v1 --chain FILE [--select SUBSTR] [--mutate M] [--revoke-own] [--ban-own]
                   [--t-from 261106000000] [--t-until 261117000000] [--min-patch 0] --out Prover.toml

Mutations (negative tests):
  tamper_challenge  flip one byte of the leaf's attestationChallenge (policy-neutral; only the signature can catch it)
  tamper_ucl        set hardware usageCountLimit to 2 in the leaf (signature AND policy break)
  high_s            keep the leaf signature's original (high) s instead of normalizing to low-s
  tamper_attcert    flip one byte inside the attestation-key certificate's extensions (v1)
  wrong_ca3         replace the public CA3 key with another real P-256 key (v1)
  truncated_len     leaf_len one byte short (prover claims a prefix of the TBS)
  pad_garbage       nonzero byte inside the SHA padding of the leaf buffer
  trailing_garbage  nonzero byte after the padded blocks of the leaf buffer
Option --att-from FILE: take the attestation key (v0) from another chain (wrong-key test).
"""
import argparse, json, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chains, poseidon2
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

P = poseidon2.P
SENT_HI = P - 1
DS_GAP = int(b"prawl-gap".hex(), 16)
DS_HA = int(b"prawl-hA".hex(), 16)
DS_R = int(b"prawl-r".hex(), 16)
LEAF_N = 704
ATT_N = 704
STATUS = os.path.join(chains.SEAM_A, "downloads", "google", "status.json")


def limbs(b32):
    return [int.from_bytes(b32[:16], "big"), int.from_bytes(b32[16:], "big")]


ZERO_PAD = False   # --zero-pad: plain zero padding for the library sha256_var variant (bench only)


def pad(b, n):
    if ZERO_PAD:
        assert len(b) + 8 <= n
        return list(b) + [0] * (n - len(b))
    """FIPS 180-4 padding inside the fixed buffer, as circuits/prawl_attest/src/sha.nr::sha256_padded expects:
    msg || 0x80 || 0.. || BE16(8*len) at the end of block k = ceil((len+9)/64); zeros after."""
    L = len(b)
    assert L + 9 <= n and n % 64 == 0, f"TBS {L} B does not fit buffer {n} (needs len+9 <= N)"
    k = (L + 9 + 63) // 64
    out = list(b) + [0x80] + [0] * (n - L - 1)
    bits = 8 * L
    out[64 * k - 2] = bits >> 8
    out[64 * k - 1] = bits & 0xFF
    return out


def toml_val(v):
    if isinstance(v, list):
        return "[" + ", ".join(toml_val(x) for x in v) + "]"
    if isinstance(v, int):
        return f'"{v}"'
    return f'"{v}"'


def write_toml(path, d):
    with open(path, "w") as f:
        for k, v in d.items():
            f.write(f"{k} = {toml_val(v)}\n")


def pick_chain(path, select):
    chains.preload_v3()
    cs = chains.load_chains(path)
    if select:
        cs = [c for c in cs if select in c[0]]
    assert cs, "no chain matched"
    return cs[0]


def sig_bytes(cert, lows=True):
    r, s = decode_dss_signature(cert.signature)
    if lows and s > chains.P256_N // 2:
        s = chains.P256_N - s
    return list(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def find_kd_fields(tbs):
    """Positions inside the leaf TBS (reference walker), used only to place mutations."""
    b = tbs
    r = chains.walk_cert_prefix(b, len(b))
    ec_, _, _ = chains.expect(b, r["after_spki"], len(b), 0xA3)
    sc, _, send = chains.expect(b, ec_, len(b), 0x30)
    p = sc
    while p < send:
        xc, xl, xend = chains.expect(b, p, send, 0x30)
        if b[xc:xc + 12] == chains.OID_KEYDESC_TLV:
            q = xc + 12
            if b[q] == 1: q += 3
            vc, vl, vend = chains.expect(b, q, xend, 0x04)
            kc, _, kend = chains.expect(b, vc, vend, 0x30)
            p2 = kc
            fields = []
            for _ in range(8):
                t, c, l, nx = chains.rd_hdr(b, p2, kend)
                fields.append((t, c, l, nx)); p2 = nx
            return fields
        p = xend
    raise ValueError("no KD")


def mutate_leaf(tbs, m):
    b = bytearray(tbs)
    f = find_kd_fields(bytes(b))
    if m == "tamper_challenge":
        t, c, l, _ = f[4]; assert t == 0x04 and l > 0
        b[c] ^= 0x01
    elif m == "tamper_ucl":
        hw = f[7]
        i = bytes(b).find(bytes.fromhex("bf831503020101"), hw[1], hw[3])
        assert i > 0
        b[i + 6] = 0x02
    return bytes(b)


# ---------------------------------------------------------------- gap-leaf Merkle trees
class GapTree:
    def __init__(self, values, depth):
        vals = sorted(set(v % P for v in values))
        pts = [0] + vals + [SENT_HI]
        self.gaps = [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
        self.depth = depth
        assert len(self.gaps) <= 2 ** depth, f"{len(self.gaps)} gaps > 2^{depth}"
        empty = poseidon2.hash_([DS_GAP, 0, 0])
        leaves = [poseidon2.hash_([DS_GAP, lo, hi]) for lo, hi in self.gaps]
        leaves += [empty] * (2 ** depth - len(leaves))
        self.levels = [leaves]
        for _ in range(depth):
            prev = self.levels[-1]
            self.levels.append([poseidon2.hash_([prev[2 * i], prev[2 * i + 1]]) for i in range(len(prev) // 2)])
        self.root = self.levels[-1][0]

    def witness(self, x):
        """(lo, hi, index, path). If x IS a member, returns the gap starting at x (the circuit must reject it)."""
        for i, (lo, hi) in enumerate(self.gaps):
            if lo < x < hi or lo == x:
                path, idx = [], i
                for d in range(self.depth):
                    path.append(self.levels[d][idx ^ 1]); idx >>= 1
                return lo, hi, i, path
        raise ValueError("no gap")


def revocation_serials():
    return [int(k, 16) for k in json.load(open(STATUS))["entries"]]


def post_mutate(d, m):
    """Buffer-level mutations (after padding)."""
    if m == "truncated_len":        # claim the TBS is 1 byte shorter (hash of a prefix)
        d["leaf_len"] -= 1
    elif m == "pad_garbage":        # nonzero byte between 0x80 and the length field
        d["leaf_tbs"][d["leaf_len"] + 3] = 0x41
    elif m == "trailing_garbage":   # nonzero byte after the padded blocks
        d["leaf_tbs"][-1] = 0x41


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("circuit", choices=["v0", "v1"])
    ap.add_argument("--chain", required=True)
    ap.add_argument("--select")
    ap.add_argument("--mutate", default="")
    ap.add_argument("--att-from")
    ap.add_argument("--revoke-own", action="store_true")
    ap.add_argument("--ban-own", action="store_true")
    ap.add_argument("--ban-dummies", type=int, default=3, help="dummy entries in the ban list")
    ap.add_argument("--t-from", type=int, default=261106000000)
    ap.add_argument("--t-until", type=int, default=261117000000)
    ap.add_argument("--min-patch", type=int, default=0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--rev-depth", type=int, default=11)
    ap.add_argument("--ban-depth", type=int, default=11)
    ap.add_argument("--leaf-n", type=int, default=LEAF_N)
    ap.add_argument("--att-n", type=int, default=ATT_N)
    ap.add_argument("--out", required=True)
    ap.add_argument("--meta", help="write a JSON with expected public outputs / secrets")
    ap.add_argument("--zero-pad", action="store_true", help="zero padding (library sha256_var bench variant)")
    a = ap.parse_args()
    global ZERO_PAD
    ZERO_PAD = a.zero_pad
    rng = random.Random(a.seed)

    lab, ch = pick_chain(a.chain, a.select)
    leaf, att = ch[0], ch[1]
    tbs = leaf.tbs_certificate_bytes
    if a.mutate in ("tamper_challenge", "tamper_ucl"):
        tbs = mutate_leaf(tbs, a.mutate)
    lsig = sig_bytes(leaf, lows=(a.mutate != "high_s"))
    meta = {"chain": lab, "mutate": a.mutate, "leaf_len": len(tbs)}
    kx, ky = chains.pub_xy(leaf)
    meta["K_limbs"] = [hex(v) for v in limbs(kx) + limbs(ky)]

    if a.circuit == "v0":
        akey = ch[1]
        if a.att_from:
            akey = pick_chain(a.att_from, None)[1][1]
        ax, ay = chains.pub_xy(akey)
        d = {"leaf_tbs": pad(tbs, a.leaf_n), "leaf_len": len(tbs), "leaf_sig": lsig,
             "att_x": list(ax), "att_y": list(ay)}
        post_mutate(d, a.mutate)
        write_toml(a.out, d)
    else:
        ca3 = ch[2]
        atbs = att.tbs_certificate_bytes
        if a.mutate == "tamper_attcert":
            bb = bytearray(atbs); bb[len(bb) - 20] ^= 0x01; atbs = bytes(bb)
        asig = sig_bytes(att)
        cx, cy = chains.pub_xy(ca3)
        ca3_limbs = limbs(cx) + limbs(cy)
        if a.mutate == "wrong_ca3":
            # another REAL P-256 key: the RKP attestation key itself (not CA3)
            wx, wy = chains.pub_xy(att)
            ca3_limbs = limbs(wx) + limbs(wy)
        ap_ = chains.walk_cert_prefix(atbs, len(atbs), True) if a.mutate != "tamper_attcert" else \
            chains.walk_cert_prefix(att.tbs_certificate_bytes, len(att.tbs_certificate_bytes), True)
        serial = ap_["serial"]
        ax, ay = chains.pub_xy(att)
        h_a = poseidon2.hash_([DS_HA] + limbs(ax) + limbs(ay))
        rev = revocation_serials()
        if a.revoke_own:
            rev.append(serial)
        rt = GapTree(rev, a.rev_depth)
        ban = [rng.randrange(1, P - 1) for _ in range(a.ban_dummies)]
        if a.ban_own:
            ban.append(h_a)
        bt = GapTree(ban, a.ban_depth)
        rlo, rhi, ridx, rpath = rt.witness(serial)
        blo, bhi, bidx, bpath = bt.witness(h_a)
        rho_a, rho_r = rng.randrange(1, P), rng.randrange(1, P)
        r_tag = poseidon2.hash_([DS_R] + limbs(bytes(lsig[:32])))
        d = {"leaf_tbs": pad(tbs, a.leaf_n), "leaf_len": len(tbs), "leaf_sig": lsig,
             "att_tbs": pad(atbs, a.att_n), "att_len": len(atbs), "att_sig": asig,
             "rev_lo": rlo, "rev_hi": rhi, "rev_index": ridx, "rev_path": rpath,
             "ban_lo": blo, "ban_hi": bhi, "ban_index": bidx, "ban_path": bpath,
             "rho_a": rho_a, "rho_r": rho_r,
             "ca3_key": ca3_limbs, "rev_root": rt.root, "ban_root": bt.root,
             "t_from": a.t_from, "t_until": a.t_until, "min_patch": a.min_patch}
        post_mutate(d, a.mutate)
        write_toml(a.out, d)
        meta.update({"att_serial": hex(serial), "att_not_before": ap_["not_before"], "att_not_after": ap_["not_after"],
                     "ca3_subject": ca3.subject.rfc4514_string(), "ca3_limbs": [hex(v) for v in ca3_limbs],
                     "rev_entries": len(set(rev)), "rev_root": hex(rt.root), "ban_root": hex(bt.root),
                     "h_a": hex(h_a), "r_tag": hex(r_tag), "rho_a": hex(rho_a), "rho_r": hex(rho_r)})
    if a.meta:
        json.dump(meta, open(a.meta, "w"), indent=1)
    print(json.dumps({k: v for k, v in meta.items() if k in ("chain", "mutate", "leaf_len", "att_serial", "rev_entries")}))


if __name__ == "__main__":
    main()
