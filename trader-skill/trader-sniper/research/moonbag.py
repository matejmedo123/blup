#!/usr/bin/env python3
"""After the bonding curve: watch a graduated coin, buy the ones that hold up, sell half every time it doubles
and let the rest ride for free — then the next one (stdlib only).

The idea (the user's, 22 Oct 2026): a coin that has just graduated from pump.fun to PumpSwap is watched for a
while; if it holds up, buy €10; at 2× sell half (the stake is back), at 4× half of the rest, at 8× half again …
the last part is never sold — a free moonbag — and the bot moves on to the next coin.

    python3 moonbag.py fetch      # 1-hour candles for every sampled graduated coin (its life after the 80 h
                                  # the 5-minute candles cover), pump.fun's swap API, ~15 min
    python3 moonbag.py            # the study: every variant, chosen on the first 5 weeks, judged on the rest

Same sample, pool model and costs as replay.py: 40 graduated coins a day for 61 days (dead ones included),
constant-product depth from the pool's starting reserves (PumpSwap burns the LP, so only trades move it),
0.3 % fee and $0.05 network fee per swap. Every decision is made on a closed bar and filled at the next bar's
open — what a bot that polls sees — unless a variant says otherwise.
"""
from __future__ import annotations

import argparse
import heapq
import itertools
import json
import math
import os
import random
import statistics
import sys
import time

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import collect as C  # noqa: E402
import replay as R  # noqa: E402

HIST = os.path.join(C.DATA, "hist")
BARS1H = os.path.join(HIST, "bars1h.jsonl")
FIVE_MIN_HOURS = 80          # the 5-minute candles cover this long after graduation; 1-hour candles after
FEE = 0.003                  # PumpSwap, per side
GAS_USD = 0.05               # per swap
STAKE = 10.0
TEST_FROM = "2026-09-27"
TRADES_PER_DAY = 20
BANKROLL = 100.0             # the bot wallet: €10 a buy out of it, every sale back into it


# ----------------------------------------------------------------------------- data

