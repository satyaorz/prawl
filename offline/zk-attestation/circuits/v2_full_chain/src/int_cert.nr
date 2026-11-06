//! Walk of the P-384 intermediate certificate's TBS (Samsung/Google StrongBox factory chain) from byte 0 to its SPKI.
//! Same structure and guarantees as prawl_attest::cert::walk_cert_prefix, with a P-384 SPKI.
use prawl_attest::der::{eq_at, expect, utc_time};

// SEQUENCE{ SEQUENCE{ OID ecPublicKey, OID secp384r1 }, BIT STRING 00 04 ... } : uncompressed P-384 only (120 bytes total)
pub global SPKI_P384_PREFIX: [u8; 27] = [
    0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00,
    0x22, 0x03, 0x62, 0x00, 0x04, 0, 0, 0,
]; // only the first 24 bytes are compared

pub struct IntPrefix {
    pub serial: Field,
    pub not_before: u64,
    pub not_after: u64,
    pub qx: [u8; 48],
    pub qy: [u8; 48],
}

pub fn walk_int<let N: u32>(b: [u8; N], n: u32) -> IntPrefix {
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
    assert(val.len == 30, "validity: not 2x UTCTime");
    assert(eq_at(b, val.c, [0x17, 0x0d]), "validity: notBefore not UTCTime");
    assert(eq_at(b, val.c + 15, [0x17, 0x0d]), "validity: notAfter not UTCTime");
    let nb = utc_time(b, val.c + 2);
    let na = utc_time(b, val.c + 17);
    let sub = expect(b, val.next, n, 0x30);
    let sp = sub.next;
    let pre: [u8; 24] = [
        0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04,
        0x00, 0x22, 0x03, 0x62, 0x00, 0x04,
    ];
    assert(eq_at(b, sp, pre), "SPKI is not an uncompressed P-384 key");
    let mut qx = [0 as u8; 48];
    let mut qy = [0 as u8; 48];
    for i in 0..48 {
        qx[i] = b[sp + 24 + i];
        qy[i] = b[sp + 72 + i];
    }
    assert(sp + 120 <= n, "SPKI past end");
    IntPrefix { serial, not_before: nb, not_after: na, qx, qy }
}
