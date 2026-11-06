//! ECDSA over P-384 with a SHA-256 digest (ecdsa-with-SHA256 under a P-384 key), noir_bigcurve/bignum.
//! Accepts only R.x == r exactly (R.x >= n has probability ~2^-190 for honest signatures).
use bignum::{BigNum, Secp384r1_Fq, Secp384r1_Fr};
use noir_bigcurve::{BigCurve, Secp384r1};
use noir_bigcurve::curves::secp384r1::Secp384r1Scalar;

pub fn verify(qx: [u8; 48], qy: [u8; 48], r: [u8; 48], s: [u8; 48], digest: [u8; 32]) {
    let mut e = [0 as u8; 48];
    for i in 0..32 {
        e[16 + i] = digest[i];
    }
    let q = Secp384r1::from_coordinates(Secp384r1_Fq::from_be_bytes(qx), Secp384r1_Fq::from_be_bytes(qy), false);
    let rr = Secp384r1_Fr::from_be_bytes(r);
    let ss = Secp384r1_Fr::from_be_bytes(s);
    let ee = Secp384r1_Fr::from_be_bytes(e);
    ss.assert_is_not_zero();
    rr.assert_is_not_zero();
    let u1 = ee / ss;
    let u2 = rr / ss;
    let p = Secp384r1::evaluate_linear_expression(
        [Secp384r1::one(), q],
        [Secp384r1Scalar::from_bignum(u1), Secp384r1Scalar::from_bignum(u2)],
        [],
    );
    assert(!p.is_infinity(), "P-384: R at infinity");
    assert(p.x().to_be_bytes() == r, "P-384 ECDSA: R.x != r");
}
