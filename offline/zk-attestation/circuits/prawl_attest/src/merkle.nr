//! Sorted-list non-membership by "gap leaves": leaf_i = H(s_i, s_{i+1}) over the sorted list with sentinels
//! 0 and 2^253 (- 1 for room). Proving x is absent = one Merkle path to a leaf (lo, hi) with lo < x < hi.
//! Empty padding leaves are H(0, 0), which no x can satisfy. One path instead of two adjacent paths.
use crate::hash::poseidon2_hash;

pub global DS_GAP: Field = 0x707261776c2d676170; // "prawl-gap"

pub fn gap_leaf(lo: Field, hi: Field) -> Field {
    poseidon2_hash([DS_GAP, lo, hi])
}

pub fn merkle_root<let D: u32>(leaf: Field, index: Field, path: [Field; D]) -> Field {
    let bits: [bool; D] = index.to_le_bits();
    let mut cur = leaf;
    for i in 0..D {
        let (l, r) = if bits[i] { (path[i], cur) } else { (cur, path[i]) };
        cur = poseidon2_hash([l, r]);
    }
    cur
}

/// Assert x is NOT in the sorted set committed by `root`.
pub fn assert_not_member<let D: u32>(x: Field, lo: Field, hi: Field, index: Field, path: [Field; D], root: Field) {
    // lo < x < hi as integers. Field::lt compares canonical representatives.
    assert(lo.lt(x), "non-membership: x <= gap low");
    assert(x.lt(hi), "non-membership: x >= gap high");
    assert(merkle_root(gap_leaf(lo, hi), index, path) == root, "non-membership: gap leaf not in tree");
}
