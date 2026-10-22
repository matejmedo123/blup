#!/usr/bin/env python3
"""The user's exit: take a partial profit at +20 % (or more), keep a remainder for a possible explosion (stdlib).
Same data and execution as moonbag.py: decide on a closed bar, fill at the next bar's open, fees, impact,
network fee, $25k liquidity floor. Entry: wait W min after graduation; 'held' = still at/above the graduation
price and never under half of it. Exits: initial stop −S (before the partial), partial P at +T, the rest:
'be' = stop at the entry price, 'trail' = 50 % under its high, 'free' = never sold (marked at the end)."""
import itertools
import os
import statistics
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import moonbag as M  # noqa: E402

coins, _ = M.load()
TEST_FROM = "2026-09-27"


def run(c, wait, held, T, P, S, rest, horizon_h=72):
    t_w = c.start + wait * 60
    i, lo = 0, c.p_grad
    while i < len(c.bars) and c.bars[i][0] + c.bars[i][1] <= t_w:
        if c.bars[i][0] >= c.start:
            lo = min(lo, c.bars[i][4])
        i += 1
    if i == 0 or i >= len(c.bars):
        return None
    if held and (c.bars[i - 1][5] < c.p_grad or lo < 0.5 * c.p_grad):
        return None
    t_in, px = c.bars[i][0], c.bars[i][2]
    if 2 * c.reserve(t_in, px) < 25000:
        return None
    tok = c.buy(t_in, px, 10.0)
    entry = 10.0 / tok
    got, part_done, pending, peak = 0.0, False, None, entry
    for j in range(i, len(c.bars)):
        t, ln, o, h, l, cl = c.bars[j]
        if pending:
            if pending == "partial":
                q = tok * P
                got += c.sell(t, o, q)
                tok -= q
                part_done = True
            else:
                got += c.sell(t, o, tok)
                tok = 0.0
                return got - 10.05
            pending = None
        peak = max(peak, cl)
        if not part_done:
            if cl <= entry * (1 - S) or t - t_in > horizon_h * 3600:
                pending = "out"
            elif cl >= entry * (1 + T):
                pending = "partial"
        else:
            if rest == "be" and cl <= entry:
                pending = "out"
            elif rest == "trail" and cl <= peak * 0.5:
                pending = "out"
    left = max(0.0, c.sell(c.bars[-1][0], c.bars[-1][5], tok) + 0.05) if tok > 0 else 0.0
    return got + left - 10.05


rows = []
for wait, held, T, P, S, rest in itertools.product((5, 30, 60), (False, True), (0.2, 0.3, 0.5), (0.5, 0.75),
                                                  (0.2, 0.3), ("be", "trail", "free")):
    tr = [(c.day, run(c, wait, held, T, P, S, rest)) for c in coins]
    tr = [(d, p) for d, p in tr if p is not None]
    a = [p for d, p in tr if d < TEST_FROM]
    b = [p for d, p in tr if d >= TEST_FROM]
    rows.append((statistics.mean(a), (wait, held, T, P, S, rest), len(a), statistics.mean(b), len(b),
                 sum(1 for p in a if p > 0) / len(a)))
rows.sort(reverse=True)
print("%d variants · positive on TRAIN: %d · positive on TEST: %d" % (
    len(rows), sum(1 for r in rows if r[0] > 0), sum(1 for r in rows if r[3] > 0)))
print("best 12 on TRAIN (mean € per €10 trade) and the same on TEST:")
for m, v, n, mt, nt, w in rows[:12]:
    print("  wait %2d %-5s +%2d%% sell %2d%% stop -%d%% rest %-5s | TRAIN n=%3d won %2.0f%% %+.2f€ | TEST n=%3d %+.2f€" % (
        v[0], "held" if v[1] else "any", v[2] * 100, v[3] * 100, v[4] * 100, v[5], n, 100 * w, m, nt, mt))
