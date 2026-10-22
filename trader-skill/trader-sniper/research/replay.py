#!/usr/bin/env python3
"""Replay trader-sniper's own rules on the historical pump.fun sample (stdlib only).

The sniper module is imported read-only and its own functions decide: ``prefilter`` (age,
liquidity, wash-trading ratio), ``signal`` (momentum / breakout / pullback, with our 5-minute bars
fed through ``fetch_bars``), ``MIN_STOP_PCT`` and ``budget_refusal`` (EUR 10 a trade, EUR 100 open,
10 positions, 20 trades a day, EUR 30 daily loss, a token never twice in 24 h). Exits follow
``manage``: stop = strategy stop + round-trip cost, half at +50 %, the rest trails 25 % under
the high, 6 h time stop, liquidity-drain exit.

What history can NOT show and how it is handled (see the report for the bounds):
* RugCheck / holders / authorities at that time  -> assumed passed (an upper bound on trades;
  pump.fun mints have mint+freeze authority revoked and PumpSwap LP burned, so those checks would
  pass; top-10 holder concentration is unknown)
* DexScreener's trade counts (buys:sells, >= 20 trades in 5 min, trades per wallet) -> not in
  OHLCV; momentum fires without them (upper bound on momentum signals)
* liquidity history -> constant-product depth from the pool's starting reserves read from the
  migration transaction (graduated) or the bonding-curve constant (curve coins)
* the sniper polls every 45 s; the replay steps on closed 5-minute bars, buys at the next bar's
  open, and fills stops at the bar's low (conservative; 'mid'/'stop' fills as sensitivity)

    python3 replay.py                 # full report
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import os
import random
import statistics
import sys
import time

sys.dont_write_bytecode = True          # never write __pycache__ into the read-only pack
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
PACK = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(HERE))  # research → trader-sniper → pack
sys.path.insert(0, os.path.join(PACK, "trader-sniper"))
sys.path.insert(0, PACK)

import collect as C  # noqa: E402
import sniper  # noqa: E402  (read-only import of the real rules)
from shared.indicators import Candle  # noqa: E402

HIST = os.path.join(C.DATA, "hist")
RESULTS = os.path.join(HERE, "results")
GAS_USD = 0.05          # per swap: priority + base fee (the sniper itself assumes 0.02)
STEP = 300
RUG_DROP = 0.90
STABLE_QUOTES = {"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                 "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"}
WSOL = "So11111111111111111111111111111111111111112"
TRAIN_SHARE = 0.6


# ----------------------------------------------------------------------------- SOL price

class SolPrice:
    def __init__(self):
        self.t, self.p = [], []
        for name in ("kraken_solusd_1d.json", "kraken_solusd_1h.json"):
            path = os.path.join(HIST, name)
            if not os.path.exists(path):
                continue
            d = json.load(open(path))
            rows = [v for k, v in d["result"].items() if k != "last"][0]
            for r in rows:
                self.t.append(int(r[0]))
                self.p.append(float(r[4]))
        z = sorted(set(zip(self.t, self.p)))
        self.t = [a for a, _ in z]
        self.p = [b for _, b in z]

    def at(self, ts):
        i = bisect.bisect_right(self.t, ts) - 1
        return self.p[max(0, i)] if self.p else 100.0


# ----------------------------------------------------------------------------- coins

RAW = bool(os.environ.get("REPLAY_RAW"))   # 1 = the candles as served, without clamp_to_volume (to compare)


def clamp_to_volume(bars, y0, depth_at):
    """The prices a constant-product pool could have shown. In one bar the quote reserve moves at most by the
    volume traded in it (all of it one way), so a print outside that band was not a trade in this pool — a dust
    trade at a broken price, another venue, a bad candle — and is pulled back into it. Real runs carry their
    volume and pass. bars: [t, o, h, l, c, v, …] (v in USD); depth_at(t): the reserve at price 1 (reserve =
    depth · √price); y0: the reserve before the first bar. → (bars, how many were pulled in)."""
    out, n, y = [], 0, y0
    for b in bars:
        t, o, h, l, c, v = b[:6]
        a = depth_at(t)
        if a <= 0 or y is None or y <= 0:
            out.append(list(b))
            continue
        lo, hi = (max(0.0, y - v) / a) ** 2, ((y + v) / a) ** 2
        fixed = [min(hi, max(lo, x)) for x in (o, h, l, c)]
        n += fixed != [o, h, l, c]
        out.append([t] + fixed + list(b[5:]))
        y = a * math.sqrt(fixed[3]) if fixed[3] > 0 else y
    return out, n


class Coin:
    """One sampled coin: sparse 5-minute bars (as GeckoTerminal/pump.fun serve them) plus a
    constant-product depth model."""

    def __init__(self, res, bars_rec, sol, curve_L_per_sqrt_sol, ds):
        self.kind = res["kind"]
        self.mint = res["mint"]
        self.key = "solana:%s" % self.mint
        self.day = res["day"]
        self.start = int(res.get("block_ts") or res["ts"])
        self.src = bars_rec.get("src")
        self.truncated = bool(bars_rec.get("truncated"))
        bars = [b for b in bars_rec.get("bars") or [] if b[4] > 0 and b[3] > 0]
        # minutes the coin spent on its bonding curve before the migration (first candle = create);
        # ~0 means the whole curve was bought in the launch bundle: insiders hold the supply
        self.curve_minutes = ((int(res.get("block_ts") or res["ts"]) - bars[0][0]) / 60.0
                              if bars and res["kind"] == "grad" and not bars_rec.get("truncated") else None)
        if res["kind"] == "grad":   # the PumpSwap pair's own history starts at the migration
            t0 = int(res.get("block_ts") or res["ts"]) // STEP * STEP
            bars = [b for b in bars if b[0] >= t0]
        self.sol = sol
        self.grad_ts = None
        self.k = None
        self.quote_kind = None
        if self.kind == "grad":
            self.grad_ts = self.start
            if res.get("base_amt") and res.get("quote_amt"):
                self.k = res["base_amt"] * res["quote_amt"]
                q = res.get("quote_mint")
                self.quote_kind = "sol" if q == WSOL else ("usd" if q in STABLE_QUOTES else None)
            sq = sol.at(self.start) if self.quote_kind == "sol" else 1.0
            y0 = res["quote_amt"] * sq if self.k and self.quote_kind else None   # the reserve it graduated with
        else:
            self.Lc = curve_L_per_sqrt_sol
            y0 = 30.0 * sol.at(self.start)       # a new curve: 30 virtual SOL
        self.clamped = 0
        if not RAW and bars:
            bars, self.clamped = clamp_to_volume(bars, y0, lambda t: self.quote_reserve(t, 1.0))
        self.bars = [Candle(int(b[0]), b[1], max(b[1], b[2], b[4]), min(b[1], b[3], b[4]), b[4], b[5]) for b in bars]
        self.bt = [b.t for b in self.bars]
        if self.kind != "grad":
            for p in ds or []:
                if p.get("dex") == "pumpswap" and p.get("created_ms"):
                    self.grad_ts = int(p["created_ms"] / 1000)
            if self.grad_ts is None:
                # DexScreener forgets old dead pairs: a curve is full once ~85 real SOL sit in it
                # (115 virtual), i.e. at price 115^2 * S / L^2 -- the first bar above it graduated
                for b in self.bars:
                    S = sol.at(b.t)
                    if b.h >= 115.0 ** 2 * S / (self.Lc ** 2):
                        self.grad_ts = b.t + STEP
                        break

    def dex_at(self, ts):
        if self.kind == "grad" or (self.grad_ts and ts >= self.grad_ts):
            return "pumpswap"
        return "pumpfun"

    def quote_reserve(self, ts, price_usd):
        """USD on the quote side of the pool at this price (half the pool's liquidity)."""
        if price_usd <= 0:
            return 0.0
        S = self.sol.at(ts)
        if self.kind == "grad":
            if not self.k or not self.quote_kind:
                return 0.0
            Sq = S if self.quote_kind == "sol" else 1.0
            return math.sqrt(self.k * price_usd * Sq)
        # bonding curve: y = sqrt(k_virtual * S * p); measured once (today) as L/sqrt(S)
        return self.Lc * math.sqrt(S) * math.sqrt(price_usd)

    def liquidity(self, ts, price_usd):
        return 2.0 * self.quote_reserve(ts, price_usd)

    # --- bar access
    def closed_until(self, ts):
        """Index one past the last bar closed at ts."""
        return bisect.bisect_right(self.bt, ts - STEP)

    def price_at(self, ts):
        """Last close of a bar closed by ts (the first open before any bar closed)."""
        i = self.closed_until(ts)
        if i == 0:
            return self.bars[0].o if self.bars else 0.0
        return self.bars[i - 1].c

    def bar_starting(self, ts):
        i = bisect.bisect_left(self.bt, ts)
        return self.bars[i] if i < len(self.bars) and self.bars[i].t == ts else None


def load(min_bars=1):
    sol = SolPrice()
    res = {}
    for r in C.read_jsonl(os.path.join(HIST, "resolved.jsonl")):
        if r.get("mint") and r.get("verified"):
            res[(r["kind"], r["mint"])] = r
    bars = {}
    for r in C.read_jsonl(os.path.join(HIST, "bars5m.jsonl")):
        if r.get("status") == 200:
            bars[(r["kind"], r["mint"])] = r      # the latest wins (GeckoTerminal refills truncated ones)
    ds = {}
    for r in C.read_jsonl(os.path.join(HIST, "coins.jsonl")):
        ds[r["mint"]] = r.get("ds")
    Lc = curve_constant(sol)
    coins, missing = [], {"no_bars": 0, "truncated": 0, "unverified": 0}
    for k, r in res.items():
        b = bars.get(k)
        if not b:
            missing["no_bars"] += 1
            continue
        c = Coin(r, b, sol, Lc, ds.get(r["mint"]))
        if c.truncated:
            missing["truncated"] += 1
        coins.append(c)
    coins.sort(key=lambda c: c.start)
    return coins, missing, Lc


def curve_constant(sol):
    """Bonding-curve depth L/sqrt(S): median over today's SOL-quoted pump.fun curve snapshots."""
    vals = []
    S = sol.at(time.time())
    for r in C.read_jsonl(os.path.join(C.DATA, "pools.jsonl")):
        if r.get("source") != "pump-new" or r.get("complete"):
            continue
        if not str(r.get("quote_mint") or "").startswith("1111"):
            continue
        s = r.get("snap") or {}
        y, p = s.get("virtual_quote_usd"), s.get("price_usd")
        if y and p:
            vals.append(y / math.sqrt(p) / math.sqrt(S))
    vals.sort()
    return vals[len(vals) // 2] if vals else 180.0


# ----------------------------------------------------------------------------- pair snapshot

def pair_at(c: Coin, ts: int) -> dict:
    """What DexScreener would have shown at ts, rebuilt from closed 5-minute bars."""
    i = c.closed_until(ts)
    px = c.price_at(ts)
    m5 = sum(b.v for b in c.bars[bisect.bisect_left(c.bt, ts - 300):i])
    h1 = sum(b.v for b in c.bars[bisect.bisect_left(c.bt, ts - 3600):i])
    p5 = c.price_at(ts - 300) if ts - 300 > c.start else (c.bars[0].o if c.bars else px)
    p60 = c.price_at(ts - 3600) if ts - 3600 > c.start else (c.bars[0].o if c.bars else px)
    created = c.grad_ts if (c.kind == "curve" and c.grad_ts and ts >= c.grad_ts) else c.start
    return {"price_usd": px, "liquidity_usd": c.liquidity(ts, px), "created_at": created,
            "dex": c.dex_at(ts), "base": {"symbol": "MEME", "address": c.mint},
            "volume": {"m5": m5, "h1": h1},
            "price_change": {"m5": 100 * (px / p5 - 1) if p5 else 0.0, "h1": 100 * (px / p60 - 1) if p60 else 0.0},
            # trade counts are not in OHLCV: set so the sniper's tx conditions pass (upper bound)
            "txns": {"m5": {"buys": 20, "sells": 0}, "h1": {"buys": 0, "sells": 0}}}


# ----------------------------------------------------------------------------- execution

def fee_pct(dex):
    return sniper.POOL_FEE_PCT.get(dex, 0.3) / 100.0


def buy_fill(c, ts, px, usd, extra_slip=0.0):
    fee = fee_pct(c.dex_at(ts)) + extra_slip
    q = usd * (1 - fee)
    y = c.quote_reserve(ts, px)
    fill = px * (1 + q / y) if y > 0 else px * 2.0
    tokens = q / fill
    return tokens, usd * fee, q - tokens * px


def sell_value(c, ts, px, tokens, extra_slip=0.0):
    v = tokens * px
    y = c.quote_reserve(ts, px)
    out = v * y / (y + v) if y > 0 else v * 0.5
    fee = fee_pct(c.dex_at(ts)) + extra_slip
    return out * (1 - fee)


def is_rug_bar(c, b, prev_close):
    ref = max(b.o, prev_close or b.o)
    return b.l <= (1 - RUG_DROP) * ref


class Replay:
    def __init__(self, coins, s, mode="sniper", stop_fill="low", extra_slip=0.0, delay=0,
                 budget=True, strategies=None, min_liq=None, min_curve_minutes=None):
        if min_curve_minutes is not None:   # proxy for RugCheck's holder checks, known at migration
            coins = [c for c in coins if c.kind != "grad" or (c.curve_minutes is not None
                                                             and c.curve_minutes >= min_curve_minutes)]
        self.coins = coins
        self.s = json.loads(json.dumps(s))
        if strategies is not None:
            self.s["strategies"] = {k: (k in strategies) for k in self.s["strategies"]}
        if min_liq is not None:
            self.s["min_liquidity_usd"] = min_liq
        self.mode = mode            # "sniper" or "baseline" (buy every coin 10 min after launch)
        self.stop_fill = stop_fill
        self.slip = extra_slip
        self.delay = delay
        self.budget = budget
        self.book = {"positions": {}, "days": {}, "traded": {}}
        self.trades = []
        self.refused = {}
        self.signals = 0

    # one position, one bar
    def _manage_bar(self, c, pos, b, prev_close, ts_close):
        ex = self.s["exits"]
        tokens = pos["tokens"]
        entry = pos["entry_px_eff"]

        def eff(px, toks=None):
            toks = tokens if toks is None else toks
            return sell_value(c, b.t, px, toks, self.slip) / toks if toks > 0 else 0.0
        held_h = (ts_close - pos["opened"]) / 3600.0
        rug = is_rug_bar(c, b, prev_close)
        pos["rug"] = pos.get("rug") or rug
        # liquidity drain (constant product: only a price fall moves it) and the stop, on the bar's low
        liq_low = c.liquidity(b.t, b.l)
        stop_px_eff = entry * (1 - pos["stop_pct"] / 100.0)
        trail_px_eff = pos["peak_eff"] * (1 - ex["trail_pct"] / 100.0) if pos["sold_part"] else None
        low_eff = eff(b.l)
        reason = None
        if pos["entry_liq"] and liq_low < pos["entry_liq"] * (1 - ex["liquidity_drop_pct"] / 100.0):
            reason = "liquidity"
        if low_eff <= stop_px_eff:
            reason = reason or "stop"
        elif trail_px_eff is not None and low_eff <= trail_px_eff:
            reason = reason or "trail"
        if reason:
            if self.stop_fill == "low" or reason == "liquidity" and low_eff > stop_px_eff:
                fill_px = b.l
            else:
                # the mid price at which the effective value hits the level, or the open if gapped
                lvl = stop_px_eff if reason in ("stop", "liquidity") else trail_px_eff
                lvl_px = self._px_for_eff(c, b.t, lvl, tokens)
                at = min(b.o, lvl_px)
                fill_px = at if self.stop_fill == "stop" else 0.5 * (at + b.l)
            return self._exit(c, pos, 1.0, fill_px, b.t + 60, "rug" if rug else reason)
        if held_h >= ex["time_stop_hours"]:
            return self._exit(c, pos, 1.0, b.c, ts_close, "time")
        if not pos["sold_part"]:
            tp_eff = entry * (1 + ex["take_profit_pct"] / 100.0)
            if eff(b.h) >= tp_eff:
                tp_px = self._px_for_eff(c, b.t, tp_eff, tokens)
                self._exit(c, pos, ex["take_profit_part"], tp_px, b.t + 60, "tp")
                pos["sold_part"] = True
        pos["peak_eff"] = max(pos["peak_eff"], eff(b.h))
        pos["value"] = sell_value(c, b.t, b.c, pos["tokens"], self.slip)
        return None

    def _px_for_eff(self, c, ts, target_eff, tokens):
        lo, hi = 1e-18, 1e6
        for _ in range(80):          # sell value per token rises with price: bisection in log space
            mid = math.sqrt(lo * hi)
            if sell_value(c, ts, mid, tokens, self.slip) / tokens < target_eff:
                lo = mid
            else:
                hi = mid
        return hi

    def _exit(self, c, pos, part, px, ts, reason):
        toks = pos["tokens0"] * part if part < 1.0 else pos["tokens"]
        got = sell_value(c, ts, px, toks, self.slip) - GAS_USD
        pos["tokens"] -= toks
        pos["realized"] += got
        pos["fills"].append((reason, round(px, 12), round(got, 4)))
        if part >= 1.0 or pos["tokens"] <= 1e-12:
            pnl = pos["realized"] - pos["cost"] - GAS_USD
            day = sniper._day(self.book, ts)
            day["pnl_usd"] = round(day["pnl_usd"] + pnl, 4)
            self.book["positions"].pop(pos["key"], None)
            self.trades.append({"key": pos["key"], "kind": c.kind, "strategy": pos["strategy"], "day": c.day,
                                "entry_t": pos["opened"], "exit_t": ts, "pnl": pnl, "ret": pnl / pos["cost"],
                                "exit": "+".join(f[0] for f in pos["fills"]), "rug": bool(pos.get("rug")) or reason == "rug",
                                "entry_liq": pos["entry_liq"], "age_min": (pos["opened"] - c.start) / 60.0,
                                "fees_impact_usd": pos["cost_in"]})
            return "closed"
        return None

    def _open(self, c, ts, strategy, stop_pct, rt_loss):
        t_fill = ts + self.delay * STEP
        b = c.bar_starting(t_fill)
        px = b.o if b else c.price_at(t_fill)
        if px <= 0:
            return
        tokens, fee, imp = buy_fill(c, t_fill, px, float(self.s["trade_usd"]), self.slip)
        cost = float(self.s["trade_usd"])
        key = c.key
        pos = {"key": key, "strategy": strategy, "opened": t_fill, "tokens": tokens, "tokens0": tokens,
               "cost": cost, "entry_px_eff": cost / tokens, "peak_eff": cost / tokens,
               "stop_pct": stop_pct + max(0.0, rt_loss), "entry_liq": c.liquidity(t_fill, px),
               "sold_part": False, "realized": 0.0, "fills": [], "value": cost, "cost_usd": cost,
               "value_usd": cost, "cost_in": fee + imp + GAS_USD, "coin": c}
        self.book["positions"][key] = pos
        self.book["traded"][key] = ts
        sniper._day(self.book, ts)["trades"] += 1

    def run(self):
        s = self.s
        coins = [c for c in self.coins if c.bars]
        if not coins:
            return self
        t0 = coins[0].start // STEP * STEP + STEP
        t_end = max(c.start for c in coins) + int((s["max_age_hours"] + s["exits"]["time_stop_hours"]) * 3600) + STEP
        active, nxt = [], 0
        age_max = float(s["max_age_hours"]) * 3600
        ts = t0
        while ts <= t_end:
            while nxt < len(coins) and coins[nxt].start <= ts:
                active.append(coins[nxt])
                nxt += 1
            # 1. exits on the bar that just closed
            for key, pos in list(self.book["positions"].items()):
                c = pos["coin"]
                b = c.bar_starting(ts - STEP)
                if b is None:     # no trade in that bar: the price did not move; only the clock runs
                    px = c.price_at(ts)
                    b = Candle(ts - STEP, px, px, px, px, 0.0)
                i = bisect.bisect_left(c.bt, ts - STEP)
                prev_close = c.bars[i - 1].c if i > 0 else None
                if pos["opened"] > ts - STEP:
                    continue      # bought at this bar's open only if it started after the fill
                self._manage_bar(c, pos, b, prev_close, ts)
                for p in self.book["positions"].values():
                    p["value_usd"] = p.get("value", p["cost"])
            # 2. new candidates, newest first, at most candidates_per_cycle judged
            active = [c for c in active if ts - c.start <= age_max + STEP]
            judged = 0
            for c in sorted(active, key=lambda c: -c.start):
                if judged >= int(s["candidates_per_cycle"]):
                    break
                if c.key in self.book["positions"]:
                    continue
                if self.mode == "baseline":
                    if not (c.start + 600 <= ts < c.start + 600 + STEP):
                        continue
                    pair = pair_at(c, ts)
                    sig = {"strategy": "baseline", "stop_pct": float(s["exits"]["stop_pct"])}
                else:
                    if ts - c.start < float(s["min_age_min"]) * 60:
                        continue
                    pair = pair_at(c, ts)
                    cand = {"chain": "solana", "address": c.mint, "pool": {}}
                    if sniper.prefilter(cand, pair, s, ts):
                        continue
                    judged += 1
                    sig = None
                liq = pair["liquidity_usd"]
                if liq <= 0:
                    continue
                impact = 100.0 * float(s["trade_usd"]) / (liq / 2.0)
                rt_loss = 2 * (impact + 100 * fee_pct(pair["dex"]))   # Jupiter's round trip: no network fee
                if rt_loss > float(s["max_roundtrip_loss_pct"]):
                    continue
                if sig is None:
                    def fetch(_c, _p, coin=c, now=ts):
                        lo = bisect.bisect_left(coin.bt, now - 8 * 3600)
                        hi = coin.closed_until(now)
                        return coin.bars[lo:hi]
                    sig = sniper.signal({"chain": "solana", "address": c.mint}, pair, s, ts, fetch_bars=fetch)
                    if not sig or float(sig["stop_pct"]) < sniper.MIN_STOP_PCT:
                        continue
                self.signals += 1
                if self.budget:
                    why = sniper.budget_refusal(self.book, s, ts, c.key)
                    if why:
                        k = why.split(" ")[0] if not why[0].isdigit() else why.split("(")[0].strip()[-20:]
                        self.refused[k] = self.refused.get(k, 0) + 1
                        continue
                elif ts - float(self.book["traded"].get(c.key, 0)) < 86400:
                    continue
                self._open(c, ts, sig["strategy"], float(sig["stop_pct"]), rt_loss)
            ts += STEP
        # anything still open: closed at its last price
        for key, pos in list(self.book["positions"].items()):
            c = pos["coin"]
            self._exit(c, pos, 1.0, c.price_at(t_end), t_end, "end")
        self.trades.sort(key=lambda t: t["entry_t"])
        return self


# ----------------------------------------------------------------------------- statistics

def summarize(trades, boot=1000, seed=11):
    n = len(trades)
    if not n:
        return {"n": 0}
    rets = [t["ret"] for t in trades]
    pnl = [t["pnl"] for t in trades]
    streak = worst = 0
    for t in trades:
        streak = streak + 1 if t["pnl"] <= 0 else 0
        worst = max(worst, streak)
    eq, peak, dd = 0.0, 0.0, 0.0
    for t in sorted(trades, key=lambda t: t["exit_t"]):
        eq += t["pnl"]
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
    # block bootstrap by day: days are resampled, keeping each day's trades together
    by_day = {}
    for t in trades:
        by_day.setdefault(t["day"], []).append(t["pnl"])
    days = list(by_day)
    rng = random.Random(seed)
    tot = []
    for _ in range(boot):
        tot.append(sum(sum(by_day[d]) for d in (rng.choice(days) for _ in days)))
    tot.sort()
    means = sorted(statistics.fmean(rng.choices(rets, k=n)) for _ in range(boot)) if n > 1 else rets
    return {"n": n, "win": sum(1 for r in rets if r > 0) / n, "mean": statistics.fmean(rets),
            "median": statistics.median(rets), "total": sum(pnl), "maxdd": dd, "streak": worst,
            "rug": sum(1 for t in trades if t["rug"]) / n,
            "ci_total": (tot[int(0.05 * boot)], tot[int(0.95 * boot) - 1]),
            "ci_mean": (means[int(0.05 * len(means))], means[int(0.95 * len(means)) - 1])}


def row(label, s):
    if not s or not s.get("n"):
        return "%-30s %5d" % (label, 0)
    return ("%-30s %5d %4.0f%% %+7.1f%% %+7.1f%% %+9.2f [%+8.1f,%+8.1f] %8.2f %4d %4.0f%%  mean CI [%+.1f,%+.1f]%%"
            % (label, s["n"], 100 * s["win"], 100 * s["mean"], 100 * s["median"], s["total"], s["ci_total"][0],
               s["ci_total"][1], s["maxdd"], s["streak"], 100 * s["rug"], 100 * s["ci_mean"][0], 100 * s["ci_mean"][1]))


HDR = ("%-30s %5s %5s %8s %8s %9s %20s %8s %4s %5s" % ("", "n", "win", "mean", "median", "EUR", "90% CI EUR (by day)",
                                                     "maxDD", "lstk", "rug"))


def periods(trades, fmt="%Y-%m"):
    out = {}
    for t in trades:
        k = time.strftime(fmt, time.gmtime(t["exit_t"]))
        o = out.setdefault(k, {"n": 0, "eur": 0.0, "wins": 0})
        o["n"] += 1
        o["eur"] += t["pnl"]
        o["wins"] += 1 if t["pnl"] > 0 else 0
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kinds", nargs="*", default=["grad", "curve"])
    args = ap.parse_args(argv)
    t_start = time.time()
    coins, missing, Lc = load()
    coins = [c for c in coins if c.kind in args.kinds]
    s = sniper.settings({})
    days = sorted({c.day for c in coins})
    cut_day = days[int(len(days) * TRAIN_SHARE)] if days else None
    print("coins: %d (%s), days %s .. %s, missing %s, curve depth L/sqrt(SOL)=%.0f" % (
        len(coins), {k: sum(1 for c in coins if c.kind == k) for k in args.kinds}, days[0] if days else "-",
        days[-1] if days else "-", missing, Lc))
    print("train = days before %s, test = from %s" % (cut_day, cut_day))
    out = {"settings": s, "coins": len(coins), "days": [days[0], days[-1]] if days else None, "runs": {}}
    variants = [
        ("SNIPER (as configured)", dict()),
        ("  momentum only", dict(strategies=["momentum"])),
        ("  breakout only", dict(strategies=["breakout"])),
        ("  pullback only", dict(strategies=["pullback"])),
        ("  min liquidity $10k", dict(min_liq=10_000)),
        ("  min liquidity $50k", dict(min_liq=50_000)),
        ("  stops fill mid stop/low", dict(stop_fill="mid")),
        ("  stops fill at stop", dict(stop_fill="stop")),
        ("  +1%/side MEV slippage", dict(extra_slip=0.01)),
        ("  fill 1 bar (5 min) later", dict(delay=1)),
        ("  no budget limits", dict(budget=False)),
        ("  excl. curve filled <2 min (bundle proxy)", dict(min_curve_minutes=2)),
        ("  excl. curve filled <10 min", dict(min_curve_minutes=10)),
        ("BASELINE buy every coin @10min", dict(mode="baseline")),
        ("  baseline, no budget limits", dict(mode="baseline", budget=False)),
    ]
    for label, kw in variants:
        for kinds in (args.kinds, ["grad"], ["curve"]) if label.startswith(("SNIPER", "BASELINE")) else (args.kinds,):
            cs = [c for c in coins if c.kind in kinds]
            r = Replay(cs, s, **kw).run()
            tr = r.trades
            lab = label + ("" if kinds == args.kinds else " [%s]" % kinds[0])
            res = {"all": summarize(tr), "train": summarize([t for t in tr if t["day"] < cut_day]),
                   "test": summarize([t for t in tr if t["day"] >= cut_day]), "signals": r.signals,
                   "refused": r.refused, "by_strategy": {}, "months": periods(tr), "weeks": periods(tr, "%G-W%V")}
            for st in sorted({t["strategy"] for t in tr}):
                res["by_strategy"][st] = {"all": summarize([t for t in tr if t["strategy"] == st]),
                                          "test": summarize([t for t in tr if t["strategy"] == st and t["day"] >= cut_day])}
            out["runs"][lab] = res
            print("\n" + lab + "   signals=%d refused=%s" % (r.signals, r.refused))
            print(HDR)
            for part in ("all", "train", "test"):
                print(row("  " + part, res[part]))
            for st, v in res["by_strategy"].items():
                print(row("  %s (all)" % st, v["all"]))
                print(row("  %s (test)" % st, v["test"]))
            if label.startswith(("SNIPER", "BASELINE")) and kinds == args.kinds:
                print("  per week: " + "  ".join("%s %+.0f (%d)" % (k[5:], v["eur"], v["n"])
                                                 for k, v in sorted(res["weeks"].items())))
                if label.startswith("SNIPER"):
                    os.makedirs(RESULTS, exist_ok=True)
                    with open(os.path.join(RESULTS, "hist_trades.jsonl"), "w") as f:
                        for t in tr:
                            f.write(json.dumps(t) + "\n")
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "hist_summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=str)
    print("\nwrote results/hist_summary.json in %.0fs" % (time.time() - t_start))


if __name__ == "__main__":
    main()
