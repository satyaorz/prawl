#!/usr/bin/env python3
"""Cluster designation: merchants that share LOCAL state (same market LAN / local witness quorum) count as ONE
recipient for the Partition bound. Lock = sum over clusters of the cluster cap.
ASSUMPTIONS: v=0.1, Poisson(20)/day, M=10 merchants (Zipf 1), q=0 non-S, merchants assigned round-robin to G clusters.
Caps chosen at a common quantile so P(any blocked payment on a day) <= eps."""
import numpy as np
rng = np.random.default_rng(11); V=0.1; DAYS=200_000
out=[]
def P(s): print(s); out.append(s)
M=10; w=1/np.arange(1,M+1); w/=w.sum()
recv = rng.multinomial(rng.poisson(20,DAYS), w)*V
def lock(groups, eps):
    agg = np.stack([recv[:,g].sum(axis=1) for g in groups],axis=1)
    lo,hi=0.5,1.0
    for _ in range(40):
        a=(lo+hi)/2; caps=np.quantile(agg,a,axis=0,method="higher")
        if (agg>caps+1e-12).any(axis=1).mean()<=eps: hi=a
        else: lo=a
    caps=np.quantile(agg,hi,axis=0,method="higher")
    return caps.sum(), (agg>caps+1e-12).any(axis=1).mean()
for eps in (0.05,0.01):
    for G in (10,5,3,2,1):
        groups=[list(range(i,M,G)) for i in range(G)]
        L,pb=lock(groups,eps)
        P(f"eps={eps:.2f} clusters G={G:>2}: lock={L:.2f} ETH (P(blocked day)={pb:.3f})")
open(__file__.replace('.py','.out'),'w').write("\n".join(out)+"\n")
