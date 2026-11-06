//! SHA-256 over a variable-length message held in a fixed buffer, with the FIPS 180-4 padding supplied by
//! the prover IN the buffer and checked with step vectors instead of being rebuilt byte by byte.
//!
//! Why: in UltraHonk one SHA-256 compression (blackbox) is ~4.0k gates, but the library `sha256_var` adds
//! ~13k gates of per-byte variable-length masking per call; this check costs ~4 gates/byte. Two library calls
//! pushed circuit v1 to 274,622 gates (dyadic 2^19); with this it is under 2^18.
//!
//! Layout the prover must supply (N % 64 == 0, len + 9 <= N, k = ceil((len + 9) / 64)):
//!   b[0..len]            message
//!   b[len]               0x80
//!   b[len+1 .. 64k-2]    0x00          (this also covers the 6 high zero bytes of the 64-bit length)
//!   b[64k-2 .. 64k]      BE16(8*len)   (len < 8192)
//!   b[64k ..]            0x00 (compressed, but the output is the state after block k)
//! The step vector s_i = [i >= len] is a prover hint, pinned by: boolean, monotone, sum(1 - s) = len.
//! Bytes 62,63 of the block that ends the padding are exempt from the zero rule and checked as BE16(8*len);
//! every other byte after the message must be 0x00 (0x80 at i == len), including blocks after the last one.
//! The DER walker reads up to b[len+4]; those bytes are padding past the end of the TBS, and any header that
//! used them would point past `len`, which the walker rejects.
use std::hash::sha256_compression;

global IV: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

unconstrained fn steps<let N: u32>(len: u32) -> [Field; N] {
    let mut s = [0; N];
    for i in 0..N {
        if i >= len {
            s[i] = 1;
        }
    }
    s
}

pub fn sha256_padded<let N: u32>(b: [u8; N], len: u32) -> [u8; 32] {
    let nb = N / 64;
    assert(nb * 64 == N, "sha: buffer not a multiple of 64");
    assert(len + 9 <= N, "sha: message too long for buffer");
    assert(len < 8192, "sha: length");
    let k = (len + 9 + 63) / 64; // number of padded blocks (division is constrained by the compiler)
    // f[j] = [block j is the last padded block]: its bytes 62,63 hold BE16(8*len) instead of zeros
    let mut f = [0 as Field; N / 64];
    for j in 0..N / 64 {
        f[j] = (j + 1 == k) as Field;
    }
    // Safety: s is fully constrained below (boolean, monotone, exactly `len` zeros => s_i = [i >= len]).
    let s = unsafe { steps::<N>(len) };
    let mut zs: Field = 0;
    let mut prev_s: Field = 0;
    for i in 0..N {
        let si = s[i];
        assert(si * (si - 1) == 0);
        if i > 0 {
            assert(prev_s * (1 - si) == 0); // monotone
        }
        zs += 1 - si;
        let ei = si - prev_s; // = [i == len]
        // after the message: 0x80 at i == len, zeros elsewhere, except the 2 length bytes of the last block
        let gate = if (i % 64) >= 62 { si - f[i / 64] } else { si };
        assert(gate * ((b[i] as Field) - 128 * ei) == 0, "sha: bad padding");
        prev_s = si;
    }
    assert(zs == len as Field, "sha: step");
    let lenpos = 64 * k - 2;
    assert((b[lenpos] as Field) * 256 + (b[lenpos + 1] as Field) == 8 * (len as Field), "sha: length field");

    let mut states: [[u32; 8]; N / 64 + 1] = [IV; N / 64 + 1];
    for j in 0..N / 64 {
        let mut w = [0 as u32; 16];
        for t in 0..16 {
            let o = 64 * j + 4 * t;
            w[t] = ((b[o] as u32) << 24)
                + ((b[o + 1] as u32) << 16)
                + ((b[o + 2] as u32) << 8)
                + (b[o + 3] as u32);
        }
        states[j + 1] = sha256_compression(w, states[j]);
    }
    let st = states[k];
    let mut out = [0 as u8; 32];
    for i in 0..8 {
        let bytes: [u8; 4] = (st[i] as Field).to_be_bytes();
        for j in 0..4 {
            out[4 * i + j] = bytes[j];
        }
    }
    out
}

/// Off-circuit helper for tests: pad a message into a buffer the way sha256_padded expects.
pub fn pad_message<let N: u32>(m: [u8; N], len: u32) -> [u8; N] {
    let mut b = [0 as u8; N];
    for i in 0..N {
        if i < len {
            b[i] = m[i];
        }
    }
    b[len] = 0x80;
    let k = (len + 9 + 63) / 64;
    let bits = 8 * len;
    b[64 * k - 2] = (bits >> 8) as u8;
    b[64 * k - 1] = (bits & 0xff) as u8;
    b
}

#[test]
fn sha_padded_matches_library() {
    let mut m = [0 as u8; 640];
    let mut x: u64 = 12345;
    for i in 0..640 {
        x = (x * 1103515245 + 12345) % 2147483648;
        m[i] = (x >> 16) as u8;
    }
    let lens: [u32; 10] = [0, 1, 55, 56, 63, 64, 119, 575, 590, 631];
    for t in 0..10 {
        let len = lens[t];
        let mut mm = [0 as u8; 640];
        for i in 0..640 {
            if i < len {
                mm[i] = m[i];
            }
        }
        let a = sha256::sha256_var(mm, len);
        let b = sha256_padded(pad_message(mm, len), len);
        assert(a == b);
    }
}

#[test(should_fail_with = "sha: bad padding")]
fn sha_padded_rejects_garbage_after_message() {
    let mut m = [0 as u8; 640];
    m[0] = 1;
    let mut b = pad_message(m, 100);
    b[101] = 7; // byte between 0x80 and the length field
    let _ = sha256_padded(b, 100);
}

#[test(should_fail_with = "sha: length field")]
fn sha_padded_rejects_wrong_length_field() {
    let m = [0 as u8; 640];
    let mut b = pad_message(m, 100);
    b[127] ^= 8;
    let _ = sha256_padded(b, 100);
}
