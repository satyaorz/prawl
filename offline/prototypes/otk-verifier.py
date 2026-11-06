#!/usr/bin/env python3
"""Prowl one-time-key (OTK) attestation verifier -- offline recipient check.

Checks an Android Key Attestation certificate chain (leaf first, PEM) and decides whether
the attested key is acceptable as a Prowl coin key, i.e. a key the secure hardware will
sign with AT MOST ONCE.

Sources for every rule (see seam_a_uncopyable_coins.md for quotes):
  * KeyDescription schema, tag numbers: source.android.com/docs/security/features/keystore/attestation
  * USAGE_COUNT_LIMIT semantics: hardware/interfaces/security/keymint/aidl/.../Tag.aidl (aosp_src/Tag.aidl)
  * Chain procedure, roots, revocation list: developer.android.com/privacy-and-security/security-key-attestation

Usage: otk_verifier.py --roots root.json --status status.json [--now 2026-11-06] chain.pem [...]
Runs fully offline: roots and the revocation list are files cached while online.
"""
import argparse, base64, datetime as dt, hashlib, json, sys
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

OID_KEY_DESC = "1.3.6.1.4.1.11129.2.1.17"   # key attestation extension
OID_PROV_INFO = "1.3.6.1.4.1.11129.2.1.30"  # RKP provisioning-info extension

TAGS = {1: "purpose", 2: "algorithm", 3: "keySize", 5: "digest", 6: "padding", 10: "ecCurve",
        200: "rsaPublicExponent", 303: "rollbackResistance", 305: "earlyBootOnly",
        400: "activeDateTime", 401: "originationExpireDateTime", 402: "usageExpireDateTime",
        405: "usageCountLimit", 503: "noAuthRequired", 504: "userAuthType", 505: "authTimeout",
        507: "trustedUserPresenceRequired", 508: "trustedConfirmationRequired",
        509: "unlockedDeviceRequired", 701: "creationDateTime", 702: "origin",
        704: "rootOfTrust", 705: "osVersion", 706: "osPatchLevel",
        709: "attestationApplicationId", 710: "attestationIdBrand", 711: "attestationIdDevice",
        712: "attestationIdProduct", 716: "attestationIdManufacturer", 717: "attestationIdModel",
        718: "vendorPatchLevel", 719: "bootPatchLevel", 724: "moduleHash"}
SECLEVEL = {0: "Software", 1: "TrustedEnvironment", 2: "StrongBox"}
BOOTSTATE = {0: "Verified", 1: "SelfSigned", 2: "Unverified", 3: "Failed"}
ORIGIN = {0: "GENERATED", 1: "DERIVED", 2: "IMPORTED", 3: "RESERVED", 4: "SECURELY_IMPORTED"}


# ---------------- minimal DER TLV parser (handles high-tag-number form) ----------------
def tlv(buf, i):
    b0 = buf[i]; i += 1
    cls, constructed, tag = b0 >> 6, bool(b0 & 0x20), b0 & 0x1F
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
    return cls, constructed, tag, buf[i:i + ln], i + ln


def children(buf):
    out, i = [], 0
    while i < len(buf):
        cls, c, tag, val, i = tlv(buf, i)
        out.append((cls, c, tag, val))
    return out


def as_int(v):
    return int.from_bytes(v, "big", signed=True)


def parse_value(name, inner):
    """inner = the single universal TLV inside an EXPLICIT [n] tag."""
    cls, c, tag, val, _ = tlv(inner, 0)
    if name == "rootOfTrust":
        f = children(val)
        return {"verifiedBootKey": f[0][3].hex(), "deviceLocked": f[1][3] != b"\x00",
                "verifiedBootState": BOOTSTATE.get(as_int(f[2][3]), as_int(f[2][3])),
                "verifiedBootHash": f[3][3].hex() if len(f) > 3 else None}
    if tag == 0x11:  # SET OF INTEGER
        return sorted(as_int(x[3]) for x in children(val))
    if tag in (0x02, 0x0A):  # INTEGER / ENUMERATED
        return as_int(val)
    if tag == 0x05:  # NULL -> boolean flag present
        return True
    if tag == 0x04:
        return val.hex()
    return val.hex()


