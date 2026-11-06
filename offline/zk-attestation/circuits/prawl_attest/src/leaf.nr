//! Android Key Attestation leaf policy, walked structurally from TBS byte 0.
//! Mirrors tools/chains.py::walk_leaf (cross-checked on all 23 distinct real leaves, see RESULTS.md).
use crate::cert::walk_cert_prefix;
use crate::der::{eq_at, expect, int_u64, read_auth};

pub global MAX_EXT: u32 = 3; // leaf extensions (real leaves: 2 = KeyUsage + KeyDescription)
pub global MAX_SW: u32 = 4; // softwareEnforced entries (real: 2-3; KeyMint 4 adds moduleHash)
pub global MAX_HW: u32 = 15; // hardwareEnforced entries (real: 12-13)
pub global MAX_PURPOSE: u32 = 4;

// 06 0a 2b 06 01 04 01 d6 79 02 01 11 = OID 1.3.6.1.4.1.11129.2.1.17 (Android key attestation)
pub global OID_KEYDESC_TLV: [u8; 12] =
    [0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11];

pub struct Leaf {
    pub x: [u8; 32], // coin key K
    pub y: [u8; 32],
    pub patch: u64, // osPatchLevel YYYYMM (hardware list)
}

pub fn walk_leaf<let N: u32, let PL: u32>(
    b: [u8; N],
    n: u32,
    expected_pkg: [u8; PL],
    expected_digest: [u8; 32],
    min_patch: u64,
) -> Leaf {
    let cp = walk_cert_prefix(b, n, false);

    // ---- extensions [3] { SEQUENCE OF Extension } must end the TBS (no trailing fields)
    let ext = expect(b, cp.after_spki, n, 0xA3);
    assert(ext.next == n, "leaf: data after extensions");
    let seq = expect(b, ext.c, ext.next, 0x30);
    assert(seq.next == ext.next, "leaf: extensions length");
    let send = seq.next;
    let mut p = seq.c;
    let mut matches: u32 = 0;
    let mut kd_c: u32 = 0;
    let mut kd_end: u32 = 0;
    for _ in 0..MAX_EXT {
        if p < send {
            let x = expect(b, p, send, 0x30);
            let o = expect(b, x.c, x.next, 0x06);
            let is_kd = eq_at(b, x.c, OID_KEYDESC_TLV);
            let mut q = o.next;
            if b[q] == 0x01 {
                assert(
                    eq_at(b, q, [0x01, 0x01, 0xff]) | eq_at(b, q, [0x01, 0x01, 0x00]),
                    "leaf: critical flag",
                );
                q = q + 3;
            }
            let v = expect(b, q, x.next, 0x04);
            assert(v.next == x.next, "leaf: extension trailing data");
            if is_kd {
                matches += 1;
                kd_c = v.c;
                kd_end = v.next;
            }
            p = x.next;
        }
    }
    assert(p == send, "leaf: more than MAX_EXT extensions");
    assert(matches == 1, "leaf: KeyDescription extension count != 1");

    // ---- KeyDescription ::= SEQUENCE
    let kd = expect(b, kd_c, kd_end, 0x30);
    assert(kd.next == kd_end, "KD: trailing data");
    let kend = kd.next;
    let av = expect(b, kd.c, kend, 0x02); // attestationVersion
    let al = expect(b, av.next, kend, 0x0A); // attestationSecurityLevel
    assert(al.len == 1, "KD: level length");
    let att_lvl = b[al.c];
    let kv = expect(b, al.next, kend, 0x02); // keyMintVersion
    let kl = expect(b, kv.next, kend, 0x0A); // keyMintSecurityLevel
    assert(kl.len == 1, "KD: level length");
    let km_lvl = b[kl.c];
    assert((att_lvl == 1) | (att_lvl == 2), "KD: attestation not TEE/StrongBox");
    assert(km_lvl == att_lvl, "KD: keyMint level != attestation level");
    let ch = expect(b, kl.next, kend, 0x04); // attestationChallenge: attacker-chosen, skipped by length
    let uid = expect(b, ch.next, kend, 0x04); // uniqueId
    let sw = expect(b, uid.next, kend, 0x30);
    let hw = expect(b, sw.next, kend, 0x30);
    assert(hw.next == kend, "KD: extra fields");

    // ---- softwareEnforced: usageCountLimit must NOT be here; attestationApplicationId must be
    let mut p = sw.c;
    let mut n405: u32 = 0;
    let mut n709: u32 = 0;
    let mut app_c: u32 = 0;
    let mut app_len: u32 = 0;
    for _ in 0..MAX_SW {
        if p < sw.next {
            let a = read_auth(b, p, sw.next);
            if a.tag == 405 {
                n405 += 1;
            }
            if a.tag == 709 {
                n709 += 1;
                app_c = a.c;
                app_len = a.len;
            }
            p = a.next;
        }
    }
    assert(p == sw.next, "SW: more than MAX_SW entries");
    assert(n405 == 0, "SW: usageCountLimit only software-enforced");
    assert(n709 == 1, "SW: attestationApplicationId missing");

    // attestationApplicationId ::= OCTET STRING { SEQUENCE { SET OF PackageInfo, SET OF OCTET STRING } }
    let app_end = app_c + app_len;
    let o = expect(b, app_c, app_end, 0x04);
    assert(o.next == app_end, "APPID: trailing");
    let s = expect(b, o.c, o.next, 0x30);
    assert(s.next == o.next, "APPID: trailing");
    let pkgs = expect(b, s.c, s.next, 0x31);
    let pinfo = expect(b, pkgs.c, pkgs.next, 0x30);
    assert(pinfo.next == pkgs.next, "APPID: more than one package");
    let name = expect(b, pinfo.c, pinfo.next, 0x04);
    assert(name.len == PL, "APPID: package name length");
    assert(eq_at(b, name.c, expected_pkg), "APPID: package name");
    let ver = expect(b, name.next, pinfo.next, 0x02);
    assert(ver.next == pinfo.next, "APPID: package info trailing");
    let digs = expect(b, pkgs.next, s.next, 0x31);
    assert(digs.next == s.next, "APPID: trailing");
    let dig = expect(b, digs.c, digs.next, 0x04);
    assert((dig.next == digs.next) & (dig.len == 32), "APPID: need exactly one 32-byte signer digest");
    assert(eq_at(b, dig.c, expected_digest), "APPID: signer digest");

    // ---- hardwareEnforced
    let mut p = hw.c;
    let mut c1: u32 = 0;
    let mut l1: u32 = 0;
    let mut k1: u32 = 0; // purpose
    let mut c2: u32 = 0;
    let mut l2: u32 = 0;
    let mut k2: u32 = 0; // algorithm
    let mut c10: u32 = 0;
    let mut l10: u32 = 0;
    let mut k10: u32 = 0; // ecCurve
    let mut c405: u32 = 0;
    let mut l405: u32 = 0;
    let mut k405: u32 = 0; // usageCountLimit
    let mut c702: u32 = 0;
    let mut l702: u32 = 0;
    let mut k702: u32 = 0; // origin
    let mut c704: u32 = 0;
    let mut l704: u32 = 0;
    let mut k704: u32 = 0; // rootOfTrust
    let mut c706: u32 = 0;
    let mut l706: u32 = 0;
    let mut k706: u32 = 0; // osPatchLevel
    for _ in 0..MAX_HW {
        if p < hw.next {
            let a = read_auth(b, p, hw.next);
            if a.tag == 1 {
                c1 = a.c;
                l1 = a.len;
                k1 += 1;
            }
            if a.tag == 2 {
                c2 = a.c;
                l2 = a.len;
                k2 += 1;
            }
            if a.tag == 10 {
                c10 = a.c;
                l10 = a.len;
                k10 += 1;
            }
            if a.tag == 405 {
                c405 = a.c;
                l405 = a.len;
                k405 += 1;
            }
            if a.tag == 702 {
                c702 = a.c;
                l702 = a.len;
                k702 += 1;
            }
            if a.tag == 704 {
                c704 = a.c;
                l704 = a.len;
                k704 += 1;
            }
            if a.tag == 706 {
                c706 = a.c;
                l706 = a.len;
                k706 += 1;
            }
            p = a.next;
        }
    }
    assert(p == hw.next, "HW: more than MAX_HW entries");
    assert(
        (k405 == 1) & (l405 == 3) & eq_at(b, c405, [0x02, 0x01, 0x01]),
        "HW: usageCountLimit != 1 in hardwareEnforced",
    );
    assert((k702 == 1) & (l702 == 3) & eq_at(b, c702, [0x02, 0x01, 0x00]), "HW: origin != GENERATED");
    assert((k2 == 1) & (l2 == 3) & eq_at(b, c2, [0x02, 0x01, 0x03]), "HW: algorithm != EC");
    assert((k10 == 1) & (l10 == 3) & eq_at(b, c10, [0x02, 0x01, 0x01]), "HW: ecCurve != P-256");

    // purpose SET OF INTEGER (one-byte values) must contain SIGN (2)
    assert(k1 == 1, "HW: purpose missing");
    let ps = expect(b, c1, c1 + l1, 0x31);
    assert(ps.next == c1 + l1, "HW: purpose trailing");
    let mut q = ps.c;
    let mut has_sign = false;
    for _ in 0..MAX_PURPOSE {
        if q < ps.next {
            assert((b[q] == 0x02) & (b[q + 1] == 0x01), "HW: purpose entry form");
            has_sign = has_sign | (b[q + 2] == 0x02);
            q = q + 3;
        }
    }
    assert(q == ps.next, "HW: purpose set form");
    assert(has_sign, "HW: purpose lacks SIGN");

    // rootOfTrust ::= SEQUENCE { verifiedBootKey OCTET STRING, deviceLocked BOOLEAN, verifiedBootState ENUMERATED, ... }
    assert(k704 == 1, "HW: rootOfTrust missing");
    let rot = expect(b, c704, c704 + l704, 0x30);
    assert(rot.next == c704 + l704, "ROT: trailing");
    let vbk = expect(b, rot.c, rot.next, 0x04);
    assert(eq_at(b, vbk.next, [0x01, 0x01, 0xff]), "ROT: deviceLocked != TRUE");
    assert(eq_at(b, vbk.next + 3, [0x0a, 0x01, 0x00]), "ROT: verifiedBootState != Verified");
    assert(vbk.next + 6 <= rot.next, "ROT: short");

    // osPatchLevel YYYYMM
    assert(k706 == 1, "HW: osPatchLevel missing");
    let pi = expect(b, c706, c706 + l706, 0x02);
    assert(pi.next == c706 + l706, "HW: osPatchLevel trailing");
    let patch = int_u64::<N, 4>(b, pi.c, pi.len);
    assert(patch >= min_patch, "HW: osPatchLevel below policy");

    Leaf { x: cp.x, y: cp.y, patch }
}
