#!/usr/bin/env python3
"""Convert the REAL phone vectors (../phone_vectors_v1/*.json) into Foundry fixtures.

For every payment file it:
  * extracts each key's P-256 (x, y) from the leaf certificate's SubjectPublicKeyInfo,
  * checks that SPKI DER == fixed P-256 SPKI prefix || 04 || x || y (what the contract hashes),
  * extracts (r, s) from each DER ECDSA signature and checks DER(r, s) re-encodes byte-identically,
  * recomputes every hop message exactly as WalletActivity.java does and verifies the signature
    with `cryptography` (an independent check of the format the contract re-implements),
  * records whether s is high (s > n/2): P256VERIFY must accept those.
For every certificate chain it also writes the DER bytes plus Python-parsed expectations
(tbs hash, signature, issuer key, KeyDescription fields) so the Solidity parser can be checked
against an independent parser. P-384 signatures in the chains get modular-inverse hint streams
from the vendored nitro-validator tool (lib/nitro-validator/tools/p384_hints.js).

Also creates SYNTHETIC software-key vectors (clearly labelled) for the equivocation test:
a software genesis key signs hop 0 of coin "c3" twice, to Bob's and to Charlie's REAL keys.

Usage: ../.venv/bin/python tools/vectors_to_foundry.py   (run from onchain_real/)
"""
import base64, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p384_hints as P384H
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa, padding
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VEC = os.path.join(ROOT, "..", "phone_vectors_v1")
OUT = os.path.join(ROOT, "fixtures")

N256 = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
SPKI_P256_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
OID_KEY_DESC = "1.3.6.1.4.1.11129.2.1.17"
OID_PROV_INFO = "1.3.6.1.4.1.11129.2.1.30"


def load(name):
    with open(os.path.join(VEC, name)) as f:
        return json.load(f)


def certs(chain_b64):
    return [x509.load_der_x509_certificate(base64.b64decode(c)) for c in chain_b64]


def spki(cert):
    return cert.public_key().public_bytes(serialization.Encoding.DER,
                                          serialization.PublicFormat.SubjectPublicKeyInfo)


def leaf_hash(chain_b64):
    return hashlib.sha256(spki(certs(chain_b64)[0])).hexdigest()


def xy(pub):
    n = pub.public_numbers()
    return n.x.to_bytes(32, "big"), n.y.to_bytes(32, "big")


def check_spki(cert):
    x, y = xy(cert.public_key())
    d = spki(cert)
    assert d == SPKI_P256_PREFIX + b"\x04" + x + y, "SPKI is not the fixed P-256 form"
    return x, y


def hop_message(coin, value, i, prev_hex, to_hex):
    return f"PRAWL-OTK-v1|{coin}|{value}|{i}|{prev_hex}|{to_hex}".encode()


def mint_hash(mint):
    return hashlib.sha256(f"{mint['coinId']}|{mint['value']}|{leaf_hash(mint['chain'])}".encode()).hexdigest()


def h32(b):
    return "0x" + b.hex()


def convert_payment(p, note):
    """Re-verify a phone payment exactly as WalletActivity.accept() does; emit contract inputs."""
    coin, value = p["coinId"], p["value"]
    mint = p["mint"]
    k0x, k0y = check_spki(certs(mint["chain"])[0])
    signer = certs(mint["chain"])[0].public_key()
    prev = mint_hash(mint)
    hops = []
    all_valid = True
    for i, h in enumerate(p["hops"]):
        to_leaf = certs(h["to"])[0]
        x, y = check_spki(to_leaf)
        sig = base64.b64decode(h["sig"])
        r, s = decode_dss_signature(sig)
        canonical = encode_dss_signature(r, s) == sig
        msg = hop_message(coin, value, i, prev, leaf_hash(h["to"]))
        try:
            signer.verify(sig, msg, ec.ECDSA(hashes.SHA256()))
            ok = True
        except InvalidSignature:
            ok = False
        all_valid &= ok
        hops.append({"x": h32(x), "y": h32(y), "r": h32(r.to_bytes(32, "big")), "s": h32(s.to_bytes(32, "big")),
                     "sigDer": h32(sig), "derCanonical": canonical, "highS": s > N256 // 2,
                     "message": msg.decode(), "msgSha256": h32(hashlib.sha256(msg).digest()),
                     "pyValid": ok})
        signer = to_leaf.public_key()
        prev = hashlib.sha256(sig).hexdigest()
    return {"note": note, "coinId": coin, "value": value, "k0x": h32(k0x), "k0y": h32(k0y),
            "mintHash": "0x" + mint_hash(mint), "k0Hash": "0x" + leaf_hash(mint["chain"]),
            "hops": hops, "pyAllValid": all_valid}


