//! TBSCertificate prefix walk: header .. SubjectPublicKeyInfo. Mirrors tools/chains.py::walk_cert_prefix.
use crate::der::{eq_at, expect, utc_time};

// SEQUENCE{ SEQUENCE{ OID ecPublicKey, OID prime256v1 }, BIT STRING 00 04 ... } : uncompressed P-256 only
pub global SPKI_P256_PREFIX: [u8; 27] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
];

pub struct CertPrefix {
    pub serial: Field, // INTEGER content as an unsigned number (<= 20 bytes, so < 2^160)
    pub not_before: u64, // YYMMDDHHMMSS (only if parse_validity)
    pub not_after: u64,
    pub x: [u8; 32],
    pub y: [u8; 32],
    pub after_spki: u32,
}

/// Walk the TBS from byte 0 to the end of SubjectPublicKeyInfo.
/// `parse_validity`: require 2x UTCTime and decode it (the leaf's 1970..2048 validity is not used).
pub fn walk_cert_prefix<let N: u32>(b: [u8; N], n: u32, parse_validity: bool) -> CertPrefix {
    assert(n + 8 <= N, "TBS buffer too small for its length");
    let top = expect(b, 0, n, 0x30);
    assert(top.next == n, "TBS length != tbs_len");
    assert(eq_at(b, top.c, [0xa0, 0x03, 0x02, 0x01, 0x02]), "TBS: version != v3");
    let ser = expect(b, top.c + 5, n, 0x02);
    assert((ser.len >= 1) & (ser.len <= 20), "TBS: serial length");
    let mut serial: Field = 0;
    for i in 0..20 {
        if i < ser.len {
            serial = serial * 256 + (b[ser.c + i] as Field);
        }
    }
    let alg = expect(b, ser.next, n, 0x30);
    let iss = expect(b, alg.next, n, 0x30);
    let val = expect(b, iss.next, n, 0x30);
    let mut nb: u64 = 0;
    let mut na: u64 = 0;
    if parse_validity {
        assert(val.len == 30, "validity: not 2x UTCTime");
        assert(eq_at(b, val.c, [0x17, 0x0d]), "validity: notBefore not UTCTime");
        assert(eq_at(b, val.c + 15, [0x17, 0x0d]), "validity: notAfter not UTCTime");
        nb = utc_time(b, val.c + 2);
        na = utc_time(b, val.c + 17);
    }
    let sub = expect(b, val.next, n, 0x30);
    let sp = sub.next;
    assert(eq_at(b, sp, SPKI_P256_PREFIX), "SPKI is not an uncompressed P-256 key");
    let mut x = [0 as u8; 32];
    let mut y = [0 as u8; 32];
    for i in 0..32 {
        x[i] = b[sp + 27 + i];
        y[i] = b[sp + 59 + i];
    }
    let after_spki = sp + 91;
    assert(after_spki <= n, "SPKI past end");
    CertPrefix { serial, not_before: nb, not_after: na, x, y, after_spki }
}
