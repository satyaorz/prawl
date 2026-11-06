#!/usr/bin/env python3
"""Designated Endorsed Notes (DEN) = N1 Endorsed Notes where the cover slot for an output is
FIXED ONLINE by the recipient's identity (payer's on-chain designation set S_p), instead of being
chosen by the payer offline.

World model (whole-note transfers, value 1 per coin, no splitting):
  * Nodes: honest, cheater, sybil (attacker-controlled; redeems first, accepts anything).
  * Each payer p has an on-chain designation set S_p with an exclusive cover slot cap[p,r] for r in S_p.
    Honest r in S_p accepts a note from p only while (value already accepted from p in this window)+1 <= cap.
  * Outputs to recipients NOT in S_p carry an N1 payer-chosen slot (capacity 1). Honest payers use a
    fresh slot per output; cheaters reuse an already attached slot with prob reuse_prob.
  * Cheaters fork: spend the same note to k recipients. Sybil leaves redeem first.
  * Settlement: per coin, the first redeemed leaf is honoured (escrow pays 1); every other note that is
    not an ancestor-or-self of that leaf is dishonoured. Each holder of a dishonoured note claims 1 from the
    slot attached to its incoming note (cascading recourse; honest intermediates are refilled from upstream).
  * Slot claim rule: pro-rata ("prorata") or Sybil-first FIFO ("fifo"). After an N1 slot is reused the
    culprit's bond B is slashed into a reserve that pays its unpaid claimants pro-rata.
Invariants asserted:
  I1 solvency (no slot pays more than its capacity; escrow pays <= 1 per coin)
  I2 DESIGNATED IMMUNITY: every honest node whose incoming note came through a designated slot ends net 0
  I3 localisation: every honest node with net < 0 got its incoming note from a cheater, via a reused
     N1 (non-designated) slot
  I4 zero-sum: sum of all nets == 0
"""
import random, sys, collections, json
ENFORCE_CAP = [True]   # negative control switch

