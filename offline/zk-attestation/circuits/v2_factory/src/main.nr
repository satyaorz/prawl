//! Circuit v2 -- leaf -> factory StrongBox attestation key A (member of a public allow-list Merkle tree).
//!
//! Design A (see RESULTS.md "v2"): the Samsung-style factory chain is
//!     leaf <- P-256 attestation key A <- P-384 intermediate <- Google RSA-4096 root,
//! and A and the intermediate are shared by a production batch. Only the first link (leaf <- A, P-256) is
//! verified in-circuit. The upper links (P-384, RSA-4096) are verified ONCE, in the clear, by whoever builds
//! the allow-list entry (tools/allowlist.py, or DeviceBondRegistry.cacheIssuer/registerAttestationKey on-chain).
//! The entry commits to everything the circuit needs from the vetted certificates:
//!     entry = Poseidon2(DS_ALLOW, serial_AK, serial_INT, A.x_hi, A.x_lo, A.y_hi, A.y_lo, notBefore, notAfter)
//! (notBefore/notAfter = intersection of the validity of the AK certificate and the intermediate, UTCTime ints).
//!
//! Private: leaf TBS+sig, A, the two serials and the validity window of the vetted chain, the allow-list path,
//!          revocation gap paths (AK serial, intermediate serial), ban gap path, commitment blinders.
//! Public inputs (SAME SHAPE AS v1_ca3: 4 + 1 + 1 + 3 = 9 fields):
//!   anchor[0..3] = [KIND_FACTORY = 2, allow_root, 0, 0]   (v1: the 4 limbs of the CA3 key)
//!   rev_root, ban_root, t_from, t_until, min_patch
//! Public outputs (same as v1): K (4 limbs), C_A (x, y), C_r (x, y).
//! Proves, beyond v0:
//!   * the entry for A is in the allow-list tree with root `allow_root`;
//!   * notBefore <= t_from <= t_until <= notAfter;
//!   * neither serial_AK nor serial_INT is in Google's revocation list (same tree as v1);
//!   * h_A = H(A) is not in the Prawl ban list (same tree/definition as v1);
//!   * C_A, C_r commit to h_A and r = H(leafSig.r) for the per-payment double-spend tag (same as v1).
use prawl_attest::{
    hash::poseidon2_hash,
    leaf::walk_leaf,
    merkle::{assert_not_member, merkle_root},
    PRAWL_APP_DIGEST,
    PRAWL_PKG,
    tag::{commit, h_att, r_tag},
    util::limbs,
};

global LEAF_N: u32 = 704;
global REV_DEPTH: u32 = 11;
global BAN_DEPTH: u32 = 11;
global ALLOW_DEPTH: u32 = 16; // 65,536 factory attestation keys
global KIND_FACTORY: Field = 2;
global DS_ALLOW: Field = 0x707261776c2d616c6c6f77; // "prawl-allow"

fn main(
    leaf_tbs: [u8; LEAF_N],
    leaf_len: u32,
    leaf_sig: [u8; 64],
    att_x: [u8; 32],
    att_y: [u8; 32],
    ak_serial: Field,
    int_serial: Field,
    ak_nb: u64,
    ak_na: u64,
    allow_index: Field,
    allow_path: [Field; ALLOW_DEPTH],
    rev_lo: Field,
    rev_hi: Field,
    rev_index: Field,
    rev_path: [Field; REV_DEPTH],
    irev_lo: Field,
    irev_hi: Field,
    irev_index: Field,
    irev_path: [Field; REV_DEPTH],
    ban_lo: Field,
    ban_hi: Field,
    ban_index: Field,
    ban_path: [Field; BAN_DEPTH],
    rho_a: Field,
    rho_r: Field,
    anchor: pub [Field; 4],
    rev_root: pub Field,
    ban_root: pub Field,
    t_from: pub u64,
    t_until: pub u64,
    min_patch: pub u64,
) -> pub [Field; 8] {
    // 0. circuit-kind tag: this circuit's anchor is [2, allow_root, 0, 0]
    assert(anchor[0] == KIND_FACTORY, "anchor kind != factory");
    assert((anchor[2] == 0) & (anchor[3] == 0), "anchor padding != 0");
    let allow_root = anchor[1];

    // 1. A is a vetted factory attestation key: its entry is in the allow-list
    let (axh, axl) = limbs(att_x);
    let (ayh, ayl) = limbs(att_y);
    let entry = poseidon2_hash([DS_ALLOW, ak_serial, int_serial, axh, axl, ayh, ayl, ak_nb as Field, ak_na as Field]);
    assert(merkle_root(entry, allow_index, allow_path) == allow_root, "attestation key not in allow-list");
    assert(ak_nb <= t_from, "chain not yet valid at t_from");
    assert(t_from <= t_until, "empty window");
    assert(t_until <= ak_na, "chain expires before t_until");

    // 2. leaf <- A (P-256 ECDSA), leaf policy
    let hl = prawl_attest::sha::sha256_padded(leaf_tbs, leaf_len);
    assert(std::ecdsa_secp256r1::verify_signature(att_x, att_y, leaf_sig, hl), "leaf not signed by A");
    let l = walk_leaf(leaf_tbs, leaf_len, PRAWL_PKG, PRAWL_APP_DIGEST, min_patch);

    // 3. revocation (Google list: AK serial AND intermediate serial) and Prawl ban list (by h_A)
    assert_not_member(ak_serial, rev_lo, rev_hi, rev_index, rev_path, rev_root);
    assert_not_member(int_serial, irev_lo, irev_hi, irev_index, irev_path, rev_root);
    let h_a = h_att(axh, axl, ayh, ayl);
    assert_not_member(h_a, ban_lo, ban_hi, ban_index, ban_path, ban_root);

    // 4. double-spend tag commitments (identical to v1)
    let mut sr = [0 as u8; 32];
    for i in 0..32 {
        sr[i] = leaf_sig[i];
    }
    let (srh, srl) = limbs(sr);
    let r = r_tag(srh, srl);
    let c_a = commit(h_a, rho_a);
    let c_r = commit(r, rho_r);

    let (xh, xl) = limbs(l.x);
    let (yh, yl) = limbs(l.y);
    [xh, xl, yh, yl, c_a.x, c_a.y, c_r.x, c_r.y]
}
