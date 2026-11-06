//! Fixed-length Poseidon2 sponge (t=4, rate 3), identical to the Noir stdlib / bb.js `poseidon2Hash`
//! (iv = len * 2^64 in the capacity element). Re-implemented because the stdlib sponge is pub(crate).
//! Python twin: tools/poseidon2.py (checked against this code by circuits/prawl_attest tests).
use std::hash::poseidon2_permutation;

pub fn poseidon2_hash<let N: u32>(input: [Field; N]) -> Field {
    let mut state: [Field; 4] = [0, 0, 0, (N as Field) * 18446744073709551616];
    let mut cache: [Field; 3] = [0; 3];
    let mut cache_size: u32 = 0;
    for i in 0..N {
        if cache_size == 3 {
            for j in 0..3 {
                state[j] += cache[j];
            }
            state = poseidon2_permutation(state);
            cache = [input[i], 0, 0];
            cache_size = 1;
        } else {
            cache[cache_size] = input[i];
            cache_size += 1;
        }
    }
    for j in 0..3 {
        if j < cache_size {
            state[j] += cache[j];
        }
    }
    state = poseidon2_permutation(state);
    state[0]
}
