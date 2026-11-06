//! Double-spend tag commitments (research note Q3, with the r-derivation change explained in RESULTS.md).
//!   h_A = Poseidon2(DS_HA, A.x_hi, A.x_lo, A.y_hi, A.y_lo)      identity of the RKP attestation key
//!   r   = Poseidon2(DS_R, leafSig.r_hi, leafSig.r_lo)           fixed per coin key, secret (leaf never leaves phone)
//!   C_A = h_A*G + rho_A*H,  C_r = r*G + rho_r*H                  Pedersen on Grumpkin (native to BN254 circuits)
//! Per payment (outside the SNARK): y = h_A + c*r mod q, plus a Schnorr proof that C_A + c*C_r - y*G is a multiple of H.
//! Two payments from one key give h_A = (c'y - cy')/(c' - c).
use crate::hash::poseidon2_hash;
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};

pub global DS_HA: Field = 0x707261776c2d6841; // "prawl-hA"
pub global DS_R: Field = 0x707261776c2d72; // "prawl-r"

pub fn generators() -> [EmbeddedCurvePoint; 2] {
    let h: [EmbeddedCurvePoint; 1] = std::hash::derive_generators("PRAWL_YTAG_H".as_bytes(), 0);
    [EmbeddedCurvePoint::generator(), h[0]]
}

pub fn commit(v: Field, rho: Field) -> EmbeddedCurvePoint {
    multi_scalar_mul(
        generators(),
        [EmbeddedCurveScalar::from_field(v), EmbeddedCurveScalar::from_field(rho)],
    )
}

pub fn h_att(ax_hi: Field, ax_lo: Field, ay_hi: Field, ay_lo: Field) -> Field {
    poseidon2_hash([DS_HA, ax_hi, ax_lo, ay_hi, ay_lo])
}

pub fn r_tag(sig_r_hi: Field, sig_r_lo: Field) -> Field {
    poseidon2_hash([DS_R, sig_r_hi, sig_r_lo])
}

#[test]
fn print_generators() {
    let g = generators();
    println(g[0].x);
    println(g[0].y);
    println(g[1].x);
    println(g[1].y);
}

#[test]
fn print_test_vectors() {
    // values checked against tools/poseidon2.py and tools/ytag.py
    println(poseidon2_hash([1, 2]));
    println(poseidon2_hash([1, 2, 3]));
    println(poseidon2_hash([1, 2, 3, 4, 5]));
    let c = commit(7, 11);
    println(c.x);
    println(c.y);
}
