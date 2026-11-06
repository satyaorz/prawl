#!/usr/bin/env python3
"""Convert the REAL v2 phone vectors (../phone_vectors_v2_onchain) into fixtures/payments_v2.json.

  * r1: Samsung StrongBox genesis key -> hop 0 to Bob (OnePlus TEE) -> Bob's key signs a REDEMPTION hop
        (hop 1) whose "to" field is sha256hex("PRAWL-REDEEM|" + chainId + "|" + escrow40 + "|" + payout40).
  * e1: a Samsung StrongBox genesis key created WITHOUT setMaxUsageCount (multi-use "cheat" key) that signed
        hop 0 twice: to Bob's real key (bobE) and to Charlie's real key (charlieE). A REAL equivocation.
Every signature is re-verified here with `cryptography`, independently of the contract.
"""
import base64, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vectors_to_foundry as V  # noqa: E402
from cryptography.exceptions import InvalidSignature  # noqa: E402
from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature  # noqa: E402

V2 = os.path.join(V.ROOT, "..", "phone_vectors_v2_onchain")


def load(n):
    return json.load(open(os.path.join(V2, n)))


def main():
    out = {"note": "REAL phone vectors v2 (phone_vectors_v2_onchain)"}
    # ---------------------------------------------------------------- r1: payment + phone-signed redemption
    r = load("redeem_r1.json")
    pay = V.convert_payment(r, "REAL: r1 Samsung StrongBox -> Bob (OnePlus TEE)")
    assert pay["pyAllValid"]
    plain = V.convert_payment(load("pay_r1_bob.json"), "REAL: pay_r1_bob.json (no redemption)")
    assert plain["hops"] == pay["hops"], "redeem file carries the same hop 0 as pay_r1_bob.json"
    rd = r["redeem"]
    e40 = rd["escrow"].lower().replace("0x", "")
    p40 = rd["payout"].lower().replace("0x", "")
    target = hashlib.sha256(f"PRAWL-REDEEM|{rd['chainId']}|{e40}|{p40}".encode()).hexdigest()
    prev = hashlib.sha256(base64.b64decode(r["hops"][-1]["sig"])).hexdigest()
    msg = V.hop_message(r["coinId"], r["value"], rd["hop"], prev, target)
    sig = base64.b64decode(rd["sig"])
    rr, ss = decode_dss_signature(sig)
    tip_pub = V.certs(r["hops"][-1]["to"])[0].public_key()
    try:
        tip_pub.verify(sig, msg, ec.ECDSA(hashes.SHA256()))
        ok = True
    except InvalidSignature:
        ok = False
    assert ok, "phone redemption signature must verify over the PRAWL-REDEEM message"
    pay["redeem"] = {"chainId": int(rd["chainId"]), "escrow": rd["escrow"], "payout": rd["payout"], "hop": rd["hop"],
                     "r": V.h32(rr.to_bytes(32, "big")), "s": V.h32(ss.to_bytes(32, "big")), "sigDer": V.h32(sig),
                     "derCanonical": encode_dss_signature(rr, ss) == sig, "highS": ss > V.N256 // 2,
                     "message": msg.decode(), "msgSha256": V.h32(hashlib.sha256(msg).digest()),
                     "target": "0x" + target, "pyValid": ok}
    out["r1"] = pay
    snap = load("snapshot.json")["deposits"][0]
    assert snap["k0"] == pay["k0Hash"][2:]

    # ---------------------------------------------------------------- e1: REAL equivocation by a multi-use key
    a = V.convert_payment(load("pay_e1_bobE.json"), "REAL: e1 cheat key -> bobE")
    b = V.convert_payment(load("pay_e1_charlieE.json"), "REAL: e1 cheat key -> charlieE (same key, hop 0 again)")
    assert a["pyAllValid"] and b["pyAllValid"] and a["k0Hash"] == b["k0Hash"]
    assert a["hops"][0]["message"] != b["hops"][0]["message"]
    for p in (a, b):
        p["hops"][0]["messageHex"] = V.h32(p["hops"][0]["message"].encode())
    out["e1"] = {"bobE": a, "charlieE": b}

    # ---------------------------------------------------------------- attestation leaves (for depositAttested)
    leaves = {}
    for name, f in [("r1", "mint_r1.json"), ("e1", "mint_e1.json")]:
        ch = load(f)["chain"]
        info = V.chain_info(ch)
        leaves[name] = {"leafDer": info[0]["der"], "akSpki": info[1]["spkiSha256"], "akSubject": info[1]["subject"],
                        "usageCountLimitHw": info[0]["keyDescription"]["usageCountLimitHw"],
                        "attestationSecurityLevel": info[0]["keyDescription"]["attestationSecurityLevel"]}
    # the e1 recipients' leaves (TEE), to show the e1 key's own leaf is what slashing would need
    out["leaves"] = leaves
    json.dump(out, open(os.path.join(V.OUT, "payments_v2.json"), "w"), indent=1)

    print("r1: hop0 valid, redemption hop", rd["hop"], "valid=", ok, "highS=", pay["redeem"]["highS"],
          "derCanonical=", pay["redeem"]["derCanonical"])
    print("    redeem message:", msg.decode())
    print("e1: bobE/charlieE both valid, same genesis key", a["k0Hash"][:18], "different messages")
    for k, v in leaves.items():
        print(f"leaf {k}: AK {v['akSubject'][:40]} spki {v['akSpki'][:14]} usageCountLimitHw={v['usageCountLimitHw']}"
              f" level={v['attestationSecurityLevel']}")


if __name__ == "__main__":
    main()
