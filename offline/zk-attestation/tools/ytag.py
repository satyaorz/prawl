#!/usr/bin/env python3
"""Per-payment double-spend tag (outside the SNARK) over Grumpkin, matching circuits/prawl_attest/src/tag.nr.

  Proof pi(K) (made once, at key creation) publishes C_A = h_A*G + rho_A*H and C_r = r*G + rho_r*H.
  Payment with challenge c = H(spend message) mod q publishes:
     y   = h_A + c*r                (mod q, q = Grumpkin group order = BN254 base field)
     sch = Schnorr PoK of rho' = rho_A + c*rho_r for the point  P = C_A + c*C_r - y*G = rho'*H
  The recipient checks sch. Binding of Pedersen (unknown log_G H) forces y = h_A + c*r.
  Two payments by the same key with c != c' reveal h_A = (c'*y - c*y') / (c' - c).

Pure Python; timings here are Python timings, not phone timings.
"""
import hashlib, os, secrets, sys, time

# Grumpkin: y^2 = x^3 - 17 over Fr(BN254); group order = Fq(BN254)
FP = 21888242871839275222246405745257275088548364400416034343698204186575808495617
Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
B = FP - 17
G = (1, 0x02cf135e7506a45d632d270d45f1181294833fc48d823f272c)
# derive_generators("PRAWL_YTAG_H", 0)[0], printed by `nargo test` in circuits/prawl_attest
H = (0x13d583853ced53dee0887f36370850b43bc0c931e3cdf87a51cb96189702476d,
     0x178b92a693d6d19b677ce72d74b84d5c47e333b5ec7e40e7e10bf3a347fbf1bc)
O = None


def on_curve(p):
    return p is None or (p[1] * p[1] - p[0] ** 3 - B) % FP == 0


def add(p, q):
    if p is None: return q
    if q is None: return p
    if p[0] == q[0]:
        if (p[1] + q[1]) % FP == 0: return None
        l = 3 * p[0] * p[0] * pow(2 * p[1], -1, FP) % FP
    else:
        l = (q[1] - p[1]) * pow(q[0] - p[0], -1, FP) % FP
    x = (l * l - p[0] - q[0]) % FP
    return (x, (l * (p[0] - x) - p[1]) % FP)


def neg(p):
    return None if p is None else (p[0], (-p[1]) % FP)


def mul(k, p):
    k %= Q
    r = None
    while k:
        if k & 1: r = add(r, p)
        p = add(p, p); k >>= 1
    return r


def commit(v, rho):
    return add(mul(v, G), mul(rho, H))


def challenge(spend_msg: bytes) -> int:
    return int.from_bytes(hashlib.sha256(b"PRAWL-YTAG-c|" + spend_msg).digest(), "big") % Q


def _fs(*pts_and_ints) -> int:
    h = hashlib.sha256(b"PRAWL-YTAG-schnorr")
    for v in pts_and_ints:
        if isinstance(v, tuple):
            h.update(v[0].to_bytes(32, "big") + v[1].to_bytes(32, "big"))
        else:
            h.update(int(v).to_bytes(32, "big"))
    return int.from_bytes(h.digest(), "big") % Q


def pay_tag(h_a, r, rho_a, rho_r, C_A, C_r, spend_msg):
    """Payer side: (y, (R, z)). 64+64+32 bytes uncompressed; 32+33+32 compressed."""
    c = challenge(spend_msg)
    y = (h_a + c * r) % Q
    rho = (rho_a + c * rho_r) % Q
    P = add(add(C_A, mul(c, C_r)), neg(mul(y, G)))
    k = secrets.randbelow(Q)
    R = mul(k, H)
    e = _fs(C_A, C_r, P, R, c, y)
    z = (k + e * rho) % Q
    return y, (R, z)


def check_tag(C_A, C_r, spend_msg, y, sch):
    c = challenge(spend_msg)
    R, z = sch
    if not (on_curve(C_A) and on_curve(C_r) and on_curve(R)):
        return False
    P = add(add(C_A, mul(c, C_r)), neg(mul(y, G)))
    e = _fs(C_A, C_r, P, R, c, y)
    return mul(z, H) == add(R, mul(e, P))


def extract(c1, y1, c2, y2):
    r = (y1 - y2) * pow(c1 - c2, -1, Q) % Q
    return (y1 - c1 * r) % Q, r


if __name__ == "__main__":
    # self-test against the Noir test vector commit(7, 11)
    c = commit(7, 11)
    assert c == (0x149c8814714a25d49fea6c639a8d139ce8e6ebb5e29e75437734c9dae3025711,
                 0x0883c5c9046dd20ada3a4c04291218a9f388be1c5c996f0ac410de2828adb724), c
    assert on_curve(G) and on_curve(H)
    print("Grumpkin commit(7,11) matches Noir: OK")
