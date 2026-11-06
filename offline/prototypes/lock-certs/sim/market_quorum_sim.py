"""Market simulation: can an offline recipient collect a 2f+1-of-3f+1 lock certificate
from its coin's witness committee over a multi-hop BLE mesh of merchant phones?

ALL parameters below are assumptions (labelled [CONJECTURE] in the notes), not measurements:
  * merchants placed uniformly at random in an L x L square (default 1 km^2, N = 2000)
    or on a 1-D "street" (both sides of a 1 km road, N stalls)
  * unit-disk radio: two phones are linked iff distance <= R (R in {10, 30, 60} m)
  * each phone is awake/relaying with prob p_relay; each committee witness is up with p_on
  * witness pool: the first W merchants (random positions) are bonded witnesses;
    the committee of n for a coin is n distinct pool members sampled uniformly
    (stands in for "sampled by H(nf || epoch beacon)")
  * per-hop one-way delay ~ Uniform(hop_lo, hop_hi) ms plus, with prob p_loss, a
    retransmission adding retry_ms (repeated geometrically)
  * witness processing = proc_ms (sign + durable write)
  * request and response each traverse the BFS shortest path (hop count h)
  * certificate time = q-th smallest response time over reachable, up committee members
Output: fraction of payments certified within 1 s / 2 s / 5 s / ever, mean hops.
"""
import sys
import numpy as np
from collections import deque

rng = np.random.default_rng(20261106)


def build_graph(pos, R):
    # grid bucketing for neighbour search
    cell = R
    keys = np.floor(pos / cell).astype(int)
    buckets = {}
    for i, k in enumerate(map(tuple, keys)):
        buckets.setdefault(k, []).append(i)
    adj = [[] for _ in range(len(pos))]
    R2 = R * R
    for (cx, cy), members in buckets.items():
        cand = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                cand.extend(buckets.get((cx + dx, cy + dy), []))
        cand = np.array(cand)
        for i in members:
            d = ((pos[cand] - pos[i]) ** 2).sum(1)
            for j in cand[(d <= R2) & (cand != i)]:
                adj[i].append(int(j))
    return adj


def bfs(adj, src, alive):
    dist = {src: 0}
    dq = deque([src])
    while dq:
        u = dq.popleft()
        for v in adj[u]:
            if alive[v] and v not in dist:
                dist[v] = dist[u] + 1
                dq.append(v)
    return dist


def hop_delay(nhops, p):
    if nhops == 0:
        return 0.0
    base = rng.uniform(p["hop_lo"], p["hop_hi"], nhops).sum()
    retries = rng.geometric(1 - p["p_loss"], nhops) - 1  # number of retransmissions per hop
    return base + retries.sum() * p["retry_ms"]


def run(scn, topologies=4, payments=250):
    p = scn
    res = {"t1": 0, "t2": 0, "t5": 0, "ever": 0, "hops": [], "total": 0}
    for _ in range(topologies):
        N = p["N"]
        if p["geom"] == "square":
            pos = rng.uniform(0, p["L"], (N, 2))
        else:  # street: two rows 10 m apart along a 1 km road
            x = rng.uniform(0, p["L"], N)
            y = rng.choice([0.0, 10.0], N)
            pos = np.stack([x, y], 1)
        adj = build_graph(pos, p["R"])
        pool = np.arange(p["W"])  # positions are random, so first W are a random subset
        for _ in range(payments):
            n, q = p["n"], 2 * ((p["n"] - 1) // 3) + 1
            alive = rng.random(N) < p["p_relay"]
            committee = rng.choice(pool, n, replace=False)
            up = rng.random(n) < p["p_on"]
            alive[committee] = up  # a down witness neither relays nor signs
            recipient = int(rng.integers(p["W"], N))  # a non-witness merchant
            alive[recipient] = True
            dist = bfs(adj, recipient, alive)
            times = []
            for w, u in zip(committee, up):
                if u and int(w) in dist:
                    h = dist[int(w)]
                    res["hops"].append(h)
                    t = hop_delay(h, p) + p["proc_ms"] + hop_delay(h, p)
                    times.append(t)
            res["total"] += 1
            if len(times) >= q:
                tq = sorted(times)[q - 1]
                res["ever"] += 1
                res["t1"] += tq <= 1000
                res["t2"] += tq <= 2000
                res["t5"] += tq <= 5000
    T = res["total"]
    mh = np.mean(res["hops"]) if res["hops"] else float("nan")
    return {k: res[k] / T for k in ("t1", "t2", "t5", "ever")} | {"mean_hops": mh}


BASE = dict(geom="square", L=1000.0, N=2000, R=30.0, W=200, n=7, p_relay=0.8, p_on=0.9,
            hop_lo=20.0, hop_hi=120.0, p_loss=0.1, retry_ms=250.0, proc_ms=15.0)
SLOW = dict(hop_lo=200.0, hop_hi=1000.0, p_loss=0.2, retry_ms=1000.0)

def main():
    scenarios = []
    for N, R in [(2000, 60), (2000, 30), (2000, 20), (1000, 30), (500, 60), (500, 30)]:
        for n in (4, 7, 10):
            scenarios.append((f"square N={N}/km2 R={R}m n={n}", BASE | dict(N=N, R=R, n=n, W=max(40, N // 10))))
    for p_on in (0.95, 0.8, 0.6):
        scenarios.append((f"square N=2000 R=30 n=7 p_on={p_on}", BASE | dict(p_on=p_on)))
    for p_relay in (0.5, 0.3):
        scenarios.append((f"square N=2000 R=30 n=7 p_relay={p_relay}", BASE | dict(p_relay=p_relay)))
    scenarios.append(("square N=2000 R=30 n=7 SLOW hops", BASE | SLOW))
    scenarios.append(("square N=2000 R=60 n=7 SLOW hops", BASE | SLOW | dict(R=60.0)))
    scenarios.append(("street 1km, 600 stalls, R=30 n=7", BASE | dict(geom="street", N=600, W=60, R=30.0)))
    scenarios.append(("street 1km, 600 stalls, R=30 n=7 SLOW", BASE | SLOW | dict(geom="street", N=600, W=60, R=30.0)))
    scenarios.append(("small bazaar 200x200m, 300 stalls, R=30 n=4", BASE | dict(L=200.0, N=300, W=30, n=4)))
    scenarios.append(("small bazaar 200x200m, 300 stalls, R=30 n=7", BASE | dict(L=200.0, N=300, W=30, n=7)))

    print(__doc__)
    print(f"{'scenario':48s} {'<=1s':>6s} {'<=2s':>6s} {'<=5s':>6s} {'ever':>6s} {'hops':>6s}  fallback")
    for name, scn in scenarios:
        r = run(scn)
        print(f"{name:48s} {r['t1']:6.3f} {r['t2']:6.3f} {r['t5']:6.3f} {r['ever']:6.3f} {r['mean_hops']:6.1f}  {1 - r['ever']:.3f}")
        sys.stdout.flush()


if __name__ == '__main__':
    main()
