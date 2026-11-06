#!/usr/bin/env python3
"""Chain loading + a Python reference of the in-circuit DER walk (mirrors circuits/lib/src/*.nr).

The reference walker exists so every circuit decision can be cross-checked on all real chains
in milliseconds (inventory), before paying for a proof. It must stay byte-for-byte equivalent
to the Noir walker: same accepted encodings, same failure cases.

Loaders accept:
  * PEM files (leaf first),
  * v1/v2 vector JSON: {"chain": [b64 DER, ...]} or payment JSON {"mint": {"chain": ...}, "hops": [{"to": [...]}]}
  * v3 vector JSON: {"chain"|"next": [refs], "certs": {ref: b64}}  (compact cert references)
"""
import base64, glob, hashlib, json, os, sys
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.abspath(os.path.join(HERE, "..", ".."))
SEAM_A = os.path.join(RAW, "seam_a_uncopyable")

P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
OID_KEYDESC_TLV = bytes.fromhex("060a2b06010401d679020111")      # OID 1.3.6.1.4.1.11129.2.1.17
SPKI_P256_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200 04".replace(" ", ""))
EXPECTED_PKG = b"xyz.prawl.otktest"


# ---------------------------------------------------------------- loading
GLOBAL_CERTS = {}   # v3 compact references: ref -> b64 DER, accumulated over all loaded files


def _der_list_from_json(d):
    """Return list of (label, [der...]) found in a vector JSON object."""
    out = []
    certs = d.get("certs") if isinstance(d.get("certs"), dict) else None
    if certs:
        GLOBAL_CERTS.update(certs)

    def resolve(lst):
        if lst and all(isinstance(x, str) and len(x) == 32 and all(c in "0123456789abcdef" for c in x) for x in lst):
            # refs the recipient already holds (pinned roots) may be absent from every file: keep the prefix
            out_l = []
            for x in lst:
                if x not in GLOBAL_CERTS:
                    break
                out_l.append(base64.b64decode(GLOBAL_CERTS[x]))
            return out_l
        return [base64.b64decode(x) for x in lst]

    if isinstance(d.get("chain"), list):
        out.append(("chain", resolve(d["chain"])))
    if isinstance(d.get("mint"), dict) and isinstance(d["mint"].get("chain"), list):
        out.append(("mint.chain", resolve(d["mint"]["chain"])))
    for i, h in enumerate(d.get("hops", []) or []):
        if isinstance(h, dict) and isinstance(h.get("to"), list):
            out.append((f"hops[{i}].to", resolve(h["to"])))
    for i, p in enumerate(d.get("path", []) or []):
        if isinstance(p, dict) and isinstance(p.get("next"), list):
            out.append((f"path[{i}].next", resolve(p["next"])))
    if certs is not None and "chain" not in d and not d.get("path"):
        pass
    return out


def load_chains(path):
    """Return list of (label, [x509.Certificate...]) for a file."""
    if path.endswith(".pem"):
        return [(os.path.basename(path), x509.load_pem_x509_certificates(open(path, "rb").read()))]
    d = json.load(open(path))
    res = []
    for lab, ders in _der_list_from_json(d):
        res.append((f"{os.path.basename(path)}:{lab}", [x509.load_der_x509_certificate(x) for x in ders]))
    return res


def all_sources():
    pats = [os.path.join(SEAM_A, "device_run*", "*.pem"),
            os.path.join(SEAM_A, "phone_vectors_v1", "*.json"),
            os.path.join(SEAM_A, "phone_vectors_v2_onchain", "*.json"),
            os.path.join(RAW, "v3", "phone_vectors", "*.json")]
    files = []
    for p in pats:
        files += sorted(glob.glob(p))
    return files


# ---------------------------------------------------------------- key/sig helpers
def pub_xy(cert):
    pk = cert.public_key()
    assert isinstance(pk, ec.EllipticCurvePublicKey) and pk.curve.name == "secp256r1", "not P-256"
    n = pk.public_numbers()
    return n.x.to_bytes(32, "big"), n.y.to_bytes(32, "big")


def sig_rs_lows(cert):
    """ECDSA (r, s) of the certificate signature, with s normalized to the low half.
    (r, n-s) is an equally valid signature on the same hash; Noir's verifier only accepts low-s."""
    r, s = decode_dss_signature(cert.signature)
    if s > P256_N // 2:
        s = P256_N - s
    return r.to_bytes(32, "big"), s.to_bytes(32, "big")


def spki_der(cert):
    return cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


# ---------------------------------------------------------------- reference walker (mirror of Noir)
class WalkError(Exception):
    pass


def need(c, msg):
    if not c:
        raise WalkError(msg)