# ----------------------------------------------------------------------------- certificates

def tlv(buf, i):
    b0 = buf[i]; start = i; i += 1
    tag = b0 & 0x1F
    if tag == 0x1F:
        tag = 0
        while True:
            b = buf[i]; i += 1
            tag = (tag << 7) | (b & 0x7F)
            if not b & 0x80:
                break
    ln = buf[i]; i += 1
    if ln & 0x80:
        n = ln & 0x7F
        ln = int.from_bytes(buf[i:i + n], "big"); i += n
    return b0, tag, i, ln, start  # header byte, tag number, content offset, content length, tlv start


def children(buf):
    out, i = [], 0
    while i < len(buf):
        b0, tag, c, ln, _ = tlv(buf, i)
        out.append((b0, tag, buf[c:c + ln]))
        i = c + ln
    return out


def key_description(cert):
    ext = cert.extensions.get_extension_for_oid(x509.ObjectIdentifier(OID_KEY_DESC)).value.value
    kd = children(children(ext)[0][2])
    sw = {t: v for _, t, v in children(kd[6][2])}
    hw = {t: v for _, t, v in children(kd[7][2])}

    def inner_int(v):
        return int.from_bytes(children(v)[0][2], "big", signed=True)
    out = {"attestationVersion": int.from_bytes(kd[0][2], "big"),
           "attestationSecurityLevel": int.from_bytes(kd[1][2], "big"),
           "keyMintVersion": int.from_bytes(kd[2][2], "big"),
           "keyMintSecurityLevel": int.from_bytes(kd[3][2], "big"),
           "attestationChallenge": h32(kd[4][2]),
           "usageCountLimitHw": inner_int(hw[405]) if 405 in hw else 0,
           "usageCountLimitSw": inner_int(sw[405]) if 405 in sw else 0}
    rot = children(children(hw[704])[0][2]) if 704 in hw else None
    out["deviceLocked"] = bool(rot and rot[1][2] != b"\x00")
    out["verifiedBootState"] = int.from_bytes(rot[2][2], "big") if rot else 99
    out["verifiedBootKey"] = h32(rot[0][2]) if rot else "0x"
    aid_src = sw.get(709) or hw.get(709)
    if aid_src:
        aid = children(children(children(aid_src)[0][2])[0][2])  # OCTET STRING -> SEQUENCE
        pkgs = children(aid[0][2])
        out["packageName"] = children(pkgs[0][2])[0][2].decode()
        out["packageVersion"] = int.from_bytes(children(pkgs[0][2])[1][2], "big")
        out["signatureDigest"] = h32(children(aid[1][2])[0][2])
    out["origin"] = inner_int(hw[702]) if 702 in hw else -1
    out["algorithm"] = inner_int(hw[2]) if 2 in hw else 0
    out["ecCurve"] = inner_int(hw[10]) if 10 in hw else 0
    out["purposeSign"] = 1 in hw and any(int.from_bytes(v, "big") == 2 for _, _, v in children(children(hw[1])[0][2]))
    out["packageNameKeccak"] = None  # filled below (needs keccak; computed in Solidity test from packageName)
    out["hwTags"] = sorted(hw.keys())
    out["swTags"] = sorted(sw.keys())
    return out


def cbor_map(b):
    """Tiny CBOR decoder, enough for the RKP provisioning-info map."""
    def item(i):
        ib = b[i]; mt, ai = ib >> 5, ib & 0x1F; i += 1
        if ai < 24: val = ai
        elif ai == 24: val = b[i]; i += 1
        elif ai == 25: val = int.from_bytes(b[i:i + 2], "big"); i += 2
        elif ai == 26: val = int.from_bytes(b[i:i + 4], "big"); i += 4
        else: raise ValueError("cbor")
        if mt == 0: return val, i
        if mt == 1: return -1 - val, i
        if mt in (2, 3): s = b[i:i + val]; return (s.decode() if mt == 3 else s.hex()), i + val
        if mt == 5:
            d = {}
            for _ in range(val):
                k, i = item(i); v, i = item(i); d[k] = v
            return d, i
        if mt == 7: return {20: False, 21: True}.get(ai, ai), i
        raise ValueError("cbor mt %d" % mt)
    return item(0)[0]


def p384_hints(hash_bytes, sig_der, issuer_pub):
    r, s = decode_dss_signature(sig_der)
    n = issuer_pub.public_numbers()
    return "0x" + P384H.hints(hash_bytes, r, s, n.x, n.y).hex()


