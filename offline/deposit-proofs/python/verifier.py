#!/usr/bin/env python3
"""Prowl v3 deposit-proof verifier (offline reference).

    verify_deposit_proof(cache, proof, address, storage_key, expected_value=None)

`cache`  : the recipient's sync-committee cache (see cache_format in RESULTS.md), produced
           online by `builder.py cache` and trusted because the phone built it itself.
`proof`  : a DepositProof JSON (builder.py proof). Untrusted.
Checks, in order (any failure raises dp_core.ProofError):
  1. committee stepping: each LightClientUpdate in proof["updates"] is signed by a committee
     we already know (>= MIN_PARTICIPANTS), its finalized header is proven by finality_branch,
     and its next_sync_committee is proven against the attested state root -> learn period+1;
  2. the finality update: sync aggregate (>= MIN_PARTICIPANTS) by the committee of
     period(signature_slot), BLS FastAggregateVerify over the Gloas-domain signing root of the
     attested header; finality_branch (gindex 735) proves the finalized header;
     execution_branch (gindex 2856) proves execution_block_hash against finalized body_root;
  3. execution: keccak256(header RLP) == execution_block_hash; read stateRoot/number/timestamp;
  4. account proof (keccak(address) path) against stateRoot -> storageRoot;
  5. storage proof (keccak(storage_key) path) against storageRoot -> 32-byte value (0 if absent).
"""
import json
import sys
import time

from py_ecc.bls import G2ProofOfPossession as _bls

import config as C
from dp_core import (ProofError, require, hx, hx32, to_hex, u64, keccak256, header_root,
                     sync_committee_root, is_valid_normalized_merkle_branch, bits_set,
                     sync_committee_signing_root, rlp_decode, be_int, mpt_get,
                     account_from_leaf, storage_value_from_leaf, ZERO32)


# ----------------------------------------------------------------------------- committees
class Committees:
    """Known sync committees by period, plus pubkey bytes. Starts from the trusted cache."""

    def __init__(self, cache: dict):
        require(cache.get("version") == "prawl-lc-cache-v1", "unknown cache version")
        require(cache.get("network") == C.NETWORK, "cache is for another network")
        require(hx32(cache["genesis_validators_root"]) == C.GENESIS_VALIDATORS_ROOT, "cache genesis_validators_root mismatch")
        self.by_period = {}
        for c in cache["committees"]:
            pks = [hx(p) for p in c["pubkeys"]]
            agg = hx(c["aggregate_pubkey"])
            require(len(pks) == C.SYNC_COMMITTEE_SIZE and all(len(p) == 48 for p in pks), "bad cached committee")
            self.by_period[u64(c["period"])] = (pks, agg)

    def get(self, period: int):
        require(period in self.by_period,
                "no sync committee known for period %d (known: %s); proof must carry LightClientUpdates"
                % (period, sorted(self.by_period)))
        return self.by_period[period]


def _check_gloas_slot(slot: int, what: str):
    # This verifier implements Gloas light-client data only (all Sepolia data since epoch 353024).
    require(C.epoch_at_slot(slot) >= C.GLOAS_FORK_EPOCH, "%s slot %d is pre-Gloas; unsupported" % (what, slot))
    require(C.epoch_at_slot(slot) < C.NEXT_UNKNOWN_FORK_EPOCH, "%s slot %d is past a fork this verifier does not know" % (what, slot))


def verify_lc_header(h: dict, what: str) -> bytes:
    """is_valid_light_client_header for Gloas. Returns execution_block_hash."""
    beacon = h["beacon"]
    _check_gloas_slot(u64(beacon["slot"]), what)
    ebh = hx32(h["execution_block_hash"])
    branch = [hx32(x) for x in h["execution_branch"]]
    require(is_valid_normalized_merkle_branch(ebh, branch, C.EXECUTION_BLOCK_HASH_GINDEX_GLOAS, hx32(beacon["body_root"])),
            "%s execution_branch does not prove execution_block_hash against body_root (gindex %d)"
            % (what, C.EXECUTION_BLOCK_HASH_GINDEX_GLOAS))
    return ebh


