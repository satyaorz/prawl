#!/usr/bin/env python3
"""Allow-list of factory StrongBox attestation keys for circuit v2 (design A).

What this tool is: the OFF-CIRCUIT half of design A. Whoever maintains the allow-list (the app publisher, the escrow
operator, or anyone: the procedure is deterministic and public) runs `vet_factory_chain` on an observed chain
    leaf <- AK (P-256) <- INT (P-384, ecdsa-with-SHA256) <- Google RSA-4096 root
and gets an entry only if EVERY upper link verifies with real cryptography against the PINNED Google root. The entry

    entry = Poseidon2(DS_ALLOW, serial_AK, serial_INT, A.x_hi, A.x_lo, A.y_hi, A.y_lo, notBefore, notAfter)

commits to exactly what circuit v2 consumes. The tree is a fixed-depth (16) Poseidon2 Merkle tree, sparse, empty
leaf = 0 (a hash output is never 0). The root is the public input `allow_root`.

  allowlist.py vet   CHAIN [--select S]        full off-circuit verification + the entry (JSON on stdout)
  allowlist.py build OUT.json CHAIN [CHAIN..]  vet each chain, write the allow-list (certs + entries + root)
  allowlist.py audit LIST.json                 re-vet every entry from the embedded certificates and recompute the root
"""
import argparse, base64, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chains, poseidon2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

P = poseidon2.P
DEPTH = 16
DS_ALLOW = int(b"prawl-allow".hex(), 16)
ROOT_JSON = os.path.join(chains.SEAM_A, "downloads", "google", "root.json")
STATUS = os.path.join(chains.SEAM_A, "downloads", "google", "status.json")
ROOT_SERIAL_ATTR = "f92009e853b6b045"   # Google hardware attestation RSA-4096 root (subject serialNumber)


def pinned_root():
    for pem in json.load(open(ROOT_JSON)):
        c = x509.load_pem_x509_certificate(pem.encode())
        if isinstance(c.public_key(), rsa.RSAPublicKey) and ROOT_SERIAL_ATTR in c.subject.rfc4514_string():
            return c
    raise RuntimeError("pinned Google RSA root not found")


def utc_int(dt):
    return int(dt.strftime("%y%m%d%H%M%S"))


def rev_serials():
    return {int(k, 16) for k in json.load(open(STATUS))["entries"]}


class VetError(Exception):
    pass


def need(c, msg):
    if not c:
        raise VetError(msg)


def vet_factory_chain(ak, inter, root=None, revoked=None, require_strongbox=True):
    """Verify AK <- INT <- ROOT with real signatures. Returns the entry fields. Raises VetError."""
    root = root or pinned_root()
    revoked = rev_serials() if revoked is None else revoked
    # --- pinned root: byte-equal to the Google RSA-4096 root we pin (not just a matching name)
    need(root.public_key().key_size == 4096, "root is not RSA-4096")
    # --- INT signed by ROOT: RSASSA-PKCS1-v1_5 / SHA-256
    need(inter.signature_hash_algorithm.name == "sha256", "INT signature hash != SHA-256")
    try:
        root.public_key().verify(inter.signature, inter.tbs_certificate_bytes, padding.PKCS1v15(), hashes.SHA256())
    except Exception as e:
        raise VetError(f"INT not signed by root: {e!r}")
    need(inter.issuer == root.subject, "INT issuer != root subject")
    # --- AK signed by INT: ecdsa-with-SHA256 under a P-384 key
    ik = inter.public_key()
    need(isinstance(ik, ec.EllipticCurvePublicKey) and ik.curve.name == "secp384r1", "INT key is not P-384")
    need(ak.signature_algorithm_oid.dotted_string == "1.2.840.10045.4.3.2", "AK signature is not ecdsa-with-SHA256")
    try:
        ik.verify(ak.signature, ak.tbs_certificate_bytes, ec.ECDSA(hashes.SHA256()))
    except Exception as e:
        raise VetError(f"AK not signed by INT: {e!r}")
    need(ak.issuer == inter.subject, "AK issuer != INT subject")
    # --- AK is a P-256 CA key (the circuit walks leaf TBS and verifies P-256 only)
    ax, ay = chains.pub_xy(ak)
    for c, n in ((ak, "AK"), (inter, "INT")):
        bc = c.extensions.get_extension_for_class(x509.BasicConstraints).value
        need(bc.ca, f"{n} is not a CA")
    need(ak.extensions.get_extension_for_class(x509.BasicConstraints).value.path_length in (None, 0), "AK path length")
    # --- policy: StrongBox batch keys only (title=StrongBox in the subject); TEE factory keyboxes are NOT admitted
    if require_strongbox:
        need("StrongBox" in ak.subject.rfc4514_string(), "AK subject is not a StrongBox attestation key")
    # --- revocation (Google status list): none of the three serials may be listed
    for c, n in ((ak, "AK"), (inter, "INT"), (root, "root")):
        need(c.serial_number not in revoked, f"{n} serial is in Google's revocation list")
    nb = max(utc_int(ak.not_valid_before_utc), utc_int(inter.not_valid_before_utc))
    na = min(utc_int(ak.not_valid_after_utc), utc_int(inter.not_valid_after_utc))
    need(nb < na, "empty validity")
    need(max(nb, na) < 500000000000, "validity beyond 2049 (UTCTime YY<50 only)")
    return dict(ak_serial=ak.serial_number, int_serial=inter.serial_number, ax=ax, ay=ay, nb=nb, na=na)


