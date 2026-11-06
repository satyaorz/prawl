/// 32 big-endian bytes -> (hi, lo) 128-bit limbs. P-256 coordinates do not fit one BN254 field element.
pub fn limbs(b: [u8; 32]) -> (Field, Field) {
    let mut hi: Field = 0;
    let mut lo: Field = 0;
    for i in 0..16 {
        hi = hi * 256 + (b[i] as Field);
        lo = lo * 256 + (b[16 + i] as Field);
    }
    (hi, lo)
}

/// (hi, lo) 128-bit limbs -> 32 big-endian bytes. to_be_bytes::<16> range-checks each limb to < 2^128.
pub fn from_limbs(hi: Field, lo: Field) -> [u8; 32] {
    let h: [u8; 16] = hi.to_be_bytes();
    let l: [u8; 16] = lo.to_be_bytes();
    let mut out = [0 as u8; 32];
    for i in 0..16 {
        out[i] = h[i];
        out[16 + i] = l[i];
    }
    out
}
