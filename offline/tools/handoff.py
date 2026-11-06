#!/usr/bin/env python3
"""Phone files -> website handoff payloads (raw/v3/HANDOFF.md, v1).

  handoff.py load   <mint3_*.json>    -> prints JSON, base64url <d>, and the https/prawl links
  handoff.py redeem <redeem3_*.json>  -> same, with the exact redeem(Header, Spend[], Redemption) arguments
  options: --site https://example.vercel.app  (default: https://<site>)  --out <file.json>

The redeem payload is built from the phone bundle: per spend, the outputs, the followed index, the DER
signature split into (r, s), and the next one-time key's (x, y) taken from its attestation leaf certificate.
Verification of the result is done by simulating the call against the real escrow (see sim in the test
script), not here.
"""
import base64, json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "escrow_v3", "tools"))
import prawl_v3 as P  # noqa: E402

def h32(x):
    x = x.lower().replace("0x", "")
    return "0x" + x.rjust(64, "0")

def a40(x):
    x = x.lower().replace("0x", "")
    return "0x" + x.rjust(40, "0")

def rs(sig_b64):
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    r, s = decode_dss_signature(P.b64d(sig_b64))
    return "0x%064x" % r, "0x%064x" % s

def header(h):
    return {"coinId": h32(h["coinId"]), "value": str(int(h["value"])), "expiry": int(h["expiry"]),
            "k0x": h32(h["k0x"]), "k0y": h32(h["k0y"]), "depositor": a40(h["depositor"])}

def outs(os_):
    return [{"value": str(int(o["value"])), "keyHash": h32(o["key"])} for o in os_]

def load(m):
    h = header(m)
    return {"v": 1, "t": "load", "chainId": int(m["chainId"]), "escrow": a40(m["escrow"]), **h}

def redeem(b):
    certs = b.get("certs", {})
    path = []
    for s in b["path"]:
        k = P.leaf_key(s["next"], certs)
        x, y = P.key_xy(k)
        r, ss = rs(s["sig"])
        path.append({"outputs": outs(s["outputs"]), "index": int(s["index"]), "r": r, "s": ss,
                     "nextX": "0x%064x" % x if isinstance(x, int) else h32(x),
                     "nextY": "0x%064x" % y if isinstance(y, int) else h32(y)})
    rd = b["redeem"]; r, ss = rs(rd["sig"])
    h = b["header"]
    return {"v": 1, "t": "redeem", "chainId": int(h["chainId"]), "escrow": a40(h["escrow"]), "header": header(h),
            "path": path, "redemption": {"outputs": outs(rd["outputs"]), "index": int(rd["index"]),
                                         "payout": a40(rd["payout"]), "r": r, "s": ss}}

def main():
    kind, f = sys.argv[1], sys.argv[2]
    site = sys.argv[sys.argv.index("--site") + 1] if "--site" in sys.argv else "https://<site>"
    j = json.load(open(f))
    p = load(j) if kind == "load" else redeem(j)
    raw = json.dumps(p, separators=(",", ":"))
    d = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    res = {"payload": p, "d": d, "https": f"{site}/#/offline/{kind}?d={d}", "prawl": f"prawl://offline/{kind}?d={d}",
           "sizes": {"json": len(raw), "d": len(d)}}
    if "--out" in sys.argv:
        json.dump(res, open(sys.argv[sys.argv.index("--out") + 1], "w"), indent=1)
    print(json.dumps(res["sizes"]), file=sys.stderr)
    print(json.dumps(p, indent=1))

if __name__ == "__main__":
    main()
