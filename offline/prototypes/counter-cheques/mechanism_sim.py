"""
mechanism_sim.py -- adversarial strategy search against the combined Prawl incentive mechanism.

Economic abstraction (crypto is assumed sound: forks are detected and attributed; slot reuse is
extractable; see formal_limits.md Thm 5).  One attacker coalition = one culprit bond P plus free Sybils
plus free device clones.  Honest parties follow the protocol.

Mechanism knobs
  n1      : Endorsed Notes (per-output exclusive collateral slot + atomic recourse).  If off, the C1 prototype
            rule applies: the final holder of a dishonoured branch claims against the culprit's slashed bond.
  rule    : payout of the culprit reserve: 'fifo' (attacker front-runs), 'prorata', 'fob', 'spr'
  cap c   : each honest recipient accepts at most c from bond P per epoch (bond-proportional cap)
  K       : physical reach = # distinct honest recipients the coalition can get to accept (assumption)
  hw      : counter tier: bond P's signing key can produce at most L signatures per epoch (each output
            consumes one counter value, recipients reject counter > L); outputs are counter-exclusive,
            i.e. slot reuse is impossible, and deposit W >= L*v backs every counter slot.
  ident   : expected extrinsic penalty after attribution (identity escrow): pen(Dmg)

Attacker strategy (genome): list of coins; coin i (value v, attacker pays v of real escrow for it) is forked
into h_i honest branches + s_i Sybil branches with slot policy 'reuse' (one slot for all branches) or
'distinct' (fresh culprit-funded slot per branch).  The attacker always lets a Sybil branch redeem the coin
escrow first when it has one, and its Sybil claims are first in FIFO order.  For value-linear payout rules
these choices are WLOG (payout depends only on totals); for FIFO they are the adversarial order.
Honest direct counterparties pass the note on through a random honest chain (depth 0..3) to test
downstream immunity.

Attacker objective
  rational : maximise excess profit  Delta = alpha*goods_from_honest + payouts_to_sybils
                                           - escrow_bought - bond_forfeited - slot_capital_forfeited - penalty
  spiteful : maximise total honest loss (profit ignored)
Search: random sampling, greedy hill-climb, simulated annealing (all three, per scenario).
"""
import random, math, json, itertools
from dataclasses import dataclass, field

EPS = 1e-9


@dataclass
class Cfg:
    v: float = 0.1          # coin / branch value (ETH)
    c: float = 0.1          # per-recipient cap per bond per epoch
    K: int = 10             # reach (distinct honest acceptors)
    B: float = 2.67         # culprit bond (seizable)
    beta: float = 0.25      # burn fraction
    lam: float = 2.0        # SPR slack: Hbar = D/lam
    rule: str = "spr"
    n1: bool = True
    hw: bool = False
    L: int = 20             # counter budget per epoch (hw)
    alpha: float = 1.0      # fence value of goods (1 = worst case)
    pen: object = None      # function(dmg) -> expected extrinsic penalty, or None
    max_coins: int = 40


def payout(rule, claims, D, Hbar):
    """claims: list of (amount, is_sybil) in arrival order (sybils first = adversarial). returns list paid."""
    N = sum(a for a, _ in claims)
    if N <= D + EPS:
        return [a for a, _ in claims]
    if rule == "fifo":
        left, out = D, []
        for a, _ in claims:
            p = min(a, left); left -= p; out.append(p)
        return out
    if rule == "prorata":
        return [a * D / N for a, _ in claims]
    if rule == "fob":
        return [0.0 for _ in claims]
    if rule == "spr":
        g = max(0.0, (D - Hbar) / (N - Hbar + 1e-12))
        return [a * g for a, _ in claims]
    raise ValueError(rule)