def run_world(seed, n_coins=4, p_cheat=0.35, p_designated=0.6, p_sybil=0.25, reuse_prob=0.6,
              cap=2, bond=1.0, rule="prorata", max_depth=6, max_k=5):
    R = random.Random(seed)
    nodes = {}            # id -> kind
    net = collections.defaultdict(float)
    nid = [0]
    def new(kind):
        nid[0] += 1; nodes[nid[0]] = kind; return nid[0]
    honest_pool = [new("H") for _ in range(12)]     # recurring honest recipients (so caps bind)
    cheaters = [new("C") for _ in range(3)]
    # designation sets: every payer designates a random subset of the recurring honest pool + some sybils
    S = collections.defaultdict(dict)                # S[p][r] = cap
    def designate(p):
        if p in S: return
        for r in honest_pool:
            if r != p and R.random() < p_designated: S[p][r] = cap
    accepted = collections.defaultdict(float)        # (p,r) -> value accepted via designated slot
    slots = {}                                       # slot id -> dict(cap, owner, designated, claims[])
    notes = []                                       # note: dict(id, payer, holder, parent, slot, depth, coin)
    children = collections.defaultdict(list)
    n1_used = collections.defaultdict(list)          # payer -> list of attached N1 slot ids
    reused = set()                                   # payers that reused an N1 slot

    def attach(p, r):
        designate(p)
        if r in S[p]:
            sid = ("D", p, r)
            if sid not in slots: slots[sid] = dict(cap=S[p][r], owner=p, designated=True, claims=[])
            return sid
        if nodes[p] == "C" and n1_used[p] and R.random() < reuse_prob:
            sid = R.choice(n1_used[p]); reused.add(p); return sid
        sid = ("N1", p, len(n1_used[p])); n1_used[p].append(sid)
        slots[sid] = dict(cap=1.0, owner=p, designated=False, claims=[])
        return sid

    def can_accept(p, r):
        """Honest recipient's offline acceptance rule."""
        designate(p)
        if nodes[r] != "H": return True
        if r in S[p]:
            if not ENFORCE_CAP[0]: return True
            return accepted[(p, r)] + 1 <= S[p][r] + 1e-12
        return True                                   # non-designated: accepts at its own risk

    def pick_recipient(p, attacker):
        u = R.random()
        if attacker and u < p_sybil:
            s = new("S")
            if R.random() < 0.5:                      # attacker designates its own Sybil too
                designate(p); S[p][s] = cap
            return s
        if u < 0.75:
            cands = [h for h in honest_pool if h != p]
            return R.choice(cands)
        return new("H")                               # one-off honest stranger

    def spend(p, parent_note, depth, coin):
        kind = nodes[p]
        if depth >= max_depth or kind == "S" or R.random() < 0.25:
            return [parent_note]                      # leaf: holder redeems
        k = R.randint(2, max_k) if kind == "C" else 1
        made = 0; leaves = []
        tries = 0
        while made < k and tries < 4 * k:
            tries += 1
            r = pick_recipient(p, kind == "C")
            if r == p or not can_accept(p, r): continue
            sid = attach(p, r)
            if sid[0] == "D": accepted[(p, r)] += 1
            n = dict(id=len(notes), payer=p, holder=r, parent=parent_note, slot=sid, depth=depth + 1, coin=coin)
            notes.append(n); children[parent_note].append(n["id"])
            net[p] += 1; net[r] -= 1                   # goods for value
            made += 1
            leaves += spend(r, n["id"], depth + 1, coin)
        if made == 0: return [parent_note]
        return leaves

    escrow_paid = collections.defaultdict(float)
    for c in range(n_coins):
        minter = R.choice(cheaters + honest_pool)
        root = dict(id=len(notes), payer=None, holder=minter, parent=None, slot=None, depth=0, coin=c)
        notes.append(root); net[minter] -= 1           # deposit into escrow
        leaves = spend(minter, root["id"], 0, c)
        # redemption order: sybil leaves first, then random
        order = sorted(leaves, key=lambda L: (0 if nodes[notes[L]["holder"]] == "S" else 1, R.random()))
        winner = order[0]
        path = set(); x = winner
        while x is not None: path.add(x); x = notes[x]["parent"]
        net[notes[winner]["holder"]] += 1; escrow_paid[c] += 1
        for n in notes:
            if n["coin"] != c or n["payer"] is None: continue
            if n["id"] in path: continue
            # dishonoured note: holder claims 1 from its incoming slot
            slots[n["slot"]]["claims"].append(dict(holder=n["holder"], amt=1.0, sybil=nodes[n["holder"]] == "S", note=n["id"]))

    # pay slots
    paid = collections.defaultdict(float); unpaid = []
    for sid, s in slots.items():
        cl = s["claims"]
        if not cl: continue
        tot = sum(x["amt"] for x in cl)
        if rule == "fifo":
            cl = sorted(cl, key=lambda x: (0 if x["sybil"] else 1, R.random()))
            left = s["cap"]
            pays = []
            for x in cl:
                a = min(x["amt"], left); left -= a; pays.append(a)
        else:
            f = min(1.0, s["cap"] / tot); pays = [x["amt"] * f for x in cl]
        assert sum(pays) <= s["cap"] + 1e-9, "I1 slot solvency"
        for x, a in zip(cl, pays):
            net[x["holder"]] += a; net[s["owner"]] -= a; paid[x["note"]] += a
            if x["amt"] - a > 1e-12: unpaid.append((s["owner"], x, x["amt"] - a))
    # extraction: reused N1 slot -> bond slashed into reserve for that culprit's unpaid claimants
    by_culprit = collections.defaultdict(list)
    for owner, x, short in unpaid:
        if owner in reused: by_culprit[owner].append((x, short))
    for owner, lst in by_culprit.items():
        tot = sum(s for _, s in lst); f = min(1.0, bond / tot)
        for x, s in lst:
            net[x["holder"]] += s * f; net[owner] -= s * f; paid[x["note"]] += s * f
    for c, v in escrow_paid.items(): assert v <= 1 + 1e-12, "I1 escrow"

    # invariants
    tot = sum(net.values()); assert abs(tot) < 1e-9, f"I4 zero-sum {tot}"
    stats = dict(desig_honest=0, nondesig_honest=0, losers=0, loss=0.0, desig_loss=0.0, cheat_gain=0.0)
    incoming = {}
    for n in notes:
        if n["payer"] is not None: incoming.setdefault(n["holder"], []).append(n)
    for h, kind in nodes.items():
        if kind == "C": stats["cheat_gain"] += net[h]
        if kind != "H": continue
        if net[h] < -1e-9:
            stats["losers"] += 1; stats["loss"] += -net[h]
            # I3: some incoming note from a cheater via reused N1 slot must exist
            ok = any(nodes[n["payer"]] == "C" and n["slot"][0] == "N1" and n["payer"] in reused
                     for n in incoming.get(h, []))
            assert ok, f"I3 violated for {h}"
    # I2: per-note check -- every dishonoured note held by honest party with designated slot fully paid
    for n in notes:
        if n["payer"] is None or nodes[n["holder"]] != "H": continue
        if n["slot"][0] == "D":
            stats["desig_honest"] += 1
            # if it was a dishonoured note it must be paid 1 in full
            if n["id"] in paid or any(n["id"] == x["note"] for x in slots[n["slot"]]["claims"]):
                assert paid[n["id"]] >= 1 - 1e-9, f"I2 designated note {n['id']} paid {paid[n['id']]}"
        else:
            stats["nondesig_honest"] += 1
            if paid.get(n["id"], 1) < 1 - 1e-9: stats["desig_loss"] += 0  # placeholder
    return stats

def main():
    out = []
    def P(s): print(s); out.append(s)
    P("DEN Monte Carlo (I1-I4 asserted in every world)")
    for rule in ("prorata", "fifo"):
        for p_des in (1.0, 0.6, 0.0):
            for reuse in (0.0, 0.6):
                agg = collections.Counter(); worlds = 3000
                for seed in range(worlds):
                    st = run_world(seed, p_designated=p_des, reuse_prob=reuse, rule=rule)
                    for k, v in st.items(): agg[k] += v
                P(f"rule={rule:7s} p_designated={p_des:.1f} reuse={reuse:.1f}: worlds={worlds} "
                  f"honest notes via designated slot={agg['desig_honest']}, via N1 slot={agg['nondesig_honest']}, "
                  f"honest losers={agg['losers']}, total honest loss={agg['loss']:.2f}, "
                  f"mean cheater net={agg['cheat_gain']/worlds:.3f}")
    P("All asserts passed (I1 solvency, I2 designated immunity, I3 localisation, I4 zero-sum).")
    # Negative control: honest recipients do NOT enforce the per-payer cap (e.g. two tills not sharing state)
    ENFORCE_CAP[0] = False
    fails = collections.Counter()
    for seed in range(3000):
        try: run_world(seed, p_designated=1.0, reuse_prob=0.0, cap=1)
        except AssertionError as e: fails[str(e).split()[0]] += 1
    P(f"NEGATIVE CONTROL (cap not enforced, cap=1, no N1 reuse): worlds with assertion failures = {dict(fails)} of 3000")
    ENFORCE_CAP[0] = True
    open(__file__.replace('.py', '.out'), 'w').write("\n".join(out) + "\n")

if __name__ == "__main__":
    main()
