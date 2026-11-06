#!/usr/bin/env python3
"""Independent derivation of the Gloas light-client generalized indices from the container field lists
(consensus-specs gloas/beacon-chain.md @204fb4a1) and the merkleization rules of
EIP-7495 (ProgressiveContainer: root = hash(merkleize_progressive(field_roots), pack_bits(active_fields)))
and EIP-7916 (merkleize_progressive: hash(first num_leaves chunks as a binary tree, rest), num_leaves 1,4,16,...).
Prints the derived values next to the spec constants used by the verifiers (config.py / DepositProof.java).
"""
import config as C

GLOAS_BEACON_BLOCK_BODY = [  # ProgressiveContainer, active_fields width 13
    "randao_reveal", "eth1_data", "graffiti", "proposer_slashings", "attester_slashings", "attestations", "deposits",
    "voluntary_exits", "sync_aggregate", "bls_to_execution_changes", "signed_execution_payload_bid",
    "payload_attestations", "parent_execution_requests"]
SIGNED_EXECUTION_PAYLOAD_BID = ["message", "signature"]  # plain Container
EXECUTION_PAYLOAD_BID = [  # ProgressiveContainer, width 12
    "parent_block_hash", "parent_block_root", "block_hash", "prev_randao", "fee_recipient", "gas_limit", "builder_index",
    "slot", "value", "execution_payment", "blob_kzg_commitments", "execution_requests_root"]
GLOAS_BEACON_STATE = [  # ProgressiveContainer, width 46
    "genesis_time", "genesis_validators_root", "slot", "fork", "latest_block_header", "block_roots", "state_roots",
    "historical_roots", "eth1_data", "eth1_data_votes", "eth1_deposit_index", "validators", "balances", "randao_mixes",
    "slashings", "previous_epoch_participation", "current_epoch_participation", "justification_bits",
    "previous_justified_checkpoint", "current_justified_checkpoint", "finalized_checkpoint", "inactivity_scores",
    "current_sync_committee", "next_sync_committee", "latest_block_hash", "next_withdrawal_index",
    "next_withdrawal_validator_index", "historical_summaries", "deposit_requests_start_index",
    "deposit_balance_to_consume", "exit_balance_to_consume", "earliest_exit_epoch", "consolidation_balance_to_consume",
    "earliest_consolidation_epoch", "pending_deposits", "pending_partial_withdrawals", "pending_consolidations",
    "proposer_lookahead", "builders", "next_withdrawal_builder_index", "execution_payload_availability",
    "builder_pending_payments", "builder_pending_withdrawals", "latest_execution_payload_bid",
    "payload_expected_withdrawals", "ptc_window"]
CHECKPOINT = ["epoch", "root"]  # plain Container


def progressive_field_gindex(i: int) -> int:
    """Gindex of field i relative to a ProgressiveContainer root (all fields active)."""
    g = 2              # left child of the root = merkleize_progressive(...); right child (3) = active_fields
    start, size = 0, 1
    while True:
        if i < start + size:
            g = 2 * g  # left: binary subtree of `size` leaves
            depth = size.bit_length() - 1
            return g * (1 << depth) + (i - start)
        g = 2 * g + 1  # right: the rest
        start += size
        size *= 4


def container_field_gindex(fields, name):
    n = len(fields)
    width = 1
    while width < n:
        width *= 2
    return width + fields.index(name)


def concat(*gs):
    out = 1
    for g in gs:
        d = g.bit_length() - 1
        out = out * (1 << d) + (g - (1 << d))
    return out


def main():
    derived = {
        "EXECUTION_BLOCK_HASH_GINDEX_GLOAS": concat(
            progressive_field_gindex(GLOAS_BEACON_BLOCK_BODY.index("signed_execution_payload_bid")),
            container_field_gindex(SIGNED_EXECUTION_PAYLOAD_BID, "message"),
            progressive_field_gindex(EXECUTION_PAYLOAD_BID.index("parent_block_hash"))),
        "FINALIZED_ROOT_GINDEX_GLOAS": concat(progressive_field_gindex(GLOAS_BEACON_STATE.index("finalized_checkpoint")),
                                              container_field_gindex(CHECKPOINT, "root")),
        "CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS": progressive_field_gindex(GLOAS_BEACON_STATE.index("current_sync_committee")),
        "NEXT_SYNC_COMMITTEE_GINDEX_GLOAS": progressive_field_gindex(GLOAS_BEACON_STATE.index("next_sync_committee")),
    }
    ok = True
    for k, v in derived.items():
        spec = getattr(C, k)
        ok &= v == spec
        print("%-38s derived %5d  spec %5d  depth %2d  %s" % (k, v, spec, v.bit_length() - 1, "OK" if v == spec else "MISMATCH"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
