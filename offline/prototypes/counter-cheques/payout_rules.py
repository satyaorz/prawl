"""
payout_rules.py -- attack the compensation (payout) rule of a slashed culprit bond.

Setting (formal_limits.md Thm 2b-2d, re-used, not re-derived):
  A culprit's forfeiture yields a compensation budget D = (1-beta)*B.  Claims against it come from
  H units of honest claims (the culprit's direct counterparties) and S units of Sybil claims that the
  attacker manufactures for free.  The ledger cannot tell them apart.
  Attacker excess profit  Delta = alpha*H - B + R_s   (goods from honest victims, minus forfeited bond,
  plus what its Sybils recover).  Given H, a RATIONAL attacker picks Sybil claims to maximise R_s.
  A SPITEFUL attacker picks Sybil claims to minimise what honest claimants get.

Rules tested (all "value-linear anonymous" unless stated: each claimed wei is paid the same fraction g(N),
N = total claimed):
  fifo         : claims paid in arrival order; attacker front-runs with Sybils (Thm 2b worst case)
  prorata      : g(N) = min(1, D/N)
  fob          : full-or-burn  g(N) = 1 if N<=D else 0                        (formal_limits Thm 2d)
  spr(Hbar)    : slack-proportional  g(N) = 1 if N<=D else (D-Hbar)/(N-Hbar+delta)  (NEW, this note)
  power(p)     : g(N) = (D/N)^p for N>D  (a "smooth" punishment rule)
  smallfirst   : NOT value-linear: pay smallest claims first until budget exhausted (attacker splits)

Checks:
  T1  rational safety: for every H<=Hbar and every Sybil profile, the best response keeps N<=D, i.e.
      honest paid in full and Delta = alpha*H - B + (D - H) <= -beta*B (alpha<=1).
  T2  maximality: any anonymous value-linear rule with g(N) > g*(N) for some N>D is NOT rationally safe
      (witness H = Hbar, S = N-Hbar).  Random rules are generated and classified.
  T3  spite: honest per-wei payout under SPR >= (1 - Hbar/D) * prorata for every S.
  T4  unequal claim sizes, random profiles, 20k trials.
"""
import random, math, json, sys

DELTA = 1e-9  # strictness margin (1 wei in the contract)


def g_prorata(N, D, **_):
    return 1.0 if N <= D else D / N


def g_fob(N, D, **_):
    return 1.0 if N <= D + 1e-12 else 0.0


def g_spr(N, D, Hbar, **_):
    if N <= D + 1e-12:
        return 1.0
    return (D - Hbar) / (N - Hbar + DELTA)


def g_spr_tight(N, D, Hbar, **_):  # supremum g*, no margin (ties)
    if N <= D + 1e-12:
        return 1.0
    return (D - Hbar) / (N - Hbar)


def g_power(N, D, p=1.0, **_):
    return 1.0 if N <= D else (D / N) ** p


LINEAR = {"prorata": g_prorata, "fob": g_fob, "spr": g_spr, "power1": lambda N, D, **k: g_power(N, D, 1.0),
          "power3": lambda N, D, **k: g_power(N, D, 3.0)}


def sybil_take_linear(g, H, S, D, Hbar):
    N = H + S
    return S * g(N, D, Hbar=Hbar), H * g(N, D, Hbar=Hbar)


def sybil_take_fifo(H, S, D):
    s_paid = min(S, D)
    return s_paid, min(H, D - s_paid)


def sybil_take_smallfirst(honest_claims, sybil_claims, D):
    # pays smallest claims first; ties -> sybil first (attacker can always make its claims 1 wei smaller)
    allc = [(c, 1) for c in sybil_claims] + [(c, 0) for c in honest_claims]
    allc.sort(key=lambda t: (t[0], -t[1]))
    left, rs, rh = D, 0.0, 0.0
    for c, is_s in allc:
        if c <= left:
            left -= c
            if is_s: rs += c
            else: rh += c
    return rs, rh


