#!/usr/bin/env python3
"""Convert Prawl v3 bundles (phone format) into one flat JSON fixture for the Foundry tests.

INPUT: a directory of *.json bundles exactly as Wallet3Activity writes them (synthetic ones add "_test"):
  {
    "header": {"v": 3, "label": "s", "coinId": <64 hex>, "chainId": "31337", "escrow": <40 hex>,
               "expiry": <unix s>, "value": "<wei>", "k0": [<cert ids>], "k0x": <hex>, "k0y": <hex>,
               "depositor": <40 hex>},
    "path":   [ {"outputs": [{"value": "<wei>", "key": <64 hex keyHash>}, ...], "index": i,
                 "sig": <base64 DER>, "next": [<cert ids of outputs[index]'s key chain>]}, ... ],
    "redeem": {"outputs": [...], "index": j, "payout": "0x..", "sig": <base64 DER>},   (redeem3 bundles only)
    "certs":  {<cert id>: <base64 DER>, ...},
    "_test":  {"name": ..., "expect": "ok" | "<contract error name>" | "equivocation", "comment": ...}  (optional)
  }
  Bundles without "redeem" (pay3 / held notes) are used only for equivocation detection.

OUTPUT (default fixtures/v3_synthetic.json), all hashes/keys as 0x-hex bytes32, all amounts as decimal strings:
  {
    "format": "prawl-v3-foundry/1",
    "coinNames": [..], "coins": {<label>: {coinId, value, expiry, k0x, k0y, k0Hash, depositor, chainId, escrow}},
    "redeemNames": [..], "redeems": {<name>: {
        coin, expect, pyVerdict, payout, amount, nPath,
        path: [{nOut, values[], keyHashes[], index, r, s, nextX, nextY, noteId, message, digest}],
        redeem: {nOut, values[], keyHashes[], index, r, s, noteId, message, digest}}},
    "equivocationNames": [..], "equivocations": {<name>: {
        coin, accusedKeyHash, nPath, path: [...as above...], a: {message, r, s}, b: {message, r, s}}}
  }
`pyVerdict` is the converter's own independent verdict ("ok" or the first rule broken, named like the
contract's error); `expect` is "_test.expect" when present, else pyVerdict. Every signature, the
conservation rule, the output->key binding, strict DER and the REDEEM target are re-checked here.

Usage: python tools/bundles_to_foundry.py [--in DIR] [--out FILE] [--depositor 0x..]
  --depositor overrides header.depositor (the phone's mint file has a placeholder; the commitment needs the
  address that actually sent the deposit transaction).
"""
import argparse
import glob
import json
import os
import re
import sys

import prawl_v3 as P

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def h32(v: int) -> str:
    return "0x%064x" % v


def hx(s: str) -> str:
    return "0x" + s


def safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", s)


class Fail(Exception):
    def __init__(self, verdict, why):
        super().__init__(why)
        self.verdict, self.why = verdict, why


def flat_outputs(outs):
    return {"nOut": len(outs), "values": [str(o["value"]) for o in outs], "keyHashes": [hx(o["key"]) for o in outs]}


