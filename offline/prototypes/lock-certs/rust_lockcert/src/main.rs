//! Lock-certificate prototype for Prawl (seam B: minimal communication).
//!
//! A "lock" is a BLS (min_sig: 48-byte G1 signature, 96-byte G2 public key)
//! signature by a bonded witness over (epoch, nf, h) where nf = coin-state
//! nullifier and h = hash binding the transfer (recipient one-time key, amount).
//! An honest witness signs at most one h per (epoch, nf), persisting the lock
//! BEFORE releasing the signature. A recipient accepts only with an aggregate
//! signature from a quorum q = 2f+1 of the n = 3f+1 committee members.
//!
//! The program:
//!   1. measures element sizes and timings with blst (supranational/blst),
//!   2. runs the fork attack exhaustively over all ways the payer can split
//!      honest witnesses between two conflicting transfers, for b Byzantine
//!      witnesses, and reports whether two conflicting certificates are possible,
//!   3. builds equivocation evidence (two certs, same nf, different h) and
//!      checks non-frameability (intersection of signer bitmaps is a subset of
//!      the Byzantine set), and
//!   4. writes ../contracts/test/vectors.json in EIP-2537 encoding for the
//!      Solidity slasher.

use blst::min_sig::{AggregateSignature, PublicKey, SecretKey, Signature};
use blst::BLST_ERROR;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Instant;

const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_";
const POP_DST: &[u8] = b"BLS_POP_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_";
const TAG: &[u8] = b"PRAWL.LOCK.v1"; // 13 bytes

fn lock_msg(epoch: u64, nf: &[u8; 32], h: &[u8; 32]) -> Vec<u8> {
    let mut m = Vec::with_capacity(85);
    m.extend_from_slice(TAG);
    m.extend_from_slice(&epoch.to_be_bytes());
    m.extend_from_slice(nf);
    m.extend_from_slice(h);
    m
}

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut hs = Sha256::new();
    for p in parts {
        hs.update(p);
    }
    hs.finalize().into()
}

/// EIP-2537 encoding: each Fp is 64 bytes (16 zero bytes + 48 big-endian).
fn pad_fp(x: &[u8]) -> Vec<u8> {
    assert_eq!(x.len(), 48);
    let mut v = vec![0u8; 16];
    v.extend_from_slice(x);
    v
}
fn g1_eip(sig: &Signature) -> String {
    let s = sig.serialize(); // 96 = x || y
    let mut v = pad_fp(&s[0..48]);
    v.extend(pad_fp(&s[48..96]));
    hex::encode(v)
}
/// blst/zcash serialization of G2 is x.c1 || x.c0 || y.c1 || y.c0;
/// EIP-2537 wants x.c0 || x.c1 || y.c0 || y.c1.
fn g2_eip(pk: &PublicKey) -> String {
    let s = pk.serialize(); // 192
    let mut v = pad_fp(&s[48..96]);
    v.extend(pad_fp(&s[0..48]));
    v.extend(pad_fp(&s[144..192]));
    v.extend(pad_fp(&s[96..144]));
    hex::encode(v)
}

struct Witness {
    sk: SecretKey,
    pk: PublicKey,
    byzantine: bool,
    /// durable lock table: (epoch, nf) -> h  (written before signing)
    locks: HashMap<(u64, [u8; 32]), [u8; 32]>,
}

impl Witness {
    fn handle(&mut self, epoch: u64, nf: &[u8; 32], h: &[u8; 32]) -> Option<Signature> {
        if !self.byzantine {
            match self.locks.get(&(epoch, *nf)) {
                Some(prev) if prev != h => return None, // conflict: refuse
                Some(_) => {}                           // idempotent retry
                None => {
                    self.locks.insert((epoch, *nf), *h); // persist first
                }
            }
        }
        Some(self.sk.sign(&lock_msg(epoch, nf, h), DST, &[]))
    }
}

