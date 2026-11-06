#!/usr/bin/env python3
"""Build the shared accept/reject test vectors (data/vectors/) from the real Sepolia artefacts in
data/. Python (test_verifier.py) and Java (DepositProofTest) both run every vector in
data/vectors/manifest.json and must agree.

Real-data vectors mutate a real proof. "Synthetic committee" vectors replace the period-1405
committee in the cache with 512 deterministic test keys and re-sign the *real* attested header,
so that wrong-domain and exact-threshold cases have otherwise valid signatures.
"""
import copy
import hashlib
import json
import os
import sys

from py_ecc.bls import G2ProofOfPossession as bls
from py_ecc.optimized_bls12_381 import curve_order

import config as C
from dp_core import (hx, hx32, to_hex, keccak256, rlp_decode, rlp_encode, mapping_slot, compute_domain,
                     compute_signing_root, header_root)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "vectors")
WETH = "0x7b79995e5f793a07bc00c21412e50ecae098e7f9"
HOLDER = "0x9487c16a8fc309050690fff1bc8479708f08b96e"
MAINNET_GVR = bytes.fromhex("4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95")
DOMAIN_BEACON_ATTESTER = bytes.fromhex("01000000")


def load(name):
    return json.load(open(os.path.join(DATA, name)))


def flip_hex(h, byte_index=-1):
    b = bytearray(hx(h))
    b[byte_index] ^= 0x01
    return to_hex(bytes(b))


