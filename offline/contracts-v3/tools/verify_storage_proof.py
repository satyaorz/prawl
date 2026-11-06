#!/usr/bin/env python3
"""Verify an eth_getProof result for deposits[coinId] (storage slot 0 mapping) against a block's stateRoot.

This is NOT the deposit-proof component (no beacon/sync-committee part). It only checks, independently of
any node library, the execution-layer half the spec describes: account proof of the escrow against
state_root -> storageRoot, then storage proof of keccak256(abi.encode(coinId, uint256(0))) -> value, and that
value == keccak256(abi.encode(value, expiry, k0x, k0y, depositor)) recomputed from the coin header.

Usage: verify_storage_proof.py <proof.json> <stateRoot> <escrow> <coinId> <value> <expiry> <k0x> <k0y> <depositor>
Pure Python: Keccak-256 (original padding 0x01, not SHA3's 0x06), RLP, Merkle-Patricia proof walk.
"""
import json
import sys

# ------------------------------------------------------------------ keccak-256

_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
       0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
       0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
       0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _f(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    while len(msg) % rate:
        msg += b"\x00"
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        blk = msg[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            a[x][y] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        a = _f(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"

# ------------------------------------------------------------------ RLP


def rlp_decode(b: bytes):
    item, rest = _rlp(b)
    assert rest == b"", "trailing RLP bytes"
    return item


def _rlp(b):
    p = b[0]
    if p < 0x80:
        return b[:1], b[1:]
    if p < 0xB8:
        n = p - 0x80
        return b[1:1 + n], b[1 + n:]
    if p < 0xC0:
        ll = p - 0xB7
        n = int.from_bytes(b[1:1 + ll], "big")
        return b[1 + ll:1 + ll + n], b[1 + ll + n:]
    if p < 0xF8:
        n = p - 0xC0
        body, rest = b[1:1 + n], b[1 + n:]
    else:
        ll = p - 0xF7
        n = int.from_bytes(b[1:1 + ll], "big")
        body, rest = b[1 + ll:1 + ll + n], b[1 + ll + n:]
    items = []
    while body:
        it, body = _rlp(body)
        items.append(it)
    return items, rest

# ------------------------------------------------------------------ Merkle-Patricia proof


def nibbles(b: bytes):
    out = []
    for x in b:
        out += [x >> 4, x & 15]
    return out


def mpt_get(root: bytes, key: bytes, proof):
    """Walk proof nodes from root along keccak(key); returns the leaf value (bytes) or None (proven absent)."""
    path = nibbles(keccak256(key))
    want = root
    for i, node_hex in enumerate(proof):
        raw = bytes.fromhex(node_hex[2:])
        if len(raw) >= 32 or i == 0:
            assert keccak256(raw) == want, f"proof node {i} hash mismatch"
        else:
            assert raw == want, f"inline node {i} mismatch"
        node = rlp_decode(raw)
        if len(node) == 17:
            if not path:
                return node[16]
            nxt = node[path[0]]
            path = path[1:]
            if nxt == b"" or nxt == []:
                return None
            want = nxt if isinstance(nxt, bytes) else None
        else:
            enc = nibbles(node[0])
            flag = enc[0]
            seg = enc[2:] if flag in (0, 2) else enc[1:]
            if path[:len(seg)] != seg:
                return None
            path = path[len(seg):]
            if flag in (2, 3):  # leaf
                assert not path, "leaf before the end of the key"
                return node[1]
            want = node[1]
    raise AssertionError("proof ended early")


def main():
    if len(sys.argv) != 10:
        sys.exit(__doc__)
    proof = json.load(open(sys.argv[1]))
    state_root = bytes.fromhex(sys.argv[2][2:])
    escrow = bytes.fromhex(sys.argv[3][2:])
    coin = bytes.fromhex(sys.argv[4][2:])
    value, expiry = int(sys.argv[5]), int(sys.argv[6])
    k0x, k0y = int(sys.argv[7], 16), int(sys.argv[8], 16)
    depositor = bytes.fromhex(sys.argv[9][2:])

    acct = mpt_get(state_root, escrow, proof["accountProof"])
    assert acct is not None, "escrow account absent"
    nonce, balance, storage_root, code_hash = rlp_decode(acct)
    print(f"account proof OK: escrow {sys.argv[3]} balance {int.from_bytes(balance, 'big')} wei, "
          f"storageRoot 0x{storage_root.hex()}")
    assert storage_root.hex() == proof["storageHash"][2:].lower()

    slot = keccak256(coin + (0).to_bytes(32, "big"))  # keccak256(abi.encode(coinId, uint256(0)))
    sp = proof["storageProof"][0]
    assert int(sp["key"], 16) == int.from_bytes(slot, "big"), "proof is for a different storage key"
    raw = mpt_get(storage_root, slot, sp["proof"])
    assert raw is not None, "storage slot absent"
    stored = rlp_decode(raw).rjust(32, b"\x00")
    want = keccak256(value.to_bytes(32, "big") + expiry.to_bytes(32, "big") + k0x.to_bytes(32, "big")
                     + k0y.to_bytes(32, "big") + depositor.rjust(32, b"\x00"))
    print(f"storage proof OK: slot keccak256(coinId, 0) = 0x{slot.hex()} holds 0x{stored.hex()}")
    assert stored == want, "stored value != commitment recomputed from the coin header"
    print("commitment matches keccak256(abi.encode(value, expiry, k0x, k0y, depositor)) from the header: DEPOSIT PROVEN")


if __name__ == "__main__":
    main()