def best_response_linear(g, H, D, Hbar, S_grid):
    best = None
    for S in S_grid:
        rs, rh = sybil_take_linear(g, H, S, D, Hbar)
        key = (rs, -rh)  # adversarial tie-break: among equal R_s prefer hurting honest
        if best is None or key > best[0]:
            best = (key, S, rs, rh)
    return best[1], best[2], best[3]


def run_T1(alpha=1.0, beta=0.25, B=10.0, lams=(1.25, 2.0, 4.0)):
    D = (1 - beta) * B
    out = {}
    for name, g in list(LINEAR.items()) + [("spr_tight", g_spr_tight)]:
        worst = {"min_honest_frac": 1.0, "max_delta": -1e9, "where": None}
        for lam in lams:
            Hbar = D / lam
            for H in [Hbar * f for f in (0.0, 0.1, 0.3, 0.5, 0.8, 0.95, 1.0)]:
                S_grid = [x * 0.05 for x in range(0, 4000)] + [D - H, D - H + 1e-6, 1e3, 1e4, 1e6]
                S, rs, rh = best_response_linear(g, H, D, Hbar, [s for s in S_grid if s >= 0])
                frac = 1.0 if H == 0 else rh / H
                delta = alpha * H - B + rs
                if frac < worst["min_honest_frac"] - 1e-9 or delta > worst["max_delta"] + 1e-9:
                    pass
                if frac < worst["min_honest_frac"]:
                    worst["min_honest_frac"] = frac
                    worst["where"] = dict(lam=lam, H=round(H, 3), S=round(S, 3), Rs=round(rs, 4), delta=round(delta, 4))
                worst["max_delta"] = max(worst["max_delta"], delta)
        out[name] = worst
    # FIFO
    w = {"min_honest_frac": 1.0, "max_delta": -1e9}
    for H in [D * f for f in (0.1, 0.5, 1.0)]:
        S = D
        rs, rh = sybil_take_fifo(H, S, D)
        w["min_honest_frac"] = min(w["min_honest_frac"], rh / H)
        w["max_delta"] = max(w["max_delta"], alpha * H - B + rs)
    out["fifo"] = w
    return D, out


def g_star(N, D, Hbar):
    return 1.0 if N <= D else (D - Hbar) / (N - Hbar)


def run_T2(trials=4000, seed=1):
    """Random anonymous linear rules on an integer grid (units). Classify rational safety by brute force
    and test the characterisation: safe  <=>  g(N) <= g*(N) for all N>D (with ties -> unsafe for strict)."""
    rng = random.Random(seed)
    agree = 0
    counter = []
    for t in range(trials):
        d = rng.randint(4, 30)
        hbar = rng.randint(0, d - 1)
        Nmax = d * 6
        # random rule: budget-feasible g(N) in [0, d/N], arbitrary (not even monotone)
        g = {N: (1.0 if N <= d else rng.random() * (d / N) * (rng.choice([0.3, 1.0]))) for N in range(0, Nmax + 1)}
        # sometimes push a rule exactly onto / just under g*
        if rng.random() < 0.3:
            for N in range(d + 1, Nmax + 1):
                g[N] = min(g[N], g_star(N, d, hbar) * (1 - 1e-6))
        # brute-force rational safety (strict): for all H<=hbar, all S with H+S in (d, Nmax]: S*g < d-H
        safe = True
        for H in range(0, hbar + 1):
            for N in range(d + 1, Nmax + 1):
                S = N - H
                if S * g[N] >= (d - H) - 1e-12 and not (S * g[N] == 0 and d - H == 0):
                    # note: if d-H == 0 and S*g == 0 the attacker is indifferent but honest unpaid -> unsafe as well
                    safe = False
                    break
            if not safe:
                break
        # characterisation
        pred = all(g[N] < g_star(N, d, hbar) - 1e-15 for N in range(d + 1, Nmax + 1))
        if hbar == d:  # never generated
            pass
        agree += (safe == pred)
        if safe != pred and len(counter) < 5:
            counter.append(dict(d=d, hbar=hbar))
    return dict(trials=trials, agree=agree, counterexamples=counter)