def verify_sync_aggregate(committees: Committees, attested_beacon: dict, sync_aggregate: dict, signature_slot: int,
                          min_participants: int, timings=None):
    period = C.period_at_slot(signature_slot)
    pks, _agg = committees.get(period)
    bits = bits_set(hx(sync_aggregate["sync_committee_bits"]), C.SYNC_COMMITTEE_SIZE)
    n = sum(bits)
    require(n >= min_participants, "sync aggregate has %d participants, need >= %d" % (n, min_participants))
    signing_root = sync_committee_signing_root(attested_beacon, signature_slot)
    participants = [pk for bit, pk in zip(bits, pks) if bit]
    sig = hx(sync_aggregate["sync_committee_signature"])
    require(len(sig) == 96, "signature must be 96 bytes")
    t0 = time.perf_counter()
    ok = _bls.FastAggregateVerify(participants, signing_root, sig)
    if timings is not None:
        timings.append(("bls_fast_aggregate_verify[%d]" % n, time.perf_counter() - t0))
    require(ok, "BLS FastAggregateVerify failed (period %d, %d participants)" % (period, n))
    return n


def verify_finality(committees: Committees, u: dict, min_participants: int, timings=None):
    """Common checks of LightClientUpdate / LightClientFinalityUpdate (finality part)."""
    att = u["attested_header"]["beacon"]
    fin = u["finalized_header"]["beacon"]
    sig_slot = u64(u["signature_slot"])
    att_slot, fin_slot = u64(att["slot"]), u64(fin["slot"])
    require(sig_slot > att_slot >= fin_slot, "slot order must be signature > attested >= finalized")
    verify_lc_header(u["attested_header"], "attested")
    ebh = verify_lc_header(u["finalized_header"], "finalized")
    branch = [hx32(x) for x in u["finality_branch"]]
    require(fin_slot != 0, "genesis finalized header not accepted")
    require(is_valid_normalized_merkle_branch(header_root(fin), branch, C.FINALIZED_ROOT_GINDEX_GLOAS, hx32(att["state_root"])),
            "finality_branch does not prove finalized header in attested state (gindex %d)" % C.FINALIZED_ROOT_GINDEX_GLOAS)
    n = verify_sync_aggregate(committees, att, u["sync_aggregate"], sig_slot, min_participants, timings)
    return ebh, n


def apply_update(committees: Committees, u: dict, min_participants: int, timings=None) -> int:
    """Verify a LightClientUpdate and learn the committee of period(attested)+1. Returns that period.
    Policy (stricter than the spec's store logic, and what /updates serves in practice):
    attested, finalized and signature slots are in the same period A; the committee of A is known."""
    att_slot = u64(u["attested_header"]["beacon"]["slot"])
    fin_slot = u64(u["finalized_header"]["beacon"]["slot"])
    a = C.period_at_slot(att_slot)
    require(C.period_at_slot(fin_slot) == a and C.period_at_slot(u64(u["signature_slot"])) == a,
            "update must have attested, finalized and signature slots in one period")
    verify_finality(committees, u, min_participants, timings)
    nsc = u["next_sync_committee"]
    pks = [hx(p) for p in nsc["pubkeys"]]
    agg = hx(nsc["aggregate_pubkey"])
    require(len(pks) == C.SYNC_COMMITTEE_SIZE and all(len(p) == 48 for p in pks) and len(agg) == 48, "bad next_sync_committee")
    branch = [hx32(x) for x in u["next_sync_committee_branch"]]
    require(is_valid_normalized_merkle_branch(sync_committee_root(pks, agg), branch, C.NEXT_SYNC_COMMITTEE_GINDEX_GLOAS,
                                              hx32(u["attested_header"]["beacon"]["state_root"])),
            "next_sync_committee_branch invalid (gindex %d)" % C.NEXT_SYNC_COMMITTEE_GINDEX_GLOAS)
    if a + 1 in committees.by_period:
        require(committees.by_period[a + 1][0] == pks, "update contradicts known committee for period %d" % (a + 1))
    committees.by_period[a + 1] = (pks, agg)
    return a + 1


# ----------------------------------------------------------------------------- execution
def verify_execution_header(block_hash: bytes, header_rlp: bytes) -> dict:
    require(keccak256(header_rlp) == block_hash, "keccak256(execution header RLP) != execution_block_hash")
    fields = rlp_decode(header_rlp)
    # Positions 3 (stateRoot), 8 (number), 11 (timestamp) are fixed since Frontier; later forks append fields.
    require(isinstance(fields, list) and len(fields) >= 15, "execution header is not an RLP list of >= 15 fields")
    state_root = fields[3]
    require(isinstance(state_root, bytes) and len(state_root) == 32, "bad stateRoot")
    return {"state_root": state_root, "number": be_int(fields[8]), "timestamp": be_int(fields[11]), "n_fields": len(fields)}


