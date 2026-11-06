#!/usr/bin/env python3
"""Collateral efficiency for a consumer: v = 0.1 ETH per payment, Poisson(20) payments/day, 1-day sync.

ASSUMPTIONS (not facts): payees drawn from the user's designated set S of M merchants with Zipf(s)
popularity; a fraction q of payments go to recipients outside S (friends / strangers).
Designs compared (lock = capital the user must keep locked in steady state):
  ALLOW  allowance factory (one-to-many channel, standing per-merchant cap a_m, merchant redeems at its
         daily sync, user tops up daily): lock = sum a_m. Guarantee: PREVENTION for payments to S.
  DEN    designated endorsed notes: spendable float E + designated cover slots c_m (= same per-merchant
         caps) + N1 payer-chosen slots for the non-S outflow: lock = E + sum c_m + 2*(non-S daily value).
         Guarantee: full cover for S at every hop; N1 residual for non-S.
  N1     endorsed notes with payer-chosen slots only: lock = E + 2*(daily value) (D = 1 d, T_ch = 1 d, from
         innovation_beyond_barriers.md). Guarantee: downstream immunity, residual on direct counterparty.
  NOBLOCK allowance factory that never blocks: every merchant cap = the daily budget -> M * budget.
Per-merchant caps a_m are set at a common quantile level alpha of the merchant's daily receipts,
alpha chosen by bisection so that P(any S-payment blocked on a day) <= eps.
"""
import numpy as np
rng = np.random.default_rng(7)
V = 0.1; LAM = 20; DAYS = 200_000
out = []
def P(s): print(s); out.append(s)

def simulate(M, s, q):
    w = 1 / np.arange(1, M + 1) ** s; w /= w.sum()
    n = rng.poisson(LAM, DAYS)
    to_S = rng.binomial(n, 1 - q)

    # vectorised multinomial
    counts = rng.multinomial(to_S, w)          # (DAYS, M)
    return counts * V, (n - to_S) * V, n * V

def caps_for(eps, recv):
    lo, hi = 0.5, 1.0
    for _ in range(40):
        a = (lo + hi) / 2
        caps = np.quantile(recv, a, axis=0, method="higher")
        pblock = (recv > caps + 1e-12).any(axis=1).mean()
        if pblock <= eps: hi = a
        else: lo = a
    caps = np.quantile(recv, hi, axis=0, method="higher")
    return caps, (recv > caps + 1e-12).any(axis=1).mean()

P(f"Assumptions: v={V} ETH, payments/day ~ Poisson({LAM}) (mean {LAM*V:.1f} ETH/day), {DAYS} simulated days")
budget99 = None
for q in (0.0, 0.1, 0.3):
    for M in (5, 10, 20):
        for s in (1.0,):
            recv, nonS, tot = simulate(M, s, q)
            E = np.quantile(tot, 0.99)                 # float that covers 99% of days
            for eps in (0.05, 0.01):
                caps, pb = caps_for(eps, recv)
                sum_caps = caps.sum()
                blocked_val = np.maximum(recv - caps, 0).sum() / max(recv.sum(), 1e-9)
                allow = sum_caps
                den = E + sum_caps + 2 * np.mean(nonS)
                n1 = E + 2 * np.mean(tot)
                noblock = M * E
                P(f"q={q:.1f} M={M:>2} zipf={s} eps={eps:.2f}: caps(ETH)={np.round(caps,1).tolist()}")
                P(f"   sum caps={sum_caps:.2f} ETH (P(day has a blocked S-payment)={pb:.3f}, blocked S-value frac={blocked_val:.4f})")
                P(f"   lock ALLOW={allow:.2f}  DEN={den:.2f}  N1={n1:.2f}  NOBLOCK={noblock:.2f}  [E(99%)={E:.2f}, mean non-S/day={np.mean(nonS):.2f}]")
                P(f"   ALLOW lock / mean daily S-spend = {allow/np.mean(recv.sum(axis=1)):.2f}x ; guaranteed share of value = {(1-q)*(1-blocked_val):.3f}")

# Hybrid: caps at lower quantile, overflow paid with N1 notes (residual risk)
P("\nHybrid ALLOW + overflow-as-N1 (q=0.1, M=10, zipf 1): lock vs share of value under PREVENTION")
recv, nonS, tot = simulate(10, 1.0, 0.1)
for a in (0.5, 0.75, 0.9, 0.95, 0.99, 0.999):
    caps = np.quantile(recv, a, axis=0, method="higher")
    over = np.maximum(recv - caps, 0).sum(axis=1)
    prevented = (recv.sum() - over.sum()) / tot.sum()
    lock = caps.sum() + 2 * np.mean(over + nonS) + np.quantile(over + nonS, 0.99)
    P(f"  per-merchant quantile {a:.3f}: sum caps={caps.sum():.2f}  total lock (caps + N1 float+slots for overflow & non-S)={lock:.2f} ETH  value under prevention={prevented:.3f}")
open(__file__.replace(".py", ".out"), "w").write("\n".join(out) + "\n")
