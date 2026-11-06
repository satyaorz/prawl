//! Circuit v2_full_chain -- DESIGN B: the whole Samsung-style factory chain verified in-circuit.
//!     leaf <- P-256 attestation key A <- P-384 intermediate <- Google RSA-4096 root (PINNED constant in root.nr)
//! Measurement circuit for the design decision (RESULTS.md "v2"): same public-input / output shape as v1_ca3 and
//! v2_factory; anchor = [3, 0, 0, 0] (kind 3 = chain verified to the pinned Google root, no allow-list).
//! Private: leaf TBS+sig, AK-certificate TBS + P-384 signature, intermediate TBS + RSA signature, gap paths, blinders.
//! Public inputs: anchor[4], rev_root, ban_root, t_from, t_until, min_patch.  Outputs: K (4), C_A (2), C_r (2).
mod root;
mod rsa;
mod p384;
mod int_cert;
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
global CERT_N: u32 = 448; // 7 SHA-256 blocks: real AK TBS 393 B, intermediate TBS 390 B
global REV_DEPTH: u32 = 11;
global BAN_DEPTH: u32 = 11;
global KIND_FULL_CHAIN: Field = 3;

fn main(
    leaf_tbs: [u8; LEAF_N],
    leaf_len: u32,
    leaf_sig: [u8; 64],
    ak_tbs: [u8; CERT_N],
    ak_len: u32,
    ak_sig_r: [u8; 48],
    ak_sig_s: [u8; 48],
    int_tbs: [u8; CERT_N],
    int_len: u32,
    int_sig: [u8; 512],
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
    assert(anchor[0] == KIND_FULL_CHAIN, "anchor kind != full chain");
    assert((anchor[1] == 0) & (anchor[2] == 0) & (anchor[3] == 0), "anchor padding != 0");

    // 1. intermediate <- pinned Google RSA-4096 root
    let hi = prawl_attest::sha::sha256_padded(int_tbs, int_len);
    rsa::verify_root_pkcs1_sha256(int_sig, hi);
    let ic = int_cert::walk_int(int_tbs, int_len);

    // 2. AK certificate <- intermediate (P-384, ecdsa-with-SHA256)
    let ha = prawl_attest::sha::sha256_padded(ak_tbs, ak_len);
    p384::verify(ic.qx, ic.qy, ak_sig_r, ak_sig_s, ha);
    let ac = walk_cert_prefix(ak_tbs, ak_len, true);

    // 3. validity: intersection of the two certificates covers [t_from, t_until]
    assert(ac.not_before <= t_from, "AK cert not yet valid");
    assert(ic.not_before <= t_from, "intermediate not yet valid");
    assert(t_from <= t_until, "empty window");
    assert(t_until <= ac.not_after, "AK cert expires before t_until");
    assert(t_until <= ic.not_after, "intermediate expires before t_until");

    // 4. leaf <- A, leaf policy
    let hl = prawl_attest::sha::sha256_padded(leaf_tbs, leaf_len);
    assert(std::ecdsa_secp256r1::verify_signature(ac.x, ac.y, leaf_sig, hl), "leaf not signed by A");
    let l = walk_leaf(leaf_tbs, leaf_len, PRAWL_PKG, PRAWL_APP_DIGEST, min_patch);

    // 5. revocation (AK + intermediate serials) and ban list
    assert_not_member(ac.serial, rev_lo, rev_hi, rev_index, rev_path, rev_root);
    assert_not_member(ic.serial, irev_lo, irev_hi, irev_index, irev_path, rev_root);
    let (axh, axl) = limbs(ac.x);
    let (ayh, ayl) = limbs(ac.y);
    let h_a = h_att(axh, axl, ayh, ayl);
    assert_not_member(h_a, ban_lo, ban_hi, ban_index, ban_path, ban_root);

    // 6. double-spend tag commitments (identical to v1/v2)
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