def walk(b: dict, depositor_override=None):
    """Independently verify a bundle. Returns (coin, flat path, flat redeem|None, spends, verdict, why).
    `spends` lists every signed message for equivocation detection: (signer keyHash, msg, r, s, prefix)."""
    h = dict(b["header"])
    if depositor_override:
        h["depositor"] = depositor_override.lower().replace("0x", "")
    certs = b.get("certs", {})
    if h.get("depositor", "") == "0" * 40 and not depositor_override:
        print(f"  WARNING coin {h.get('label')}: header.depositor is the zero placeholder (Wallet3Activity.mint3). "
              "The deposit commitment includes the depositor, so a light-client proof can only match the real "
              "depositing account: pass --depositor 0x<that account>.", file=sys.stderr)
    errs = P.check_header(h)
    if errs:
        raise ValueError("header: " + "; ".join(errs))
    k0 = P.leaf_key(h["k0"], certs)
    x, y = P.key_xy(k0)
    if "k0x" in h and int(h["k0x"], 16) != x or "k0y" in h and int(h["k0y"], 16) != y:
        raise ValueError("header k0x/k0y differ from the k0 certificate")
    coin = {"coinId": hx(h["coinId"]), "value": str(h["value"]), "expiry": int(h["expiry"]), "k0x": h32(x),
            "k0y": h32(y), "k0Hash": hx(P.key_hash(k0)), "depositor": "0x" + h["depositor"],
            "chainId": int(h["chainId"]), "escrow": "0x" + h["escrow"], "label": h.get("label", "")}
    signer, value, note_id = k0, int(h["value"]), P.genesis_note_id(h)
    path, spends = [], []
    # tv: verdict on the chosen REDEEM output (the escrow checks it FIRST: index, then target);
    # pv: verdict on the path + tip spend (zero output, conservation, signature, output->next-key binding).
    st = {"tv": "ok", "pv": "ok", "why": ""}
    po40 = None
    if "redeem" in b:
        rd = b["redeem"]
        po40 = rd["payout"].lower().replace("0x", "")
        if not P.HEX40.match(po40):
            raise ValueError("payout is not a 20-byte address")
        if int(rd["index"]) >= len(rd["outputs"]):
            st.update(tv="BadIndex", why="redeem index out of range")
        elif rd["outputs"][int(rd["index"])]["key"] != P.redeem_key(h["chainId"], h["escrow"], po40):
            st.update(tv="NotRedeemOutput", why="redeem output is not PRAWL-REDEEM for (chainId, escrow, payout)")

    def path_fail(verdict, why):
        if st["pv"] == "ok":
            st["pv"] = verdict
            if st["tv"] == "ok":
                st["why"] = why

    def check_spend(depth, outs, sig_der):
        errs = P.check_outputs(outs)
        if errs:
            raise ValueError(f"spend {depth}: " + "; ".join(errs))
        r, s, strict = P.strict_der(sig_der)
        if not strict:
            raise ValueError(f"spend {depth}: signature is not strict DER (the contract rebuilds DER from r,s)")
        vals = [int(o["value"]) for o in outs]
        msg = P.spend_message(h, depth, note_id, outs)
        sig_ok = P.verify(signer, msg, sig_der)
        # A validly signed message by a key reached through a valid prefix is equivocation evidence, even if
        # this spend breaks conservation or names a wrong REDEEM target (proveEquivocation takes raw messages).
        if st["pv"] == "ok" and sig_ok:
            spends.append((P.key_hash(signer), msg, r, s, list(path)))
        if any(v == 0 for v in vals):  # same order as the contract: zero output, conservation, signature
            path_fail("ZeroOutput", f"spend {depth} has a zero output")
        elif sum(vals) != value:
            path_fail("ConservationViolated", f"spend {depth}: outputs sum {sum(vals)} != note value {value}")
        elif not sig_ok:
            path_fail("BadSig", f"spend {depth}: signature does not verify under the note's key")
        return r, s, msg

    for d, sp in enumerate(b["path"]):
        sig = P.b64d(sp["sig"])
        r, s, msg = check_spend(d, sp["outputs"], sig)
        nk = P.leaf_key(sp["next"], certs)
        nx, ny = P.key_xy(nk)
        idx = int(sp["index"])
        e = flat_outputs(sp["outputs"])
        e.update({"index": idx, "r": h32(r), "s": h32(s), "nextX": h32(nx), "nextY": h32(ny), "noteId": hx(note_id),
                  "message": "0x" + msg.hex(), "digest": hx(P.sha256hex(msg))})
        path.append(e)
        if idx >= len(sp["outputs"]):
            path_fail("BadIndex", f"spend {d}: index {idx} out of range")
        elif sp["outputs"][idx]["key"] != P.key_hash(nk):
            path_fail("OutputKeyMismatch", f"spend {d}: outputs[{idx}] does not pay the next key")
        value = int(sp["outputs"][idx]["value"]) if idx < len(sp["outputs"]) else 0
        note_id = P.child_note_id(sig, idx)
        signer = nk
    red = None
    if "redeem" in b:
        rd = b["redeem"]
        idx = int(rd["index"])
        sig = P.b64d(rd["sig"])
        r, s, msg = check_spend(len(b["path"]), rd["outputs"], sig)
        red = flat_outputs(rd["outputs"])
        red.update({"index": idx, "r": h32(r), "s": h32(s), "noteId": hx(note_id), "message": "0x" + msg.hex(),
                    "digest": hx(P.sha256hex(msg)), "payout": "0x" + po40,
                    "amount": str(rd["outputs"][idx]["value"]) if idx < len(rd["outputs"]) else "0"})
    verdict = st["tv"] if st["tv"] != "ok" else st["pv"]
    why = st["why"]
    return coin, path, red, spends, verdict, why


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="indir", default=os.path.join(ROOT, "vectors", "synthetic"))
    ap.add_argument("--out", default=os.path.join(ROOT, "fixtures", "v3_synthetic.json"))
    ap.add_argument("--depositor", default=None)
    a = ap.parse_args()

    coins, redeems, seen_spends = {}, {}, {}
    files = sorted(glob.glob(os.path.join(a.indir, "*.json")))
    if not files:
        sys.exit(f"no bundles in {a.indir}")
    for f in files:
        b = json.load(open(f))
        if "header" not in b or "path" not in b:
            print(f"  skip {os.path.basename(f)} (not a v3 bundle)")
            continue
        coin, path, red, spends, verdict, why = walk(b, a.depositor)
        label = safe_name(coin.pop("label") or coin["coinId"][2:14])
        if label in coins and coins[label] != coin:
            sys.exit(f"{f}: header of coin '{label}' differs from an earlier bundle")
        coins[label] = coin
        for kh, msg, r, s, prefix in spends:
            seen_spends.setdefault(kh, {})
            seen_spends[kh].setdefault(msg, (label, r, s, prefix))
        if red is None:
            continue
        t = b.get("_test", {})
        name = safe_name(t.get("name") or os.path.splitext(os.path.basename(f))[0])
        expect = t.get("expect", verdict)
        mark = "OK " if verdict == expect or (expect == "equivocation" and verdict == "ok") else "!! "
        print(f"  {mark}{name:34s} coin={label:12s} depth={len(path)} pyVerdict={verdict:22s} expect={expect}"
              + (f"  ({why})" if why else ""))
        if mark == "!! ":
            sys.exit(f"python verdict for {name} contradicts its _test.expect")
        redeems[name] = {"coin": label, "expect": expect, "pyVerdict": verdict, "payout": red.pop("payout"),
                         "amount": red.pop("amount"), "nPath": len(path), "path": path, "redeem": red}

    # equivocation: one key, two different validly signed messages (across all bundles, in their coin's context)
    eqs = {}
    for kh, msgs in sorted(seen_spends.items()):
        if len(msgs) < 2:
            continue
        (ma, (label, ra, sa, prefix)), (mb, (_, rb, sb, _p)) = list(msgs.items())[:2]
        name = safe_name(f"equiv_{label}_{kh[:8]}")
        eqs[name] = {"coin": label, "accusedKeyHash": hx(kh), "nPath": len(prefix), "path": prefix,
                     "a": {"message": "0x" + ma.hex(), "r": h32(ra), "s": h32(sa)},
                     "b": {"message": "0x" + mb.hex(), "r": h32(rb), "s": h32(sb)},
                     "nMessages": len(msgs)}
        print(f"  EQUIVOCATION key {kh[:16]}… in coin {label}: {len(msgs)} different signed messages -> {name}")

    out = {"format": "prawl-v3-foundry/1", "source": os.path.relpath(a.indir, ROOT),
           "coinNames": sorted(coins), "coins": coins,
           "redeemNames": sorted(redeems), "redeems": redeems,
           "equivocationNames": sorted(eqs), "equivocations": eqs}
    json.dump(out, open(a.out, "w"), indent=1)
    print(f"wrote {os.path.relpath(a.out, ROOT)}: {len(coins)} coins, {len(redeems)} redemptions, "
          f"{len(eqs)} equivocations (all signatures re-verified in Python)")


if __name__ == "__main__":
    main()
