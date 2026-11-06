//! RSASSA-PKCS1-v1_5 / SHA-256 verification under the pinned Google RSA-4096 root (e = 65537).
use bignum::{params::BigNumParams, RuntimeBigNum};
use crate::root::{ROOT_MODULUS, ROOT_REDC};

type RsaN = RuntimeBigNum<35, 4096>;

pub fn verify_root_pkcs1_sha256(sig: [u8; 512], digest: [u8; 32]) {
    let params = BigNumParams::new(false, ROOT_MODULUS, ROOT_REDC);
    let s = RsaN::from_be_bytes(params, sig);
    s.validate_in_field();
    let mut acc = s;
    for _ in 0..16 {
        acc = acc * acc;
    }
    acc = acc * s;
    let em = acc.to_be_bytes();
    let prefix: [u8; 19] = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
    assert(em[0] == 0, "rsa: EM[0]");
    assert(em[1] == 1, "rsa: EM[1]");
    for i in 2..460 {
        assert(em[i] == 0xff, "rsa: PS");
    }
    assert(em[460] == 0, "rsa: separator");
    for i in 0..19 {
        assert(em[461 + i] == prefix[i], "rsa: DigestInfo");
    }
    for i in 0..32 {
        assert(em[480 + i] == digest[i], "rsa: digest");
    }
}