def rd_hdr(b, pos, end):
    """Universal or context TLV header with a ONE-byte identifier. Length: short form, 0x81 or 0x82.
    Mirrors der.nr::read_header (no high-tag identifiers here)."""
    need(pos + 2 <= end, "header past end")
    t = b[pos]
    l0 = b[pos + 1]
    if l0 < 0x80:
        hl, ln = 2, l0
    elif l0 == 0x81:
        ln = b[pos + 2]; hl = 3
        need(ln >= 0x80, "non-minimal 0x81 length")
    elif l0 == 0x82:
        ln = (b[pos + 2] << 8) | b[pos + 3]; hl = 4
        need(ln >= 0x100, "non-minimal 0x82 length")
    else:
        raise WalkError("length form not supported")
    need(pos + hl + ln <= end, "TLV past end")
    return t, pos + hl, ln, pos + hl + ln


def expect(b, pos, end, tag):
    t, c, l, n = rd_hdr(b, pos, end)
    need(t == tag, f"expected tag {tag:#x} at {pos}, got {t:#x}")
    return c, l, n


def rd_auth_entry(b, pos, end):
    """AuthorizationList entry: [tag] EXPLICIT, context-specific constructed, tag < 2^14.
    Mirrors keydesc.nr::read_auth_header."""
    need(pos + 2 <= end, "auth hdr past end")
    b0 = b[pos]
    need((b0 & 0xE0) == 0xA0, "auth entry not context-constructed")
    if (b0 & 0x1F) != 0x1F:
        tag, il = b0 & 0x1F, 1
    else:
        b1 = b[pos + 1]
        if b1 & 0x80:
            b2 = b[pos + 2]
            need(b2 < 0x80, "tag > 2 bytes")
            need(b1 != 0x80, "non-minimal tag")
            tag, il = ((b1 & 0x7F) << 7) | b2, 3
        else:
            need(b1 >= 31, "non-minimal tag")
            tag, il = b1, 2
    l0 = b[pos + il]
    if l0 < 0x80:
        hl, ln = il + 1, l0
    elif l0 == 0x81:
        ln = b[pos + il + 1]; hl = il + 2
        need(ln >= 0x80, "non-minimal 0x81 length")
    else:
        raise WalkError("auth entry length form not supported")
    need(pos + hl + ln <= end, "auth entry past end")
    return tag, pos + hl, ln, pos + hl + ln


def int_value(b, c, l, maxlen):
    need(1 <= l <= maxlen, "int length")
    need(b[c] < 0x80, "negative int")
    return int.from_bytes(b[c:c + l], "big")


def walk_cert_prefix(b, n, parse_validity=False):
    """TBSCertificate header .. SPKI. Returns dict with serial, validity, spki x/y, pos after SPKI, tbs end."""
    need(n <= len(b), "len")
    c, l, end = expect(b, 0, n, 0x30)
    need(end == n, "TBS length != tbs_len")
    need(b[c:c + 5] == bytes.fromhex("a003020102"), "version != v3")
    p = c + 5
    sc, sl, p = expect(b, p, n, 0x02)                 # serial
    need(1 <= sl <= 20, "serial length")
    serial = int.from_bytes(b[sc:sc + sl], "big")
    _, _, p = expect(b, p, n, 0x30)                   # signature AlgorithmIdentifier
    _, _, p = expect(b, p, n, 0x30)                   # issuer
    vc, vl, p = expect(b, p, n, 0x30)                 # validity
    if parse_validity:
        need(vl == 30 and b[vc:vc + 2] == b"\x17\x0d" and b[vc + 15:vc + 17] == b"\x17\x0d", "validity not 2x UTCTime")
    nb, na = b[vc + 2:vc + 15], b[vc + 17:vc + 30]
    if parse_validity:
        nb, na = utc_to_int(nb), utc_to_int(na)
    _, _, p = expect(b, p, n, 0x30)                   # subject
    need(b[p:p + 27] == SPKI_P256_PREFIX, "SPKI is not uncompressed P-256")
    x, y = b[p + 27:p + 59], b[p + 59:p + 91]
    return dict(serial=serial, not_before=nb, not_after=na, x=x, y=y, after_spki=p + 91, end=n)


def utc_to_int(t):
    need(len(t) == 13 and t[12:13] == b"Z" and all(0x30 <= c <= 0x39 for c in t[:12]), "bad UTCTime")
    v = int(t[:12].decode())   # YYMMDDHHMMSS as a 12-digit decimal integer
    need(v < 500000000000, "UTCTime 19xx")
    return v