def limbs(b32):
    return [int.from_bytes(b32[:16], "big"), int.from_bytes(b32[16:], "big")]


def entry_hash(f):
    return poseidon2.hash_([DS_ALLOW, f["ak_serial"], f["int_serial"]] + limbs(f["ax"]) + limbs(f["ay"]) + [f["nb"], f["na"]])


def h_a(f):
    """The double-spend-tag identity of the attestation key (same definition as v1: H(DS_HA, A limbs))."""
    return poseidon2.hash_([int(b"prawl-hA".hex(), 16)] + limbs(f["ax"]) + limbs(f["ay"]))


class SparseTree:
    """Fixed-depth Poseidon2 Merkle tree; only non-empty nodes are stored. Leaf i is at level 0, position i."""

    def __init__(self, depth=DEPTH):
        self.depth = depth
        self.empty = [0]
        for _ in range(depth):
            self.empty.append(poseidon2.hash_([self.empty[-1], self.empty[-1]]))
        self.nodes = [dict() for _ in range(depth + 1)]
        self.dirty = False

    def set(self, index, leaf):
        assert 0 <= index < 2 ** self.depth
        self.nodes[0][index] = leaf
        self.dirty = True

    def _build(self):
        for d in range(self.depth):
            self.nodes[d + 1] = {}
            for i in sorted({i >> 1 for i in self.nodes[d]}):
                l = self.nodes[d].get(2 * i, self.empty[d])
                r = self.nodes[d].get(2 * i + 1, self.empty[d])
                self.nodes[d + 1][i] = poseidon2.hash_([l, r])
        self.dirty = False

    @property
    def root(self):
        if self.dirty:
            self._build()
        return self.nodes[self.depth].get(0, self.empty[self.depth])

    def path(self, index):
        if self.dirty:
            self._build()
        out, i = [], index
        for d in range(self.depth):
            out.append(self.nodes[d].get(i ^ 1, self.empty[d]))
            i >>= 1
        return out


def synthetic_filler(n, seed=7):
    """Random entry hashes standing in for OTHER factory batches in tests (clearly synthetic: no certificates)."""
    import random
    rng = random.Random(seed)
    return [rng.randrange(1, P) for _ in range(n)]


def chain_for(path, select=None):
    chains.preload_v3()
    cs = chains.load_chains(path)
    if select:
        cs = [c for c in cs if select in c[0]]
    return cs[0][1]


def cmd_vet(a):
    ch = chain_for(a.chain, a.select)
    f = vet_factory_chain(ch[1], ch[2])
    f["entry"] = hex(entry_hash(f))
    f["h_A"] = hex(h_a(f))
    print(json.dumps({k: (hex(v) if isinstance(v, int) else v.hex() if isinstance(v, bytes) else v) for k, v in f.items()}, indent=1))


def cmd_build(a):
    entries, seen = [], set()
    for p in a.chains:
        ch = chain_for(p)
        f = vet_factory_chain(ch[1], ch[2])
        key = (f["ax"], f["ay"])
        if key in seen:
            continue
        seen.add(key)
        entries.append(dict(
            ak_cert=base64.b64encode(ch[1].public_bytes(serialization.Encoding.DER)).decode(),
            int_cert=base64.b64encode(ch[2].public_bytes(serialization.Encoding.DER)).decode(),
            ak_serial=hex(f["ak_serial"]), int_serial=hex(f["int_serial"]), nb=f["nb"], na=f["na"],
            ak_x=f["ax"].hex(), ak_y=f["ay"].hex(), entry=hex(entry_hash(f)), h_A=hex(h_a(f))))
    t = SparseTree()
    for i, e in enumerate(entries):
        t.set(i, int(e["entry"], 16))
    json.dump(dict(version=1, depth=DEPTH, root_cert_serial=ROOT_SERIAL_ATTR, entries=entries, root=hex(t.root)),
              open(a.out, "w"), indent=1)
    print(f"{len(entries)} entries, root {hex(t.root)}")


def cmd_audit(a):
    d = json.load(open(a.list))
    root = pinned_root()
    t = SparseTree(d["depth"])
    for i, e in enumerate(d["entries"]):
        ak = x509.load_der_x509_certificate(base64.b64decode(e["ak_cert"]))
        it = x509.load_der_x509_certificate(base64.b64decode(e["int_cert"]))
        f = vet_factory_chain(ak, it, root)
        assert hex(entry_hash(f)) == e["entry"], f"entry {i}: hash mismatch"
        t.set(i, entry_hash(f))
    assert hex(t.root) == d["root"], "root mismatch"
    print(f"audit OK: {len(d['entries'])} entries re-vetted against the pinned root, root {d['root']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    v = sp.add_parser("vet"); v.add_argument("chain"); v.add_argument("--select"); v.set_defaults(fn=cmd_vet)
    b = sp.add_parser("build"); b.add_argument("out"); b.add_argument("chains", nargs="+"); b.set_defaults(fn=cmd_build)
    u = sp.add_parser("audit"); u.add_argument("list"); u.set_defaults(fn=cmd_audit)
    a = ap.parse_args()
    a.fn(a)
