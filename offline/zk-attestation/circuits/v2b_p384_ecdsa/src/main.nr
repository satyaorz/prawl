//! Benchmark-only primitive for design B: ECDSA verification over P-384 (secp384r1) with noir_bigcurve/bignum.
//! Verifies (r, s) on e = SHA-256 digest (as a 256-bit integer; ecdsa-with-SHA256 under a P-384 key, as in the
//! Samsung factory chain: AK certificate signed by the P-384 intermediate) under public key Q.
//! Check R.x == r exactly (R.x mod n == r differs only when R.x >= n, probability ~2^-190 for honest keys).
use bignum::{BigNum, Secp384r1_Fq, Secp384r1_Fr};
use noir_bigcurve::{BigCurve, Secp384r1};
use noir_bigcurve::curves::secp384r1::Secp384r1Scalar;

fn main(qx: [u8; 48], qy: [u8; 48], r: [u8; 48], s: [u8; 48], e: [u8; 48]) {
    let q = Secp384r1::from_coordinates(Secp384r1_Fq::from_be_bytes(qx), Secp384r1_Fq::from_be_bytes(qy), false);
    let rr = Secp384r1_Fr::from_be_bytes(r);
    let ss = Secp384r1_Fr::from_be_bytes(s);
    let ee = Secp384r1_Fr::from_be_bytes(e);
    ss.assert_is_not_zero();
    rr.assert_is_not_zero();
    let u1 = ee / ss;
    let u2 = rr / ss;
    let g = Secp384r1::one();
    let p = Secp384r1::evaluate_linear_expression(
        [g, q],
        [Secp384r1Scalar::from_bignum(u1), Secp384r1Scalar::from_bignum(u2)],
        [],
    );
    assert(!p.is_infinity(), "R at infinity");
    assert(p.x().to_be_bytes() == r, "P-384 ECDSA: R.x != r");
}
