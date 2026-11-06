#!/usr/bin/env python3
"""Prowl v3 deposit-proof builder (online). Talks to a beacon API (light-client routes) and an
execution JSON-RPC that serves eth_getProof at finalized depth.

  builder.py cache   --beacon URL [--beacon2 URL] [--checkpoint ROOT] --out cache.json
  builder.py updates --beacon URL --from-period P --to-period Q --out updates.json
  builder.py extend  --cache cache.json --updates updates.json --out cache2.json     (offline)
  builder.py proof   --beacon URL --rpc URL [--rpc2 URL] --address A (--key K | --coin-id C |
                     --mapping-key X --mapping-slot N) [--recipient-cache cache.json] --out proof.json

Every artefact is checked with the offline verifier before it is written.
"""
import argparse
import json
import sys
import time
import urllib.request

import config as C
from dp_core import (ProofError, require, hx, hx32, to_hex, keccak256, header_root, rlp_encode,
                     is_valid_normalized_merkle_branch, sync_committee_root, mapping_slot)
import verifier as V

UA = {"User-Agent": "prawl-deposit-proof-builder/1", "Accept": "application/json"}


def http_get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001  (retry on any transport error)
            last = e
            time.sleep(1 + 2 * i)
    raise RuntimeError("GET %s failed: %s" % (url, last))


def rpc(url, method, params, tries=4):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={**UA, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.loads(r.read())
            if "error" in resp:
                raise RuntimeError("%s: %s" % (method, resp["error"]))
            return resp["result"]
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1 + 2 * i)
    raise RuntimeError("RPC %s %s failed: %s" % (url, method, last))


def check_fork_config(beacon):
    """Fail if the node's view of Sepolia differs from our code constants."""
    spec = http_get(beacon + "/eth/v1/config/spec")["data"]
    gen = http_get(beacon + "/eth/v1/beacon/genesis")["data"]
    require(hx32(gen["genesis_validators_root"]) == C.GENESIS_VALIDATORS_ROOT, "genesis_validators_root differs")
    require(spec["DOMAIN_SYNC_COMMITTEE"] == "0x07000000", "DOMAIN_SYNC_COMMITTEE differs")
    names = ["ALTAIR", "BELLATRIX", "CAPELLA", "DENEB", "ELECTRA", "FULU", "GLOAS"]
    for (e, v), n in zip(C.FORK_SCHEDULE[1:], names):
        require(int(spec[n + "_FORK_EPOCH"]) == e and hx(spec[n + "_FORK_VERSION"]) == v, "%s fork differs" % n)
    # The fork after Gloas must still be unscheduled, or this verifier is outdated.
    require(int(spec.get("HEZE_FORK_EPOCH", 2**64 - 1)) == 2**64 - 1, "HEZE is scheduled: update config.py")
    return spec


# ----------------------------------------------------------------------------- cache
def committee_json(period, pks, agg):
    return {"period": period, "pubkeys": [to_hex(p) for p in pks], "aggregate_pubkey": to_hex(agg)}


def build_cache(beacon, checkpoint=None, beacon2=None, with_next=True):
    check_fork_config(beacon)
    if checkpoint is None:
        checkpoint = http_get(beacon + "/eth/v1/beacon/states/head/finality_checkpoints")["data"]["finalized"]["root"]
    boot = http_get(beacon + "/eth/v1/beacon/light_client/bootstrap/" + checkpoint)
    require(boot.get("version") == "gloas", "bootstrap version %r" % boot.get("version"))
    b = boot["data"]
    hdr = b["header"]["beacon"]
    require(to_hex(header_root(hdr)) == checkpoint.lower(), "bootstrap header root != trusted checkpoint root")
    V.verify_lc_header(b["header"], "bootstrap")
    csc = b["current_sync_committee"]
    pks = [hx(p) for p in csc["pubkeys"]]
    agg = hx(csc["aggregate_pubkey"])
    require(is_valid_normalized_merkle_branch(sync_committee_root(pks, agg), [hx32(x) for x in b["current_sync_committee_branch"]],
                                              C.CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS, hx32(hdr["state_root"])),
            "current_sync_committee_branch invalid (gindex %d)" % C.CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS)
    if beacon2:  # independent implementation must agree on the bootstrap (defence against one bad server)
        boot2 = http_get(beacon2 + "/eth/v1/beacon/light_client/bootstrap/" + checkpoint)["data"]
        require(boot2["current_sync_committee"] == csc and boot2["header"]["beacon"] == hdr, "beacon2 disagrees on bootstrap")
    period = C.period_at_slot(int(hdr["slot"]))
    cache = {
        "version": "prawl-lc-cache-v1",
        "network": C.NETWORK,
        "genesis_validators_root": to_hex(C.GENESIS_VALIDATORS_ROOT),
        "anchor": {"root": checkpoint.lower(), "header": hdr, "source": beacon, "cross_checked_with": beacon2,
                   "fetched_at": int(time.time())},
        "committees": [committee_json(period, pks, agg)],
    }
    if with_next:
        ups = http_get("%s/eth/v1/beacon/light_client/updates?start_period=%d&count=1" % (beacon, period))
        if ups:
            committees = V.Committees(cache)
            p1 = V.apply_update(committees, ups[0]["data"], C.MIN_PARTICIPANTS)
            pks1, agg1 = committees.by_period[p1]
            cache["committees"].append(committee_json(p1, pks1, agg1))
    return cache


