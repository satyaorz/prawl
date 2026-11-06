//! Minimal constrained DER reader.
//!
//! Soundness rule used everywhere in this crate: every position is DERIVED by walking TLV headers from
//! byte 0 of the signed TBS. No offset is ever taken from the prover. Content the attacker chooses
//! (attestation challenge, package name, RKP build fingerprint) lives inside OCTET/UTF8/CBOR values that
//! the walk skips by length, so it can never be read as a structural field.
//!
//! Every read touches at most pos+4, so buffers must be at least `len + 8` long (asserted by callers).

pub struct Tlv {
    pub tag: u8,
    pub c: u32, // first content byte
    pub len: u32, // content length
    pub next: u32, // first byte after this TLV
}

/// Header with a one-byte identifier (all universal types + low context tags).
/// Length forms accepted: short, 0x81 (minimal: >=0x80), 0x82 (minimal: >=0x100). Others rejected.
pub fn read_tlv<let N: u32>(b: [u8; N], pos: u32, end: u32) -> Tlv {
    let t = b[pos];
    let l0 = b[pos + 1] as u32;
    let l1 = b[pos + 2] as u32;
    let l2 = b[pos + 3] as u32;
    let short = l0 < 0x80;
    let f81 = l0 == 0x81;
    let f82 = l0 == 0x82;
    let mut hl: u32 = 2;
    let mut ln: u32 = l0;
    if f81 {
        hl = 3;
        ln = l1;
    }
    if f82 {
        hl = 4;
        ln = l1 * 256 + l2;
    }
    assert(short | (f81 & (l1 >= 0x80)) | (f82 & (ln >= 0x100)), "DER: length form");
    let next = pos + hl + ln;
    assert(next <= end, "DER: TLV runs past its parent");
    Tlv { tag: t, c: pos + hl, len: ln, next }
}

pub fn expect<let N: u32>(b: [u8; N], pos: u32, end: u32, tag: u8) -> Tlv {
    let t = read_tlv(b, pos, end);
    assert(t.tag == tag, "DER: unexpected tag");
    t
}

/// b[pos..pos+M] == pat
pub fn eq_at<let N: u32, let M: u32>(b: [u8; N], pos: u32, pat: [u8; M]) -> bool {
    let mut ok = true;
    for i in 0..M {
        ok = ok & (b[pos + i] == pat[i]);
    }
    ok
}

/// AuthorizationList entry header: context-specific constructed [tag] EXPLICIT, tag < 2^14 (1..3 id bytes),
/// length short or 0x81. Mirrors tools/chains.py::rd_auth_entry.
pub struct Auth {
    pub tag: u32,
    pub c: u32,
    pub len: u32,
    pub next: u32,
}

pub fn read_auth<let N: u32>(b: [u8; N], pos: u32, end: u32) -> Auth {
    let b0 = b[pos];
    let b1 = b[pos + 1] as u32;
    let b2 = b[pos + 2] as u32;
    let b3 = b[pos + 3] as u32;
    let b4 = b[pos + 4] as u32;
    assert((b0 & 0xE0) == 0xA0, "auth: not context-specific constructed");
    let low = (b0 & 0x1F) as u32;
    let high = low == 0x1F;
    let three = b1 >= 0x80;
    // identifier length and tag number
    let mut il: u32 = 1;
    let mut tag: u32 = low;
    let mut l0 = b1;
    let mut l1 = b2;
    if high {
        if three {
            assert(b2 < 0x80, "auth: tag longer than 3 bytes");
            assert(b1 != 0x80, "auth: non-minimal tag");
            il = 3;
            tag = (b1 - 0x80) * 128 + b2;
            l0 = b3;
            l1 = b4;
        } else {
            assert(b1 >= 31, "auth: non-minimal tag");
            il = 2;
            tag = b1;
            l0 = b2;
            l1 = b3;
        }
    }
    let short = l0 < 0x80;
    let f81 = l0 == 0x81;
    assert(short | (f81 & (l1 >= 0x80)), "auth: length form");
    let mut hl = il + 1;
    let mut ln = l0;
    if f81 {
        hl = il + 2;
        ln = l1;
    }
    let next = pos + hl + ln;
    assert(next <= end, "auth: entry runs past list");
    Auth { tag, c: pos + hl, len: ln, next }
}

/// Unsigned big-endian INTEGER content of 1..=MAXL bytes, as u64 (positive DER only).
pub fn int_u64<let N: u32, let MAXL: u32>(b: [u8; N], c: u32, len: u32) -> u64 {
    assert((len >= 1) & (len <= MAXL), "int: length");
    assert(b[c] < 0x80, "int: negative");
    let mut v: u64 = 0;
    for i in 0..MAXL {
        if i < len {
            v = v * 256 + (b[c + i] as u64);
        }
    }
    v
}

/// Parse a 13-byte UTCTime "YYMMDDHHMMSSZ" at c into the decimal integer YYMMDDHHMMSS.
/// Monotone in time for 1950..2049 only within one century: RKP certs live in 20xx, and the
/// circuit additionally requires YY < 50 so 19xx encodings cannot alias.
pub fn utc_time<let N: u32>(b: [u8; N], c: u32) -> u64 {
    let mut v: u64 = 0;
    for i in 0..12 {
        let d = b[c + i];
        assert((d >= 0x30) & (d <= 0x39), "UTCTime: digit");
        v = v * 10 + ((d - 0x30) as u64);
    }
    assert(b[c + 12] == 0x5A, "UTCTime: Z");
    assert(v < 500000000000, "UTCTime: 19xx");
    v
}
