"""Zone-committee sweep: coins are 'homed' to a fixed zone (an L x L square market block) whose
bonded witnesses form the committee. Densities 2,000 / 10,000 / 20,000 stalls per km^2
(1 stall per 500 / 100 / 50 m^2) [CONJECTURE: realistic Indian bazaar density is not measured here].
Witness pool = 10% of stalls (min 10); committee n=7 (f=2, q=5) drawn from the pool.
Same radio/latency assumptions as market_quorum_sim.py (FAST: 20-120 ms/hop, SLOW: 200-1000 ms/hop).
Also reports median certificate latency over certified payments.
"""
import numpy as np
import market_quorum_sim as M

def run_lat(scn, topologies=4, payments=250):
    p = scn; lat = []; tot = 0; ok = 0
    for _ in range(topologies):
        N = p["N"]; pos = M.rng.uniform(0, p["L"], (N, 2)); adj = M.build_graph(pos, p["R"])
        pool = np.arange(p["W"])
        for _ in range(payments):
            n = p["n"]; q = 2 * ((n - 1) // 3) + 1
            alive = M.rng.random(N) < p["p_relay"]
            com = M.rng.choice(pool, n, replace=False); up = M.rng.random(n) < p["p_on"]
            alive[com] = up
            r = int(M.rng.integers(p["W"], N)); alive[r] = True
            d = M.bfs(adj, r, alive)
            ts = sorted(M.hop_delay(d[int(w)], p) * 2 + p["proc_ms"] for w, u in zip(com, up) if u and int(w) in d)
            tot += 1
            if len(ts) >= q:
                ok += 1; lat.append(ts[q - 1])
    lat = np.array(lat)
    f = lambda x: (lat <= x).sum() / tot
    return ok / tot, (np.median(lat) if len(lat) else float("nan")), f(1000), f(2000), f(5000)

print(__doc__)
print(f"{'zone':>6} {'dens/km2':>8} {'N':>5} {'R':>4} {'hops':>5}  {'cert':>6} {'p50ms':>7} {'<=1s':>6} {'<=2s':>6} {'<=5s':>6}")
for speed, extra in (("FAST", {}), ("SLOW", M.SLOW)):
    print(f"-- {speed} per-hop latency --")
    for L in (100.0, 200.0, 300.0):
        for dens in (2000, 10000, 20000):
            N = int(dens * (L / 1000) ** 2)
            for R in (10.0, 20.0, 30.0):
                scn = M.BASE | extra | dict(L=L, N=N, W=max(10, N // 10), R=R, n=7)
                c, p50, a, b, e = run_lat(scn, topologies=3, payments=150)
                print(f"{int(L):5d}m {dens:8d} {N:5d} {int(R):4d} {'':>5}  {c:6.3f} {p50:7.0f} {a:6.3f} {b:6.3f} {e:6.3f}", flush=True)