def evaluate(cfg: Cfg, genome, rng):
    """genome: list of (h, s, policy). returns dict with Delta, honest_loss, downstream_loss, honest_goods."""
    v = cfg.v
    honest_used = sum(h for h, _, _ in genome)
    if honest_used > cfg.K * max(1, int(cfg.c / v + EPS)):
        return None
    if cfg.hw and sum(h + s for h, s, _ in genome) > cfg.L:
        return None
    D = (1 - cfg.beta) * cfg.B
    Hbar = D / cfg.lam
    att = 0.0              # attacker cash flow
    honest_net = 0.0       # sum over honest parties (direct + downstream)
    downstream_loss = 0.0
    goods = 0.0
    slot_capital = 0.0
    nh_claims = 0          # honest claims of value v against the culprit reserve
    ns_claims = 0          # sybil claims of value v (always first in FIFO order)
    n_down = 0             # honest claims whose loss sits with a downstream holder (no-N1 accounting)
    forked = False
    reuse_any = False
    for (h, s, pol) in genome:
        if h + s == 0:
            continue
        att -= v                      # buys the coin's escrow
        nb = h + s
        if nb >= 2:
            forked = True
        if cfg.hw:
            pol = "distinct"          # counter slots are exclusive by hardware
        if pol == "reuse" and nb >= 2:
            reuse_any = True
        # honest branches: goods to attacker
        att += cfg.alpha * h * v
        goods += h * v
        honest_net -= h * v           # honest recipients hand over goods
        # winner of escrow
        if s > 0:
            att += v                  # sybil redeems first
            sy_left, h_left = s - 1, h
        else:
            honest_net += v           # one honest branch redeems
            sy_left, h_left = 0, h - 1
        # dishonoured branches: h_left honest, sy_left sybil
        if h_left == 0 and sy_left == 0:
            continue
        # downstream: each dishonoured honest branch may have been passed on
        if pol == "distinct":
            # each branch has its own culprit-funded slot of capacity v; paid in full
            slot_capital += v * (h_left + sy_left)
            att -= v * (h_left + sy_left)        # slot capital spent
            att += v * sy_left                   # ...but sybil slots return to attacker
            honest_net += v * h_left
            continue
        # reused slot (capacity v, culprit-funded once)
        slot_capital += v
        att -= v
        slot_paid_to_sybil = sy_left > 0
        if slot_paid_to_sybil:
            att += v; sy_left -= 1
        else:
            honest_net += v; h_left -= 1
        # each remaining honest branch claims v against the reserve. With N1 the final holder is repaid by the
        # honest direct counterparty's exclusive slot and the direct counterparty claims (net-equivalent);
        # without N1 the final holder claims and, if the note was passed on (depth>0), the loss is downstream.
        nh_claims += h_left
        if not cfg.n1:
            n_down += sum(1 for _ in range(h_left) if rng.random() < 0.6)   # P(depth>0) = 3/5
        ns_claims += sy_left
    # slash & reserve
    dmg_honest_unpaid = 0.0
    if forked:
        att -= cfg.B
        N = (nh_claims + ns_claims) * v
        if N <= D + EPS:
            ph, ps = v, v
        elif cfg.rule == "fifo":
            ps_tot = min(ns_claims * v, D)
            ph_tot = min(nh_claims * v, D - ps_tot)
            ps = ps_tot / ns_claims if ns_claims else 0.0
            ph = ph_tot / nh_claims if nh_claims else 0.0
        else:
            frac = payout(cfg.rule, [(N, False)], D, Hbar)[0] / N
            ph = ps = v * frac
        att += ns_claims * ps
        honest_net += nh_claims * ph
        dmg_honest_unpaid = nh_claims * (v - ph)
        if not cfg.n1:
            downstream_loss = n_down * (v - ph)
        if cfg.pen is not None:
            att -= cfg.pen(dmg_honest_unpaid, reuse_any)
    return dict(Delta=att, honest_loss=-honest_net, downstream_loss=downstream_loss, goods=goods,
                slot_capital=slot_capital, forked=forked)


