#!/usr/bin/env python3
"""SYNTHETIC fixtures for the slashing test (NOT phone data).

Simulates the threat that bonds exist for: an attestation key (AK) whose private key has leaked
(e.g. an extracted keybox). With it, anyone can issue an "attestation" for a SOFTWARE key that copies a
genuine KeyDescription (here: the REAL extension bytes from Bob's OnePlus TEE leaf, which says
usageCountLimit=1 hardware-enforced). On-chain policy checks then pass, the software key signs twice,
and the bond on that AK is what pays for it.

Writes fixtures/leaked_keybox.json: CA cert, AK cert, two leaf certs (software keys), leaf private keys.
"""
import base64, datetime as dt, json, os
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VEC = os.path.join(ROOT, "..", "phone_vectors_v1")
OID_KD = x509.ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")

bob_leaf = x509.load_der_x509_certificate(base64.b64decode(json.load(open(os.path.join(VEC, "req_bob.json")))["chain"][0]))
real_kd = bob_leaf.extensions.get_extension_for_oid(OID_KD).value.value  # extnValue content (KeyDescription DER)

def key(seed):
    return ec.derive_private_key(seed, ec.SECP256R1())

nb = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
na = dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc)
ca_k, ak_k = key(0x5EED_CA), key(0x5EED_A4)
ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SYNTHETIC leaked-keybox CA")])
ak_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SYNTHETIC leaked AK"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "TEE")])

def ca_cert(subj, pub, iss, sk, serial):
    return (x509.CertificateBuilder().subject_name(subj).issuer_name(iss).public_key(pub).serial_number(serial)
            .not_valid_before(nb).not_valid_after(na)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, False, False, False), critical=True)
            .sign(sk, hashes.SHA256()))

ca = ca_cert(ca_name, ca_k.public_key(), ca_name, ca_k, 1)
ak = ca_cert(ak_name, ak_k.public_key(), ca_name, ca_k, 2)
leaves = []
for i, seed in enumerate([0x50F7_0001, 0x50F7_0002]):
    lk = key(seed)
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Android Keystore Key")]))
            .issuer_name(ak_name).public_key(lk.public_key()).serial_number(1)
            .not_valid_before(dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)).not_valid_after(dt.datetime(2048, 1, 1, tzinfo=dt.timezone.utc))
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=False)
            .add_extension(x509.UnrecognizedExtension(OID_KD, real_kd), critical=False)
            .sign(ak_k, hashes.SHA256()))
    n = lk.public_key().public_numbers()
    leaves.append({"der": "0x" + leaf.public_bytes(serialization.Encoding.DER).hex(), "priv": hex(lk.private_numbers().private_value),
                   "x": "0x%064x" % n.x, "y": "0x%064x" % n.y})
out = {"note": "SYNTHETIC: software CA/AK/leaf keys; leaf KeyDescription bytes copied from the REAL req_bob leaf",
       "ca": "0x" + ca.public_bytes(serialization.Encoding.DER).hex(),
       "ak": "0x" + ak.public_bytes(serialization.Encoding.DER).hex(), "leaves": leaves}
json.dump(out, open(os.path.join(ROOT, "fixtures", "leaked_keybox.json"), "w"), indent=1)
print("wrote fixtures/leaked_keybox.json; leaf sizes", [len(l["der"]) // 2 - 1 for l in leaves])
