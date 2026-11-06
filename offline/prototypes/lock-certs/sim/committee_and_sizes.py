"""(1) Committee-sampling safety: probability a randomly sampled committee of n from a pool
    with Byzantine (stake) fraction beta has > f = floor((n-1)/3) Byzantine members, exactly
    (hypergeometric, pool of Npool members) and with G grinding attempts.
(2) Wire sizes of the lock request / certificate, built from element sizes MEASURED with blst
    (rust_run.log: G1 sig 48 B compressed, G2 pk 96 B) and standard sizes for other schemes.
(3) Channel fit: SMS (140 octets binary / 160 GSM-7 chars), LoRa airtime (Semtech SX127x
    formula), and duty-cycle-limited throughput.
"""
from math import comb, ceil, log2

print(__doc__)

# ---------------------------------------------------------------- (1) committee sampling
def p_bad(Npool, beta, n):
    B = round(beta * Npool)
    f = (n - 1) // 3
    tot = comb(Npool, n)
    return sum(comb(B, k) * comb(Npool - B, n - k) for k in range(f + 1, min(n, B) + 1)) / tot

print("== (1) P[committee has > f Byzantine]  (hypergeometric) ; with G grinding tries: 1-(1-p)^G ==")
print(f"{'Npool':>6} {'beta':>5} {'n':>4} {'f':>3} {'p(G=1)':>11} {'G=1e3':>9} {'G=1e6':>9}")
for Npool in (100, 1000):
    for beta in (0.05, 0.10, 0.20, 0.33):
        for n in (4, 7, 10, 31, 64):
            if n > Npool:
                continue
            p = p_bad(Npool, beta, n)
            g3 = 1 - (1 - p) ** 1e3
            g6 = 1 - (1 - p) ** 1e6
            print(f"{Npool:6d} {beta:5.2f} {n:4d} {(n-1)//3:3d} {p:11.3e} {g3:9.3e} {g6:9.3e}")

# smallest n with p_bad <= 2^-20 and 2^-40 (Npool = 1000)
print("\nSmallest committee n (n = 3f+1) with P[bad] <= target, Npool = 1000:")
for beta in (0.05, 0.10, 0.20, 0.25):
    out = []
    for tgt in (1e-3, 2 ** -20, 2 ** -40):
        n = next((n for n in range(4, 400, 3) if p_bad(1000, beta, n) <= tgt), None)
        out.append(f"target {tgt:.1e}: n={n}")
    print(f"  beta={beta:.2f}: " + "; ".join(out))

# ---------------------------------------------------------------- (2) wire sizes
print("\n== (2) Wire formats (bytes) ==")
SIG_BLS_G1 = 48   # measured (blst min_sig compressed)
SIG_BLS_G2 = 96   # measured (blst min_pk compressed)
SIG_BN254_G1 = 32 # derived: compressed BN254 G1 point (~100-bit security; EIP-196/197 curve)
SIG_SCHNORR = 64  # BIP340 / FROST-Ed25519 signature (R,z); FROST(secp256k1, SHA-256) RFC 9591 = 65
SIG_ECDSA = 65    # r,s,v (individual ecrecover-able)

def req(nf, h, epoch=2, ver=1):
    return ver + epoch + nf + h

def cert(sig, n, aggregate=True, t=None, epoch=2, ver=1, bitmap=True):
    bm = ceil(n / 8) if bitmap else 0
    if aggregate:
        return ver + epoch + bm + sig
    return ver + epoch + bm + t * sig

rows = [
    ("lock request, tight (nf 16 B, h 16 B)", req(16, 16)),
    ("lock request, conservative (nf 32 B, h 32 B)", req(32, 32)),
]
for n in (4, 7, 10, 31, 100):
    f = (n - 1) // 3
    q = 2 * f + 1
    rows.append((f"cert BLS12-381 multisig agg (G1 48) + bitmap, n={n}", cert(SIG_BLS_G1, n)))
    if n in (4, 7):
        rows.append((f"cert BLS12-381 min_pk (G2 96) + bitmap, n={n}", cert(SIG_BLS_G2, n)))
        rows.append((f"cert individual ECDSA x q={q}, n={n}", cert(SIG_ECDSA, n, aggregate=False, t=q)))
        rows.append((f"cert individual Schnorr x q={q}, n={n}", cert(SIG_SCHNORR, n, aggregate=False, t=q)))