def bits_hex(indices):
    b = bytearray(64)
    for i in indices:
        b[i // 8] |= 1 << (i % 8)
    return to_hex(bytes(b))


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []

    def save(fname, obj):
        json.dump(obj, open(os.path.join(OUT, fname), "w"), indent=1)
        return fname

    def vec(name, cache, proof, expect, why, key=None, address=WETH, expected_value=None, now=None, min_participants=None):
        manifest.append({"name": name, "cache": cache, "proof": proof, "address": address,
                         "key": key, "expected_value": expected_value, "now": now,
                         "min_participants": min_participants, "expect": expect, "why": why})

    cache_now = load("cache_now.json")
    cache_stale = load("cache_1403_stale.json")
    p_bal = load("proof_weth_balance.json")
    p_abs = load("proof_absent_coin.json")
    p_step = load("proof_weth_balance_stepped.json")
    coin = open(os.path.join(DATA, "absent_coin_id.txt")).read().strip()
    key_bal = to_hex(mapping_slot(hx(HOLDER).rjust(32, b"\x00"), 3))
    key_abs = to_hex(mapping_slot(hx32(coin), 0))
    assert key_bal == p_bal["storage"]["key"] and key_abs == p_abs["storage"]["key"]
    val_bal = p_bal["storage"]["value"]

    save("cache_now.json", cache_now)
    save("cache_1403_stale.json", cache_stale)
    save("proof_weth_balance.json", p_bal)
    save("proof_absent_coin.json", p_abs)
    save("proof_weth_balance_stepped.json", p_step)

    def m(fname, base, fn):
        p = copy.deepcopy(base)
        fn(p)
        return save(fname, p)

    # --- accept
    vec("ok_inclusion_weth_balance", "cache_now.json", "proof_weth_balance.json", "accept",
        "real WETH balanceOf slot, committee cached", key_bal, expected_value=val_bal)
    vec("ok_absent_escrow_style_key", "cache_now.json", "proof_absent_coin.json", "accept",
        "non-inclusion of keccak(coinId,0) -> value 0", key_abs, expected_value="0x" + "00" * 32)
    vec("ok_stepped_two_updates", "cache_1403_stale.json", "proof_weth_balance_stepped.json", "accept",
        "cache is 2 periods old; proof carries 2 updates", key_bal, expected_value=val_bal)

    # --- real escrow v3 (0x70b3...); no deposits yet on 2026-11-06, so its storage trie is empty
    if os.path.exists(os.path.join(DATA, "proof_escrow_v3_absent.json")):
        esc = load("proof_escrow_v3_absent.json")
        save("proof_escrow_v3_absent.json", esc)
        ecoin = open(os.path.join(DATA, "escrow_v3_absent_coin_id.txt")).read().strip()
        ekey = to_hex(mapping_slot(hx32(ecoin), 0))
        vec("ok_real_escrow_v3_absent_empty_trie", "cache_now.json", "proof_escrow_v3_absent.json", "accept",
            "real escrow v3 account proof; storageRoot = empty trie -> coin absent", ekey,
            address=esc["account"]["address"], expected_value="0x" + "00" * 32)
        vec("real_escrow_v3_absent_claimed_deposited", "cache_now.json", "proof_escrow_v3_absent.json", "reject",
            "a coin the escrow does not hold cannot be shown deposited", ekey,
            address=esc["account"]["address"], expected_value="0x" + "11" * 32)

    # --- real sync-committee boundary: finalized header in period P, signature in P+1 (Nimbus data)
    if os.path.exists(os.path.join(DATA, "proof_boundary_1406_cached.json")):
        bc = load("proof_boundary_1406_cached.json")
        save("proof_boundary_1406_cached.json", bc)
        save("proof_boundary_1406_stale.json", load("proof_boundary_1406_stale.json"))
        vec("ok_boundary_next_committee_from_cache", "cache_now.json", "proof_boundary_1406_cached.json", "accept",
            "signed in 1406 by the cached next committee (finalized header in 1405), no updates", key_bal,
            expected_value=bc["storage"]["value"])
        vec("ok_boundary_stale_cache_three_updates", "cache_1403_stale.json", "proof_boundary_1406_stale.json", "accept",
            "1403-only cache + updates 1403,1404,1405 -> 1406", key_bal, expected_value=bc["storage"]["value"])
        only_current = copy.deepcopy(cache_now)
        only_current["committees"] = [c for c in only_current["committees"] if c["period"] == 1405]
        save("cache_1405_only.json", only_current)
        vec("boundary_cache_without_next_committee", "cache_1405_only.json", "proof_boundary_1406_cached.json", "reject",
            "cache knows 1405 only; a 1406 signature needs the next committee or an update", key_bal)

    # --- reject: value / keys / address
    vec("wrong_expected_value", "cache_now.json", "proof_weth_balance.json", "reject", "value differs from expectation",
        key_bal, expected_value=to_hex((int(val_bal, 16) + 1).to_bytes(32, "big")))
    vec("wrong_storage_key", "cache_now.json", "proof_weth_balance.json", "reject", "verifier asks for another key", key_abs)
    vec("wrong_address", "cache_now.json", "proof_weth_balance.json", "reject", "verifier asks for another contract",
        key_bal, address="0x" + "11" * 20)
    vec("absent_proof_claimed_as_value", "cache_now.json", "proof_absent_coin.json", "reject",
        "absent key with nonzero expected value", key_abs, expected_value=val_bal)
    vec("relabelled_storage_key", "cache_now.json",
        m("t_relabel_key.json", p_bal, lambda p: p["storage"].__setitem__("key", key_abs)), "reject",
        "label says absent coin key, nodes are for the balance key: MPT walk must fail", key_abs,
        expected_value="0x" + "00" * 32)
    vec("relabelled_address", "cache_now.json",
        m("t_relabel_addr.json", p_bal, lambda p: p["account"].__setitem__("address", "0x" + "11" * 20)), "reject",
        "label says another contract, account nodes are WETH's: MPT walk must fail", key_bal, address="0x" + "11" * 20)

    # --- reject: beacon-side tampering
    vec("tampered_finalized_state_root", "cache_now.json",
        m("t_fin_state_root.json", p_bal, lambda p: p["finality_update"]["finalized_header"]["beacon"].__setitem__(
            "state_root", flip_hex(p["finality_update"]["finalized_header"]["beacon"]["state_root"]))),
        "reject", "finality branch no longer matches", key_bal)
    vec("tampered_finalized_slot", "cache_now.json",
        m("t_fin_slot.json", p_bal, lambda p: p["finality_update"]["finalized_header"]["beacon"].__setitem__(
            "slot", str(int(p["finality_update"]["finalized_header"]["beacon"]["slot"]) - 32))),
        "reject", "header root changes", key_bal)
    vec("tampered_attested_proposer", "cache_now.json",
        m("t_att_proposer.json", p_bal, lambda p: p["finality_update"]["attested_header"]["beacon"].__setitem__(
            "proposer_index", str(int(p["finality_update"]["attested_header"]["beacon"]["proposer_index"]) + 1))),
        "reject", "signing root changes -> BLS fails", key_bal)
    vec("tampered_execution_block_hash", "cache_now.json",
        m("t_exec_hash.json", p_bal, lambda p: p["finality_update"]["finalized_header"].__setitem__(
            "execution_block_hash", flip_hex(p["finality_update"]["finalized_header"]["execution_block_hash"]))),
        "reject", "execution branch fails", key_bal)
    vec("tampered_execution_branch", "cache_now.json",
        m("t_exec_branch.json", p_bal, lambda p: p["finality_update"]["finalized_header"]["execution_branch"].__setitem__(
            5, flip_hex(p["finality_update"]["finalized_header"]["execution_branch"][5]))),
        "reject", "execution branch node changed", key_bal)
    vec("tampered_finality_branch", "cache_now.json",
        m("t_fin_branch.json", p_bal, lambda p: p["finality_update"]["finality_branch"].__setitem__(
            3, flip_hex(p["finality_update"]["finality_branch"][3]))),
        "reject", "finality branch node changed", key_bal)

    def set_rlp_state_root(p):
        f = rlp_decode(hx(p["execution"]["header_rlp"]))
        f[3] = keccak256(b"forged state")
        p["execution"]["header_rlp"] = to_hex(rlp_encode(f))
    vec("tampered_header_rlp_state_root", "cache_now.json", m("t_header_rlp.json", p_bal, set_rlp_state_root),
        "reject", "keccak(header) != execution_block_hash", key_bal)

    # --- reject: sync aggregate
    def participants(p):
        b = hx(p["finality_update"]["sync_aggregate"]["sync_committee_bits"])
        return [i for i in range(512) if (b[i // 8] >> (i % 8)) & 1]
    on = participants(p_bal)
    vec("too_few_participants_341", "cache_now.json",
        m("t_bits_341.json", p_bal, lambda p: p["finality_update"]["sync_aggregate"].__setitem__("sync_committee_bits", bits_hex(on[:341]))),
        "reject", "341 < 342 participants (threshold check)", key_bal)
    vec("one_participant_bit_cleared", "cache_now.json",
        m("t_bits_minus1.json", p_bal, lambda p: p["finality_update"]["sync_aggregate"].__setitem__("sync_committee_bits", bits_hex(on[1:]))),
        "reject", "bits no longer match the aggregate -> BLS fails", key_bal)
    vec("signature_swapped", "cache_now.json",
        m("t_sig_swap.json", p_bal, lambda p: p["finality_update"]["sync_aggregate"].__setitem__(
            "sync_committee_signature", p_step["updates"][1]["sync_aggregate"]["sync_committee_signature"])),
        "reject", "valid signature of another header", key_bal)
    vec("signature_slot_next_period", "cache_now.json",
        m("t_sigslot_next.json", p_bal, lambda p: p["finality_update"].__setitem__(
            "signature_slot", str(int(p["finality_update"]["signature_slot"]) + 8192))),
        "reject", "selects the next period's committee -> BLS fails", key_bal)
    vec("signature_slot_in_future", "cache_now.json", "proof_weth_balance.json", "reject",
        "phone clock is before the signature slot", key_bal,
        now=C.slot_start_time(int(p_bal["finality_update"]["signature_slot"])) - 3600)

    # --- reject: committee stepping
    vec("stale_cache_without_updates", "cache_1403_stale.json", "proof_weth_balance.json", "reject",
        "no committee for the signature period", key_bal)
    vec("stale_cache_partial_updates", "cache_1403_stale.json",
        m("t_updates_partial.json", p_step, lambda p: p.__setitem__("updates", p["updates"][:1])),
        "reject", "only one of two steps", key_bal)
    vec("updates_out_of_order", "cache_1403_stale.json",
        m("t_updates_reversed.json", p_step, lambda p: p.__setitem__("updates", p["updates"][::-1])),
        "reject", "second update first: signed by an unknown committee", key_bal)

    def swap_next_pk(p):
        pk = p["updates"][0]["next_sync_committee"]["pubkeys"]
        pk[7], pk[8] = pk[8], pk[7]
    vec("update_next_committee_tampered", "cache_1403_stale.json", m("t_update_nsc.json", p_step, swap_next_pk),
        "reject", "next_sync_committee_branch fails", key_bal)
    vec("update_next_committee_branch_tampered", "cache_1403_stale.json",
        m("t_update_nsc_branch.json", p_step, lambda p: p["updates"][0]["next_sync_committee_branch"].__setitem__(
            0, flip_hex(p["updates"][0]["next_sync_committee_branch"][0]))),
        "reject", "branch node changed", key_bal)

    # --- reject: execution-side forgeries
    def forge_leaf(p):
        nodes = p["storage"]["proof"]
        leaf = rlp_decode(hx(nodes[-1]))
        leaf[1] = rlp_encode((int(val_bal, 16) * 10).to_bytes(9, "big").lstrip(b"\x00"))
        nodes[-1] = to_hex(rlp_encode(leaf))
        p["storage"]["value"] = to_hex((int(val_bal, 16) * 10).to_bytes(32, "big"))
    vec("forged_storage_leaf_value", "cache_now.json", m("t_storage_leaf.json", p_bal, forge_leaf), "reject",
        "leaf hash no longer matches parent", key_bal)

    def forge_selfmade_trie(p):  # a one-leaf trie holding our key -> its own root, unrelated to storageRoot
        k = keccak256(hx(key_bal))
        leaf = rlp_encode([bytes([0x20]) + k, rlp_encode(b"\x01" + b"\x00" * 20)])
        p["storage"]["proof"] = [to_hex(leaf)]
    vec("forged_storage_selfmade_trie", "cache_now.json", m("t_storage_selfmade.json", p_bal, forge_selfmade_trie),
        "reject", "root of forged trie != storageRoot", key_bal)
    vec("storage_proof_of_other_key", "cache_now.json",
        m("t_storage_other.json", p_bal, lambda p: p["storage"].__setitem__("proof", p_abs["storage"]["proof"])),
        "reject", "nodes for another path", key_bal)
    vec("storage_proof_truncated", "cache_now.json",
        m("t_storage_trunc.json", p_bal, lambda p: p["storage"]["proof"].pop()), "reject", "missing leaf", key_bal)
    vec("storage_proof_extra_node", "cache_now.json",
        m("t_storage_extra.json", p_bal, lambda p: p["storage"]["proof"].append(p["storage"]["proof"][-1])),
        "reject", "trailing node", key_bal)
    vec("absent_proof_truncated", "cache_now.json",
        m("t_absent_trunc.json", p_abs, lambda p: p["storage"]["proof"].pop()), "reject",
        "non-inclusion proof missing its last node", key_abs)

    def forge_account_storage_root(p):
        nodes = p["account"]["proof"]
        leaf = rlp_decode(hx(nodes[-1]))
        acct = rlp_decode(leaf[1])
        acct[2] = keccak256(b"forged storage root")
        leaf[1] = rlp_encode(acct)
        nodes[-1] = to_hex(rlp_encode(leaf))
    vec("forged_account_storage_root", "cache_now.json", m("t_account_leaf.json", p_bal, forge_account_storage_root),
        "reject", "account leaf hash mismatch", key_bal)
    vec("lax_integer_encoding", "cache_now.json",
        m("t_lax_int.json", p_bal, lambda p: p["finality_update"].__setitem__("signature_slot", "+" + p["finality_update"]["signature_slot"])),
        "reject", "'+<digits>' slot string must be refused by both parsers", key_bal)
    vec("bad_version", "cache_now.json", m("t_version.json", p_bal, lambda p: p.__setitem__("version", "prawl-deposit-proof-v0")),
        "reject", "unknown format", key_bal)

    # --- synthetic committee: exact-threshold and fork-domain checks with valid signatures
    sks = [int.from_bytes(hashlib.sha256(b"prawl-synthetic-sk-%d" % i).digest(), "big") % curve_order for i in range(512)]
    assert all(sks)
    print("deriving 512 synthetic pubkeys (py_ecc)...", flush=True)
    pks = [bls.SkToPk(sk) for sk in sks]
    agg_pk = bls._AggregatePKs(pks)
    att = p_bal["finality_update"]["attested_header"]["beacon"]
    sig_slot = int(p_bal["finality_update"]["signature_slot"])
    sp = C.period_at_slot(sig_slot)  # 1405 for the 2026-11-06 data set
    syn_cache = copy.deepcopy(cache_now)
    syn_cache["anchor"]["note"] = "TEST ONLY: period %d committee replaced by synthetic keys sha256('prawl-synthetic-sk-<i>')" % sp
    syn_cache["committees"] = [c for c in syn_cache["committees"] if c["period"] != sp] + [
        {"period": sp, "pubkeys": [to_hex(p) for p in pks], "aggregate_pubkey": to_hex(agg_pk)}]
    save("cache_synthetic.json", syn_cache)
    gloas_v = C.fork_version_at_epoch(C.epoch_at_slot(sig_slot - 1))

    def signed(fname, signers, version=gloas_v, gvr=C.GENESIS_VALIDATORS_ROOT, dtype=C.DOMAIN_SYNC_COMMITTEE):
        sr = compute_signing_root(header_root(att), compute_domain(dtype, version, gvr))
        sk = sum(sks[i] for i in signers) % curve_order
        sig = bls.Sign(sk, sr)
        def f(p):
            p["finality_update"]["sync_aggregate"] = {"sync_committee_bits": bits_hex(signers),
                                                      "sync_committee_signature": to_hex(sig)}
        return m(fname, p_bal, f)

    all512 = list(range(512))
    vec("synthetic_ok_512_gloas_domain", "cache_synthetic.json", signed("s_ok_512.json", all512), "accept",
        "512 test keys sign with DOMAIN_SYNC_COMMITTEE + Gloas 0x90000076 + Sepolia GVR", key_bal, expected_value=val_bal)
    vec("synthetic_ok_342_exact_threshold", "cache_synthetic.json", signed("s_ok_342.json", list(range(170, 512))), "accept",
        "exactly 342 participants", key_bal, expected_value=val_bal)
    vec("synthetic_341_valid_sig_below_threshold", "cache_synthetic.json", signed("s_341.json", list(range(171, 512))),
        "reject", "valid signature but 341 participants", key_bal)
    vec("synthetic_341_with_threshold_lowered", "cache_synthetic.json", "s_341.json", "accept",
        "same 341 vector accepted when min_participants=341 (shows the threshold is the only failing check)",
        key_bal, expected_value=val_bal, min_participants=341)
    vec("synthetic_wrong_fork_fulu", "cache_synthetic.json", signed("s_fulu.json", all512, version=bytes.fromhex("90000075")),
        "reject", "signed with Fulu fork version (previous fork)", key_bal)
    vec("synthetic_wrong_fork_electra", "cache_synthetic.json", signed("s_electra.json", all512, version=bytes.fromhex("90000074")),
        "reject", "signed with Electra fork version", key_bal)
    vec("synthetic_wrong_fork_genesis", "cache_synthetic.json", signed("s_genesis.json", all512, version=bytes.fromhex("90000069")),
        "reject", "signed with genesis fork version", key_bal)
    vec("synthetic_wrong_gvr_mainnet", "cache_synthetic.json", signed("s_gvr.json", all512, gvr=MAINNET_GVR),
        "reject", "signed with mainnet genesis_validators_root", key_bal)
    vec("synthetic_wrong_domain_type", "cache_synthetic.json", signed("s_dtype.json", all512, dtype=DOMAIN_BEACON_ATTESTER),
        "reject", "DOMAIN_BEACON_ATTESTER instead of DOMAIN_SYNC_COMMITTEE", key_bal)
    vec("synthetic_sig_on_real_cache", "cache_now.json", "s_ok_512.json", "reject",
        "synthetic signature checked against the real committee", key_bal)

    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    print("%d vectors -> %s" % (len(manifest), OUT))


if __name__ == "__main__":
    sys.exit(main())