def verify_account(state_root: bytes, address: bytes, proof_hex) -> dict:
    require(len(address) == 20, "address must be 20 bytes")
    leaf = mpt_get(state_root, keccak256(address), [hx(n) for n in proof_hex])
    require(leaf is not None, "account proof shows the contract does not exist")
    return account_from_leaf(leaf)


def verify_storage(storage_root: bytes, storage_key: bytes, proof_hex) -> bytes:
    require(len(storage_key) == 32, "storage key must be 32 bytes")
    leaf = mpt_get(storage_root, keccak256(storage_key), [hx(n) for n in proof_hex])
    return ZERO32 if leaf is None else storage_value_from_leaf(leaf)


# ----------------------------------------------------------------------------- top level
def verify_deposit_proof(cache: dict, proof: dict, address: bytes, storage_key: bytes, expected_value=None,
                         min_participants: int = C.MIN_PARTICIPANTS, now: int = None, timings=None) -> dict:
    t_start = time.perf_counter()
    require(proof.get("version") == "prawl-deposit-proof-v1", "unknown proof version")
    require(proof.get("network") == C.NETWORK, "proof is for another network")
    committees = Committees(cache)
    learned = [apply_update(committees, u, min_participants, timings) for u in proof.get("updates", [])]

    fu = proof["finality_update"]
    if now is not None:  # optional clock check (phone clock); signature slot may not be in the future
        require(C.slot_start_time(u64(fu["signature_slot"])) <= now + 2 * C.SECONDS_PER_SLOT, "signature_slot is in the future")
    ebh, participants = verify_finality(committees, fu, min_participants, timings)

    ex = verify_execution_header(ebh, hx(proof["execution"]["header_rlp"]))
    require(hx(proof["account"]["address"]) == address, "proof is for a different address")
    acct = verify_account(ex["state_root"], address, proof["account"]["proof"])
    require(hx32(proof["storage"]["key"]) == storage_key, "proof is for a different storage key")
    value = verify_storage(acct["storage_root"], storage_key, proof["storage"]["proof"])
    if expected_value is not None:
        require(value == expected_value, "storage value %s != expected %s" % (to_hex(value), to_hex(expected_value)))
    fin = fu["finalized_header"]["beacon"]
    res = {
        "ok": True,
        "finalized_slot": u64(fin["slot"]),
        "finalized_root": to_hex(header_root(fin)),
        "signature_slot": u64(fu["signature_slot"]),
        "signature_period": C.period_at_slot(u64(fu["signature_slot"])),
        "participants": participants,
        "learned_periods": learned,
        "execution_block_hash": to_hex(ebh),
        "block_number": ex["number"],
        "block_timestamp": ex["timestamp"],
        "state_root": to_hex(ex["state_root"]),
        "storage_root": to_hex(acct["storage_root"]),
        "value": to_hex(value),
        "verify_seconds": round(time.perf_counter() - t_start, 3),
    }
    return res


def main(argv):
    import argparse
    from dp_core import mapping_slot
    ap = argparse.ArgumentParser(description="Verify a Prowl v3 DepositProof offline.")
    ap.add_argument("--cache", required=True)
    ap.add_argument("--proof", required=True)
    ap.add_argument("--address", help="defaults to the address in the proof (then it is NOT an independent check)")
    ap.add_argument("--key", help="32-byte storage key; or use --coin-id")
    ap.add_argument("--coin-id", help="escrow v3: key = keccak256(abi.encode(coinId, uint256(0)))")
    ap.add_argument("--expect", help="expected 32-byte value")
    ap.add_argument("--min-participants", type=int, default=C.MIN_PARTICIPANTS)
    a = ap.parse_args(argv)
    cache = json.load(open(a.cache))
    proof = json.load(open(a.proof))
    address = hx(a.address or proof["account"]["address"])
    if a.coin_id:
        key = mapping_slot(hx32(a.coin_id), 0)
    else:
        key = hx32(a.key or proof["storage"]["key"])
    exp = hx32(a.expect) if a.expect else None
    timings = []
    try:
        res = verify_deposit_proof(cache, proof, address, key, exp, a.min_participants, now=int(time.time()), timings=timings)
    except ProofError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1
    res["timings"] = {k: round(v, 3) for k, v in timings}
    print(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