def parse_authlist(seq):
    d = {}
    for cls, c, tag, val in children(seq):
        name = TAGS.get(tag, f"tag{tag}")
        d[name] = parse_value(name, val)
    return d


def parse_key_description(der):
    _, _, _, body, _ = tlv(der, 0)
    f = children(body)
    return {"attestationVersion": as_int(f[0][3]),
            "attestationSecurityLevel": SECLEVEL.get(as_int(f[1][3])),
            "keyMintVersion": as_int(f[2][3]),
            "keyMintSecurityLevel": SECLEVEL.get(as_int(f[3][3])),
            "attestationChallenge": f[4][3],
            "uniqueId": f[5][3],
            "softwareEnforced": parse_authlist(f[6][3]),
            "hardwareEnforced": parse_authlist(f[7][3])}


# ---------------- chain checks ----------------
def load_chain(path):
    data = open(path, "rb").read()
    return x509.load_pem_x509_certificates(data)


def load_roots(path):
    roots = []
    for pem in json.load(open(path)):
        roots.append(x509.load_pem_x509_certificate(pem.encode()))
    return roots


def spki(cert):
    return cert.public_key().public_bytes(serialization.Encoding.DER,
                                          serialization.PublicFormat.SubjectPublicKeyInfo)


def sig_alg(cert):
    pk = cert.public_key()
    if isinstance(pk, ec.EllipticCurvePublicKey):
        return f"EC-{pk.curve.name}"
    if isinstance(pk, rsa.RSAPublicKey):
        return f"RSA-{pk.key_size}"
    return type(pk).__name__


