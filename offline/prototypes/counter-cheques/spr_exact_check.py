"""Exact rational-arithmetic check of the SPR identities used in Theorem 1 (seam_d_incentives.md Q4)."""
from fractions import Fraction as Fr
import random
r = random.Random(11); bad = 0
for _ in range(200000):
    D = Fr(r.randint(1, 10**6)); Hb = Fr(r.randint(0, int(D) - 1)) if D > 1 else Fr(0)
    H = Fr(r.randint(0, int(Hb))); N = D + Fr(r.randint(1, 10**7)); d = Fr(1)
    if (D - H) * (N - Hb) - (N - H) * (D - Hb) != (N - D) * (Hb - H): bad += 1      # key identity
    if (N - H) * (D - Hb) / (N - Hb + d) >= D - H and not (H == Hb == D): bad += 1  # strict safety
    if N * (D - Hb) / (N - Hb + d) > D: bad += 1                                  # solvency
    if Hb >= d and (D - Hb) / (N - Hb + d) < (1 - Hb / D) * (D / N): bad += 1     # spite bound
print("exact-arithmetic SPR identity/inequality violations over 200000 draws:", bad)