fn committee(n: usize, seed: u8) -> Vec<Witness> {
    (0..n)
        .map(|i| {
            let ikm = sha(&[b"witness-ikm", &[seed], &(i as u64).to_be_bytes()]);
            let sk = SecretKey::key_gen(&ikm, &[]).unwrap();
            let pk = sk.sk_to_pk();
            Witness { sk, pk, byzantine: false, locks: HashMap::new() }
        })
        .collect()
}

struct Cert {
    bitmap: u128,
    sig: Signature,
}

fn verify_cert(ws: &[Witness], q: usize, epoch: u64, nf: &[u8; 32], h: &[u8; 32], c: &Cert) -> bool {
    if (c.bitmap.count_ones() as usize) < q {
        return false;
    }
    let pks: Vec<&PublicKey> = (0..ws.len()).filter(|i| c.bitmap >> i & 1 == 1).map(|i| &ws[i].pk).collect();
    c.sig.fast_aggregate_verify(true, &lock_msg(epoch, nf, h), DST, &pks) == BLST_ERROR::BLST_SUCCESS
}

/// Try to assemble a quorum cert from the witnesses in `ask` (in order).
fn collect(ws: &mut [Witness], ask: &[usize], q: usize, epoch: u64, nf: &[u8; 32], h: &[u8; 32]) -> Option<Cert> {
    let mut sigs = vec![];
    let mut bitmap = 0u128;
    for &i in ask {
        if let Some(s) = ws[i].handle(epoch, nf, h) {
            sigs.push(s);
            bitmap |= 1u128 << i;
        }
        if sigs.len() == q {
            break;
        }
    }
    if sigs.len() < q {
        return None;
    }
    let refs: Vec<&Signature> = sigs.iter().collect();
    let agg = AggregateSignature::aggregate(&refs, true).unwrap().to_signature();
    Some(Cert { bitmap, sig: agg })
}

fn bench<F: FnMut()>(label: &str, iters: u32, mut f: F) -> f64 {
    let t = Instant::now();
    for _ in 0..iters {
        f();
    }
    let us = t.elapsed().as_secs_f64() * 1e6 / iters as f64;
    println!("  {:<58} {:>10.1} us", label, us);
    us
}