def mean_eval(cfg, genome, seed, reps=1):
    rs = [evaluate(cfg, genome, random.Random(seed + r)) for r in range(reps)]
    if rs[0] is None:
        return None
    return {k: sum(r[k] for r in rs) / reps for k in ("Delta", "honest_loss", "downstream_loss", "goods")}


def objective(res, mode):
    if res is None:
        return -1e18
    return res["Delta"] if mode == "rational" else res["honest_loss"] + 1e-6 * res["Delta"]


def random_genome(cfg, rng):
    n = rng.randint(1, cfg.max_coins)
    g, budget = [], cfg.K
    for _ in range(n):
        h = rng.randint(0, max(0, min(budget, rng.choice([1, 2, 5, 20, cfg.K]))))
        budget -= h
        s = rng.choice([0, 0, 1, 2, 5, 20, 100])
        g.append((h, s, rng.choice(["reuse", "distinct"])))
    if cfg.hw:
        while sum(h + s for h, s, _ in g) > cfg.L and g:
            h, s, p = g[-1]
            if s > 0: g[-1] = (h, s - 1, p)
            elif h > 0: g[-1] = (h - 1, s, p)
            else: g.pop()
    return g


def neighbours(cfg, g, rng):
    g = list(g)
    op = rng.randrange(7)
    if op == 0 or not g:
        g.append((rng.randint(0, 3), rng.randint(0, 3), rng.choice(["reuse", "distinct"])))
    else:
        i = rng.randrange(len(g)); h, s, p = g[i]
        if op == 1: h += 1
        elif op == 2: h = max(0, h - 1)
        elif op == 3: s += rng.choice([1, 1, 2, 10])
        elif op == 4: s = max(0, s - rng.choice([1, 1, 2, 10]))
        elif op == 5: p = "distinct" if p == "reuse" else "reuse"
        elif op == 6: g.pop(i); return g
        g[i] = (h, s, p)
    return g


def search(cfg, mode, seed=0, n_random=200, n_anneal=800):
    rng = random.Random(seed)
    best = (None, -1e18, None)
    # random
    for t in range(n_random):
        g = random_genome(cfg, rng)
        r = mean_eval(cfg, g, seed + t)
        o = objective(r, mode)
        if o > best[1]:
            best = (g, o, r)
    # greedy from empty (structured actions)
    g = []
    cur = objective(mean_eval(cfg, [(0, 0, "reuse")], seed), mode)
    improved = True
    while improved and len(g) < 60:
        improved = False
        cands = [g + [(1, 0, "reuse")], g + [(1, 1, "reuse")], g + [(cfg.K - sum(x[0] for x in g), 1, "reuse")]]
        for i in range(len(g)):
            h, s, p = g[i]
            for nh, ns in ((h + 1, s), (h, s + 1), (h, s + 10), (h, max(0, s - 1))):
                cands.append(g[:i] + [(nh, ns, p)] + g[i + 1:])
        sc = [(objective(mean_eval(cfg, c_, seed), mode), c_) for c_ in cands]
        o, c_ = max(sc, key=lambda t: t[0])
        if o > cur + 1e-9:
            cur, g, improved = o, c_, True
    r = mean_eval(cfg, g, seed)
    if objective(r, mode) > best[1]:
        best = (g, objective(r, mode), r)
    # anneal from best
    g = best[0] or []
    cur = best[1]
    T0 = 0.5
    for t in range(n_anneal):
        T = T0 * (1 - t / n_anneal) + 1e-4
        ng = neighbours(cfg, g, rng)
        r = mean_eval(cfg, ng, seed + 7)
        o = objective(r, mode)
        if o > cur or rng.random() < math.exp((o - cur) / T) if o > -1e17 else False:
            g, cur = ng, o
            if o > best[1]:
                best = (ng, o, r)
    return best


def summarize(g):
    if not g:
        return "[]"
    H = sum(h for h, _, _ in g); S = sum(s for _, s, _ in g)
    reuse = sum(1 for h, s, p in g if p == "reuse" and h + s >= 2)
    return f"coins={len(g)} honest_branches={H} sybil_branches={S} reuse_coins={reuse}"