def walk_leaf(b, n, max_ext=3, max_sw=4, max_hw=15, expected_pkg=EXPECTED_PKG, expected_digest=None, min_patch=0):
    """Full leaf policy walk. Returns dict; raises WalkError on any rejection."""
    r = walk_cert_prefix(b, n)
    p = r["after_spki"]
    ec_, el, eend = expect(b, p, n, 0xA3)              # [3] extensions
    need(eend == n, "trailing data after extensions")
    sc, sl, send = expect(b, ec_, eend, 0x30)
    need(send == eend, "extensions SEQUENCE length")
    p = sc
    kd_c = None; kd_end = None; matches = 0
    for _ in range(max_ext):
        if p < send:
            xc, xl, xend = expect(b, p, send, 0x30)
            oc, ol, q = expect(b, xc, xend, 0x06)
            is_kd = b[xc:xc + 12] == OID_KEYDESC_TLV
            if b[q] == 0x01:
                need(b[q:q + 3] in (b"\x01\x01\xff", b"\x01\x01\x00"), "bad critical flag")
                q += 3
            vc, vl, vend = expect(b, q, xend, 0x04)
            need(vend == xend, "extension trailing")
            if is_kd:
                matches += 1; kd_c, kd_end = vc, vend
            p = xend
    need(p == send, "more extensions than MAX_EXT")
    need(matches == 1, "KeyDescription extension count != 1")
    # KeyDescription
    kc, kl, kend = expect(b, kd_c, kd_end, 0x30)
    need(kend == kd_end, "KeyDescription trailing")
    p = kc
    _, _, p = expect(b, p, kend, 0x02)                 # attestationVersion
    c, l, p = expect(b, p, kend, 0x0A); need(l == 1, "len"); att_lvl = b[c]
    _, _, p = expect(b, p, kend, 0x02)                 # keyMintVersion
    c, l, p = expect(b, p, kend, 0x0A); need(l == 1, "len"); km_lvl = b[c]
    need(att_lvl in (1, 2), "attestationSecurityLevel not TEE/StrongBox")
    need(km_lvl == att_lvl, "keyMint level != attestation level")
    _, _, p = expect(b, p, kend, 0x04)                 # attestationChallenge (attacker-chosen bytes: skipped)
    _, _, p = expect(b, p, kend, 0x04)                 # uniqueId
    swc, swl, swend = expect(b, p, kend, 0x30)
    hwc, hwl, hwend = expect(b, swend, kend, 0x30)
    need(hwend == kend, "KeyDescription has extra fields")
    # softwareEnforced
    p = swc; sw_405 = False; app_id = None; n709 = 0
    for _ in range(max_sw):
        if p < swend:
            tag, c, l, nx = rd_auth_entry(b, p, swend)
            if tag == 405: sw_405 = True
            if tag == 709: app_id = (c, l); n709 += 1
            p = nx
    need(p == swend, "more sw entries than MAX_SW")
    need(not sw_405, "usageCountLimit in softwareEnforced")
    need(n709 == 1, "attestationApplicationId count != 1")
    # attestationApplicationId ::= OCTET STRING { SEQ { SET OF PackageInfo, SET OF OCTET STRING digest } }
    c, l = app_id
    oc, ol, oend = expect(b, c, c + l, 0x04); need(oend == c + l, "appid trailing")
    ac, al, aend = expect(b, oc, oend, 0x30); need(aend == oend, "appid seq trailing")
    pc, pl, pend = expect(b, ac, aend, 0x31)          # package infos SET
    ic, il, iend = expect(b, pc, pend, 0x30); need(iend == pend, "more than one package")
    nc, nl, nend = expect(b, ic, iend, 0x04)
    pkg = b[nc:nc + nl]
    need(pkg == expected_pkg, f"package {pkg!r} != {expected_pkg!r}")
    _, _, vend = expect(b, nend, iend, 0x02); need(vend == iend, "pkg info trailing")
    dc, dl, dend = expect(b, pend, aend, 0x31); need(dend == aend, "appid trailing2")
    gc, gl, gend = expect(b, dc, dend, 0x04); need(gend == dend and gl == 32, "need exactly one 32-byte signer digest")
    digest = b[gc:gc + 32]
    if expected_digest is not None:
        need(digest == expected_digest, "app signer digest mismatch")
    # hardwareEnforced
    p = hwc
    seen = {}; cnt = {}
    for _ in range(max_hw):
        if p < hwend:
            tag, c, l, nx = rd_auth_entry(b, p, hwend)
            seen[tag] = (c, l); cnt[tag] = cnt.get(tag, 0) + 1
            p = nx
    need(p == hwend, "more hw entries than MAX_HW")
    for t in (1, 2, 10, 405, 702, 704, 706):
        need(cnt.get(t, 0) <= 1, f"duplicate hw tag {t}")
    need(405 in seen and b[seen[405][0]:seen[405][0] + seen[405][1]] == b"\x02\x01\x01", "usageCountLimit != 1 in hardwareEnforced")
    need(702 in seen and b[seen[702][0]:seen[702][0] + 3] == b"\x02\x01\x00" and seen[702][1] == 3, "origin != GENERATED")
    need(2 in seen and b[seen[2][0]:seen[2][0] + 3] == b"\x02\x01\x03" and seen[2][1] == 3, "algorithm != EC")
    need(10 in seen and b[seen[10][0]:seen[10][0] + 3] == b"\x02\x01\x01" and seen[10][1] == 3, "ecCurve != P-256")
    # purpose: SET OF INTEGER must contain SIGN(2); entries are 02 01 xx (one-byte purposes)
    need(1 in seen, "no purpose")
    c, l = seen[1]
    sc_, sl_, send_ = expect(b, c, c + l, 0x31)
    need(send_ == c + l and sl_ % 3 == 0 and sl_ // 3 <= 4, "purpose set form")
    has_sign = any(b[sc_ + 3 * k:sc_ + 3 * k + 3] == b"\x02\x01\x02" for k in range(sl_ // 3))
    for k in range(sl_ // 3):
        need(b[sc_ + 3 * k:sc_ + 3 * k + 2] == b"\x02\x01", "purpose entry form")
    need(has_sign, "purpose lacks SIGN")
    # rootOfTrust
    need(704 in seen, "no rootOfTrust")
    c, l = seen[704]
    rc, rl, rend = expect(b, c, c + l, 0x30); need(rend == c + l, "rot trailing")
    kc2, kl2, q = expect(b, rc, rend, 0x04)            # verifiedBootKey (any length)
    need(b[q:q + 3] == b"\x01\x01\xff", "deviceLocked != TRUE")
    need(b[q + 3:q + 6] == b"\x0a\x01\x00", "verifiedBootState != Verified")
    need(q + 6 <= rend, "rootOfTrust short")
    # osPatchLevel (YYYYMM)
    need(706 in seen, "no osPatchLevel")
    c, l = seen[706]
    ic2, il2, iend2 = expect(b, c, c + l, 0x02); need(iend2 == c + l, "patch trailing")
    patch = int_value(b, ic2, il2, 4)
    need(patch >= min_patch, "osPatchLevel below policy")
    return dict(r, att_level=att_lvl, patch=patch, digest=digest, pkg=pkg)


# ---------------------------------------------------------------- inventory
def classify(chain):
    leaf = chain[0]
    oids = lambda c: [e.oid.dotted_string for e in c.extensions]
    rkp = any("1.3.6.1.4.1.11129.2.1.30" in oids(c) for c in chain)
    issuer = chain[1].subject.rfc4514_string() if len(chain) > 1 else "?"
    gp = chain[2].subject.rfc4514_string() if len(chain) > 2 else "?"
    return rkp, issuer, gp


def preload_v3():
    for f in sorted(glob.glob(os.path.join(RAW, "v3", "phone_vectors", "*.json"))):
        d = json.load(open(f))
        if isinstance(d.get("certs"), dict):
            GLOBAL_CERTS.update(d["certs"])


def inventory():
    preload_v3()
    seen = set()
    rows = []
    for f in all_sources():
        for lab, chain in load_chains(f):
            leaf_der = chain[0].public_bytes(serialization.Encoding.DER)
            h = hashlib.sha256(leaf_der).hexdigest()[:12]
            if h in seen:
                continue
            seen.add(h)
            rkp, issuer, gp = classify(chain)
            tbs = chain[0].tbs_certificate_bytes
            try:
                w = walk_leaf(tbs, len(tbs))
                verdict = f"ACCEPT patch={w['patch']} lvl={w['att_level']}"
            except WalkError as e:
                verdict = f"REJECT {e}"
            except Exception as e:  # noqa
                verdict = f"ERROR {type(e).__name__}: {e}"
            ca3 = ""
            if len(chain) > 2:
                try:
                    walk_cert_prefix(chain[1].tbs_certificate_bytes, len(chain[1].tbs_certificate_bytes), True)
                    ca3 = "attcert-walk-ok"
                except WalkError as e:
                    ca3 = f"attcert-walk-FAIL {e}"
            rows.append((h, lab, len(tbs), len(chain[1].tbs_certificate_bytes) if len(chain) > 1 else 0,
                         "RKP" if rkp else "factory", issuer[:44], gp[:28], verdict, ca3))
    return rows


if __name__ == "__main__":
    for r in inventory():
        print(" | ".join(str(x) for x in r))