def cert_info(c, issuer):
    der = c.public_bytes(serialization.Encoding.DER)
    tbs = c.tbs_certificate_bytes
    alg = c.signature_algorithm_oid.dotted_string
    pub = c.public_key()
    info = {"der": h32(der), "len": len(der), "subject": c.subject.rfc4514_string(),
            "issuer": c.issuer.rfc4514_string(), "sigAlg": c.signature_algorithm_oid._name,
            "tbsSha256": h32(hashlib.sha256(tbs).digest()), "tbsSha384": h32(hashlib.sha384(tbs).digest()),
            "spkiSha256": h32(hashlib.sha256(spki(c)).digest()),
            "notBefore": int(c.not_valid_before_utc.timestamp()), "notAfter": int(c.not_valid_after_utc.timestamp()),
            "hasKeyDescription": any(e.oid.dotted_string == OID_KEY_DESC for e in c.extensions)}
    if isinstance(pub, ec.EllipticCurvePublicKey):
        sz = pub.curve.key_size // 8
        n = pub.public_numbers()
        info.update(pubKind="EC-" + pub.curve.name, pubX=h32(n.x.to_bytes(sz, "big")), pubY=h32(n.y.to_bytes(sz, "big")))
    else:
        n = pub.public_numbers()
        info.update(pubKind="RSA-%d" % pub.key_size, rsaN=h32(n.n.to_bytes(pub.key_size // 8, "big")), rsaE=n.e)
    if info["hasKeyDescription"]:
        info["keyDescription"] = key_description(c)
    try:
        pi = c.extensions.get_extension_for_oid(x509.ObjectIdentifier(OID_PROV_INFO)).value.value
        info["provisioningInfo"] = cbor_map(pi)  # extnValue content is the CBOR map itself
    except x509.ExtensionNotFound:
        pass
    # signature by issuer: independent check + inputs for the contract
    ipub = issuer.public_key()
    if isinstance(ipub, ec.EllipticCurvePublicKey):
        hfn = hashes.SHA256() if alg == "1.2.840.10045.4.3.2" else hashes.SHA384()
        ipub.verify(c.signature, tbs, ec.ECDSA(hfn))
        r, s = decode_dss_signature(c.signature)
        sz = ipub.curve.key_size // 8
        info.update(sigR=h32(r.to_bytes(sz, "big")), sigS=h32(s.to_bytes(sz, "big")))
        if sz == 48:
            n384 = 0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973
            info["sigSLow"] = h32(min(s, n384 - s).to_bytes(48, "big"))  # (r, n-s) is equally valid
            digest = hashlib.sha256(tbs).digest() if alg == "1.2.840.10045.4.3.2" else hashlib.sha384(tbs).digest()
            info["p384Hints"] = p384_hints(digest, c.signature, ipub)
    else:
        ipub.verify(c.signature, tbs, padding.PKCS1v15(), hashes.SHA256())
        info["rsaSig"] = h32(c.signature)
    info["pyIssuerSigValid"] = True
    return info


def chain_info(chain_b64):
    cs = certs(chain_b64)
    out = []
    for i, c in enumerate(cs):
        out.append(cert_info(c, cs[i + 1] if i + 1 < len(cs) else c))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    pays = {
        "bob": convert_payment(load("pay_c1_bob.json"), "REAL: Alice(Samsung StrongBox) -> Bob(OnePlus TEE), 1 hop"),
        "dave": convert_payment(load("pay_c1_dave.json"), "REAL: ... -> Bob -> Dave(Samsung StrongBox), 2 hops"),
        "replay": convert_payment(load("pay_c1_replay.json"), "REAL: Bob's payment forwarded to Charlie (byte-identical to bob)"),
        "tamper": convert_payment(load("pay_c1_tamper.json"), "REAL sig, value edited 0.2 -> 2.0"),
        "c2bob3": convert_payment(load("pay_c2_bob3.json"), "REAL: c2, genesis key is a MULTI-USE cheat key"),
    }
    keys = {}
    for n in ["bob", "bob3", "charlie", "dave"]:
        x, y = check_spki(certs(load(f"req_{n}.json")["chain"])[0])
        keys[n] = {"x": h32(x), "y": h32(y), "hash": "0x" + leaf_hash(load(f"req_{n}.json")["chain"])}
    snap = load("snapshot.json")
    for d in snap["deposits"]:
        p = pays["bob"] if d["coinId"] == "c1" else pays["c2bob3"]
        assert p["k0Hash"][2:] == d["k0"], "snapshot k0 mismatch"

    # ------------------------------------------------------------- synthetic software-key equivocation
    # A software key cannot be stopped from signing twice. It plays a genesis key whose hardware
    # "failed": hop 0 of coin c3 is signed to Bob's REAL key and, again, to Charlie's REAL key.
    sk = ec.derive_private_key(0xC0FFEE_5EED_0001, ec.SECP256R1())
    sx, sy = xy(sk.public_key())
    sk_spki = sk.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    assert sk_spki == SPKI_P256_PREFIX + b"\x04" + sx + sy
    k0h = hashlib.sha256(sk_spki).hexdigest()
    mh = hashlib.sha256(f"c3|0.05|{k0h}".encode()).hexdigest()
    equiv = {"note": "SYNTHETIC software genesis key (NOT a phone key) signing hop 0 twice",
             "coinId": "c3", "value": "0.05", "k0x": h32(sx), "k0y": h32(sy), "k0Priv": hex(sk.private_numbers().private_value),
             "mintHash": "0x" + mh, "branches": {}}
    for who in ["bob", "charlie"]:
        msg = hop_message("c3", "0.05", 0, mh, keys[who]["hash"][2:])
        sig = sk.sign(msg, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(sig)
        equiv["branches"][who] = {"x": keys[who]["x"], "y": keys[who]["y"], "r": h32(r.to_bytes(32, "big")),
                                  "s": h32(s.to_bytes(32, "big")), "message": msg.decode(),
                                  "messageHex": h32(msg)}

    # ------------------------------------------------------------- certificate chains
    chains = {
        "samsungSB_mint_c1": chain_info(load("mint_c1.json")["chain"]),
        "samsungSB_mint_c2_cheat": chain_info(load("mint_c2.json")["chain"]),
        "samsungSB_dave": chain_info(load("req_dave.json")["chain"]),
        "oneplusTEE_bob": chain_info(load("req_bob.json")["chain"]),
        "oneplusTEE_charlie": chain_info(load("req_charlie.json")["chain"]),
    }

    # raw binary blobs (certs, hints) for the anvil script: vm.readFileBinary avoids re-encoding big JSON strings
    bdir = os.path.join(OUT, "bin")
    os.makedirs(bdir, exist_ok=True)
    for name, ch in chains.items():
        for i, c in enumerate(ch):
            open(os.path.join(bdir, f"{name}_{i}.der"), "wb").write(bytes.fromhex(c["der"][2:]))
            open(os.path.join(bdir, f"{name}_{i}.spki"), "w").write(c["spkiSha256"])
            if "p384Hints" in c:
                open(os.path.join(bdir, f"{name}_{i}.hints"), "wb").write(bytes.fromhex(c["p384Hints"][2:]))

    open(os.path.join(bdir, "app_signer_digest.txt"), "w").write(chains["oneplusTEE_bob"][0]["keyDescription"]["signatureDigest"])

    with open(os.path.join(OUT, "payments.json"), "w") as f:
        json.dump({"payments": pays, "keys": keys, "equivocation": equiv}, f, indent=1)
    with open(os.path.join(OUT, "chains.json"), "w") as f:
        json.dump(chains, f, indent=1)

    # ------------------------------------------------------------- report
    print("payments:")
    for k, p in pays.items():
        print(f"  {k:7s} coin={p['coinId']} value={p['value']} hops={len(p['hops'])} pyAllValid={p['pyAllValid']}"
              + "".join(f"\n      hop{i}: valid={h['pyValid']} highS={h['highS']} derCanonical={h['derCanonical']} "
                        f"msg={h['message'][:60]}..." for i, h in enumerate(p['hops'])))
    print("chains:")
    for k, ch in chains.items():
        print(f"  {k}:")
        for i, c in enumerate(ch):
            extra = ""
            if "keyDescription" in c:
                kd = c["keyDescription"]
                extra = (f" attLvl={kd['attestationSecurityLevel']} kmLvl={kd['keyMintSecurityLevel']} ucl_hw={kd['usageCountLimitHw']}"
                         f" ucl_sw={kd['usageCountLimitSw']} locked={kd['deviceLocked']} vbs={kd['verifiedBootState']}"
                         f" pkg={kd.get('packageName')} v={kd.get('attestationVersion')} origin={kd['origin']}")
            if "provisioningInfo" in c:
                extra += f" provInfo={c['provisioningInfo']}"
            print(f"    [{i}] {c['pubKind']:13s} {c['sigAlg']:24s} len={c['len']} hints={len(c.get('p384Hints', '0x')) // 2 - 1}B{extra}")


if __name__ == "__main__":
    main()