def scenario(name, cfg, seeds=(1, 2, 3)):
    out = {"name": name}
    for mode in ("rational", "spiteful"):
        worst = None
        for sd in seeds:
            g, o, r = search(cfg, mode, seed=sd)
            if worst is None or o > worst[1]:
                worst = (g, o, r)
        g, o, r = worst
        out[mode] = dict(Delta=round(r["Delta"], 4), honest_loss=round(r["honest_loss"], 4),
                         downstream_loss=round(r["downstream_loss"], 4), goods=round(r["goods"], 3),
                         strategy=summarize(g))
    return out


class pen_identity:
    """expected extrinsic penalty after identity reveal: lien min(Vf, dmg) + p_e(dmg)*rho*dmg,
    p_e(dmg) = p_max*min(1, dmg/D0)  [ASSUMPTION: enforcement curve]"""
    def __init__(self, p_max=1.0, D0=5.0, rho=1.0, Vf=0.0):
        self.p_max, self.D0, self.rho, self.Vf = p_max, D0, rho, Vf

    def __call__(self, dmg, revealed):
        if not revealed or dmg <= 0:
            return 0.0
        pe = self.p_max * min(1.0, dmg / self.D0)
        return min(self.Vf, dmg) + pe * self.rho * dmg


def _run(args):
    name, cfg = args
    return scenario(name, cfg, seeds=(1, 2))


if __name__ == "__main__":
    import multiprocessing as mp
    base = dict(v=0.1, c=0.1, B=2.67, beta=0.25, lam=2.0)   # D = 2.0, Hbar = 1.0 = K*c for K=10
    jobs = [
        ("C-tier N1+SPR, K=10 (within Kbar=10)", Cfg(**base, K=10, rule="spr")),
        ("C-tier N1+FoB, K=10", Cfg(**base, K=10, rule="fob")),
        ("C-tier N1+prorata, K=10", Cfg(**base, K=10, rule="prorata")),
        ("C-tier N1+FIFO, K=10", Cfg(**base, K=10, rule="fifo")),
        ("C1 prototype (no N1) + FIFO, K=10", Cfg(**base, K=10, rule="fifo", n1=False)),
        ("C-tier N1+SPR, K=40 (reach exceeds Kbar)", Cfg(**base, K=40, rule="spr")),
        ("C-tier N1+SPR, K=200", Cfg(**base, K=200, rule="spr")),
        ("C-tier N1+SPR, K=200, alpha=0.6", Cfg(**base, K=200, rule="spr", alpha=0.6)),
        ("C-tier N1+SPR+identity (p_max=1,D0=5,rho=1), K=1000", Cfg(**base, K=1000, rule="spr", pen=pen_identity(1.0, 5.0, 1.0))),
        ("C-tier N1+SPR+identity (p_max=0.5,D0=5,rho=1), K=1000", Cfg(**base, K=1000, rule="spr", pen=pen_identity(0.5, 5.0, 1.0))),
        ("H-tier counter L=20, W=2.0, K=1000", Cfg(v=0.1, c=0.1, B=0.0, beta=0.0, lam=1.0001, K=1000, rule="spr", hw=True, L=20)),
        ("H-tier BROKEN -> C-tier with B=W=2.0, K=1000", Cfg(v=0.1, c=0.1, B=2.0, beta=0.25, K=1000, rule="spr", hw=False)),
        ("H-tier BROKEN -> C-tier with B=W=2.0, K=7 (within fallback Kbar=7.5)", Cfg(v=0.1, c=0.1, B=2.0, beta=0.25, K=7, rule="spr", hw=False)),
    ]
    with mp.get_context("fork").Pool(min(len(jobs), 8)) as pool:
        for r in pool.imap(_run, jobs):
            print(json.dumps(r), flush=True)
