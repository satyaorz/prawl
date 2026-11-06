#!/usr/bin/env python3
"""Simulate a website handoff payload against the real escrow exactly as the website would (eth_call).
  handoff_sim.py <payload.json | handoff.py output> [--rpc URL] [--from 0x..]
"""
import json, subprocess, sys
REDEEM = ("redeem((bytes32,uint256,uint64,uint256,uint256,address),"
          "((uint256,bytes32)[],uint256,bytes32,bytes32,bytes32,bytes32)[],"
          "((uint256,bytes32)[],uint256,address,bytes32,bytes32))(bool)")
DEPOSIT = "deposit(bytes32,uint64,uint256,uint256)"
def outs(o): return "[" + ",".join(f"({x['value']},{x['keyHash']})" for x in o) + "]"
def main():
    j = json.load(open(sys.argv[1])); p = j.get("payload", j)
    rpc = sys.argv[sys.argv.index("--rpc") + 1] if "--rpc" in sys.argv else "https://ethereum-sepolia-rpc.publicnode.com"
    frm = sys.argv[sys.argv.index("--from") + 1] if "--from" in sys.argv else "0x03a62B04aBe69f382bd7582f492be735B1dDb47B"
    if p["t"] == "redeem":
        h = p["header"]
        H = f"({h['coinId']},{h['value']},{h['expiry']},{h['k0x']},{h['k0y']},{h['depositor']})"
        S = "[" + ",".join(f"({outs(s['outputs'])},{s['index']},{s['r']},{s['s']},{s['nextX']},{s['nextY']})" for s in p["path"]) + "]"
        r = p["redemption"]; R = f"({outs(r['outputs'])},{r['index']},{r['payout']},{r['r']},{r['s']})"
        cmd = ["cast", "call", "--from", frm, p["escrow"], REDEEM, H, S, R, "--rpc-url", rpc]
    else:
        cmd = ["cast", "call", "--from", p["depositor"], "--value", p["value"], p["escrow"], DEPOSIT,
               p["coinId"], str(p["expiry"]), p["k0x"], p["k0y"], "--rpc-url", rpc]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    print("SIMULATION", "OK:" if res.returncode == 0 else "REVERT:", (res.stdout or res.stderr).strip()[:400])
    sys.exit(res.returncode)
if __name__ == "__main__": main()
