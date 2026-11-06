"""Offline primitives for Prawl v3 deposit proofs: SSZ (SHA-256), RLP, Merkle-Patricia
trie proofs (keccak256), and the sync-committee signing root. No network access here.

The Java port (java/DepositProof.java) mirrors these functions one to one.
"""
import hashlib

from Crypto.Hash import keccak as _keccak

import config as C


class ProofError(Exception):
    """Raised for any failed check. The message says which check failed."""


def require(cond, msg):
    if not cond:
        raise ProofError(msg)


# ----------------------------------------------------------------------------- hashing
def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def keccak256(b: bytes) -> bytes:
    h = _keccak.new(digest_bits=256)
    h.update(b)
    return h.digest()


def hx(s: str) -> bytes:
    """Strict 0x-hex decoder."""
    require(isinstance(s, str) and s[:2] in ("0x", "0X"), "expected 0x-hex string, got %r" % (s,))
    body = s[2:]
    require(len(body) % 2 == 0, "odd-length hex")
    return bytes.fromhex(body)


def hx32(s: str) -> bytes:
    b = hx(s)
    require(len(b) == 32, "expected 32 bytes, got %d" % len(b))
    return b


def to_hex(b: bytes) -> str:
    return "0x" + b.hex()


def u64(x) -> int:
    """Strict uint64: a JSON integer, or a string of ASCII decimal digits (beacon API style).
    Rejects what Python's int() would also accept ("1_0", " 7", "+3", "٣") so Python and Java agree."""
    if isinstance(x, bool):
        raise ProofError("expected uint64, got bool")
    if isinstance(x, int):
        v = x
    else:
        require(isinstance(x, str) and 0 < len(x) <= 20 and all("0" <= c <= "9" for c in x), "expected decimal uint64, got %r" % (x,))
        v = int(x)
    require(0 <= v < 2**64, "uint64 out of range")
    return v


# ----------------------------------------------------------------------------- SSZ
ZERO32 = b"\x00" * 32


def uint64_leaf(n: int) -> bytes:
    require(0 <= n < 2**64, "uint64 out of range")
    return n.to_bytes(8, "little") + b"\x00" * 24


def merkleize(chunks, limit=None):
    """Binary Merkle root of 32-byte chunks, padded with zero chunks to a power of two."""
    n = len(chunks) if limit is None else limit
    width = 1
    while width < n:
        width *= 2
    layer = list(chunks) + [ZERO32] * (width - len(chunks))
    while len(layer) > 1:
        layer = [sha256(layer[i] + layer[i + 1]) for i in range(0, len(layer), 2)]
    return layer[0]


def header_root(h: dict) -> bytes:
    """hash_tree_root(BeaconBlockHeader); unchanged (plain Container) in Gloas."""
    return merkleize([
        uint64_leaf(u64(h["slot"])),
        uint64_leaf(u64(h["proposer_index"])),
        hx32(h["parent_root"]),
        hx32(h["state_root"]),
        hx32(h["body_root"]),
    ])


def pubkey_root(pk: bytes) -> bytes:
    require(len(pk) == 48, "BLS pubkey must be 48 bytes")
    return sha256(pk[:32] + pk[32:] + b"\x00" * 16)


def sync_committee_root(pubkeys, aggregate_pubkey: bytes) -> bytes:
    """hash_tree_root(SyncCommittee{pubkeys: Vector[BLSPubkey, 512], aggregate_pubkey})."""
    require(len(pubkeys) == C.SYNC_COMMITTEE_SIZE, "sync committee must have 512 pubkeys")
    return sha256(merkleize([pubkey_root(p) for p in pubkeys]) + pubkey_root(aggregate_pubkey))


def floorlog2(x: int) -> int:
    return x.bit_length() - 1


def is_valid_normalized_merkle_branch(leaf: bytes, branch, gindex: int, root: bytes) -> bool:
    """consensus-specs altair/light-client/sync-protocol.md is_valid_normalized_merkle_branch."""
    depth = floorlog2(gindex)
    index = gindex % (1 << depth)  # get_subtree_index
    num_extra = len(branch) - depth
    if num_extra < 0:
        return False
    for i in range(num_extra):
        if branch[i] != ZERO32:
            return False
    value = leaf
    for i, node in enumerate(branch[num_extra:]):
        if (index >> i) & 1:
            value = sha256(node + value)
        else:
            value = sha256(value + node)
    return value == root


