//! Circuit v0 -- leaf link.
//! Private: leaf TBS (+ its length), leaf signature (r||s, low-s), the RKP attestation public key A.
//! Proves: SHA-256(leaf TBS) is signed by A (ECDSA P-256), and the TBS -- walked structurally from byte 0 --
//! is an Android attestation leaf with hardware-enforced usageCountLimit=1, rootOfTrust locked+Verified,
//! origin GENERATED, EC P-256 SIGN key, attestation/KeyMint level TEE|StrongBox (equal), app
//! "xyz.prawl.otktest" signed by the pinned certificate digest.
//! Public output: the coin key K = (x_hi, x_lo, y_hi, y_lo). A is NOT output.
//! NOTE: v0 alone does not stop a prover from inventing A (see RESULTS.md); v1 binds A to Google's Droid CA3.
use prawl_attest::{leaf::walk_leaf, PRAWL_APP_DIGEST, PRAWL_PKG, util::limbs};

global LEAF_N: u32 = 704; // 11 SHA-256 blocks of buffer; real leaves are 590-598 B

fn main(
    leaf_tbs: [u8; LEAF_N],
    leaf_len: u32,
    leaf_sig: [u8; 64],
    att_x: [u8; 32],
    att_y: [u8; 32],
) -> pub [Field; 4] {
    let h = prawl_attest::sha::sha256_padded(leaf_tbs, leaf_len);
    assert(std::ecdsa_secp256r1::verify_signature(att_x, att_y, leaf_sig, h), "leaf signature invalid");
    let l = walk_leaf(leaf_tbs, leaf_len, PRAWL_PKG, PRAWL_APP_DIGEST, 0);
    let (xh, xl) = limbs(l.x);
    let (yh, yl) = limbs(l.y);
    [xh, xl, yh, yl]
}
