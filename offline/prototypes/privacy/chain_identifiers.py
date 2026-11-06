#!/usr/bin/env python3
"""Privacy analysis of real Prowl attestation chains (2026-11-06).

For every certificate seen on the two phones (device_run*, phone_vectors_v1, android_test/linkability),
report per-link algorithms, serials, subjects, validity and RKP provisioning info, and for each
attested leaf the device-identifying fields of the KeyDescription (uniqueId, ID attestation tags,
rootOfTrust, patch levels, creationDateTime, app id).
Run: ../../.venv/bin/python chain_identifiers.py  (from this directory)
"""
import sys, os, glob, json, base64, hashlib, collections
HERE = os.path.dirname(os.path.abspath(__file__))
SEAM = os.path.dirname(HERE)
sys.path.insert(0, SEAM)
import otk_verifier as V
from cryptography import x509
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import ec, rsa

def der_hash(c): return hashlib.sha256(c.public_bytes(serialization.Encoding.DER)).hexdigest()[:16]
def alg(c):
    pk = c.public_key()
    if isinstance(pk, ec.EllipticCurvePublicKey): k = f"EC {pk.curve.name}"
    elif isinstance(pk, rsa.RSAPublicKey): k = f"RSA-{pk.key_size}"
    else: k = type(pk).__name__
    return k, c.signature_algorithm_oid._name

certs = {}           # der-hash -> cert
chains = []          # (source, [certs leaf first])
for p in glob.glob(os.path.join(SEAM, "device_run*", "*.pem")):
    ch = x509.load_pem_x509_certificates(open(p, "rb").read()); chains.append((os.path.relpath(p, SEAM), ch))
def walk_json(o, src):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("chain", "to") and isinstance(v, list) and v and isinstance(v[0], str):
                try:
                    ch = [x509.load_der_x509_certificate(base64.b64decode(s)) for s in v]
                    chains.append((src + ":" + k, ch))
                except Exception: pass
            else: walk_json(v, src)
    elif isinstance(o, list):
        for v in o: walk_json(v, src)
for p in glob.glob(os.path.join(SEAM, "phone_vectors_v1", "*.json")):
    walk_json(json.load(open(p)), os.path.relpath(p, SEAM))
for p in glob.glob(os.path.join(SEAM, "android_test", "linkability", "*", "*")):
    try: c = x509.load_der_x509_certificate(open(p, "rb").read()); certs[der_hash(c)] = c
    except Exception as e: print("skip", p, e)
for _, ch in chains:
    for c in ch: certs[der_hash(c)] = c
roots = x509.load_pem_x509_certificates(open(os.path.join(SEAM, "android_test/assets/roots.pem"), "rb").read())
for r in roots: certs[der_hash(r)] = r

by_subject = collections.defaultdict(list)
for h, c in certs.items(): by_subject[c.subject.rfc4514_string()].append(c)

def is_leaf(c):
    try: c.extensions.get_extension_for_oid(x509.ObjectIdentifier(V.OID_KEY_DESC)); return True
    except x509.ExtensionNotFound: return False

print("== distinct certificates:", len(certs))
leaves = [c for c in certs.values() if is_leaf(c)]
nonleaf = [c for c in certs.values() if not is_leaf(c)]
print("   attested leaves:", len(leaves), " intermediates/roots:", len(nonleaf))

print("\n== non-leaf certificates (issuer -> subject), algorithms, serial, validity")
for c in sorted(nonleaf, key=lambda c: c.not_valid_before_utc):
    k, s = alg(c)
    prov = ""
    try:
        e = c.extensions.get_extension_for_oid(x509.ObjectIdentifier(V.OID_PROV_INFO)); prov = " RKP-provInfo=" + e.value.value.hex()
    except x509.ExtensionNotFound: pass
    n_children = sum(1 for l in certs.values() if l.issuer == c.subject)
    print(f"- subject={c.subject.rfc4514_string()}\n  issuer={c.issuer.rfc4514_string()}\n  key={k} sigAlg={s} serial={c.serial_number:x}"
          f"\n  valid {c.not_valid_before_utc:%Y-%m-%d} .. {c.not_valid_after_utc:%Y-%m-%d}  children_in_dataset={n_children}{prov}")

print("\n== leaves grouped by issuing attestation key")
grp = collections.defaultdict(list)
for l in leaves: grp[l.issuer.rfc4514_string()].append(l)
for iss, ls in grp.items():
    kd0 = V.parse_key_description(ls[0].extensions.get_extension_for_oid(x509.ObjectIdentifier(V.OID_KEY_DESC)).value.value)
    k, s = alg(ls[0])
    print(f"- issuer={iss}: {len(ls)} leaves, leaf key {k}, leaf sigAlg {s}, attestSecLevel={kd0['attestationSecurityLevel']}")
    serials = collections.Counter(l.serial_number for l in ls); subj = collections.Counter(l.subject.rfc4514_string() for l in ls)
    nb = collections.Counter((l.not_valid_before_utc.date(), l.not_valid_after_utc.date()) for l in ls)
    print(f"  leaf serials={dict(serials)} subjects={dict(subj)} validity={ {str(a)+'..'+str(b):n for (a,b),n in nb.items()} }")
    fields = collections.defaultdict(collections.Counter)
    for l in ls:
        kd = V.parse_key_description(l.extensions.get_extension_for_oid(x509.ObjectIdentifier(V.OID_KEY_DESC)).value.value)
        fields["uniqueId(len)"][len(kd["uniqueId"])] += 1
        fields["challenge(len)"][len(kd["attestationChallenge"])] += 1
        for lst in ("softwareEnforced", "hardwareEnforced"):
            for name, v in kd[lst].items():
                if name in ("rootOfTrust",):
                    fields[lst + ".rootOfTrust.verifiedBootKey"][v["verifiedBootKey"][:16]] += 1
                    fields[lst + ".rootOfTrust.verifiedBootHash"][(v["verifiedBootHash"] or "")[:16]] += 1
                    fields[lst + ".rootOfTrust.locked/state"][(v["deviceLocked"], v["verifiedBootState"])] += 1
                elif name == "creationDateTime":
                    fields[lst + ".creationDateTime"]["present (ms timestamp, unique per key)"] += 1
                elif name.startswith("attestationId") or name in ("osVersion", "osPatchLevel", "vendorPatchLevel", "bootPatchLevel", "usageCountLimit", "moduleHash", "attestationApplicationId", "origin"):
                    vv = v if not isinstance(v, str) else v[:24]
                    fields[lst + "." + name][str(vv)] += 1
    for f, cnt in sorted(fields.items()):
        print(f"    {f}: {dict(cnt)}")

print("\n== per-chain link algorithms (one example chain per source type)")
seen = set()
for src, ch in chains:
    key = tuple(c.issuer.rfc4514_string()[:20] for c in ch)
    if key in seen: continue
    seen.add(key)
    print("-", src, f"({len(ch)} certs)")
    for i, c in enumerate(ch):
        k, s = alg(c)
        print(f"   [{i}] {c.subject.rfc4514_string()[:70]:70s} key={k:16s} signedBy={s}  {len(c.public_bytes(serialization.Encoding.DER))} B DER")
for r in roots:
    k, s = alg(r); print(f"   root {r.subject.rfc4514_string()[:60]} key={k} sig={s} serial={r.serial_number:x} valid {r.not_valid_before_utc:%Y}-{r.not_valid_after_utc:%Y}")