def fetch_updates(beacon, start, count):
    ups = http_get("%s/eth/v1/beacon/light_client/updates?start_period=%d&count=%d" % (beacon, start, count))
    out = []
    for u in ups:
        require(u.get("version") == "gloas", "update version %r" % u.get("version"))
        out.append(u["data"])
    require(len(out) == count, "server returned %d of %d updates" % (len(out), count))
    return out


def extend_cache(cache, updates):
    """What a phone does when it receives LightClientUpdates (e.g. from a payer): verify, append."""
    committees = V.Committees(cache)
    for u in updates:
        p = V.apply_update(committees, u, C.MIN_PARTICIPANTS)
        if all(c["period"] != p for c in cache["committees"]):
            pks, agg = committees.by_period[p]
            cache["committees"].append(committee_json(p, pks, agg))
    return cache


# ----------------------------------------------------------------------------- execution header
INT_FIELDS = {"difficulty", "number", "gasLimit", "gasUsed", "timestamp", "baseFeePerGas", "blobGasUsed",
              "excessBlobGas", "slotNumber"}
BASE_ORDER = ["parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom",
              "difficulty", "number", "gasLimit", "gasUsed", "timestamp", "extraData", "mixHash", "nonce",
              "baseFeePerGas", "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot",
              "requestsHash"]


