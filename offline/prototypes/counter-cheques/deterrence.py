"""
deterrence.py -- closed forms + numeric checks for seam D (economics).

  S1  worked collateral numbers: v=0.1 ETH, 20 payments/day, 1-day sync (+1-day claim window)
  S2  identity escrow + debt-follows-identity lien + damage-increasing enforcement: max profit over k
  S3  insurance mutual: Sybil-claimant bound and Bernstein reserve vs Monte Carlo
  S4  polynomial tranche reveal (degree-j shares) -- algebra + the "fork every slot exactly j times" game
  S5  velocity lower bound sanity check
All parameters marked ASSUMPTION are scenario inputs, not facts.
"""
import math, random, json
import numpy as np

v, n_day, T_sync, T_ch = 0.1, 20, 1.0, 1.0

print("== S1 collateral / UX (v=0.1, 20 pay/day, sync 1 d, claim window 1 d) ==")
spend_day = v * n_day
L = n_day * T_sync
print(f"honest spend per epoch = {spend_day:.2f} ETH, counter budget L = {L:.0f}")
print(f"[H-tier] deposit W = L*v_max = {L*v:.2f} ETH (= the user's own offline balance; locked epoch+T_ch)")
print(f"[H-tier] velocity lower bound (any scheme, full coverage): (L-1)*v = {(L-1)*v:.2f} ETH")
print(f"[N1]    slot capital ~ onward spend * (D+T_ch) = {spend_day*(T_sync+T_ch):.2f} ETH (innovation note formula)")
print("[C-tier] bond for reach Kbar with SPR slack lam, burn beta, cap c=v (alpha=1):")
print("   Kbar  lam  beta   B_comp=lam*Kbar*c/(1-beta)   B_deter=alpha*Kbar*c/beta   B=max   B/spend_day")
for Kbar in (5, 10, 20, 50, 200, 1000):
    for lam, beta in ((2.0, 0.25), (1.25, 0.5)):
        bc = lam * Kbar * v / (1 - beta)
        bd = 1.0 * Kbar * v / beta
        print(f"   {Kbar:5d} {lam:4.2f} {beta:5.2f}   {bc:10.2f}                   {bd:10.2f}             {max(bc,bd):8.2f}  {max(bc,bd)/spend_day:6.1f}x")
print("   note: with SPR the rational profit is already <= -beta*B whenever Kbar*c <= D/lam, so B_deter")
print("   is only needed for the regime K>Kbar; B=B_comp suffices inside the reach assumption.")

print("\n== S2 identity escrow + lien + enforcement curve p_e(D)=p_max*min(1,D/D0) ==")
def max_profit(alpha, B, Vf, p_max, D0, rho, F=0.0, Dmax=1e4):
    Ds = np.concatenate([np.linspace(0, 50, 50001), np.geomspace(50, Dmax, 2000)])
    pe = p_max * np.minimum(1.0, Ds / D0)
    prof = alpha * Ds - B - np.minimum(Vf, Ds) - pe * (rho * Ds + F)
    i = int(np.argmax(prof))
    tail = (alpha - p_max * rho)  # slope for D > D0
    return prof[i], Ds[i], tail
print(" alpha  B   Vf  p_max  D0  rho | max profit over D in [0,1e4] ETH | argmax D | slope beyond D0 | closed form a^2 D0/(4 p rho) - B - Vf")
rows = []
for alpha in (1.0, 0.6):
    for (B, Vf) in ((1.0, 0.0), (1.0, 1.0), (2.0, 2.0)):
        for (p_max, D0, rho) in ((1.0, 5.0, 1.0), (1.0, 20.0, 1.0), (0.5, 5.0, 1.0), (0.8, 5.0, 1.0), (0.3, 5.0, 1.0)):
            mp, dstar, tail = max_profit(alpha, B, Vf, p_max, D0, rho)
            cf = alpha**2 * D0 / (4 * p_max * rho) - B - Vf if alpha <= 2 * p_max * rho else float('nan')
            print(f" {alpha:4.1f} {B:4.1f} {Vf:4.1f} {p_max:5.2f} {D0:4.0f} {rho:4.1f} | {mp:12.3f} | {dstar:9.2f} | {tail:6.2f} | {cf:8.3f}")
print(" constant p_e (k* formula generalised with lien Vf, alpha):  k* = 1 + (B+Vf+p_e F)/(v (alpha - p_e rho))")
for pe in (0.0, 0.1, 0.3, 0.5, 0.9):
    for alpha in (1.0, 0.6):
        den = v * (alpha - pe * 1.0)
        ks = float('inf') if den <= 0 else 1 + (1.0 + 1.0 + pe * 0) / den
        print(f"   p_e={pe:.1f} alpha={alpha:.1f} B=1 Vf=1 -> k* = {ks}")

