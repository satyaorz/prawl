#!/usr/bin/env python3
"""Seed idea 1: recipient-indexed collateral slots, slot = H(salt, pk_R) mod n.

Questions tested (all numbers here are MEASURED by Monte Carlo or exact formula):
  A. Birthday: honest-only random fork recipients. P(any collision), P(a given honest R collides),
     P(max load > t). Exact formulas checked against MC.
  B. Target selection: the attacker does NOT pick victims at random. Given a reachable pool of N
     honest recipients whose slots are public (deterministic hash), it picks the most loaded slot.
     Uncovered loss vs. total collateral n*c, compared with the Partition bound (sum of caps).
  C. Salt grinding at mint: attacker grinds the coin salt so that a FIXED target set of t merchants
     shares one slot. Expected work ~ n^(t-1).
  D. Registered Sybils: honest R shares its slot with Binomial(M, 1/n) attacker-registered Sybils.
     Pro-rata within the slot. Fraction of R's loss recovered.
  E. Recipient-chosen random slot revealed during the payment, attacker may abort: number of
     aborts needed to herd k victims into one slot.
Units: v = 1 (one payment value). c = slot capacity in units of v.
"""
import math, random, hashlib, sys
import numpy as np

rng = np.random.default_rng(20261106)
random.seed(20261106)
out = []
def P(*a):
    s = " ".join(str(x) for x in a); print(s); out.append(s)

# ---------------- A. birthday -----------------
P("== A. Birthday collisions, k honest fork recipients, n slots (uniform hash) ==")
def p_any_collision(k, n):
    p = 1.0
    for i in range(k):
        p *= (n - i) / n if n - i > 0 else 0.0
    return 1 - p
def p_given_collides(k, n):
    return 1 - (1 - 1 / n) ** (k - 1)
def mc_maxload(k, n, t, trials=20000):
    bins = rng.integers(0, n, size=(trials, k))
    cnt = np.zeros((trials, n), dtype=np.int32)
    np.add.at(cnt, (np.repeat(np.arange(trials), k), bins.ravel()), 1)
    mx = cnt.max(axis=1)
    # fraction of honest recipients in a slot with load > t (they are not fully covered if c = t)
    load_of_each = np.take_along_axis(cnt, bins, axis=1)
    frac_uncovered = (load_of_each > t).mean()
    return (mx > t).mean(), frac_uncovered
P(f"{'k':>4} {'n':>6} {'P(any coll) exact':>18} {'P(R collides)':>14} {'MC P(maxload>1)':>16} {'MC P(maxload>2)':>16} {'frac R uncov c=1':>17} {'frac R uncov c=2':>17}")
for k in (2, 5, 10, 20, 50):
    for n in (20, 100, 1000, 10000):
        pa = p_any_collision(k, n); pg = p_given_collides(k, n)
        m1, f1 = mc_maxload(k, n, 1, trials=4000 if n >= 1000 else 20000)
        m2, f2 = mc_maxload(k, n, 2, trials=4000 if n >= 1000 else 20000)
        P(f"{k:>4} {n:>6} {pa:>18.4f} {pg:>14.4f} {m1:>16.4f} {m2:>16.4f} {f1:>17.4f} {f2:>17.4f}")
P("Check: MC P(maxload>1) should equal exact P(any collision).")

# ---------------- B. target selection -----------------
P("\n== B. Attacker selects victims from a reachable pool of N honest recipients (slots public) ==")
P("Attacker forks to every recipient in the most-loaded slot (and anywhere else it likes).")
P("Loss to honest = sum over slots of max(0, load_j - c) restricted to the victims it chooses.")
P("Attacker choosing ALL N reachable: uncovered = sum_j max(0, load_j - c). Collateral = n*c.")
P(f"{'N':>5} {'n':>5} {'c':>3} {'collat n*c':>10} {'E[uncovered|all N]':>19} {'E[max slot load]':>17} {'partition need N':>17}")
for N in (50, 200, 1000):
    for n in (16, 64, 256):
        for c in (1, 2, 4):
            unc = []; ml = []
            for _ in range(2000):
                loads = np.bincount(rng.integers(0, n, size=N), minlength=n)
                unc.append(np.maximum(0, loads - c).sum()); ml.append(loads.max())
            P(f"{N:>5} {n:>5} {c:>3} {n*c:>10} {np.mean(unc):>19.2f} {np.mean(ml):>17.2f} {N:>17}")
P("Observation: uncovered loss is zero only when n*c >= N roughly AND no slot is over c; the")
P("attacker can always concentrate on the max-load slot, so per-victim guarantee needs c >= max load.")