rows.append(("cert threshold BLS (DKG, no bitmap)", cert(SIG_BLS_G1, 0, bitmap=False)))
rows.append(("cert FROST threshold Schnorr (BIP340-style 64 B)", cert(SIG_SCHNORR, 0, bitmap=False)))
rows.append(("cert BN254 multisig + bitmap n=7 (~100-bit sec.)", cert(SIG_BN254_G1, 7)))
rows.append(("witness partial response (1 BLS G1 sig + idx)", 1 + 48))
for name, b in rows:
    sms_bin = "yes" if b <= 140 else f"no ({ceil(b/140)} SMS)"
    # GSM-7 text with base64: 6 bits/char, 160 chars -> 120 bytes of payload
    sms_txt = "yes" if b <= 120 else f"no ({ceil(b/120)} SMS)"
    print(f"  {name:56s} {b:5d} B   1 binary SMS(140B): {sms_bin:12s} 1 text SMS(base64,120B): {sms_txt}")

# information-theoretic floor (bits), for the notes
print("\n  Floors [DERIVED]: uplink must name the coin state and the transfer: >= ~2*128 bits if both are")
print("  second-preimage-protected 128-bit digests (32 B) -> with framing 35 B; downlink must carry an")
print("  authenticator the payer cannot forge: >= 128 bits in principle; the shortest practical publicly")
print("  verifiable one here is a 48-B BLS12-381 G1 signature (32 B on BN254 at ~100-bit security).")

# ---------------------------------------------------------------- (3) LoRa airtime
print("\n== (3) LoRa airtime (Semtech SX127x formula; explicit header, CRC on) ==")
def lora_airtime_ms(PL, SF, BW, CR=1, preamble=16, crc=1, ih=0):
    tsym = (2 ** SF) / BW * 1000.0
    de = 1 if tsym > 16.0 else 0
    tpre = (preamble + 4.25) * tsym
    num = 8 * PL - 4 * SF + 28 + 16 * crc - 20 * ih
    nsym = 8 + max(ceil(num / (4 * (SF - 2 * de))) * (CR + 4), 0)
    return tpre + nsym * tsym

MESH_HDR = 16  # Meshtastic over-the-air header (forum figures say 14-16 B) [CONJECTURE]
REQ = req(16, 16) + 4   # + 4 B channel/port framing guess [CONJECTURE]
RESP = 1 + 48 + 4
presets = [("LongFast SF11/250k CR4/5", 11, 250e3), ("MediumFast SF9/250k (assumed)", 9, 250e3),
           ("ShortFast SF7/250k (assumed)", 7, 250e3), ("SF12/125k (max range)", 12, 125e3)]
for name, SF, BW in presets:
    a_req = lora_airtime_ms(REQ + MESH_HDR, SF, BW)
    a_resp = lora_airtime_ms(RESP + MESH_HDR, SF, BW)
    for n in (4, 7):
        q = 2 * ((n - 1) // 3) + 1
        # one request, q responses (others suppressed after quorum is heard), single hop
        per_pay_1hop = a_req + q * a_resp
        # with up to 3 hops of managed flooding, assume every packet retransmitted <= 3 times
        per_pay_3hop = 3 * per_pay_1hop
        # pure-ALOHA useful channel occupancy ~ 18.4%
        pay_per_h_1 = 0.184 * 3600e3 / per_pay_1hop
        pay_per_h_3 = 0.184 * 3600e3 / per_pay_3hop
        # duty cycle: each witness sends one response per payment; 1% -> 36 s/h of airtime
        dc1 = 36e3 / a_resp
        dc10 = 360e3 / a_resp
        print(f"  {name:30s} n={n}: req {a_req:7.1f} ms, resp {a_resp:7.1f} ms; latency(1 hop, serial) ~{per_pay_1hop/1000:5.2f} s;"
              f" channel cap ~{pay_per_h_1:6.0f} pay/h (1 hop), ~{pay_per_h_3:5.0f} (3 hops);"
              f" per-witness duty cap {dc1:5.0f}/h @1%, {dc10:6.0f}/h @10%")

# ---------------------------------------------------------------- SMS round trip
print("\n== SMS round trip from IMDA Singapore 2019 per-SMS P[delivered <= 15 s] ==")
for p in (0.9626, 0.9787, 0.9946):
    print(f"  per-SMS {p:.4f} -> P[request and reply both <= 15 s] = {p*p:.4f} (independence assumed)")
