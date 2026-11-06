#!/usr/bin/env python3
"""Synthetic (software-signed) witnesses that isolate the circuit's PARSER from its signature checks.

Real hardware will not sign attacker-modified TBS bytes, so these use a software key A' that the attacker
controls. They answer: "if an attacker could get ANY signature the circuit accepts, could attacker-chosen
bytes be misread as policy fields?"

  resign      v0: real OnePlus leaf TBS, re-signed by A'. EXPECTED ACCEPT: v0 alone trusts any A (why v1 exists).
  inject_ucl  v0: real Samsung cheat-key leaf (mint_c2: no usageCountLimit), challenge rewritten to contain the
              bytes of a hardware usageCountLimit=1 entry (bf 83 15 03 02 01 01), re-signed by A'.
              EXPECTED REJECT by the circuit; a naive byte-pattern verifier ACCEPTS it (printed).
  inject_spki v1: real OnePlus A_cert TBS whose RKP provisioning-info bytes are overwritten with a full P-256
              SPKI of the attacker key A', signed by a fake CA3' (public input). The leaf is signed by A'.
              EXPECTED REJECT ("leaf not signed by A"): the walk takes the real SPKI, not the injected one.
              A verifier that took the SPKI offset from the prover would accept.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chains, gen_inputs as gi, poseidon2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

OP = os.path.join(chains.SEAM_A, "device_run_oneplus", "otk_tee.pem")
C2 = os.path.join(chains.SEAM_A, "phone_vectors_v1", "mint_c2.json")


def key(seed):
    return ec.derive_private_key(seed, ec.SECP256R1())


def sign_lows(priv, msg):
    r, s = decode_dss_signature(priv.sign(msg, ec.ECDSA(hashes.SHA256())))
    if s > chains.P256_N // 2:
        s = chains.P256_N - s
    return list(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def xy(priv):
    n = priv.public_key().public_numbers()
    return n.x.to_bytes(32, "big"), n.y.to_bytes(32, "big")


def naive_accepts(tbs):
    """What a fixed-pattern 'search the bytes' verifier would conclude."""
    return bytes.fromhex("bf831503020101") in tbs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("case", choices=["resign", "inject_ucl", "inject_spki"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    attacker = key(0xA77AC3E5)
    ax, ay = xy(attacker)
    if a.case == "resign":
        _, ch = gi.pick_chain(OP, None)
        tbs = ch[0].tbs_certificate_bytes
        gi.write_toml(a.out, {"leaf_tbs": gi.pad(tbs, gi.LEAF_N), "leaf_len": len(tbs),
                              "leaf_sig": sign_lows(attacker, tbs), "att_x": list(ax), "att_y": list(ay)})
        print(json.dumps({"case": a.case, "reference_walker": "accept"}))
    elif a.case == "inject_ucl":
        _, ch = gi.pick_chain(C2, None)
        tbs = bytearray(ch[0].tbs_certificate_bytes)
        f = gi.find_kd_fields(bytes(tbs))
        t, c, l, _ = f[4]
        assert t == 0x04 and l == 32
        fake = bytes.fromhex("bf831503020101") + bytes.fromhex("bf85404c304a0420") + bytes(17)
        tbs[c:c + 32] = fake[:32]
        tbs = bytes(tbs)
        try:
            chains.walk_leaf(tbs, len(tbs)); ref = "accept"
        except chains.WalkError as e:
            ref = f"reject: {e}"
        gi.write_toml(a.out, {"leaf_tbs": gi.pad(tbs, gi.LEAF_N), "leaf_len": len(tbs),
                              "leaf_sig": sign_lows(attacker, tbs), "att_x": list(ax), "att_y": list(ay)})
        print(json.dumps({"case": a.case, "naive_pattern_verifier": "accept" if naive_accepts(tbs) else "reject",
                          "reference_walker": ref}))
    else:
        _, ch = gi.pick_chain(OP, None)
        fake_ca3 = key(0xFA4ECA3)
        atbs = bytearray(ch[1].tbs_certificate_bytes)
        # overwrite 91 bytes inside the provisioning-info extension value (OID ...2.1.30) with an SPKI of A'
        oid = bytes.fromhex("060a2b06010401d67902011e")
        i = bytes(atbs).find(oid)
        assert i > 0
        start = i + len(oid) + 3 + 20       # inside the OCTET STRING content, past the CBOR map header
        spki = chains.SPKI_P256_PREFIX + ax + ay
        atbs[start:start + 91] = spki
        atbs = bytes(atbs)
        r = chains.walk_cert_prefix(atbs, len(atbs), True)
        real_x = r["x"]
        assert real_x != ax and atbs.find(spki) == start
        # leaf: real OnePlus leaf TBS signed by the attacker key A'
        ltbs = ch[0].tbs_certificate_bytes
        cx, cy = xy(fake_ca3)
        base = {}
        import subprocess, tempfile
        tmp = a.out + ".base.toml"
        subprocess.check_call([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen_inputs.py"),
                               "v1", "--chain", OP, "--out", tmp], stdout=subprocess.DEVNULL)
        lines = open(tmp).read().splitlines()
        os.remove(tmp)
        repl = {"att_tbs": gi.toml_val(gi.pad(atbs, gi.ATT_N)), "att_len": gi.toml_val(len(atbs)),
                "att_sig": gi.toml_val(sign_lows(fake_ca3, atbs)),
                "leaf_sig": gi.toml_val(sign_lows(attacker, ltbs)),
                "ca3_key": gi.toml_val(gi.limbs(cx) + gi.limbs(cy))}
        with open(a.out, "w") as f:
            for ln in lines:
                k = ln.split(" = ")[0]
                f.write(f"{k} = {repl[k]}\n" if k in repl else ln + "\n")
        print(json.dumps({"case": a.case, "injected_spki_at": start, "real_spki_x": real_x.hex()[:16],
                          "attacker_x": ax.hex()[:16],
                          "prover_hinted_offset_verifier": "would accept (offset points at injected SPKI)",
                          "reference_walker_extracts": "real SPKI"}))


if __name__ == "__main__":
    main()