# Worst case per-victim guarantee: what fraction of slots must have c >= load to guarantee all
P("\nCollateral to guarantee EVERY reachable honest recipient (c = max load), vs partition N*1:")
for N in (50, 200, 1000):
    for n in (16, 64, 256, 1024):
        mls = [np.bincount(rng.integers(0, n, size=N), minlength=n).max() for _ in range(2000)]
        c99 = int(np.quantile(mls, 0.99))
        P(f"  N={N:>5} n={n:>5}: c needed (99th pct of max load)={c99:>3}  total n*c={n*c99:>6}  vs partition bound N={N}  ratio={n*c99/N:6.2f}")

# ---------------- C. salt grinding -----------------
P("\n== C. Salt grinding: make t fixed target merchants share one slot ==")
def grind(t, n, max_tries=2_000_000):
    pks = [hashlib.sha256(f"merchant{i}".encode()).digest() for i in range(t)]
    for s in range(max_tries):
        salt = s.to_bytes(8, "big")
        slots = {int.from_bytes(hashlib.sha256(salt + pk).digest()[:8], "big") % n for pk in pks}
        if len(slots) == 1:
            return s + 1
    return None
for n in (16, 64, 256):
    for t in (2, 3, 4):
        if n ** (t - 1) > 3_000_000:
            P(f"  n={n:>4} t={t}: expected tries n^(t-1) = {n**(t-1):,} (skipped MC; trivially feasible for a GPU)")
            continue
        tries = [grind(t, n) for _ in range(5 if n ** (t - 1) > 50000 else 30)]
        # vary merchant set per trial by different names
        P(f"  n={n:>4} t={t}: measured tries (mean over runs) ~ {np.mean([x for x in tries if x]):,.0f}; theory n^(t-1) = {n**(t-1):,}")
P("Note: identical merchant set across runs -> same answer; mean is over 1 deterministic run when equal.")

# ---------------- D. registered Sybils -----------------
P("\n== D. Registry-gated hash slots with M attacker-registered Sybils (fresh salt per coin) ==")
P("Honest R in slot j; Sybils in slot j ~ Binomial(M,1/n); each Sybil holds a forked claim of value 1.")
P("Pro-rata: R recovers min(1, c/(1+s_j)). FIFO with Sybils first: R recovers max(0, min(1, c - s_j)).")
P(f"{'n':>5} {'M':>6} {'c':>3} {'P(R whole) pro-rata':>20} {'E[recovery] pro-rata':>21} {'P(R whole) FIFO':>16}")
for n in (64, 256, 1024):
    for M in (0, 64, 256, 1024, 4096):
        for c in (1, 2):
            s = rng.binomial(M, 1 / n, size=200000)
            rec_pr = np.minimum(1, c / (1 + s)); rec_ff = np.clip(c - s, 0, 1)
            P(f"{n:>5} {M:>6} {c:>3} {(rec_pr>=1-1e-12).mean():>20.4f} {rec_pr.mean():>21.4f} {(rec_ff>=1-1e-12).mean():>16.4f}")
P("But the attacker sees R's slot in the transcript BEFORE choosing which Sybils claim: with M >= n*ln(n)")
P("registered Sybils it has one in every slot with high prob, and it can put ALL Sybils whose slot == j in.")
for n in (64, 256, 1024):
    for M in (n, int(n * math.log(n)), 4 * n * int(math.log(n))):
        s = rng.binomial(M, 1 / n, size=200000)
        P(f"  n={n:>5} M={M:>6}: P(>=1 Sybil in R's slot)={(s>=1).mean():.4f}  P(>=2)={(s>=2).mean():.4f}  E[s]={s.mean():.2f}")

# ---------------- E. recipient-chosen slot with abort -----------------
P("\n== E. Recipient reveals a random slot during the payment; attacker may abort and walk away ==")
P("Attacker wants all k victims in slot 0. Each attempt succeeds w.p. 1/n. Expected attempts = k*n.")
for n in (4, 16, 64):
    for k in (5, 20):
        att = [sum(rng.geometric(1 / n, size=k)) for _ in range(2000)]
        P(f"  n={n:>3} k={k:>3}: mean attempts={np.mean(att):8.1f} (theory {k*n}); all k victims share ONE slot of capacity c")
P("If aborts are made costly (payment irrevocable before slot reveal) slots are i.i.d. uniform -> case A,")
P("but Sybils still choose their slot after seeing honest slots -> case D with the attacker's choice (worst).")

open(__file__.replace(".py", ".out"), "w").write("\n".join(out) + "\n")
