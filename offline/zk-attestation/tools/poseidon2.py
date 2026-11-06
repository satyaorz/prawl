#!/usr/bin/env python3
"""Poseidon2 (BN254, t=4, d=5, 8 full + 56 partial rounds) as in barretenberg, and the fixed-length sponge hash
used by circuits/prawl_attest/src/hash.nr (== Noir stdlib / bb.js poseidon2Hash). Pure Python, for building
revocation/ban trees and test inputs off-circuit."""
import json, os
P = 21888242871839275222246405745257275088548364400416034343698204186575808495617  # BN254 scalar field
_C = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "poseidon2_bn254_t4.json")))
DIAG = [int(x, 16) for x in _C["diag_minus_one"]]
RC = [[int(x, 16) for x in r] for r in _C["round_constants"]]


def _ext(s):
    a, b, c, d = s
    t0 = a + b; t1 = c + d; t2 = 2 * b + t1; t3 = 2 * d + t0
    t4 = 4 * t1 + t3; t5 = 4 * t0 + t2; t6 = t3 + t5; t7 = t2 + t4
    return [t6 % P, t5 % P, t7 % P, t4 % P]


def _int(s):
    sm = sum(s) % P
    return [(s[i] * DIAG[i] + sm) % P for i in range(4)]


def permute(s):
    s = _ext([x % P for x in s])
    for i in range(4):
        s = [pow((s[j] + RC[i][j]) % P, 5, P) for j in range(4)]
        s = _ext(s)
    for i in range(4, 60):
        s[0] = pow((s[0] + RC[i][0]) % P, 5, P)
        s = _int(s)
    for i in range(60, 64):
        s = [pow((s[j] + RC[i][j]) % P, 5, P) for j in range(4)]
        s = _ext(s)
    return s


def hash_(inputs):
    n = len(inputs)
    state = [0, 0, 0, (n << 64) % P]
    cache = []
    for x in inputs:
        if len(cache) == 3:
            for j in range(3):
                state[j] = (state[j] + cache[j]) % P
            state = permute(state)
            cache = [x % P]
        else:
            cache.append(x % P)
    for j, c in enumerate(cache):
        state[j] = (state[j] + c) % P
    return permute(state)[0]


if __name__ == "__main__":
    # must equal circuits/prawl_attest tag::print_test_vectors
    for v in ([1, 2], [1, 2, 3], [1, 2, 3, 4, 5]):
        print(hex(hash_(v)))
    t = [int(x, 16) for x in _C["test_out"]]
    assert permute([int(x, 16) for x in _C["test_in"]]) == t, "permutation test vector mismatch"
    print("barretenberg permutation test vector: OK")