def verify(chain_path, roots, status, now):
    chain = load_chain(chain_path)
    res = {"file": chain_path, "n_certs": len(chain),
           "chain_der_bytes": sum(len(c.public_bytes(serialization.Encoding.DER)) for c in chain),
           "cert_keys": [sig_alg(c) for c in chain],
           "cert_sig_hashes": [c.signature_hash_algorithm.name if c.signature_hash_algorithm else "none" for c in chain],
           "errors": [], "warnings": []}
    # 1. each cert signed by the next; last cert self-signed root that is a Google root
    for child, parent in zip(chain, chain[1:]):
        try:
            child.verify_directly_issued_by(parent)
        except Exception as e:  # noqa
            res["errors"].append(f"signature/issuer mismatch: {child.subject.rfc4514_string()} <- {parent.subject.rfc4514_string()}: {e}")
    root = chain[-1]
    google = [r for r in roots if spki(r) == spki(root)]
    res["root"] = root.subject.rfc4514_string()
    res["root_is_google"] = bool(google)
    if not google:
        res["errors"].append("root public key is not a Google attestation root")
    # 2. revocation (offline, cached list) + validity window
    # Google's list writes 64-bit serials in DECIMAL and longer ones in hex (audit F-04): look the serial up in both renderings
    for c in chain:
        for sn in (format(c.serial_number, "x"), str(c.serial_number)):
            if sn in status["entries"]:
                res["errors"].append(f"revoked serial {sn}: {status['entries'][sn]}")
                break
    res["rkp"] = any(OID_PROV_INFO in [e.oid.dotted_string for e in c.extensions] for c in chain)
    for c in chain[:-1]:
        if not (c.not_valid_before_utc <= now <= c.not_valid_after_utc):
            msg = f"cert outside validity ({c.not_valid_before_utc.date()}..{c.not_valid_after_utc.date()}): {c.subject.rfc4514_string()}"
            # Google: expired *factory* certs stay trusted; RKP certs MUST be in validity.
            (res["errors"] if res["rkp"] else res["warnings"]).append(msg)
    # 3. key description: nearest-to-root cert carrying the extension (Google's rule)
    idx = None
    for i in range(len(chain) - 1, -1, -1):
        if OID_KEY_DESC in [e.oid.dotted_string for e in chain[i].extensions]:
            idx = i; break
    if idx is None:
        res["errors"].append("no key attestation extension"); return res
    if idx != 0:
        res["errors"].append(f"attestation extension at chain index {idx}, not leaf: coin key would be attacker-extended")
    ext = chain[idx].extensions.get_extension_for_oid(x509.ObjectIdentifier(OID_KEY_DESC))
    kd = parse_key_description(ext.value.value)
    res["kd"] = {k: (v.hex() if isinstance(v, bytes) else v) for k, v in kd.items()}
    hw, sw = kd["hardwareEnforced"], kd["softwareEnforced"]
    res["coin_pubkey_sha256"] = hashlib.sha256(spki(chain[0])).hexdigest()
    # 4. Prowl one-time-key policy
    pol = []
    def req(cond, msg):
        pol.append((bool(cond), msg))
    req(kd["attestationSecurityLevel"] in ("TrustedEnvironment", "StrongBox"), "attestation from TEE/StrongBox")
    req(kd["keyMintSecurityLevel"] == kd["attestationSecurityLevel"], "keymint level == attestation level")
    req(hw.get("usageCountLimit") == 1, "usageCountLimit == 1 in hardwareEnforced (TEE/SB enforces single use)")
    req("usageCountLimit" not in sw, "usageCountLimit NOT merely in softwareEnforced (keystore-only)")
    req(hw.get("origin") == 0, "origin GENERATED in hardware (key never existed outside secure HW)")
    req(2 in hw.get("purpose", []), "purpose SIGN")
    req(hw.get("algorithm") == 3 and hw.get("ecCurve") == 1, "EC P-256 (on-chain via EIP-7951 P256VERIFY)")
    rot = hw.get("rootOfTrust", {})
    req(rot.get("deviceLocked") is True, "bootloader locked")
    req(rot.get("verifiedBootState") == "Verified", "verified boot state Verified")
    req(res["rkp"], "RKP-provisioned chain (factory keybox leaks do not apply)")
    res["policy"] = pol
    res["usageCountLimit_location"] = ("hardware" if "usageCountLimit" in hw else
                                       "software" if "usageCountLimit" in sw else "absent")
    res["accept_as_prawl_coin_key"] = not res["errors"] and all(ok for ok, _ in pol)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roots", required=True)
    ap.add_argument("--status", required=True)
    ap.add_argument("--now", default="2026-11-06")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("chains", nargs="+")
    a = ap.parse_args()
    roots = load_roots(a.roots)
    status = json.load(open(a.status))
    now = dt.datetime.fromisoformat(a.now).replace(tzinfo=dt.timezone.utc)
    out = []
    for p in a.chains:
        try:
            r = verify(p, roots, status, now)
        except Exception as e:  # noqa
            r = {"file": p, "errors": [f"parse failure: {type(e).__name__}: {e}"], "accept_as_prawl_coin_key": False}
        out.append(r)
        if not a.json:
            kd = r.get("kd", {})
            hw = kd.get("hardwareEnforced", {})
            print(f"== {p}")
            print(f"   certs={r.get('n_certs')} der={r.get('chain_der_bytes')}B keys={r.get('cert_keys')} hashes={r.get('cert_sig_hashes')}")
            print(f"   google_root={r.get('root_is_google')} rkp={r.get('rkp')} attVer={kd.get('attestationVersion')} level={kd.get('attestationSecurityLevel')}")
            print(f"   usageCountLimit: {r.get('usageCountLimit_location')} hw={hw.get('usageCountLimit')} sw={kd.get('softwareEnforced', {}).get('usageCountLimit')}"
                  f" origin={ORIGIN.get(hw.get('origin'))} rot={hw.get('rootOfTrust', {}).get('verifiedBootState')}/locked={hw.get('rootOfTrust', {}).get('deviceLocked')}"
                  f" model={bytes.fromhex(hw['attestationIdModel']).decode() if 'attestationIdModel' in hw else '-'}")
            for e in r["errors"]:
                print(f"   ERROR {e}")
            for w in r.get("warnings", []):
                print(f"   warn  {w}")
            failed = [m for ok, m in r.get("policy", []) if not ok]
            print(f"   ACCEPT={r['accept_as_prawl_coin_key']}  policy_failures={failed}")
    if a.json:
        print(json.dumps(out, default=str, indent=1))


if __name__ == "__main__":
    main()
