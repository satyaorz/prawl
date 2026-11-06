//! Circuit v1 -- leaf -> RKP attestation key -> Google Droid CA3.
//! Private: leaf TBS+sig, attestation-key certificate TBS+sig, revocation and ban-list gap paths, commitment blinders.
//! Public inputs: CA3 key (4 limbs), revocation root, ban root, validity window [t_from, t_until] (YYMMDDHHMMSS),
//!                min osPatchLevel (YYYYMM).
//! Public outputs: coin key K (4 limbs), C_A (x, y), C_r (x, y).
//! Proves, beyond v0:
//!   * A_cert TBS (walked from byte 0) is signed by the CA3 key, A := its SPKI, and the leaf is signed by A;
//!   * notBefore(A_cert) <= t_from <= t_until <= notAfter(A_cert);
//!   * serial(A_cert) is not in Google's revocation list (sorted gap-leaf Merkle tree, root public);
//!   * h_A = H(A) is not in the Prawl ban list (same structure);
//!   * C_A, C_r commit to h_A and r = H(leafSig.r) for the per-payment double-spend tag.
//! The verifier checks CA3 -> CA2 -> CA1 (Google root) in the clear, once per CA3.
use prawl_attest::{
    cert::walk_cert_prefix,
    leaf::walk_leaf,
    merkle::assert_not_member,
    PRAWL_APP_DIGEST,
    PRAWL_PKG,
    tag::{commit, h_att, r_tag},
    util::{from_limbs, limbs},
};

global LEAF_N: u32 = 704;
global ATT_N: u32 = 704;
global REV_DEPTH: u32 = 11; // 1,769 revoked serials (+ sentinels) -> 1,770 gaps <= 2^11
global BAN_DEPTH: u32 = 11;

fn main(
    leaf_tbs: [u8; LEAF_N],
    leaf_len: u32,
    leaf_sig: [u8; 64],
    att_tbs: [u8; ATT_N],
    att_len: u32,
    att_sig: [u8; 64],
    rev_lo: Field,
    rev_hi: Field,
    rev_index: Field,
    rev_path: [Field; REV_DEPTH],
    ban_lo: Field,
    ban_hi: Field,
    ban_index: Field,
    ban_path: [Field; BAN_DEPTH],
    rho_a: Field,
    rho_r: Field,
    ca3_key: pub [Field; 4],
    rev_root: pub Field,
    ban_root: pub Field,
    t_from: pub u64,
    t_until: pub u64,
    min_patch: pub u64,
) -> pub [Field; 8] {
    // 1. A_cert <- CA3
    let ca3_x = from_limbs(ca3_key[0], ca3_key[1]);
    let ca3_y = from_limbs(ca3_key[2], ca3_key[3]);
    let ha = prawl_attest::sha::sha256_padded(att_tbs, att_len);
    assert(std::ecdsa_secp256r1::verify_signature(ca3_x, ca3_y, att_sig, ha), "A_cert not signed by CA3");
    let ac = walk_cert_prefix(att_tbs, att_len, true);
    assert(ac.not_before <= t_from, "A_cert not yet valid at t_from");
    assert(t_from <= t_until, "empty window");
    assert(t_until <= ac.not_after, "A_cert expires before t_until");

    // 2. leaf <- A, leaf policy
    let hl = prawl_attest::sha::sha256_padded(leaf_tbs, leaf_len);
    assert(std::ecdsa_secp256r1::verify_signature(ac.x, ac.y, leaf_sig, hl), "leaf not signed by A");
    let l = walk_leaf(leaf_tbs, leaf_len, PRAWL_PKG, PRAWL_APP_DIGEST, min_patch);

    // 3. revocation (Google list, by A_cert serial) and Prawl ban list (by h_A)
    assert_not_member(ac.serial, rev_lo, rev_hi, rev_index, rev_path, rev_root);
    let (axh, axl) = limbs(ac.x);
    let (ayh, ayl) = limbs(ac.y);
    let h_a = h_att(axh, axl, ayh, ayl);
    assert_not_member(h_a, ban_lo, ban_hi, ban_index, ban_path, ban_root);

    // 4. double-spend tag commitments
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