def run_T3(B=10.0, beta=0.25):
    D = (1 - beta) * B
    rows = []
    for lam in (1.25, 2.0, 4.0, 10.0):
        Hbar = D / lam
        H = Hbar
        worst_ratio = 1e9
        for S in [0.5, 1, 2, 5, 10, 30, 100, 1e3, 1e4, 1e5]:
            N = H + S
            spr = g_spr(N, D, Hbar=Hbar)
            pr = g_prorata(N, D)
            fob = g_fob(N, D)
            worst_ratio = min(worst_ratio, spr / pr)
            rows.append(dict(lam=lam, S=S, honest_frac_spr=round(spr, 5), honest_frac_prorata=round(pr, 5),
                             honest_frac_fob=fob))
        assert worst_ratio >= (1 - 1 / lam) - 1e-6, (lam, worst_ratio)
    return rows


def run_T4(trials=20000, seed=7, alpha=1.0):
    """Unequal claim sizes; attacker optimiser over Sybil split (number and sizes) by random search + greedy."""
    rng = random.Random(seed)
    viol = {"spr": 0, "fob": 0, "prorata": 0, "smallfirst": 0}
    honest_short = {k: 0 for k in viol}
    for t in range(trials):
        B = rng.uniform(1, 20)
        beta = rng.choice([0.0, 0.1, 0.25, 0.5])
        D = (1 - beta) * B
        lam = rng.choice([1.0, 1.5, 2.0, 3.0])
        Hbar = D / lam
        nh = rng.randint(1, 12)
        raw = [rng.random() for _ in range(nh)]
        Ht = rng.uniform(0, Hbar)
        hon = [Ht * r / sum(raw) for r in raw]
        H = sum(hon)
        # attacker search over S (linear rules only depend on total S)
        cand_S = [0, max(0.0, D - H)] + [rng.uniform(0, 5 * D) for _ in range(60)] + [D - H + 1e-6, 10 * D, 1e3 * D]
        for name in ("spr", "fob", "prorata"):
            g = LINEAR[name] if name != "spr" else g_spr
            S, rs, rh = best_response_linear(g, H, D, Hbar, [s for s in cand_S if s >= 0])
            if rh < H - 1e-7:
                honest_short[name] += 1
            if alpha * H - B + rs > -beta * B + 1e-7:
                viol[name] += 1
        # smallest-first: attacker splits its Sybil claims into dust below the smallest honest claim
        mn = min(hon)
        k = int(D / (mn * 0.999)) + 1
        syb = [mn * 0.999] * k
        rs, rh = sybil_take_smallfirst(hon, syb, D)
        if rh < H - 1e-7:
            honest_short["smallfirst"] += 1
        if alpha * H - B + rs > -beta * B + 1e-7:
            viol["smallfirst"] += 1
    return dict(trials=trials, profit_above_minus_betaB=viol, honest_not_fully_paid_at_best_response=honest_short)


if __name__ == "__main__":
    D, t1 = run_T1()
    print("== T1 rational attacker, B=10, beta=0.25, D=%.2f, alpha=1, lambda=D/Hbar in {1.25,2,4}, H<=Hbar ==" % D)
    for k, v in t1.items():
        print(f"  {k:10s} worst honest fraction at attacker best response = {v['min_honest_frac']:.4f}; "
              f"max excess profit = {v['max_delta']:.4f}; where={v.get('where')}")
    D, t1b = run_T1(lams=(1.0,))
    print("== T1b same, lambda=1 (Hbar=D: no slack; adversarial tie-breaking) ==")
    for k, v in t1b.items():
        print(f"  {k:10s} worst honest fraction = {v['min_honest_frac']:.4f}; max excess profit = {v['max_delta']:.4f}; where={v.get('where')}")
    t2 = run_T2()
    print("== T2 characterisation (safe <=> g < g* pointwise) on random rules ==")
    print("  ", t2)
    t3 = run_T3()
    print("== T3 spiteful attacker, honest at H=Hbar: honest per-wei payout ==")
    for r in t3:
        if r["S"] in (1, 10, 100, 1e4):
            print("  ", r)
    t4 = run_T4()
    print("== T4 random unequal claims, attacker search ==")
    print("  ", json.dumps(t4))
