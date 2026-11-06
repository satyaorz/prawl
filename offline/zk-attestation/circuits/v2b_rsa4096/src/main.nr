//! Benchmark-only primitive for design B: RSASSA-PKCS1-v1_5 / SHA-256 verification under the pinned Google
//! RSA-4096 root (e = 65537) with noir bignum (RuntimeBigNum, modulus = pinned public constant).
//! s^65537 mod N = 16 squarings + 1 multiplication; then compare with the EMSA-PKCS1-v1_5 encoding of `digest`.
//! `digest` is an input here; in a full chain proof it would be the in-circuit SHA-256 of the intermediate's TBS.
mod root;
use bignum::{params::BigNumParams, RuntimeBigNum};

type RsaN = RuntimeBigNum<35, 4096>;

fn main(sig: [u8; 512], digest: [u8; 32]) {
    let params = BigNumParams::new(false, root::ROOT_MODULUS, root::ROOT_REDC);
    let s = RsaN::from_be_bytes(params, sig);
    s.validate_in_field();
    let mut acc = s;
    for _ in 0..16 {
        acc = acc * acc;
    }
    acc = acc * s;
    let em = acc.to_be_bytes();
    // EM = 00 01 FF..FF(458) 00 || DigestInfo(SHA-256) || digest
    let prefix: [u8; 19] = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
    assert(em[0] == 0);
    assert(em[1] == 1);
    for i in 2..460 {
        assert(em[i] == 0xff);
    }
    assert(em[460] == 0);
    for i in 0..19 {
        assert(em[461 + i] == prefix[i]);
    }
    for i in 0..32 {
        assert(em[480 + i] == digest[i]);
    }
}