print("\n== S3 insurance mutual ==")
print(" Lemma check: attacker forks only to s own Sybil claimants (h=0). Mutual pays m per claimant beyond the")
print(" culprit forfeiture F; each fake claimant costs c_s.  net = s*(m - c_s) + (Sybil share of F) - F")
for m, cs in ((0.1, 0.0), (0.1, 0.05), (0.1, 0.1), (0.1, 0.2)):
    nets = [s * (m - cs) for s in (1, 10, 100, 1000)]
    print(f"   m={m} c_s={cs}: net (excl. forfeiture, which Sybils recover under any budget-filling rule) for s=1,10,100,1000 -> {nets}")
# Bernstein reserve vs MC, per-event loss capped at ell_max
rng = np.random.default_rng(3)
def mc_annual(lam_year, ell_max, mean_k, trials=200000):
    n = rng.poisson(lam_year, trials)
    tot = np.zeros(trials)
    maxn = n.max()
    # per-event uncovered loss X = min(ell_max, c * G) with G ~ geometric(mean mean_k)  [ASSUMPTION]
    p = 1.0 / mean_k
    G = rng.geometric(p, size=(trials, maxn))
    X = np.minimum(ell_max, v * G)
    mask = np.arange(maxn)[None, :] < n[:, None]
    tot = (X * mask).sum(axis=1)
    EX = X[mask].mean() if mask.any() else 0
    EX2 = (X[mask] ** 2).mean() if mask.any() else 0
    return tot, EX, EX2
print(" lam/yr ell_max mean_K | E[S]   MC q99.9  Bernstein R(1e-3) | per-merchant premium (10k merchants)")
for lam_year, ell_max, mean_k in ((20, 2.0, 10), (70, 2.0, 30), (70, 10.0, 30), (365, 10.0, 30)):
    tot, EX, EX2 = mc_annual(lam_year, ell_max, mean_k)
    ES = lam_year * EX
    var = lam_year * EX2
    d = 1e-3
    t = (ell_max * math.log(1/d) / 3) + math.sqrt((ell_max * math.log(1/d) / 3) ** 2 + 2 * var * math.log(1/d))
    print(f" {lam_year:6.0f} {ell_max:7.1f} {mean_k:6.0f} | {ES:7.2f} {np.quantile(tot, 0.999):8.2f} {ES + t:10.2f} | {ES/1e4*1e3:.3f} mETH/yr")

print("\n== S4 polynomial tranche reveal (prime field) ==")
P = 2**61 - 1
def ev(coefs, x):
    r = 0
    for c in reversed(coefs):
        r = (r * x + c) % P
    return r
def interp0(pts):
    # Lagrange at 0
    s = 0
    for i, (xi, yi) in enumerate(pts):
        num, den = 1, 1
        for j, (xj, _) in enumerate(pts):
            if i != j:
                num = num * (-xj) % P
                den = den * (xi - xj) % P
        s = (s + yi * num * pow(den, P - 2, P)) % P
    return s
rr = random.Random(5)
m = 6
polys = {j: [rr.randrange(P) for _ in range(j + 1)] for j in range(1, m + 1)}  # tranche j: degree j, key = f_j(0)
ok = True
for k in range(1, m + 2):
    xs = [rr.randrange(1, P) for _ in range(k)]
    unlocked = []
    for j in range(1, m + 1):
        if k >= j + 1:
            rec = interp0([(x, ev(polys[j], x)) for x in xs[: j + 1]])
            ok &= rec == polys[j][0]
            unlocked.append(j)
    print(f"  {k} spends -> tranches unlocked {unlocked} (count {len(unlocked)} = k-1 capped at m)")
print("  reconstruction correct:", ok)
print("  game: identity encrypted under tranche j0's key; attacker forks n_slots slots exactly j0 times each")
for j0, nslots, u in ((2, 20, 0.1), (3, 20, 0.1)):
    forks = nslots * (j0 - 1)
    print(f"   j0={j0}: {forks} extra spends with no identity reveal; tranche capital forfeited = {forks*u:.1f} ETH if each "
          f"tranche is pre-funded with u={u} -> profit = forks*(v-u) = {forks*(v-u):.2f}; capital needed per slot = {(j0-1)*u:.1f}")

print("\n== S5 velocity lower bound: attacker with ONE coin v and counter budget L gets L acceptances ==")
for Lb in (5, 20, 100):
    print(f"   L={Lb}: unbacked exposure = (L-1)*v = {(Lb-1)*v:.1f} ETH -> collateral needed for full coverage")