def _enc_field(k, v):
    if k in INT_FIELDS:
        n = int(v, 16)
        return n.to_bytes((n.bit_length() + 7) // 8, "big")
    return hx(v)


def header_rlp_from_json(blk):
    """Rebuild the RLP execution header from eth_getBlockByHash JSON and check it hashes to blk.hash.
    Amsterdam (Glamsterdam) adds blockAccessListHash and slotNumber after requestsHash; we try the
    trailing-field orders and accept only the one whose keccak matches (so nothing is assumed)."""
    want = hx32(blk["hash"])
    tails = [[], ["blockAccessListHash"], ["blockAccessListHash", "slotNumber"], ["slotNumber", "blockAccessListHash"]]
    for tail in tails:
        order = BASE_ORDER + tail
        if any(k not in blk for k in order):
            continue
        raw = rlp_encode([_enc_field(k, blk[k]) for k in order])
        if keccak256(raw) == want:
            return raw, order
    raise ProofError("could not rebuild an execution header RLP that hashes to %s" % blk["hash"])


# ----------------------------------------------------------------------------- proof
def build_proof(beacon, rpc_url, address, storage_key, rpc2=None, recipient_cache=None, finality_update=None):
    check_fork_config(beacon)
    if finality_update is None:
        fu_resp = http_get(beacon + "/eth/v1/beacon/light_client/finality_update")
        require(fu_resp.get("version") == "gloas", "finality update version %r" % fu_resp.get("version"))
        finality_update = fu_resp["data"]
    fu = finality_update
    ebh = to_hex(V.verify_lc_header(fu["finalized_header"], "finalized"))

    blk = rpc(rpc_url, "eth_getBlockByHash", [ebh, False])
    require(blk is not None, "execution RPC does not know block %s" % ebh)
    raw, order = header_rlp_from_json(blk)
    number = blk["number"]
    gp = rpc(rpc_url, "eth_getProof", [to_hex(address), [to_hex(storage_key)], number])
    if rpc2:  # second, independent EL client must return the same proof
        gp2 = rpc(rpc2, "eth_getProof", [to_hex(address), [to_hex(storage_key)], number])
        require(gp2["accountProof"] == gp["accountProof"] and gp2["storageProof"][0]["proof"] == gp["storageProof"][0]["proof"],
                "rpc2 returned a different proof")
    sp = gp["storageProof"][0]
    value = int(sp["value"], 16).to_bytes(32, "big")

    updates = []
    if recipient_cache is not None:
        known = max(int(c["period"]) for c in recipient_cache["committees"])
        sig_period = C.period_at_slot(int(fu["signature_slot"]))
        if sig_period > known:
            updates = fetch_updates(beacon, known, sig_period - known)

    proof = {
        "version": "prawl-deposit-proof-v1",
        "network": C.NETWORK,
        "updates": updates,
        "finality_update": {k: fu[k] for k in ("attested_header", "finalized_header", "finality_branch",
                                                "sync_aggregate", "signature_slot")},
        "execution": {"block_hash": ebh, "block_number": int(number, 16), "header_rlp": to_hex(raw),
                      "header_fields": order},
        "account": {"address": to_hex(address), "proof": gp["accountProof"]},
        "storage": {"key": to_hex(storage_key), "value": to_hex(value), "proof": sp["proof"]},
        "meta": {"beacon": beacon, "rpc": rpc_url, "rpc2": rpc2, "built_at": int(time.time()),
                 "rpc_claimed_storage_hash": gp["storageHash"], "rpc_claimed_balance": gp["balance"]},
    }
    return proof


def _storage_key(a):
    if a.key:
        return hx32(a.key)
    if a.coin_id:
        return mapping_slot(hx32(a.coin_id), 0)
    if a.mapping_key:
        return mapping_slot(hx(a.mapping_key).rjust(32, b"\x00"), a.mapping_slot)
    raise SystemExit("need --key, --coin-id or --mapping-key/--mapping-slot")


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cache")
    c.add_argument("--beacon", required=True)
    c.add_argument("--beacon2")
    c.add_argument("--checkpoint")
    c.add_argument("--no-next", action="store_true")
    c.add_argument("--out", required=True)
    u = sub.add_parser("updates")
    u.add_argument("--beacon", required=True)
    u.add_argument("--from-period", type=int, required=True)
    u.add_argument("--to-period", type=int, required=True, help="inclusive")
    u.add_argument("--out", required=True)
    x = sub.add_parser("extend", help="verify LightClientUpdates (file from `updates` or the API) and append learned committees")
    x.add_argument("--cache", required=True)
    x.add_argument("--updates", required=True)
    x.add_argument("--out", required=True)
    p = sub.add_parser("proof")
    p.add_argument("--beacon", required=True)
    p.add_argument("--rpc", required=True)
    p.add_argument("--rpc2")
    p.add_argument("--address", required=True)
    p.add_argument("--key")
    p.add_argument("--coin-id")
    p.add_argument("--mapping-key")
    p.add_argument("--mapping-slot", type=int, default=0)
    p.add_argument("--recipient-cache")
    p.add_argument("--save-finality-update")
    p.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    if a.cmd == "cache":
        cache = build_cache(a.beacon, a.checkpoint, a.beacon2, not a.no_next)
        json.dump(cache, open(a.out, "w"), indent=1)
        print("cache: anchor slot %s, periods %s -> %s" % (cache["anchor"]["header"]["slot"],
                                                         [c["period"] for c in cache["committees"]], a.out))
    elif a.cmd == "updates":
        ups = fetch_updates(a.beacon, a.from_period, a.to_period - a.from_period + 1)
        json.dump(ups, open(a.out, "w"), indent=1)
        print("%d updates -> %s" % (len(ups), a.out))
    elif a.cmd == "extend":
        cache = json.load(open(a.cache))
        ups = [u["data"] if "data" in u else u for u in json.load(open(a.updates))]
        before = [c["period"] for c in cache["committees"]]
        extend_cache(cache, ups)
        json.dump(cache, open(a.out, "w"), indent=1)
        print("cache periods %s -> %s -> %s" % (before, [c["period"] for c in cache["committees"]], a.out))
    else:
        rc = json.load(open(a.recipient_cache)) if a.recipient_cache else None
        addr = hx(a.address)
        key = _storage_key(a)
        proof = build_proof(a.beacon, a.rpc, addr, key, a.rpc2, rc)
        if rc is not None:  # self-check against the recipient cache before writing
            res = V.verify_deposit_proof(rc, proof, addr, key)
            print("self-check:", json.dumps(res))
        json.dump(proof, open(a.out, "w"), indent=1)
        print("proof: block %d value %s -> %s" % (proof["execution"]["block_number"], proof["storage"]["value"], a.out))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
