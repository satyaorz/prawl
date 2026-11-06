#!/usr/bin/env python3
"""Phone file -> validated arguments for cast (used by sepolia_deposit.sh / sepolia_redeem.sh).

  v3_bundle_args.py mint   <mint3_*.json>
  v3_bundle_args.py redeem <redeem3_*.json> [--depositor 0x..]

Prints KEY=VALUE lines. Every value is checked against a strict regex before printing (hex, decimal, or a
cast tuple/array literal built only from hex/decimal), so the shell scripts can read them without eval.

mint:   verifies that (k0x, k0y) in the header is the public key of the genesis leaf certificate carried in
        the file (chain header.k0, cert ids = the phone's 128-bit ids), and the header field syntax.
redeem: runs the full independent verification of tools/bundles_to_foundry.walk (every signature, strict DER,
        conservation, output->key binding, REDEEM target); refuses unless the verdict is "ok"; then builds the
        three cast arguments of redeem(Header, Spend[], Redemption).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prawl_v3 as P  # noqa: E402
from bundles_to_foundry import walk  # noqa: E402

SAFE = re.compile(r"^[0-9A-Za-z()\[\],]*$")
REDEEM_SIG = ("redeem((bytes32,uint256,uint64,uint256,uint256,address),"
              "((uint256,bytes32)[],uint256,bytes32,bytes32,bytes32,bytes32)[],"
              "((uint256,bytes32)[],uint256,address,bytes32,bytes32))")


def out(k, v):
    v = str(v)
    if not SAFE.match(v):
        sys.exit(f"refusing to emit unsafe value for {k}")
    print(f"{k}={v}")


def norm40(s):
    s = s.lower().replace("0x", "")
    if not P.HEX40.match(s):
        sys.exit(f"not a 20-byte hex address: {s!r}")
    return s


def mint(path):
    m = json.load(open(path))
    if m.get("v") != 3:
        sys.exit("not a v3 mint file")
    h = dict(m)
    h["escrow"] = norm40(h["escrow"])
    h["depositor"] = norm40(h.get("depositor", "0" * 40))
    errs = P.check_header(h)
    if errs:
        sys.exit("header: " + "; ".join(errs))
    k0 = P.leaf_key(h["k0"], m.get("certs", {}))
    x, y = P.key_xy(k0)
    if int(h["k0x"], 16) != x or int(h["k0y"], 16) != y:
        sys.exit("header k0x/k0y are not the key of the genesis certificate")
    out("COIN_ID", "0x" + h["coinId"])
    out("EXPIRY", int(h["expiry"]))
    out("VALUE", int(h["value"]))
    out("K0X", "0x%064x" % x)
    out("K0Y", "0x%064x" % y)
    out("K0_HASH", "0x" + P.key_hash(k0))
    out("DEPOSITOR", "0x" + h["depositor"])
    out("CHAIN_ID", int(h["chainId"]))
    out("ESCROW", "0x" + h["escrow"])


def redeem(path, depositor=None):
    b = json.load(open(path))
    if "redeem" not in b:
        sys.exit("not a redemption bundle (no 'redeem' record)")
    b["header"] = dict(b["header"])
    b["header"]["escrow"] = norm40(b["header"]["escrow"])
    b["header"]["depositor"] = norm40(b["header"].get("depositor", "0" * 40))
    coin, pth, red, _spends, verdict, why = walk(b, depositor)
    if verdict != "ok":
        sys.exit(f"bundle does not verify: {verdict} ({why})")
    if int(coin["depositor"], 16) == 0:
        sys.exit("header.depositor is the zero placeholder; pass --depositor 0x<deposit sender>")
    hdr = f"({coin['coinId']},{coin['value']},{coin['expiry']},{coin['k0x']},{coin['k0y']},{coin['depositor']})"

    def outs(e):
        return "[" + ",".join(f"({v},{k})" for v, k in zip(e["values"], e["keyHashes"])) + "]"

    spends = ",".join(f"({outs(s)},{s['index']},{s['r']},{s['s']},{s['nextX']},{s['nextY']})" for s in pth)
    out("COIN_ID", coin["coinId"])
    out("VALUE", coin["value"])
    out("EXPIRY", coin["expiry"])
    out("K0X", coin["k0x"])
    out("K0Y", coin["k0y"])
    out("DEPOSITOR", coin["depositor"])
    out("CHAIN_ID", coin["chainId"])
    out("ESCROW", coin["escrow"])
    out("DEPTH", len(pth))
    out("PAYOUT", red["payout"])
    out("AMOUNT", red["amount"])
    out("TIP_DIGEST", red["digest"])
    out("TIP_INDEX", red["index"])
    out("ARG_HEADER", hdr)
    out("ARG_PATH", f"[{spends}]")
    out("ARG_REDEMPTION", f"({outs(red)},{red['index']},{red['payout']},{red['r']},{red['s']})")


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("mint", "redeem"):
        sys.exit(__doc__)
    if sys.argv[1] == "mint":
        mint(sys.argv[2])
    else:
        dep = sys.argv[sys.argv.index("--depositor") + 1] if "--depositor" in sys.argv else None
        redeem(sys.argv[2], dep)