fn main() {
    println!("== 1. Element sizes (blst {}), min_sig ciphersuite ==", "0.3.16");
    let w = committee(1, 0).pop().unwrap();
    let s = w.sk.sign(b"x", DST, &[]);
    println!("  secret key                     {} B", w.sk.to_bytes().len());
    println!("  G2 public key compressed       {} B (uncompressed {} B)", w.pk.compress().len(), w.pk.serialize().len());
    println!("  G1 signature compressed        {} B (uncompressed {} B)", s.compress().len(), s.serialize().len());
    {
        use blst::min_pk as mp;
        let sk = mp::SecretKey::key_gen(&[7u8; 32], &[]).unwrap();
        let sg = sk.sign(b"x", b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_", &[]);
        println!("  [min_pk, Ethereum-consensus style] pk {} B, sig {} B", sk.sk_to_pk().compress().len(), sg.compress().len());
    }

    println!("\n== 2. Timings on this laptop (release build) ==");
    let nf = sha(&[b"nf"]);
    let h = sha(&[b"h"]);
    let m = lock_msg(1, &nf, &h);
    println!("  lock message length = {} B", m.len());
    bench("witness: sign lock (hash-to-G1 + scalar mult)", 2000, || {
        let _ = w.sk.sign(&m, DST, &[]);
    });
    let sig1 = w.sk.sign(&m, DST, &[]);
    bench("verify single partial signature", 1000, || {
        assert_eq!(sig1.verify(true, &m, DST, &[], &w.pk, true), BLST_ERROR::BLST_SUCCESS);
    });
    bench("decompress 48-B signature (with subgroup check)", 2000, || {
        let _ = Signature::uncompress(&sig1.compress()).unwrap();
    });
    for &n in &[4usize, 7, 10, 31, 100] {
        let f = (n - 1) / 3;
        let q = 2 * f + 1;
        let ws = committee(n, 1);
        let sigs: Vec<Signature> = ws[..q].iter().map(|x| x.sk.sign(&m, DST, &[])).collect();
        let refs: Vec<&Signature> = sigs.iter().collect();
        let pks: Vec<&PublicKey> = ws[..q].iter().map(|x| &x.pk).collect();
        let agg = AggregateSignature::aggregate(&refs, true).unwrap().to_signature();
        bench(&format!("n={:>3} q={:>3}: aggregate q partials", n, q), 200, || {
            let _ = AggregateSignature::aggregate(&refs, true).unwrap();
        });
        bench(&format!("n={:>3} q={:>3}: recipient verifies cert (agg pk + 2 pairings)", n, q), 200, || {
            assert_eq!(agg.fast_aggregate_verify(true, &m, DST, &pks), BLST_ERROR::BLST_SUCCESS);
        });
    }

    println!("\n== 3. Fork attack, exhaustive over honest-witness splits ==");
    println!("  (payer sends h_B to subset S and h_C to the rest; Byzantine witnesses sign both)");
    for &n in &[4usize, 7, 10] {
        let f = (n - 1) / 3;
        let q = 2 * f + 1;
        for b in 0..=(f + 1) {
            let mut both = 0u64;
            let mut splits = 0u64;
            let mut framed = 0u64;
            // honest witnesses are indices b..n; Byzantine are 0..b
            let hn = n - b;
            // Only test a few hundred splits for n=10 to keep runtime small (all 2^hn for hn<=10 is 1024: fine).
            for mask in 0u64..(1u64 << hn) {
                splits += 1;
                let mut ws = committee(n, 2);
                for i in 0..b {
                    ws[i].byzantine = true;
                }
                let nf = sha(&[b"coin", &[n as u8, b as u8]]);
                let hb = sha(&[b"to-bob"]);
                let hc = sha(&[b"to-charlie"]);
                // order: Byzantine first for both, then honest split by mask
                let mut ask_b: Vec<usize> = (0..b).collect();
                let mut ask_c: Vec<usize> = (0..b).collect();
                for j in 0..hn {
                    if mask >> j & 1 == 1 { ask_b.push(b + j) } else { ask_c.push(b + j) }
                }
                // and then each side also asks everyone else (honest ones that already locked refuse)
                let rest_b: Vec<usize> = (0..n).filter(|i| !ask_b.contains(i)).collect();
                let rest_c: Vec<usize> = (0..n).filter(|i| !ask_c.contains(i)).collect();
                // phase 1: first-contact locks, phase 2: ask the rest
                let mut order_b = ask_b.clone();
                order_b.extend(rest_b);
                let mut order_c = ask_c.clone();
                order_c.extend(rest_c);
                // interleave: deliver first-contact requests before any "rest" requests
                for &i in &ask_b { let _ = ws[i].handle(1, &nf, &hb); }
                for &i in &ask_c { let _ = ws[i].handle(1, &nf, &hc); }
                let cb = collect(&mut ws, &order_b, q, 1, &nf, &hb);
                let cc = collect(&mut ws, &order_c, q, 1, &nf, &hc);
                if let (Some(cb), Some(cc)) = (cb, cc) {
                    assert!(verify_cert(&ws, q, 1, &nf, &hb, &cb));
                    assert!(verify_cert(&ws, q, 1, &nf, &hc, &cc));
                    both += 1;
                    let inter = cb.bitmap & cc.bitmap;
                    let byz_mask = (1u128 << b) - 1;
                    if inter & !byz_mask != 0 { framed += 1; }
                    assert!(inter.count_ones() as usize >= f + 1);
                }
                if n == 10 && splits >= 1024 { break; }
            }
            println!("  n={:>2} f={} q={} byzantine b={}: splits tried {:>5}, two conflicting certs in {:>5}, honest witness in intersection {}", n, f, q, b, splits, both, framed);
        }
    }

    println!("\n== 4. Equivocation evidence + vectors for Solidity ==");
    let mut out = serde_json::Map::new();
    let neg_one = hex::decode("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000000").unwrap();
    let neg_g2 = SecretKey::from_bytes(&neg_one).unwrap().sk_to_pk();
    out.insert("negG2".into(), format!("0x{}", g2_eip(&neg_g2)).into());
    out.insert("dst".into(), format!("0x{}", hex::encode(DST)).into());
    out.insert("popDst".into(), format!("0x{}", hex::encode(POP_DST)).into());
    for &n in &[4usize, 7, 10, 31, 100] {
        let f = (n - 1) / 3;
        let q = 2 * f + 1;
        let mut ws = committee(n, 3);
        for i in 0..=f { ws[i].byzantine = true; } // f+1 Byzantine: indices 0..=f
        let nf = sha(&[b"evidence-coin", &[n as u8]]);
        let hb = sha(&[b"to-bob"]);
        let hc = sha(&[b"to-charlie"]);
        // Bob's cert: Byzantine 0..=f plus honest f+1..2f (total 2f+1)
        let ob: Vec<usize> = (0..q).collect();
        // Charlie's cert: Byzantine 0..=f plus honest 2f+1..3f (total 2f+1)
        let mut oc: Vec<usize> = (0..=f).collect();
        oc.extend(q..n);
        let cb = collect(&mut ws, &ob, q, 1, &nf, &hb).unwrap();
        let cc = collect(&mut ws, &oc, q, 1, &nf, &hc).unwrap();
        assert!(verify_cert(&ws, q, 1, &nf, &hb, &cb) && verify_cert(&ws, q, 1, &nf, &hc, &cc));
        let inter = cb.bitmap & cc.bitmap;
        println!("  n={:>3}: bitmapB={:#x} bitmapC={:#x} intersection={:#x} ({} witnesses, all Byzantine: {})",
            n, cb.bitmap & 0xffff, cc.bitmap & 0xffff, inter & 0xffff, inter.count_ones(), inter == (1u128 << (f + 1)) - 1);
        let pks: Vec<serde_json::Value> = ws.iter().map(|x| format!("0x{}", g2_eip(&x.pk)).into()).collect();
        let pops: Vec<serde_json::Value> = ws.iter().map(|x| {
            let enc = hex::decode(g2_eip(&x.pk)).unwrap();
            format!("0x{}", g1_eip(&x.sk.sign(&enc, POP_DST, &[]))).into()
        }).collect();
        // bitmaps as u256 hex (n<=100 fits u128 but we use u64 in Rust => build as big bitstring)
        let bm = |c: &Cert, order: &Vec<usize>| -> String {
            let mut bits = [0u8; 32];
            let _ = c;
            for &i in order.iter().take(q) { bits[31 - i / 8] |= 1 << (i % 8); }
            format!("0x{}", hex::encode(bits))
        };
        let mut o = serde_json::Map::new();
        o.insert("n".into(), n.into());
        o.insert("q".into(), q.into());
        o.insert("pks".into(), pks.into());
        o.insert("pops".into(), pops.into());
        o.insert("nf".into(), format!("0x{}", hex::encode(nf)).into());
        o.insert("hB".into(), format!("0x{}", hex::encode(hb)).into());
        o.insert("hC".into(), format!("0x{}", hex::encode(hc)).into());
        o.insert("bitmapB".into(), bm(&cb, &ob).into());
        o.insert("bitmapC".into(), bm(&cc, &oc).into());
        o.insert("sigB".into(), format!("0x{}", g1_eip(&cb.sig)).into());
        o.insert("sigC".into(), format!("0x{}", g1_eip(&cc.sig)).into());
        out.insert(format!("n{}", n), o.into());
        // n>=64 bitmaps don't fit in the u64 used by `Cert.bitmap`; the u256 bitmap above is built from `order` instead.
    }
    let path = "../contracts/test/vectors.json";
    std::fs::create_dir_all("../contracts/test").unwrap();
    std::fs::write(path, serde_json::to_string_pretty(&serde_json::Value::Object(out)).unwrap()).unwrap();
    println!("  wrote {}", path);
}
