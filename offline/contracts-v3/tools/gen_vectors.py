#!/usr/bin/env python3
"""SYNTHETIC v3 test vectors: multi-level split trees signed with SOFTWARE P-256 keys.

Output: vectors/synthetic/*.json, one bundle per file, in EXACTLY the phone's v3 bundle format
(android_test/.../Wallet3Activity.java: mint3 header, pay3 path records, redeem3 "redeem" record, carried
certs keyed by the phone's 128-bit cert id), so that tools/bundles_to_foundry.py treats synthetic and real
phone bundles identically. The only addition is an optional "_test" object (name, expected contract
outcome, comment) that phones never write.

Software keys get a synthetic leaf certificate signed by a synthetic CA (NOT self-signed: a one-time key
must never sign anything but its one spend, or its certificate signature would itself be evidence of a
second message). Signatures use RFC 6979 deterministic ECDSA, so re-running gives identical files.
The attested coin's genesis key is the SYNTHETIC "leaked keybox" leaf copied from seam_a (fixtures/leaked_keybox.json).

Run:  ../../seam_a_uncopyable/.venv/bin/python tools/gen_vectors.py
"""
import datetime as dt
import hashlib
import json
import os
import shutil
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

import prawl_v3 as P

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "vectors", "synthetic")

NOW = 1_793_966_400  # 2026-11-06 12:00 UTC (the Foundry tests warp here)
EXPIRY = NOW + 30 * 86400
CHAIN_ID = "31337"
ESCROW40 = "00000000000000000000000000000000000e5c70"  # the phones' default test escrow address
ESCROW_B40 = "00000000000000000000000000000000000e5c71"  # a second escrow (wrong-escrow tests)
DEPOSITOR40 = "00000000000000000000000000000000000a11ce"
ETH = 10**18
SIGALG = ec.ECDSA(hashes.SHA256(), deterministic_signing=True)


def payout(name: str) -> str:
    """Deterministic EOA-like payout address (no code, not a precompile), in the phone's input style '0x...'."""
    return "0x" + hashlib.sha256(b"payout|" + name.encode()).hexdigest()[:40]


# ------------------------------------------------------------------ synthetic certificates

_ca_key = ec.derive_private_key(int.from_bytes(hashlib.sha256(b"prawl-v3 synthetic CA").digest(), "big") % P.P256_N,
                                ec.SECP256R1())
_ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SYNTHETIC Prowl v3 software-key CA")])
_ca_cert = (x509.CertificateBuilder().subject_name(_ca_name).issuer_name(_ca_name).public_key(_ca_key.public_key())
            .serial_number(1).not_valid_before(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
            .not_valid_after(dt.datetime(2028, 1, 1, tzinfo=dt.timezone.utc))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(_ca_key, hashes.SHA256(), ecdsa_deterministic=True)).public_bytes(serialization.Encoding.DER)


class Key:
    """A software one-time key with a phone-style chain [leaf id, CA id] (or an explicit attested chain)."""

    def __init__(self, name: str, priv=None, chain_ders=None):
        self.name = name
        if priv is None:
            seed = int.from_bytes(hashlib.sha256(b"prawl-v3 key|" + name.encode()).digest(), "big") % (P.P256_N - 1) + 1
            priv = ec.derive_private_key(seed, ec.SECP256R1())
        self.priv = priv
        self.pub = priv.public_key()
        self.hash = P.key_hash(self.pub)
        self.x, self.y = P.key_xy(self.pub)
        if chain_ders is None:
            cn = f"SYNTHETIC v3 software key {name}"
            if len(cn) > 64:  # X.509 CN limit
                cn = "SYNTHETIC v3 software key " + hashlib.sha256(name.encode()).hexdigest()[:24]
            leaf = (x509.CertificateBuilder()
                    .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
                    .issuer_name(_ca_name).public_key(self.pub)
                    .serial_number(int(self.hash[:16], 16))
                    .not_valid_before(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
                    .not_valid_after(dt.datetime(2028, 1, 1, tzinfo=dt.timezone.utc))
                    .sign(_ca_key, hashes.SHA256(), ecdsa_deterministic=True)).public_bytes(serialization.Encoding.DER)
            chain_ders = [leaf, _ca_cert]
        self.chain = [P.cert_id(d) for d in chain_ders]
        self.certs = {P.cert_id(d): P.b64e(d) for d in chain_ders}

    def sign(self, msg: bytes) -> bytes:
        return self.priv.sign(msg, SIGALG)


class Note:
    def __init__(self, header, path, value, note_id, key, certs):
        self.header, self.path, self.value, self.note_id, self.key, self.certs = header, path, value, note_id, key, certs

    @property
    def depth(self):
        return len(self.path)


def mint(label: str, value: int, k0: Key, depositor40=DEPOSITOR40, chain_id=CHAIN_ID, escrow40=ESCROW40,
         expiry=EXPIRY, coin_salt="") -> Note:
    h = {"v": 3, "label": label,
         "coinId": hashlib.sha256(b"prawl-v3 coin|" + label.encode() + coin_salt.encode()).hexdigest(),
         "chainId": chain_id, "escrow": escrow40, "expiry": expiry, "value": str(value), "k0": k0.chain,
         "k0x": format(k0.x, "x"), "k0y": format(k0.y, "x"), "depositor": depositor40}
    return Note(h, [], value, P.genesis_note_id(h), k0, dict(k0.certs))


class Spent:
    """Result of one spend: its signature and outputs, plus the child notes / redemption records."""

    def __init__(self, note: Note, outs, sig: bytes, targets):
        self.note, self.outs, self.sig, self.targets = note, outs, sig, targets

    def child(self, i: int) -> Note:
        k = self.targets[i]
        assert isinstance(k, Key), "output is not a key output"
        rec = {"outputs": self.outs, "index": i, "sig": P.b64e(self.sig), "next": k.chain}
        certs = dict(self.note.certs)
        certs.update(k.certs)
        return Note(self.note.header, self.note.path + [rec], int(self.outs[i]["value"]),
                    P.child_note_id(self.sig, i), k, certs)

    def redeem_bundle(self, i: int, test: dict) -> dict:
        po = self.targets[i]
        assert isinstance(po, str), "output is not a REDEEM output"
        return {"header": self.note.header, "path": self.note.path,
                "redeem": {"outputs": self.outs, "index": i, "payout": po, "sig": P.b64e(self.sig)},
                "certs": self.note.certs, "_test": test}


def spend(note: Note, targets, values, signer: Key = None, depth=None, redeem_chain=None,
          redeem_escrow=None) -> Spent:
    """note's key (or `signer`, for forgeries) signs a spend creating outputs (values[i] -> targets[i]).
    A target is a Key (a note) or a payout address string (a PRAWL-REDEEM output)."""
    redeem_chain = note.header["chainId"] if redeem_chain is None else redeem_chain
    redeem_escrow = note.header["escrow"] if redeem_escrow is None else redeem_escrow
    outs = []
    for t, v in zip(targets, values):
        if isinstance(t, Key):
            outs.append({"value": str(v), "key": t.hash})
        else:
            outs.append({"value": str(v), "key": P.redeem_key(redeem_chain, redeem_escrow, t.lower().replace("0x", ""))})
    msg = P.spend_message(note.header, note.depth if depth is None else depth, note.note_id, outs)
    sig = (signer or note.key).sign(msg)
    return Spent(note, outs, sig, list(targets))


def held_bundle(note: Note, test: dict) -> dict:
    """What a recipient holds after accepting a payment (phone pay3 bundle)."""
    return {"header": note.header, "path": note.path, "certs": note.certs, "_test": test}


FILES = {}


def emit(fname: str, bundle: dict):
    assert fname not in FILES, fname
    FILES[fname] = bundle


def redeem_all(sp: Spent, idx: int, name: str, expect="ok", comment=""):
    emit(f"redeem_{name}.json", sp.redeem_bundle(idx, {"name": name, "expect": expect, "comment": comment}))


# ------------------------------------------------------------------ scenario: the split tree

def tree():
    K = {n: Key(n) for n in ["alice0", "bob1", "alice1", "charlie1", "bob2", "dave1", "alice2", "erin1", "frank1",
                             "gina1", "dave2", "gina2"]}
    g = mint("tree", 1 * ETH, K["alice0"])
    # Alice pays Bob 0.2, change 0.8 to her own fresh key
    s0 = spend(g, [K["bob1"], K["alice1"]], [ETH // 5, 4 * ETH // 5])
    bob1, alice1 = s0.child(0), s0.child(1)
    # Bob pays Charlie 0.1, change 0.1
    s1 = spend(bob1, [K["charlie1"], K["bob2"]], [ETH // 10, ETH // 10])
    charlie1, bob2 = s1.child(0), s1.child(1)
    # Alice's change pays Dave 0.5, change 0.3
    s3 = spend(alice1, [K["dave1"], K["alice2"]], [ETH // 2, 3 * ETH // 10])
    dave1, alice2 = s3.child(0), s3.child(1)
    # Dave fans out to 4: Erin 0.2, Frank 0.1, Gina 0.1, change 0.1
    s4 = spend(dave1, [K["erin1"], K["frank1"], K["gina1"], K["dave2"]], [ETH // 5, ETH // 10, ETH // 10, ETH // 10])
    erin1, frank1, gina1, dave2 = (s4.child(i) for i in range(4))
    # Gina redeems half and keeps half (partial redemption with change)
    s7 = spend(gina1, [payout("gina"), K["gina2"]], [ETH // 20, ETH // 20])
    gina2 = s7.child(1)
    for n, note in [("bob1", bob1), ("alice1", alice1), ("charlie1", charlie1), ("bob2", bob2), ("dave1", dave1),
                    ("alice2", alice2), ("erin1", erin1), ("frank1", frank1), ("gina1", gina1), ("dave2", dave2),
                    ("gina2", gina2)]:
        emit(f"pay_tree_{n}.json", held_bundle(note, {"name": f"held_tree_{n}", "comment": "what the holder received"}))
    # every leaf redeems (tip auth)
    redeem_all(spend(charlie1, [payout("charlie")], [ETH // 10]), 0, "tree_charlie", comment="depth 2")
    redeem_all(spend(bob2, [payout("bob")], [ETH // 10]), 0, "tree_bob", comment="Bob's change, depth 2")
    redeem_all(spend(alice2, [payout("alice")], [3 * ETH // 10]), 0, "tree_alice", comment="Alice's change, depth 2")
    redeem_all(spend(erin1, [payout("erin")], [ETH // 5]), 0, "tree_erin", comment="depth 3, fan-out 4 parent")
    redeem_all(spend(frank1, [payout("frank")], [ETH // 10]), 0, "tree_frank", comment="depth 3")
    redeem_all(spend(dave2, [payout("dave")], [ETH // 10]), 0, "tree_dave", comment="Dave's change, depth 3")
    redeem_all(s7, 0, "tree_gina", comment="partial redemption: REDEEM output next to a change output, depth 3")
    s8 = spend(gina2, [payout("gina"), payout("gina_savings")], [3 * ETH // 100, 2 * ETH // 100])
    redeem_all(s8, 0, "tree_gina2a", comment="two REDEEM outputs in one spend (a), depth 4")
    redeem_all(s8, 1, "tree_gina2b", comment="two REDEEM outputs in one spend (b), depth 4")

    # ---- negative vectors built on the same tree (each is a DIFFERENT message by an honest-path key, so the
    # tests run them on fresh state; if they reached the chain after the valid one, they would be equivocations)
    redeem_all(spend(charlie1, [payout("charlie")], [ETH // 10], redeem_escrow=ESCROW_B40), 0,
               "tree_charlie_targetEscrowB", expect="NotRedeemOutput",
               comment="REDEEM output names escrow B while the path is signed for escrow A: NotRedeemOutput at A, BadSig(0) at B")
    redeem_all(spend(charlie1, [payout("charlie")], [ETH // 10], redeem_chain="1"), 0,
               "tree_charlie_targetChain1", expect="NotRedeemOutput",
               comment="REDEEM output names chainId 1: NotRedeemOutput on 31337, BadSig(0) after vm.chainId(1)")
    redeem_all(spend(charlie1, [payout("bob")], [ETH // 10], signer=K["bob1"]), 0,
               "tree_bobSignsCharliesRedeem", expect="BadSig",
               comment="no tip auth: Bob (who paid Charlie) holds Charlie's path and signs the REDEEM himself")
    redeem_all(spend(charlie1, [payout("charlie")], [ETH // 10], depth=1), 0,
               "tree_charlie_wrongDepth", expect="BadSig", comment="tip signs depth 1 instead of 2")
    return K


# ------------------------------------------------------------------ scenario: conservation violations (validly signed)

def bad():
    K = {n: Key(n) for n in ["mal0", "m1", "m2", "m3", "m4"]}
    g = mint("bad", ETH // 5, K["mal0"])
    for name, vals, expect in [("over", [3 * ETH // 20, ETH // 10], "ConservationViolated"),   # 0.25 > 0.2
                               ("under", [ETH // 10, ETH // 20], "ConservationViolated"),     # 0.15 < 0.2
                               ("zero", [ETH // 5, 0], "ZeroOutput")]:
        s = spend(g, [K["m1"], K["m2"]], vals)
        m1 = s.child(0)
        redeem_all(spend(m1, [payout("m1")], [vals[0]]), 0, f"bad_{name}", expect=expect,
                   comment=f"genesis spend outputs {vals} of a 0.2 ETH note")
    s = spend(g, [K["m3"], K["m4"]], [ETH // 10, ETH // 10])
    m3, m4 = s.child(0), s.child(1)
    redeem_all(spend(m3, [payout("m3")], [3 * ETH // 20]), 0, "bad_tipOver", expect="ConservationViolated",
               comment="REDEEM spend claims 0.15 from a 0.1 note")
    redeem_all(spend(m4, [payout("m4")], [ETH // 20]), 0, "bad_tipUnder", expect="ConservationViolated",
               comment="REDEEM spend of 0.05 from a 0.1 note")
    redeem_all(spend(m3, [payout("m3")], [ETH // 10]), 0, "bad_valid", comment="the valid redemption in this coin")


# ------------------------------------------------------------------ scenario: equivocation inside a tree

def eq():
    K = {n: Key(n) for n in ["ann0", "ben1", "ann1", "cat1", "ben2", "dan1"]}
    g = mint("eq", ETH, K["ann0"])
    s0 = spend(g, [K["ben1"], K["ann1"]], [2 * ETH // 5, 3 * ETH // 5])
    ben1, ann1 = s0.child(0), s0.child(1)
    # Ben's "one-time" key (broken hardware / software) signs TWO different splits of his 0.4 note
    sa = spend(ben1, [K["cat1"], K["ben2"]], [3 * ETH // 10, ETH // 10])
    sb = spend(ben1, [K["dan1"]], [2 * ETH // 5])
    cat1, ben2, dan1 = sa.child(0), sa.child(1), sb.child(0)
    redeem_all(spend(cat1, [payout("cat")], [3 * ETH // 10]), 0, "eq_cat", comment="branch A of Ben's equivocation")
    redeem_all(spend(ben2, [payout("ben")], [ETH // 10]), 0, "eq_ben", comment="branch A (Ben's change)")
    redeem_all(spend(dan1, [payout("dan")], [2 * ETH // 5]), 0, "eq_dan", expect="equivocation",
               comment="branch B of Ben's equivocation")
    redeem_all(spend(ann1, [payout("ann")], [3 * ETH // 5]), 0, "eq_ann", comment="not under Ben: stays redeemable")
    for n, note in [("cat1", cat1), ("dan1", dan1)]:
        emit(f"pay_eq_{n}.json", held_bundle(note, {"name": f"held_eq_{n}"}))

    # genesis equivocation: everything is under the broken key
    K0 = {n: Key(n) for n in ["zed0", "yan1", "yan2", "zed1"]}
    g0 = mint("eq0", ETH // 2, K0["zed0"])
    a = spend(g0, [K0["yan1"]], [ETH // 2])
    b = spend(g0, [K0["yan2"], K0["zed1"]], [ETH // 4, ETH // 4])
    redeem_all(spend(a.child(0), [payout("yan1")], [ETH // 2]), 0, "eq0_yan1", comment="genesis branch A")
    redeem_all(spend(b.child(0), [payout("yan2")], [ETH // 4]), 0, "eq0_yan2", expect="equivocation",
               comment="genesis branch B")
    redeem_all(spend(b.child(1), [payout("zed1")], [ETH // 4]), 0, "eq0_zed1", expect="equivocation",
               comment="genesis branch B (the equivocator's own change)")


# ------------------------------------------------------------------ scenario: gas matrix (depth x fan-out)

def gas():
    for f in (2, 4):
        for d in (0, 1, 2, 3, 8, 16):
            if d == 0 and f == 4:
                continue
            if d in (8, 16) and f == 4:
                continue
            label = f"gas_d{d}_f{f}"
            note = mint(label, ETH, Key(label + "_k0"))
            last = None
            for lvl in range(d):
                keys = [Key(f"{label}_l{lvl}_o{i}") for i in range(f)]
                vals = [ETH // (f ** (lvl + 1))] * f
                vals[0] = note.value - sum(vals[1:])
                last = spend(note, keys, vals)
                note = last.child(0)
            redeem_all(spend(note, [payout(label)], [note.value]), 0, label,
                       comment=f"{d} spend(s) of fan-out {f}, then the REDEEM spend")
            if last is not None:
                sib = last.child(1)
                redeem_all(spend(sib, [payout(label + "_sib")], [sib.value]), 0, label + "_sib",
                           comment="sibling of the above: every key on its path is already recorded")


# ------------------------------------------------------------------ scenario: attested genesis key (leaked keybox)

def attested():
    lk = json.load(open(os.path.join(ROOT, "fixtures", "leaked_keybox.json")))
    leaf0 = bytes.fromhex(lk["leaves"][0]["der"][2:])
    priv = ec.derive_private_key(int(lk["leaves"][0]["priv"], 16), ec.SECP256R1())
    k0 = Key("att0_leakedLeaf0", priv=priv,
             chain_ders=[leaf0, bytes.fromhex(lk["ak"][2:]), bytes.fromhex(lk["ca"][2:])])
    assert k0.x == int(lk["leaves"][0]["x"], 16)
    K = {n: Key(n) for n in ["hal1", "ivy1", "jon1"]}
    g = mint("att", ETH, k0)
    s = spend(g, [K["hal1"], K["ivy1"]], [3 * ETH // 5, 2 * ETH // 5])
    redeem_all(spend(s.child(0), [payout("hal")], [3 * ETH // 5]), 0, "att_hal",
               comment="attested (SYNTHETIC leaked-keybox) genesis key, honest branch")
    t = spend(g, [K["jon1"]], [ETH])
    redeem_all(spend(t.child(0), [payout("jon")], [ETH]), 0, "att_jon", expect="equivocation",
               comment="the attested 'one-time' genesis key signs a second split: slashable")


def coin_for(args):
    """A fresh SYNTHETIC coin for a given (chain, escrow, depositor, expiry), written as PHONE-FORMAT files:
    mint3_<label>.json (header + certs, what Wallet3Activity.mint3 writes), pay3_<label>_<who>.json and
    redeem3_<label>_<who>.json. Tree: Alice -> Bob 40% + Alice change 60%; Bob -> Charlie 25% + Bob change 75%;
    Charlie, Bob's change and Alice's change each redeem (depths 2, 2, 1). The coinId is fresh per salt."""
    esc40 = args.escrow.lower().replace("0x", "")
    dep40 = args.depositor.lower().replace("0x", "")
    salt = args.salt or os.urandom(16).hex()
    tag = hashlib.sha256(salt.encode()).hexdigest()[:8]
    K = {n: Key(f"{args.label}|{salt}|{n}") for n in ["alice0", "bob1", "alice1", "charlie1", "bob2"]}
    v = int(args.value)
    g = mint(args.label, v, K["alice0"], depositor40=dep40, chain_id=str(args.chain_id), escrow40=esc40,
             expiry=int(args.expiry), coin_salt="|" + salt)
    vb = v * 2 // 5
    s0 = spend(g, [K["bob1"], K["alice1"]], [vb, v - vb])
    bob1, alice1 = s0.child(0), s0.child(1)
    vc = vb // 4
    s1 = spend(bob1, [K["charlie1"], K["bob2"]], [vc, vb - vc])
    charlie1, bob2 = s1.child(0), s1.child(1)
    os.makedirs(args.out, exist_ok=True)
    mint_file = dict(g.header)
    mint_file["certs"] = dict(K["alice0"].certs)
    files = {f"mint3_{args.label}.json": mint_file,
             f"pay3_{args.label}_bob1.json": held_bundle(bob1, {}), f"pay3_{args.label}_charlie1.json": held_bundle(charlie1, {})}
    for who, note in [("charlie", charlie1), ("bob", bob2), ("alice", alice1)]:
        files[f"redeem3_{args.label}_{who}.json"] = spend(note, [payout(f"{who}|{salt}")], [note.value]).redeem_bundle(0, {})
    for fname, b in files.items():
        b.pop("_test", None)  # phone files have no _test
        with open(os.path.join(args.out, fname), "w") as f:
            json.dump(b, f, indent=1)
    print(f"SYNTHETIC coin '{args.label}' (salt tag {tag}) for chain {args.chain_id}, escrow 0x{esc40}, depositor 0x{dep40}, "
          f"expiry {args.expiry}, value {v} wei: coinId {g.header['coinId']}")
    print(f"wrote {len(files)} phone-format files to {args.out}")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--coin-for-escrow", dest="escrow", help="mint a fresh coin for this escrow (phone-format files)")
    ap.add_argument("--chain-id", default="11155111")
    ap.add_argument("--depositor")
    ap.add_argument("--expiry")
    ap.add_argument("--value", default=str(10**15))
    ap.add_argument("--label", default="sd")
    ap.add_argument("--salt", default=None)
    ap.add_argument("--out")
    args = ap.parse_args()
    if args.escrow:
        if not (args.depositor and args.expiry and args.out):
            sys.exit("--coin-for-escrow needs --depositor, --expiry and --out")
        coin_for(args)
        return
    tree()
    bad()
    eq()
    gas()
    attested()
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for fname, b in sorted(FILES.items()):
        with open(os.path.join(OUT, fname), "w") as f:
            json.dump(b, f, indent=1)
    print(f"wrote {len(FILES)} SYNTHETIC v3 bundles to vectors/synthetic/")


if __name__ == "__main__":
    main()
