"""Sepolia consensus constants for the Prowl v3 deposit-proof verifier.

Every value here was read from a live Sepolia beacon node on 2026-11-06
(`/eth/v1/config/spec`, `/eth/v1/config/fork_schedule`, `/eth/v1/beacon/genesis`)
or quoted from consensus-specs master (v1.7.0-beta.4 era); see RESULTS.md for links.
They are code constants on purpose: the verifier must not take fork versions or
the genesis validators root from the (attacker-supplied) proof.
"""

NETWORK = "sepolia"

# /eth/v1/beacon/genesis
GENESIS_TIME = 1655733600
GENESIS_VALIDATORS_ROOT = bytes.fromhex("d8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078")

# /eth/v1/config/spec (PRESET_BASE mainnet)
SECONDS_PER_SLOT = 12
SLOTS_PER_EPOCH = 32
EPOCHS_PER_SYNC_COMMITTEE_PERIOD = 256
SYNC_COMMITTEE_SIZE = 512
DOMAIN_SYNC_COMMITTEE = bytes.fromhex("07000000")

# /eth/v1/config/fork_schedule  (epoch, current_version). HEZE_FORK_EPOCH is FAR_FUTURE today.
FORK_SCHEDULE = [
    (0, bytes.fromhex("90000069")),       # genesis (phase0)
    (50, bytes.fromhex("90000070")),      # altair
    (100, bytes.fromhex("90000071")),     # bellatrix
    (56832, bytes.fromhex("90000072")),   # capella
    (132608, bytes.fromhex("90000073")),  # deneb
    (222464, bytes.fromhex("90000074")),  # electra
    (272640, bytes.fromhex("90000075")),  # fulu
    (353024, bytes.fromhex("90000076")),  # gloas (EIP-7732 ePBS + EIP-7688 progressive containers)
]
GLOAS_FORK_EPOCH = 353024
# The next scheduled fork (HEZE) is FAR_FUTURE on 2026-11-06. When it gets an epoch the
# verifier must be updated (new fork version, possibly new gindices). We refuse to verify
# anything signed at or after this epoch, so an outdated verifier fails closed.
NEXT_UNKNOWN_FORK_EPOCH = 2**64 - 1

# consensus-specs/specs/gloas/light-client/sync-protocol.md "New constants".
# Re-derived by hand from the Gloas ProgressiveContainer layouts (gindex.py) and
# confirmed by verifying real Sepolia light-client data against them.
FINALIZED_ROOT_GINDEX_GLOAS = 735
CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS = 2945
NEXT_SYNC_COMMITTEE_GINDEX_GLOAS = 2946
EXECUTION_BLOCK_HASH_GINDEX_GLOAS = 2856

# Prowl policy: a sync aggregate must carry a 2/3 supermajority (spec's
# `sum * 3 >= SYNC_COMMITTEE_SIZE * 2`; with 512 members this is >= 342, which is also
# the smallest count strictly greater than 2/3). MIN_SYNC_COMMITTEE_PARTICIPANTS (=1) is
# far too weak for a payment check.
MIN_PARTICIPANTS = (2 * SYNC_COMMITTEE_SIZE + 2) // 3  # 342


def epoch_at_slot(slot: int) -> int:
    return slot // SLOTS_PER_EPOCH


def period_at_slot(slot: int) -> int:
    return slot // (SLOTS_PER_EPOCH * EPOCHS_PER_SYNC_COMMITTEE_PERIOD)


def fork_version_at_epoch(epoch: int) -> bytes:
    if epoch >= NEXT_UNKNOWN_FORK_EPOCH:
        raise ValueError("epoch %d is at/after an unknown future fork; update the verifier" % epoch)
    version = None
    for e, v in FORK_SCHEDULE:
        if epoch >= e:
            version = v
    return version


def slot_start_time(slot: int) -> int:
    return GENESIS_TIME + slot * SECONDS_PER_SLOT
