#!/usr/bin/env python3
"""Prowl protocol v3 message format: an independent Python reference (raw/v3/SPEC.md section 3).

Written from the spec and cross-read against the phone code (android_test/.../Wallet3Activity.java):
spendMessage, outputsHash, genesisNoteId, childNoteId and redeemKey below mirror those Java methods.

    message     = "PRAWL-OTK-v3|" chainId "|" escrow40 "|" coinIdHex64 "|" expiry "|" depth "|"
                  parentNoteId "|" outputsHash                                   (UTF-8)
    outputsHash = sha256hex(";".join(valueWei_i + ":" + keyHash_i))
    keyHash     = sha256hex(SPKI DER of the one-time P-256 key)
                | sha256hex("PRAWL-REDEEM|" chainId "|" escrow40 "|" payout40)   (a redemption output)
    genesis id  = sha256hex("genesis|" + coinIdHex64)
    child id    = sha256hex(hex(DER signature of the spend) + "|" + outputIndex)
    depth       = number of spends from genesis to the note being spent; parentNoteId = that note's id.
Signatures are SHA256withECDSA (P-256), DER-encoded; integers are canonical decimal; hex is lowercase.
"""
import base64
import hashlib
import re

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
from cryptography.exceptions import InvalidSignature

# DER prefix of an uncompressed named-curve P-256 SubjectPublicKeyInfo (the on-chain PrawlCodec.keyHash form)
SPKI_P256_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551

DEC = re.compile(r"^(0|[1-9][0-9]*)$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")


def sha256hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def spki_der(pub: ec.EllipticCurvePublicKey) -> bytes:
    return pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def key_xy(pub: ec.EllipticCurvePublicKey):
    n = pub.public_numbers()
    return n.x, n.y


def key_hash(pub: ec.EllipticCurvePublicKey) -> str:
    """sha256hex of the SPKI DER; asserts the SPKI is the fixed P-256 form the contract rebuilds from (x, y)."""
    der = spki_der(pub)
    x, y = key_xy(pub)
    assert der == SPKI_P256_PREFIX + b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big"), "unexpected SPKI form"
    return sha256hex(der)


def redeem_key(chain_id: str, escrow40: str, payout40: str) -> str:
    return sha256hex(f"PRAWL-REDEEM|{chain_id}|{escrow40}|{payout40}".encode())


def outputs_hash(outs) -> str:
    return sha256hex(";".join(f"{o['value']}:{o['key']}" for o in outs).encode())


def spend_message(h: dict, depth: int, parent_note_id: str, outs) -> bytes:
    return (f"PRAWL-OTK-v3|{h['chainId']}|{h['escrow']}|{h['coinId']}|{h['expiry']}|{depth}|"
            f"{parent_note_id}|{outputs_hash(outs)}").encode()


def genesis_note_id(h: dict) -> str:
    return sha256hex(("genesis|" + h["coinId"]).encode())


def child_note_id(sig_der: bytes, index: int) -> str:
    return sha256hex((sig_der.hex() + "|" + str(index)).encode())


def strict_der(sig_der: bytes):
    """(r, s) of a DER ECDSA signature, and whether re-encoding gives the same bytes (the contract rebuilds DER)."""
    r, s = decode_dss_signature(sig_der)
    return r, s, encode_dss_signature(r, s) == sig_der


def verify(pub: ec.EllipticCurvePublicKey, msg: bytes, sig_der: bytes) -> bool:
    try:
        pub.verify(sig_der, msg, ec.ECDSA(hashes.SHA256()))
        return True
    except InvalidSignature:
        return False


def cert_id(der: bytes) -> str:
    """Phone cert-store id (Wallet2Activity.h): first 16 bytes of sha256(DER), hex."""
    return hashlib.sha256(der).hexdigest()[:32]


def b64d(s: str) -> bytes:
    return base64.b64decode(s)


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


def leaf_key(chain_ids, certs: dict) -> ec.EllipticCurvePublicKey:
    """Public key of chain[0], looked up in the bundle's carried certs (by the phone's cert id)."""
    cid = chain_ids[0]
    if cid not in certs:
        raise ValueError(f"leaf certificate {cid} not carried in the bundle")
    der = b64d(certs[cid])
    if cert_id(der) != cid:
        raise ValueError(f"cert id mismatch for {cid}")
    pub = x509.load_der_x509_certificate(der).public_key()
    if not isinstance(pub, ec.EllipticCurvePublicKey) or pub.curve.name != "secp256r1":
        raise ValueError("leaf key is not P-256")
    return pub


def check_header(h: dict):
    """Field syntax the escrow's message reconstruction relies on."""
    errs = []
    if not DEC.match(str(h["chainId"])): errs.append("chainId not canonical decimal")
    if not HEX40.match(h["escrow"]): errs.append("escrow not 40 lowercase hex")
    if not HEX64.match(h["coinId"]): errs.append("coinId not 64 lowercase hex")
    if not DEC.match(str(h["expiry"])): errs.append("expiry not canonical decimal")
    if not DEC.match(str(h["value"])) or int(h["value"]) == 0: errs.append("value not canonical positive decimal")
    if not HEX40.match(h["depositor"]): errs.append("depositor not 40 lowercase hex")
    return errs


def check_outputs(outs):
    errs = []
    for i, o in enumerate(outs):
        if not DEC.match(str(o["value"])): errs.append(f"output {i} value not canonical decimal")
        if not HEX64.match(o["key"]): errs.append(f"output {i} key not 64 lowercase hex")
    return errs