def cmd_fetch(args):
    done = {r["mint"] for r in C.read_jsonl(BARS1H) if r.get("status") == 200}
    todo = [r for r in C.read_jsonl(os.path.join(HIST, "resolved.jsonl"))
            if r.get("verified") and r.get("kind") == "grad" and r["mint"] not in done]
    C.log("bars1h: %d to do" % len(todo))
    batch = []
    for i, r in enumerate(todo):
        start = int(r.get("block_ts") or r["ts"])
        url = ("%s/v2/coins/%s/candles?interval=1h&limit=1000&currency=USD&createdTs=%d"
               % (C.PUMP_SWAP_API, r["mint"], (start - 86400) * 1000))
        st, d = C.get_json(url)
        bars = []
        for c in d if isinstance(d, list) else []:
            try:
                bars.append([int(c["timestamp"] // 1000), float(c["open"]), float(c["high"]), float(c["low"]),
                             float(c["close"]), float(c["volume"])])
            except (KeyError, TypeError, ValueError):
                continue
        bars.sort()
        # the newest 1000 hours: complete only if they reach back to the 5-minute window's end
        batch.append({"mint": r["mint"], "status": st, "bars": bars, "fetched_ts": int(time.time()),
                      "gap": bool(len(bars) >= 1000 and bars[0][0] > start + FIVE_MIN_HOURS * 3600)})
        if len(batch) >= 50:
            C.append_jsonl(BARS1H, batch)
            batch = []
            C.log("bars1h %d/%d %s" % (i + 1, len(todo), C.STATS))
    C.append_jsonl(BARS1H, batch)


class Coin:
    """One graduated coin: 5-minute bars for its first 80 h on PumpSwap, hourly bars after, the pool's depth."""

    def __init__(self, res, b5, b1h, sol, curve_minutes):
        self.mint = res["mint"]
        self.day = res["day"]
        self.start = int(res.get("block_ts") or res["ts"])
        self.curve_minutes = curve_minutes
        self.sol = sol
        self.k = res["base_amt"] * res["quote_amt"]
        self.quote_sol = res.get("quote_mint") == R.WSOL
        edge = self.start + FIVE_MIN_HOURS * 3600
        five = [(b[0], 300) + tuple(b[1:5]) for b in b5 if self.start // 300 * 300 <= b[0] < edge]
        hour = [(b[0], 3600) + tuple(b[1:5]) for b in b1h if b[0] >= edge]
        # (t, length, open, high, low, close), positive prices only
        self.bars = [b for b in five + hour if min(b[2:]) > 0]
        self.gap = False

    def reserve(self, ts, px):
        """USD on the quote side of the pool at this price."""
        s = self.sol.at(ts)
        return math.sqrt(self.k * px * (s if self.quote_sol else 1.0)) if px > 0 else 0.0

    def buy(self, ts, px, usd):
        q = usd * (1 - FEE)
        y = self.reserve(ts, px)
        fill = px * (1 + q / y) if y > 0 else px * 2
        return q / fill

    def sell(self, ts, px, tokens):
        v = tokens * px
        y = self.reserve(ts, px)
        out = v * y / (y + v) if y > 0 else 0.0
        return out * (1 - FEE) - GAS_USD


def load():
    sol = R.SolPrice()
    res = {r["mint"]: r for r in C.read_jsonl(os.path.join(HIST, "resolved.jsonl"))
           if r.get("verified") and r.get("kind") == "grad" and r.get("base_amt") and r.get("quote_amt")}
    b5 = {}
    for r in C.read_jsonl(os.path.join(HIST, "bars5m.jsonl")):
        if r.get("kind") == "grad" and r.get("status") == 200:
            b5[r["mint"]] = r
    b1 = {r["mint"]: r for r in C.read_jsonl(BARS1H) if r.get("status") == 200}
    coins, missing = [], {"no_1h": 0, "gap": 0, "quote": 0}
    for m, r in res.items():
        if r.get("quote_mint") != R.WSOL:
            missing["quote"] += 1
            continue
        if m not in b5:
            continue
        bars5 = b5[m].get("bars") or []
        cm = None
        if bars5 and not b5[m].get("truncated"):
            cm = (int(r.get("block_ts") or r["ts"]) - bars5[0][0]) / 60.0
        h = b1.get(m)
        if h is None:
            missing["no_1h"] += 1
        c = Coin(r, bars5, (h or {}).get("bars") or [], sol, cm)
        c.gap = bool((h or {}).get("gap"))
        missing["gap"] += c.gap
        if c.bars:
            coins.append(c)
    coins.sort(key=lambda c: c.start)
    return coins, missing


# ----------------------------------------------------------------------------- one coin, one variant

VARIANT_KEYS = ("wait_min", "watch", "bundle", "first_tp", "stop", "tp_within_h", "fill")


def simulate(c: Coin, v: dict):
    """The trade on one coin under variant v: None (not bought) or {entry_t, flows: [(t, usd)], …}.

    watch: "none" — buy after wait_min whatever happened; "held" — only if the last close is at or above the
    price it graduated at and no low went under half of it. bundle: skip coins whose bonding curve filled in
    under 10 minutes (the launch was bought by insiders). Ladder: sell half at first_tp × entry, then half of
    the rest at every further doubling; the last part is never sold. stop: before the first sale, out if the
    price falls this far under the entry (None = no stop). tp_within_h: not doubled (no first sale) within
    this many hours — sold, the money goes to the next coin (None = kept). fill: "next" — decided on a closed
    bar, filled at the next bar's open; "level" — the take-profit fills at its level, the stop at the bar's
    low."""
    if v["bundle"] and (c.curve_minutes is None or c.curve_minutes < 10):
        return None
    bars = c.bars
    p0 = bars[0][2]                       # the first trade on PumpSwap: the graduation price
    t_watch = c.start + 60 * v["wait_min"]
    i = 0
    lo = p0
    while i < len(bars) and bars[i][0] + bars[i][1] <= t_watch:
        lo = min(lo, bars[i][4])
        i += 1
    if i == 0 or i >= len(bars):
        return None                       # no trade before or after the watch: nothing to judge or buy
    last = bars[i - 1][5]
    if v["watch"] == "held" and (last < p0 or lo < 0.5 * p0):
        return None
    entry_bar = bars[i]
    t_in, px_in = entry_bar[0], entry_bar[2]
    tokens = c.buy(t_in, px_in, STAKE)
    entry_px = STAKE / tokens             # what one token really cost us
    flows = [(t_in, -STAKE - GAS_USD)]
    level = v["first_tp"] * entry_px      # the next sale's price (per token, what we paid)
    sold_any = False
    pending = None                        # ("tp" | "stop", decided at) for fill="next"
    exit_reason = "held"
    for j in range(i, len(bars)):
        t, ln, o, h, l, cl = bars[j]
        if pending is not None:
            kind, _ = pending
            pending = None
            if kind == "stop":
                flows.append((t, c.sell(t, o, tokens)))
                tokens = 0.0
                exit_reason = "stop" if not (v.get("tp_within_h") is not None and
                                             t - t_in >= v["tp_within_h"] * 3600) else "time"
                break
            part = tokens / 2.0
            flows.append((t, c.sell(t, o, part)))
            tokens -= part
            sold_any = True
            level *= 2.0
            while o >= level:             # a gap through several levels: one sale, the levels move on
                level *= 2.0
        late = (not sold_any and v.get("tp_within_h") is not None
                and t + ln - t_in >= v["tp_within_h"] * 3600)
        if v["fill"] == "level":
            if late:
                flows.append((t + ln, c.sell(t + ln, cl, tokens)))
                tokens = 0.0
                exit_reason = "time"
                break
            if not sold_any and v["stop"] is not None and l <= entry_px * (1 - v["stop"]):
                flows.append((t, c.sell(t, l, tokens)))
                tokens = 0.0
                exit_reason = "stop"
                break
            while h >= level and tokens > 0:
                at = max(o, level)
                part = tokens / 2.0
                flows.append((t, c.sell(t, at, part)))
                tokens -= part
                sold_any = True
                level *= 2.0
            continue
        # fill = "next": look at the closed bar, act at the next open
        if (not sold_any and v["stop"] is not None and cl <= entry_px * (1 - v["stop"])) or late:
            pending = ("stop", t)
        elif cl >= level:
            pending = ("tp", t)
    if pending is not None and pending[0] == "stop" and tokens > 0:   # decided on the last bar: sold at its close
        t, ln, cl = bars[-1][0], bars[-1][1], bars[-1][5]
        flows.append((t + ln, c.sell(t + ln, cl, tokens)))
        tokens = 0.0
    end_t, end_px = bars[-1][0] + bars[-1][1], bars[-1][5]
    left = c.sell(end_t, end_px, tokens) + GAS_USD if tokens > 0 else 0.0   # marked, not sold: no network fee
    left = max(0.0, left)
    got = sum(f for _, f in flows[1:])
    return {"mint": c.mint, "day": c.day, "entry_t": t_in, "flows": flows, "left_usd": left, "end_t": end_t,
            "pnl": got + left - STAKE - GAS_USD, "sales": len(flows) - 1, "first_tp": sold_any,
            "exit": exit_reason, "peak_x": max(b[3] for b in bars[i:]) / entry_px,
            "days_held": (end_t - t_in) / 86400.0}


# ----------------------------------------------------------------------------- the wallet

def bankroll(trades, cash=BANKROLL):
    """The bot wallet the user chose: €100. Each buy takes €10 (and the network fee) out of it — only if it is
    there — each sale puts its proceeds back, at most TRADES_PER_DAY buys a UTC day. Moonbags never sold stay
    in the wallet at their last value. → (trades bought, {final, cash, moonbags, low, broke_at})."""
    events = []                            # (time, order, trade): sales before buys at the same moment
    for tr in trades:
        events.append((tr["entry_t"], 1, tr))
    events.sort(key=lambda e: (e[0], e[1]))
    taken, bought, inflows = {}, [], []    # inflows: (time, usd) of the trades bought, merged in as time passes
    low, broke_at = cash, None
    for t, _, tr in events:
        while inflows and inflows[0][0] <= t:
            cash += heapq.heappop(inflows)[1]
        d = time.strftime("%Y-%m-%d", time.gmtime(t))
        cost = -tr["flows"][0][1]
        if taken.get(d, 0) >= TRADES_PER_DAY:
            continue
        if cash < cost:
            broke_at = broke_at or t
            continue
        taken[d] = taken.get(d, 0) + 1
        cash -= cost
        low = min(low, cash)
        bought.append(tr)
        for ft, f in tr["flows"][1:]:
            heapq.heappush(inflows, (ft, f))
    while inflows:
        cash += heapq.heappop(inflows)[1]
    bags = sum(tr["left_usd"] for tr in bought)
    return bought, {"final": round(cash + bags, 2), "cash": round(cash, 2), "moonbags": round(bags, 2),
                    "low": round(low, 2), "broke_at": broke_at}


# ----------------------------------------------------------------------------- statistics

def stats(trades, boot=2000, seed=7):
    n = len(trades)
    if not n:
        return {"n": 0}
    pnl = [t["pnl"] for t in trades]
    by_day = {}
    for t in trades:
        by_day.setdefault(t["day"], []).append(t["pnl"])
    days = sorted(by_day)
    rng = random.Random(seed)
    sums = sorted(sum(sum(by_day[rng.choice(days)]) for _ in days) for _ in range(boot))
    eq = peak = dd = 0.0
    for t in sorted(trades, key=lambda t: t["entry_t"]):
        eq += t["pnl"]
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
    top = sorted(pnl, reverse=True)
    return {"n": n, "eur": round(sum(pnl), 2), "mean": round(statistics.mean(pnl), 3),
            "median": round(statistics.median(pnl), 3), "win": round(sum(1 for p in pnl if p > 0) / n, 3),
            "tp": round(sum(1 for t in trades if t["first_tp"]) / n, 3),
            "ci90": (round(sums[int(0.05 * boot)], 1), round(sums[int(0.95 * boot)], 1)),
            "maxdd": round(dd, 2), "best": [round(x, 1) for x in top[:3]],
            "without_best": round(sum(top[1:]), 2), "moonbag_eur": round(sum(t["left_usd"] for t in trades), 2)}


def grid():
    for w, watch, bundle, tp, stop, within in itertools.product((5, 15, 30, 60), ("none", "held"), (False, True),
                                                              (1.5, 2.0), (None, 0.5), (None, 24)):
        yield {"wait_min": w, "watch": watch, "bundle": bundle, "first_tp": tp, "stop": stop, "tp_within_h": within,
               "fill": "next"}


def label(v):
    return "wait %2d min, %-4s, %s, half at %.1f×, stop %-5s, %s, %s" % (
        v["wait_min"], v["watch"], "no bundles" if v["bundle"] else "all coins ", v["first_tp"],
        "none" if v["stop"] is None else "-%d%%" % (100 * v["stop"]),
        "keep" if v.get("tp_within_h") is None else "out after %dh" % v["tp_within_h"], v["fill"])


def fmt_row(name, s):
    if not s.get("n"):
        return "  %-66s n=0" % name
    return ("  %-66s n=%4d win %3.0f%% 2× %3.0f%% mean %+6.2f€ med %+6.2f€ total %+9.2f€ [%+.0f,%+.0f] "
            "best %s without best %+.2f€ moonbags %.2f€") % (
        name, s["n"], 100 * s["win"], 100 * s["tp"], s["mean"], s["median"], s["eur"], s["ci90"][0], s["ci90"][1],
        s["best"], s["without_best"], s["moonbag_eur"])


def fmt_wallet(name, w, n):
    broke = time.strftime("%m-%d", time.gmtime(w["broke_at"])) if w["broke_at"] else "never"
    return "  %-66s €100 → €%.2f (cash %.2f + moonbags %.2f) · %d buys · lowest cash €%.2f · first short of €10: %s" % (
        name, w["final"], w["cash"], w["moonbags"], n, w["low"], broke)


def cmd_study(args):
    t0 = time.time()
    coins, missing = load()
    print("graduated coins: %d (%s .. %s), missing %s" % (len(coins), coins[0].day, coins[-1].day, missing))
    train = [c for c in coins if c.day < TEST_FROM]
    test = [c for c in coins if c.day >= TEST_FROM]
    print("train: %d coins before %s · test: %d coins from %s" % (len(train), TEST_FROM, len(test), TEST_FROM))
    print("Per trade: every coin the rule would buy, €10 each, no wallet limit (the most data per rule).")
    print("Wallet: €100 to start, €10 a buy only while the cash is there, sales back in, 20 buys a day.\n")

    def trades_of(cs, v):
        return [tr for tr in (simulate(c, v) for c in cs) if tr]

    results = [(v, stats(trades_of(train, v))) for v in grid()]
    results.sort(key=lambda r: -(r[1]["mean"] if r[1].get("n", 0) >= 30 else -1e9))
    print("ALL %d VARIANTS ON TRAIN (by mean € a trade; n ≥ 30 first)" % len(results))
    for v, s in results:
        print(fmt_row(label(v), s))
    plain = {"wait_min": 30, "watch": "held", "bundle": False, "first_tp": 2.0, "stop": None, "tp_within_h": None,
             "fill": "next"}
    best = results[0][0]
    print("\nTHE PLAIN IDEA (fixed before looking) and THE BEST ON TRAIN — judged on the last weeks")
    for name, v in (("plain: " + label(plain), plain), ("best on train: " + label(best), best)):
        print("  " + name)
        for part, cs in (("train", train), ("TEST", test)):
            trs = trades_of(cs, v)
            print(fmt_row("  per trade [%s]" % part, stats(trs)))
            bought, w = bankroll(trs)
            print(fmt_wallet("  wallet [%s]" % part, w, len(bought)))
        print(fmt_row("  per trade [all, take-profits at their level]", stats(trades_of(coins, dict(v, fill="level")))))
        print()
    ahead = sum(1 for _, s in results if (s.get("mean") or 0) > 0)
    test_all = [(v, stats(trades_of(test, v))) for v, _ in results]
    print("variants ahead per trade on train: %d of %d · on TEST: %d of %d (median mean %+.2f€)" % (
        ahead, len(results), sum(1 for _, s in test_all if (s.get("mean") or 0) > 0), len(test_all),
        statistics.median([s.get("mean") or 0 for _, s in test_all])))
    trs = trades_of(coins, plain)
    if trs:
        px = sorted(t["peak_x"] for t in trs)
        print("\nplain rule, every coin it would buy: %d · reached 2× (any moment): %.0f %% · 10×: %.0f %% · 100×: %.0f %%"
              % (len(px), 100 * sum(1 for x in px if x >= 2) / len(px), 100 * sum(1 for x in px if x >= 10) / len(px),
                 100 * sum(1 for x in px if x >= 100) / len(px)))
        for t in sorted(trs, key=lambda t: -t["pnl"])[:5]:
            print("  %s %s peak %.1f× sales %d pnl %+.2f€ moonbag now %.2f€ data for %.1f days after the buy" % (
                t["day"], t["mint"][:8], t["peak_x"], t["sales"], t["pnl"], t["left_usd"], t["days_held"]))
    print("\n%.0f s" % (time.time() - t0))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", nargs="?", default="study", choices=("fetch", "study"))
    args = p.parse_args(argv)
    {"fetch": cmd_fetch, "study": cmd_study}[args.cmd](args)


if __name__ == "__main__":
    main()
