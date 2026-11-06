#!/usr/bin/env python3
"""Size the in-circuit work for a ZK proof of a Prawl coin-key attestation, from the real chains.
For each link: TBS length -> SHA-256/384 compression calls, signature algorithm, and which links are
device-specific (must stay hidden) vs Google-public (can be public inputs).
Run: ../.venv/bin/python circuit_sizing.py
"""
import os
from cryptography import x509
SEAM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def blocks(n, bs=64, lenbytes=8): return (n + 1 + lenbytes + bs - 1) // bs
for name in ("device_run/otk_sb.pem", "device_run_oneplus/otk_tee.pem", "device_run/otk_tee.pem"):
    ch = x509.load_pem_x509_certificates(open(os.path.join(SEAM, name), "rb").read())
    print(f"== {name}")
    for i, c in enumerate(ch[:-1]):
        tbs = c.tbs_certificate_bytes; h = c.signature_hash_algorithm.name
        nb = blocks(len(tbs)) if h == "sha256" else blocks(len(tbs), 128, 16)
        issuer_pk = ch[i + 1].public_key()
        kind = getattr(issuer_pk, "curve", None)
        kind = kind.name if kind else f"RSA-{issuer_pk.key_size}"
        try:
            ext = c.extensions.get_extension_for_oid(x509.ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")).value.value
            extl = f", KeyDescription {len(ext)} B"
        except x509.ExtensionNotFound: extl = ""
        print(f"  link {i}: '{c.subject.rfc4514_string()[:45]}' signed by {kind} with {h}; TBS {len(tbs)} B = {nb} {h} blocks{extl}")