def compute_domain(domain_type: bytes, fork_version: bytes, genesis_validators_root: bytes) -> bytes:
    fork_data_root = sha256(fork_version + b"\x00" * 28 + genesis_validators_root)
    return domain_type + fork_data_root[:28]


def compute_signing_root(object_root: bytes, domain: bytes) -> bytes:
    return sha256(object_root + domain)


def sync_committee_signing_root(attested_beacon_header: dict, signature_slot: int) -> bytes:
    """Signing root for a sync aggregate included at `signature_slot`.
    Fork version is that of epoch(max(signature_slot, 1) - 1), as in validate_light_client_update."""
    fork_version = C.fork_version_at_epoch(C.epoch_at_slot(max(signature_slot, 1) - 1))
    domain = compute_domain(C.DOMAIN_SYNC_COMMITTEE, fork_version, C.GENESIS_VALIDATORS_ROOT)
    return compute_signing_root(header_root(attested_beacon_header), domain)


def bits_set(bitvector: bytes, n: int):
    require(len(bitvector) * 8 == n, "bitvector length")
    return [(bitvector[i // 8] >> (i % 8)) & 1 for i in range(n)]


# ----------------------------------------------------------------------------- RLP
def rlp_decode(data: bytes):
    """Decode one RLP item that must span all of `data`. bytes -> bytes, lists -> list.
    Rejects non-canonical encodings (they would let two encodings share one meaning)."""
    item, end = _rlp_item(data, 0)
    require(end == len(data), "trailing bytes after RLP item")
    return item


def _rlp_len(data, pos, nlen):
    require(pos + nlen <= len(data), "RLP length overrun")
    lb = data[pos:pos + nlen]
    require(lb[0] != 0, "RLP length has leading zero")
    n = int.from_bytes(lb, "big")
    require(n > 55, "RLP long form used for short length")
    return n


def _rlp_item(data, pos):
    require(pos < len(data), "RLP truncated")
    b0 = data[pos]
    if b0 < 0x80:
        return data[pos:pos + 1], pos + 1
    if b0 < 0xB8:
        n = b0 - 0x80
        s, e = pos + 1, pos + 1 + n
        require(e <= len(data), "RLP string overrun")
        require(not (n == 1 and data[s] < 0x80), "RLP single byte not canonical")
        return data[s:e], e
    if b0 < 0xC0:
        nlen = b0 - 0xB7
        n = _rlp_len(data, pos + 1, nlen)
        s = pos + 1 + nlen
        require(s + n <= len(data), "RLP string overrun")
        return data[s:s + n], s + n
    if b0 < 0xF8:
        n = b0 - 0xC0
        s, e = pos + 1, pos + 1 + n
    else:
        nlen = b0 - 0xF7
        n = _rlp_len(data, pos + 1, nlen)
        s = pos + 1 + nlen
        e = s + n
    require(e <= len(data), "RLP list overrun")
    out, p = [], s
    while p < e:
        it, p = _rlp_item(data, p)
        out.append(it)
    require(p == e, "RLP list length mismatch")
    return out, e


def rlp_encode(x) -> bytes:
    if isinstance(x, (bytes, bytearray)):
        x = bytes(x)
        if len(x) == 1 and x[0] < 0x80:
            return x
        return _rlp_prefix(len(x), 0x80) + x
    if isinstance(x, list):
        body = b"".join(rlp_encode(i) for i in x)
        return _rlp_prefix(len(body), 0xC0) + body
    raise TypeError(type(x))


def _rlp_prefix(n, off):
    if n <= 55:
        return bytes([off + n])
    lb = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([off + 55 + len(lb)]) + lb


def be_int(b: bytes) -> int:
    require(len(b) == 0 or b[0] != 0, "RLP integer has leading zero")
    return int.from_bytes(b, "big")


# ----------------------------------------------------------------------------- MPT
EMPTY_TRIE_ROOT = keccak256(rlp_encode(b""))  # 0x56e81f17...


def _nibbles(b: bytes):
    out = []
    for x in b:
        out += [x >> 4, x & 15]
    return out


def _hp_decode(path: bytes):
    require(len(path) >= 1, "empty hex-prefix path")
    flag = path[0] >> 4
    require(flag <= 3, "bad hex-prefix flag")
    is_leaf = flag >= 2
    nib = _nibbles(path)
    if flag & 1:
        nib = nib[1:]          # odd: first nibble is payload
    else:
        require(path[0] & 15 == 0, "hex-prefix padding nibble not zero")
        nib = nib[2:]
    return is_leaf, nib


def mpt_get(root: bytes, key: bytes, proof):
    """Verify an eth_getProof-style proof for `key` (already the 32-byte trie key, i.e. the
    keccak of address/slot) against `root`. Returns the leaf value bytes, or None when the
    proof shows the key is absent. Raises ProofError for any invalid proof.
    Every proof node must be used, in order (no padding nodes)."""
    require(len(root) == 32, "trie root must be 32 bytes")
    path = _nibbles(key)
    if root == EMPTY_TRIE_ROOT:
        require(all(n == b"\x80" for n in proof), "non-empty proof for empty trie")
        return None
    i = 0          # nibble position
    idx = 0        # next proof node
    ref = root     # bytes (32-byte hash) or a decoded inline node (list)
    while True:
        if isinstance(ref, list):
            node = ref
        else:
            require(len(ref) == 32, "child reference is neither a hash nor an inline node")
            require(idx < len(proof), "proof too short")
            raw = proof[idx]
            idx += 1
            require(keccak256(raw) == ref, "proof node %d hash mismatch" % (idx - 1))
            node = rlp_decode(raw)
            require(isinstance(node, list), "trie node is not an RLP list")
        if len(node) == 17:
            require(i < len(path), "key exhausted at branch (value-in-branch unsupported for 32-byte keys)")
            child = node[path[i]]
            i += 1
            if child == b"":
                require(idx == len(proof), "extra proof nodes after absence point")
                return None
            ref = child
        elif len(node) == 2:
            require(isinstance(node[0], bytes), "bad node path")
            is_leaf, npath = _hp_decode(node[0])
            if is_leaf:
                require(idx == len(proof), "extra proof nodes after leaf")
                if path[i:] == npath:
                    require(isinstance(node[1], bytes) and len(node[1]) > 0, "empty leaf value")
                    return node[1]
                return None  # a different key's leaf sits where ours would be: absence
            if path[i:i + len(npath)] != npath:
                require(idx == len(proof), "extra proof nodes after absence point")
                return None  # extension diverges: absence
            require(len(npath) > 0, "empty extension")
            i += len(npath)
            ref = node[1]
        else:
            raise ProofError("trie node has %d items" % len(node))


def account_from_leaf(leaf: bytes):
    acct = rlp_decode(leaf)
    require(isinstance(acct, list) and len(acct) == 4, "account must be [nonce, balance, storageRoot, codeHash]")
    nonce, balance, storage_root, code_hash = acct
    require(len(storage_root) == 32 and len(code_hash) == 32, "bad account roots")
    return {"nonce": be_int(nonce), "balance": be_int(balance), "storage_root": storage_root, "code_hash": code_hash}


def storage_value_from_leaf(leaf: bytes) -> bytes:
    v = rlp_decode(leaf)
    require(isinstance(v, bytes) and 0 < len(v) <= 32 and v[0] != 0, "storage leaf must be a canonical non-zero integer")
    return v.rjust(32, b"\x00")


def mapping_slot(key32: bytes, slot: int) -> bytes:
    """Storage key of mapping entry `key32` for a mapping at `slot`: keccak256(abi.encode(key, slot))."""
    require(len(key32) == 32, "mapping key must be 32 bytes (left-pad addresses)")
    return keccak256(key32 + slot.to_bytes(32, "big"))
