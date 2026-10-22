#!/usr/bin/env python3
"""Honest backtest of early-momentum meme-coin strategies on recorded DEX pools (stdlib only).

Input: ``data/pools.jsonl`` + ``data/bars.jsonl`` written by ``collect.py`` (pools sampled by
creation time, dead ones included). Output: tables on stdout, ``results/summary.json`` and
``results/trades.csv``.

Execution model (deliberately conservative):

* signal on a bar's close -> entry at the NEXT 1-minute bar's open (we poll every 30-60 s)
* price impact from a constant-product AMM: buying Q USD against quote reserve y moves the fill
  to p*(1+Q/y); selling V USD worth gets p/(1+V/y) (= the brief's size/(liquidity/2) for small
  sizes, but never negative). y(p) = L*sqrt(p): along a constant-product curve the quote
  reserve scales with sqrt(price), so a -90 % rug leaves ~32 % of the liquidity. L comes from
  the latest pool snapshot taken before the signal (or the earliest one after it)
* fees per side by venue (pump.fun curve 1 %, PumpSwap/Raydium/Pancake 0.25 %, ...) plus a fixed
  network/priority fee per swap ($0.05 Solana, $0.20 BSC, $0.10 Base)
* stops (hard and trailing) fill at the LOW of the bar that touched them, never at the stop
  price; if a bar touches both a stop and a target, the stop is assumed first
* targets fill at the target price; time stops at the open of the first bar past the limit
* a bar whose low is <= 10 % of its reference price is a rug-like collapse; a position caught
  in it is sold at that bar's low (post-rug price)
* a trade still open when the data ends is closed at the last close and flagged ``censored``

Strategies (parameters fixed before looking at results, see PREREG):

* ``baseline``   buy every new pool at minute 5, sell at minute 125
* ``launch``     first N min after open: 3 higher 1-min closes and 5-min volume >= X x the
                 average 5-min volume so far -> stop -30 %, half at +50 %, trail rest 25 %, 2 h
* ``breakout``   pool >= 2 h old, 5-min range of W bars with height <= H, close above range
                 high on >= 2x average volume -> stop below range low (max -25 %), half at
                 +1x range height, rest at +2x, time stop 6 h
* ``pullback``   after a >= +100 % run, first 5-min close back above EMA20 after a 30-50 %
                 pullback from the high -> stop at pullback low, trail 20 %, time stop 6 h

    python3 backtest.py                 # full report
    python3 backtest.py --quick         # defaults only, no grid
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import statistics
import sys
import time
from bisect import bisect_left

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RESULTS = os.path.join(HERE, "results")

# ----------------------------------------------------------------------------- pre-registration
# Written down before the first backtest run. The grid is deliberately tiny; the default (first
# value of every list) is what the user's notes describe.
PREREG = {
    "baseline": {"entry_min": [5], "hold_min": [120]},
    "launch": {"window_min": [30, 15], "vol_mult": [2.0, 3.0], "stop": [0.30], "tp1": [0.50],
               "tp1_frac": [0.5], "trail": [0.25], "time_stop_min": [120]},
    "breakout": {"min_age_min": [120], "range_bars": [18, 24], "max_height": [0.20, 0.15],
                 "vol_mult": [2.0], "max_stop": [0.25], "time_stop_min": [360],
                 "min_avg_vol5": [100.0]},
    "pullback": {"min_run": [1.0, 2.0], "pb_min": [0.30], "pb_max": [0.50], "ema": [20],
                 "trail": [0.20, 0.30], "time_stop_min": [360], "min_bars": [6]},
}
# pre-trade filters, evaluated with information available at the signal bar only
FILTERS = {
    "none": {},
    "liq>=10k": {"min_liq": 10_000},
    "liq>=25k": {"min_liq": 25_000},
    "liq>=50k": {"min_liq": 50_000},
    "age>=30m": {"min_age_min": 30},
    "vol1h/liq<=20": {"max_vol_liq": 20.0},
    "impact<=3%": {"max_impact": 0.03},
    "combo": {"min_liq": 10_000, "max_vol_liq": 20.0, "max_impact": 0.03},
}
TRAIN_SHARE = 0.6
SIZE_USD = 10.0          # EUR 10 per trade, EUR ~ USD
MAX_OPEN = 10            # at most EUR 100 in meme positions at once
RUG_DROP = 0.90          # -90 % within one bar

FEES = {  # fee per side by GeckoTerminal dex id (longest prefix wins); assumptions, see notes
    "pump-fun": 0.01,             # pump.fun bonding curve (brief: 1 %)
    "pumpswap": 0.0025,           # brief: ~0.25 %
    "raydium": 0.0025, "raydium-launchlab": 0.01, "letsbonk": 0.01,
    "meteora": 0.01,              # DBC / DAMM v2 / DLMM meme pools: dynamic fees, 1 % is optimistic
    "bags": 0.01, "orca": 0.0025,
    "four-meme": 0.01, "pancakeswap": 0.0025,
    "uniswap-v2": 0.003, "uniswap-v3": 0.01, "uniswap-v4": 0.01,   # meme v3/v4 pools: 1 % tier
    "aero": 0.003, "bankr": 0.01,
}
DEFAULT_FEE = 0.003
GAS = {"solana": 0.05, "bsc": 0.20, "base": 0.10}


def fee_for(dex: str) -> float:
    dex = dex or ""
    best = None
    for k, v in FEES.items():
        if dex.startswith(k) and (best is None or len(k) > len(best[0])):
            best = (k, v)
    return best[1] if best else DEFAULT_FEE


# ----------------------------------------------------------------------------- data loading

def _read_jsonl(path):
    out = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def universe_of(p: dict) -> str:
    if p["source"] == "pump-new":
        return "sol-pumpfun-curve"
    if p["source"] == "pump-grad":
        return "sol-pumpswap-grad"
    return "%s-new" % p["network"]


class Pool:
    """Dense 1-minute bars of one pool plus its liquidity model and costs."""

    def __init__(self, key, meta, rec):
        self.key = key
        self.network = meta["network"]
        self.dex = (rec.get("info") or {}).get("dex") or meta.get("dex")
        self.source = meta["source"]
        self.universe = universe_of(meta)
        self.created = int(rec.get("pool_created_ts") or meta.get("created_ts") or 0)
        self.fee = fee_for(self.dex)
        self.gas = GAS.get(self.network, 0.10)
        self.fetched = int(rec.get("fetched_ts") or time.time())
        raw = [b for b in rec.get("bars") or [] if b[4] > 0 and b[3] > 0]
        self.n_raw = len(raw)
        self.t, self.o, self.h, self.l, self.c, self.v = [], [], [], [], [], []
        if raw:
            self._densify(raw)
        self.ds_now = rec.get("ds")
        self.graduated = bool((rec.get("info") or {}).get("complete"))
        self.anchors = self._anchors(meta, rec)

    def _densify(self, raw):
        start = raw[0][0]
        if self.created and self.created // 60 * 60 < start:
            start_pool = self.created // 60 * 60
        else:
            start_pool = start
        self.first_trade_t = start
        self.created = self.created or start
        # the series starts at the first trade: before it there is no price
        end_cap = self.fetched // 60 * 60
        if self.source != "pump-new":   # GT window = first 1000 minutes after the pool opened
            end_cap = min(end_cap, start_pool + 1000 * 60)
        end = max(raw[-1][0], end_cap - 60)
        by_t = {int(b[0]): b for b in raw}
        prev_c = raw[0][1]
        t = start
        while t <= end:
            b = by_t.get(t)
            if b:
                self.t.append(t)
                self.o.append(b[1]); self.h.append(max(b[1], b[2], b[4]))
                self.l.append(min(b[1], b[3], b[4])); self.c.append(b[4]); self.v.append(b[5])
                prev_c = b[4]
            else:   # no trade this minute: the AMM still quotes the last price
                self.t.append(t)
                self.o.append(prev_c); self.h.append(prev_c); self.l.append(prev_c)
                self.c.append(prev_c); self.v.append(0.0)
            t += 60
        self.end_t = end

    def _anchors(self, meta, rec):
        """[(ts, L)] with L = quote_reserve/sqrt(price), the depth of a constant-product pool.

        Every discovery snapshot (taken minutes to hours after listing) and the pool state at
        fetch time give one anchor. L stays constant while nobody adds/removes liquidity, so the
        quote reserve at any price is L*sqrt(price). A trade uses the latest anchor taken before
        its signal (or the earliest one if all are later): a liquidity pull that happens after
        the signal is not known at the signal."""
        side = rec.get("token_side") or meta.get("token_side") or "base"
        token = (meta.get("quote_token") if side == "quote" else meta.get("base_token")) or meta.get("mint") or ""

        def gt_point(s):
            # GT reserve_in_usd is 0 for many Uniswap-v4/CL pools: fall back to DexScreener's
            r = s.get("reserve_usd") or s.get("ds_liq_usd")
            p = s.get("base_price_usd") if side == "base" else s.get("quote_price_usd")
            if not p and s.get("ds_price_usd") and (s.get("ds_base_token") or "").lower() == token.lower():
                p = s["ds_price_usd"]
            return (r / 2.0 if r else None), p

        pts = []
        for s in meta.get("snaps") or []:
            if meta["source"] == "pump-new":
                if s.get("complete"):
                    continue    # curve state is meaningless once the coin migrated
                y, p = s.get("virtual_quote_usd"), s.get("price_usd")
            else:
                y, p = gt_point(s)
            if y and p and y > 0 and p > 0:
                pts.append((int(s.get("seen_ts") or 0), y / math.sqrt(p)))
        info = rec.get("info") or {}
        if meta["source"] == "pump-new":
            now = info.get("now") or {}
            y, p = (None, None) if info.get("complete") else (now.get("virtual_quote_usd"), now.get("price_usd"))
        else:
            info = dict(info, **(self.ds_now or {}))
            y, p = gt_point(info)
        if y and p and y > 0 and p > 0:
            pts.append((self.fetched, y / math.sqrt(p)))
        return sorted(pts)

    def depth_at(self, ts: int) -> float:
        if not self.anchors:
            return 0.0
        best = self.anchors[0][1]
        for t, L in self.anchors:
            if t <= ts:
                best = L
            else:
                break
        return best

    def quote_reserve(self, price: float, ts: int = None) -> float:
        if price <= 0:
            return 0.0
        L = self.depth_at(ts if ts is not None else (self.t[0] if self.t else 0))
        return L * math.sqrt(price)

    def liquidity(self, price: float, ts: int = None) -> float:
        return 2.0 * self.quote_reserve(price, ts)

    def idx_at(self, ts: int) -> int:
        """First bar index with t >= ts."""
        return bisect_left(self.t, ts)

    def __len__(self):
        return len(self.t)


def load_dataset(data_dir=DATA, min_age_h=2.5):
    metas = {}
    for r in _read_jsonl(os.path.join(data_dir, "pools.jsonl")):
        k = r.get("key")
        if not k:
            continue
        if k not in metas:
            m = dict(r)
            m["snaps"] = []
            metas[k] = m
        m = metas[k]
        for f in ("created_ts", "coin_created_ts"):
            if r.get(f) and not m.get(f):
                m[f] = r[f]
        if r.get("snap"):
            m["snaps"].append(dict(r["snap"], seen_ts=r.get("seen_ts"), complete=r.get("complete")))
    recs = {}
    for r in _read_jsonl(os.path.join(data_dir, "bars.jsonl")):
        if r.get("status") == 200 or r["key"] not in recs:
            recs[r["key"]] = r
    for r in _read_jsonl(os.path.join(data_dir, "dexscreener.jsonl")):
        if r.get("key") in recs and r.get("ds_liq_usd") is not None:
            recs[r["key"]]["ds"] = r
    pools, skipped = [], {"no_meta": 0, "too_young": 0, "fetch_failed": 0}
    for k, rec in recs.items():
        meta = metas.get(k)
        if not meta:
            skipped["no_meta"] += 1
            continue
        if rec.get("status") != 200:     # never fetched successfully: unknown, not "no trades"
            skipped["fetch_failed"] += 1
            continue
        p = Pool(k, meta, rec)
        if (p.fetched - (p.created or p.fetched)) < min_age_h * 3600:
            skipped["too_young"] += 1
            continue
        pools.append(p)
    pools.sort(key=lambda p: p.created)
    return pools, skipped


# ----------------------------------------------------------------------------- helpers

def is_rug_bar(pool: Pool, i: int) -> bool:
    ref = max(pool.o[i], pool.c[i - 1] if i > 0 else pool.o[i])
    return pool.l[i] <= (1 - RUG_DROP) * ref


def agg5(pool: Pool):
    """Clock-aligned 5-minute bars: list of (t, o, h, l, c, v, first_idx, last_idx)."""
    out = []
    cur = None
    for i, t in enumerate(pool.t):
        b = t // 300 * 300
        if cur is None or cur[0] != b:
            if cur:
                out.append(tuple(cur))
            cur = [b, pool.o[i], pool.h[i], pool.l[i], pool.c[i], pool.v[i], i, i]
        else:
            cur[2] = max(cur[2], pool.h[i]); cur[3] = min(cur[3], pool.l[i])
            cur[4] = pool.c[i]; cur[5] += pool.v[i]; cur[7] = i
    if cur:
        out.append(tuple(cur))
    return out


def ema(values, n):
    k = 2.0 / (n + 1)
    out, e = [], None
    for x in values:
        e = x if e is None else e + k * (x - e)
        out.append(e)
    return out


# ----------------------------------------------------------------------------- signals
# Each strategy returns a list of candidate entries (chronological). An entry is a dict with
# signal index ``si`` (1-min bar whose close completed the signal), the exit plan, and tags.
# Filters later pick the first candidate that passes; one trade per pool.

def sig_baseline(pool: Pool, prm):
    i = pool.idx_at(pool.created // 60 * 60 + prm["entry_min"] * 60)
    if i >= len(pool):
        return []
    return [{"si": i - 1, "ei": i, "stop": None, "tps": [], "trail": None,
             "time_stop_min": prm["hold_min"], "time_entry": True}]


def sig_launch(pool: Pool, prm):
    out = []
    t0 = pool.created // 60 * 60
    cv = 0.0  # cumulative volume of bars [0, i-5]
    n = len(pool)
    for i in range(n - 1):
        if pool.t[i] + 60 - t0 > prm["window_min"] * 60:
            break
        if i >= 5:
            cv += pool.v[i - 5]
        if i < 5:
            continue
        c = pool.c
        if not (c[i] > c[i - 1] > c[i - 2] > c[i - 3]):
            continue
        base5 = cv / (i - 4) * 5.0          # average 5-min volume over the bars before the last 5
        vol5 = sum(pool.v[i - 4:i + 1])
        if base5 <= 0 or vol5 < prm["vol_mult"] * base5:
            continue
        out.append({"si": i, "ei": i + 1, "stop_pct": prm["stop"],
                    "tps": [(prm["tp1"], prm["tp1_frac"])], "trail": prm["trail"],
                    "trail_after_tp": True, "time_stop_min": prm["time_stop_min"]})
    return out


def sig_breakout(pool: Pool, prm, bars5=None):
    b5 = bars5 if bars5 is not None else agg5(pool)
    out = []
    W = prm["range_bars"]
    for k in range(W, len(b5)):
        t_close = b5[k][0] + 300
        if t_close - pool.created < prm["min_age_min"] * 60:
            continue
        win = b5[k - W:k]
        rh = max(b[2] for b in win)
        rl = min(b[3] for b in win)
        if rl <= 0 or (rh - rl) / rl > prm["max_height"]:
            continue
        avgv = sum(b[5] for b in win) / W
        if avgv < prm["min_avg_vol5"]:
            continue
        if b5[k][4] > rh and b5[k][5] >= prm["vol_mult"] * avgv:
            si = b5[k][7]
            if si + 1 >= len(pool):
                break
            out.append({"si": si, "ei": si + 1, "range_low": rl, "range_h": rh - rl,
                        "max_stop": prm["max_stop"], "time_stop_min": prm["time_stop_min"]})
    return out


def sig_pullback(pool: Pool, prm, bars5=None):
    b5 = bars5 if bars5 is not None else agg5(pool)
    if len(b5) < prm["min_bars"] + 2:
        return []
    closes = [b[4] for b in b5]
    e = ema(closes, prm["ema"])
    out = []
    run_low = float("inf")      # lowest price seen so far
    low_before = None           # lowest price before the current peak
    peak, pb_low = None, None
    for k in range(len(b5)):
        o, h, l, c = b5[k][1], b5[k][2], b5[k][3], b5[k][4]
        if peak is None or h > peak:
            # a new high restarts the pullback; the run is measured from the low before it
            low_before = min(run_low, o)
            peak, pb_low = h, None
            run_low = min(run_low, l)
            continue
        run_low = min(run_low, l)
        pb_low = l if pb_low is None else min(pb_low, l)
        if k < prm["min_bars"] or low_before <= 0:
            continue
        if peak / low_before - 1 < prm["min_run"]:
            continue
        depth = 1 - pb_low / peak
        if depth < prm["pb_min"] or depth > prm["pb_max"]:
            continue
        if c > e[k] and closes[k - 1] <= e[k - 1]:
            si = b5[k][7]
            if si + 1 >= len(pool):
                break
            out.append({"si": si, "ei": si + 1, "stop": pb_low, "trail": prm["trail"],
                        "trail_after_tp": False, "tps": [], "time_stop_min": prm["time_stop_min"]})
    return out


STRATEGIES = {"baseline": sig_baseline, "launch": sig_launch, "breakout": sig_breakout,
              "pullback": sig_pullback}


# ----------------------------------------------------------------------------- execution

def buy(L: float, price: float, usd: float, fee_rate: float, impact: bool = True):
    """Spend ``usd`` (fee included) at mid ``price`` in a pool of depth ``L``.

    Returns (tokens, fee_usd, impact_usd)."""
    fee = usd * fee_rate
    q = usd - fee
    y = L * math.sqrt(price) if impact else 0.0
    fill = price * (1 + q / y) if (impact and y > 0) else price
    if impact and y <= 0:
        fill = price * 2.0   # unknown liquidity: assume the worst plausible case, 50 % impact
    tokens = q / fill
    return tokens, fee, q - tokens * price


def sell(L: float, price: float, tokens: float, fee_rate: float, impact: bool = True):
    """Sell ``tokens`` at mid ``price``; returns (usd_out, fee_usd, impact_usd)."""
    v = tokens * price
    if impact:
        y = L * math.sqrt(price)
        out = v * y / (y + v) if y > 0 else v * 0.5
    else:
        out = v
    fee = out * fee_rate
    return out - fee, fee, v - out


def check_filters(pool: Pool, si: int, flt: dict) -> bool:
    if not flt:
        return True
    si = max(si, 0)
    price = pool.c[si]
    liq = pool.liquidity(price, pool.t[si])
    if "min_liq" in flt and liq < flt["min_liq"]:
        return False
    if "max_impact" in flt:
        y = liq / 2
        if y <= 0 or SIZE_USD / y > flt["max_impact"]:
            return False
    if "min_age_min" in flt and (pool.t[si] + 60 - pool.created) < flt["min_age_min"] * 60:
        return False
    if "max_vol_liq" in flt:
        v1h = sum(pool.v[max(0, si - 59):si + 1])
        if liq <= 0 or v1h / liq > flt["max_vol_liq"]:
            return False
    return True


def simulate(pool: Pool, entry: dict, costs: dict = None):
    """Run one trade from ``entry`` through the exit rules on 1-minute bars.

    ``costs`` may override {"fee": per-side fee, "gas": USD per swap, "impact": bool,
    "stop_fill": "low" (default, conservative) | "mid" | "stop" (stop price, or open on a gap),
    "slip": extra adverse slippage per side (MEV, priority auctions), "delay": extra bars
    between signal and fill (slow RPC, failed first transaction)}."""
    costs = costs or {}
    fee_rate = costs.get("fee", pool.fee) + costs.get("slip", 0.0)
    gas = costs.get("gas", pool.gas)
    use_impact = costs.get("impact", True)
    stop_fill = costs.get("stop_fill", "low")
    ei = entry["ei"] + costs.get("delay", 0)
    n = len(pool)
    if ei >= n:
        return None
    px = pool.o[ei]
    L = pool.depth_at(pool.t[ei] - 60)     # liquidity known when the signal fired
    tokens, fee_in, imp_in = buy(L, px, SIZE_USD, fee_rate, use_impact)
    gross_tokens = SIZE_USD / px
    stop = entry.get("stop")
    tps = list(entry.get("tps") or [])      # (gain vs entry, cumulative share sold after it)
    if entry.get("stop_pct") is not None:
        stop = px * (1 - entry["stop_pct"])
    if entry.get("range_low") is not None:   # breakout: below the range low, never worse than max_stop
        stop = max(entry["range_low"] * 0.995, px * (1 - entry["max_stop"]))
        rh = entry["range_h"]
        tps = [(rh / px, 0.5), (2 * rh / px, 1.0)]
    trail = entry.get("trail")
    trail_on = trail is not None and not entry.get("trail_after_tp")
    t_limit = pool.t[ei] + entry["time_stop_min"] * 60
    remaining = 1.0
    fills = []      # (share of position, mid price, reason)
    hi = px
    rug = False
    i = ei
    while i < n and remaining > 1e-9:
        if pool.t[i] >= t_limit:
            fills.append((remaining, pool.o[i], "time"))
            remaining = 0.0
            break
        rug_here = is_rug_bar(pool, i)
        rug = rug or rug_here
        lvl = stop
        if trail_on:
            tl = hi * (1 - trail)
            lvl = tl if lvl is None else max(lvl, tl)
        if lvl is not None and pool.l[i] <= lvl:
            if stop_fill == "low":
                fp = pool.l[i]
            elif stop_fill == "mid":     # halfway between the stop (or a gapped open) and the low
                fp = 0.5 * (min(pool.o[i], lvl) + pool.l[i])
            else:
                fp = min(pool.o[i], lvl)
            why = "rug" if rug_here else ("trail" if (stop is None or lvl > stop) else "stop")
            fills.append((remaining, fp, why))
            remaining = 0.0
            break
        while tps and remaining > 1e-9:
            gain, cum = tps[0]
            tgt = px * (1 + gain)
            if pool.h[i] < tgt:
                break
            take = max(0.0, min(remaining, cum - (1.0 - remaining)))
            if take > 0:
                fills.append((take, tgt, "tp"))
                remaining -= take
            tps.pop(0)
            if entry.get("trail_after_tp") and trail is not None:
                trail_on = True
        hi = max(hi, pool.h[i])
        i += 1
    censored = False
    if remaining > 1e-9:
        fills.append((remaining, pool.c[n - 1], "end"))
        censored = True
    last = min(i, n - 1)
    out_usd = fee_out = imp_out = gross_out = 0.0
    for share, mid, why in fills:
        u, f, im = sell(L, mid, tokens * share, fee_rate, use_impact)
        out_usd += u - gas
        fee_out += f
        imp_out += im
        gross_out += gross_tokens * share * mid
    pnl = out_usd - SIZE_USD - gas
    reasons = [f[2] for f in fills]
    return {
        "key": pool.key, "universe": pool.universe, "network": pool.network, "dex": pool.dex,
        "created": pool.created, "entry_t": pool.t[ei], "exit_t": pool.t[last],
        "entry_px": px, "liq_entry": round(2 * L * math.sqrt(px), 2), "pnl": pnl, "ret": pnl / SIZE_USD,
        "gross_pnl": gross_out - SIZE_USD, "fees": fee_in + fee_out, "impact": imp_in + imp_out,
        "gas": gas * (1 + len(fills)), "rug": rug, "censored": censored,
        "exit": "+".join(reasons), "hold_min": (pool.t[last] - pool.t[ei]) / 60.0,
        "age_at_entry_min": (pool.t[ei] - pool.created) / 60.0,
    }


def candidates(pool: Pool, strat: str, prm: dict, cache: dict):
    key = (pool.key, strat, tuple(sorted(prm.items())))
    if key not in cache:
        fn = STRATEGIES[strat]
        if strat in ("breakout", "pullback"):
            b5 = cache.setdefault(("b5", pool.key), agg5(pool))
            cache[key] = fn(pool, prm, b5)
        else:
            cache[key] = fn(pool, prm)
    return cache[key]


def run(pools, strat: str, prm: dict, flt: dict, cache: dict, costs=None):
    trades = []
    for p in pools:
        if len(p) < 2:
            continue
        for e in candidates(p, strat, prm, cache):
            if check_filters(p, e["si"], flt):
                tr = simulate(p, e, costs)
                if tr:
                    trades.append(tr)
                break   # one trade per pool: the first signal that passes the filters
    trades.sort(key=lambda t: t["entry_t"])
    return trades


def cap_portfolio(trades, max_open=MAX_OPEN):
    """Chronological EUR 100 cap: skip a signal while 10 positions are open."""
    open_exits, kept = [], []
    for t in trades:
        open_exits = [x for x in open_exits if x > t["entry_t"]]
        if len(open_exits) >= max_open:
            continue
        open_exits.append(t["exit_t"])
        kept.append(t)
    return kept


# ----------------------------------------------------------------------------- statistics

def stats(trades, boot=400, seed=7):
    n = len(trades)
    if n == 0:
        return {"n": 0}
    rets = [t["ret"] for t in trades]
    pnl = [t["pnl"] for t in trades]
    streak = worst = 0
    for t in trades:   # chronological
        streak = streak + 1 if t["pnl"] <= 0 else 0
        worst = max(worst, streak)
    rng = random.Random(seed)
    means = sorted(statistics.fmean(rng.choices(rets, k=n)) for _ in range(boot)) if n > 1 else rets
    return {
        "n": n, "win": sum(1 for r in rets if r > 0) / n, "mean": statistics.fmean(rets),
        "median": statistics.median(rets), "total_eur": sum(pnl), "worst_streak": worst,
        "rug_share": sum(1 for t in trades if t["rug"]) / n,
        "censored": sum(1 for t in trades if t["censored"]),
        "gross_mean": statistics.fmean(t["gross_pnl"] for t in trades) / SIZE_USD,
        "cost_fee": statistics.fmean(t["fees"] for t in trades),
        "cost_impact": statistics.fmean(t["impact"] for t in trades),
        "cost_gas": statistics.fmean(t["gas"] for t in trades),
        "ci90": (means[int(0.05 * len(means))], means[int(0.95 * len(means)) - 1]),
        "p90_ret": sorted(rets)[int(0.9 * (n - 1))], "max_ret": max(rets),
    }


def fmt_row(label, s):
    if not s or s.get("n", 0) == 0:
        return "%-34s %5d" % (label, 0)
    return ("%-34s %5d %5.0f%% %+7.1f%% %+7.1f%% %+8.2f %4d %5.0f%% %+7.1f%% %5.2f %5.2f %5.2f  [%+.1f,%+.1f]"
            % (label, s["n"], 100 * s["win"], 100 * s["mean"], 100 * s["median"], s["total_eur"],
               s["worst_streak"], 100 * s["rug_share"], 100 * s["gross_mean"], s["cost_fee"],
               s["cost_impact"], s["cost_gas"], 100 * s["ci90"][0], 100 * s["ci90"][1]))


HEADER = ("%-34s %5s %6s %8s %8s %8s %4s %6s %8s %5s %5s %5s  %s"
          % ("", "n", "win", "mean", "median", "EUR", "lstk", "rug", "gross", "fee", "imp", "gas",
             "90% CI of mean"))


def grid(space: dict):
    keys = list(space)
    combos = [{}]
    for k in keys:
        combos = [dict(c, **{k: v}) for c in combos for v in space[k]]
    return combos


def split_by_time(pools, share=TRAIN_SHARE):
    """Earlier pools -> train, later pools -> test, separately inside every universe."""
    train, test = [], []
    by_u = {}
    for p in pools:
        by_u.setdefault(p.universe, []).append(p)
    cut = {}
    for u, ps in by_u.items():
        ps.sort(key=lambda p: p.created)
        k = int(len(ps) * share)
        train += ps[:k]
        test += ps[k:]
        cut[u] = ps[k].created if k < len(ps) else None
    return train, test, cut


def dataset_summary(pools):
    rows = {}
    for p in pools:
        r = rows.setdefault(p.universe, {"pools": 0, "no_trades": 0, "died": 0, "rug2h": 0,
                                         "t0": 1e12, "t1": 0, "liq": [], "no_liq": 0,
                                         "graduated": 0, "under_1k_liq": 0, "hours": []})
        r["graduated"] += 1 if p.graduated else 0
        r["hours"].append((p.fetched - p.created) / 3600.0)
        r["pools"] += 1
        r["t0"] = min(r["t0"], p.created)
        r["t1"] = max(r["t1"], p.created)
        if len(p) == 0:
            r["no_trades"] += 1
            continue
        peak = max(p.h)
        if p.c[-1] < 0.1 * peak:
            r["died"] += 1
        lim = p.idx_at(p.created + 7200)
        if any(is_rug_bar(p, i) for i in range(1, min(lim, len(p)))):
            r["rug2h"] += 1
        i5 = min(p.idx_at(p.created // 60 * 60 + 300), len(p) - 1)
        if p.anchors:
            r["liq"].append(p.liquidity(p.c[i5], p.t[i5]))
            r["under_1k_liq"] += 1 if r["liq"][-1] < 1000 else 0
        else:
            r["no_liq"] += 1
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--quick", action="store_true", help="defaults only, no grid")
    ap.add_argument("--min-age-h", type=float, default=2.5)
    ap.add_argument("--universes", nargs="*", default=None)
    args = ap.parse_args(argv)
    t_start = time.time()
    pools, skipped = load_dataset(args.data, args.min_age_h)
    if args.universes:
        pools = [p for p in pools if p.universe in args.universes]
    print("loaded %d pools (%s) in %.1fs" % (len(pools), skipped, time.time() - t_start))
    ds = dataset_summary(pools)
    print("\nDATASET")
    for u, r in sorted(ds.items()):
        liq = sorted(r["liq"])
        med = liq[len(liq) // 2] if liq else 0
        hrs = sorted(r["hours"])
        print("  %-20s pools=%4d  created %s .. %s  no-trades=%d  died(<10%% of peak)=%d  rug<2h=%d  "
              "median liq@5min=$%.0f  liq<$1k=%d  no-liq-info=%d  graduated=%d  median age at fetch %.1fh"
              % (u, r["pools"], time.strftime("%m-%d %H:%M", time.gmtime(r["t0"])),
                 time.strftime("%m-%d %H:%M", time.gmtime(r["t1"])), r["no_trades"], r["died"],
                 r["rug2h"], med, r["under_1k_liq"], r["no_liq"], r["graduated"],
                 hrs[len(hrs) // 2] if hrs else 0))
    train, test, cut = split_by_time(pools)
    print("  train=%d test=%d (time cut per universe: %s)" % (
        len(train), len(test), {u: time.strftime("%m-%d %H:%M", time.gmtime(c)) for u, c in cut.items() if c}))
    cache = {}
    summary = {"dataset": {u: {k: v for k, v in r.items() if k not in ("liq", "hours")} for u, r in ds.items()},
               "prereg": PREREG, "filters": FILTERS, "results": {}}
    all_trades = []
    for strat, space in PREREG.items():
        combos = grid(space)[:1] if args.quick else grid(space)
        print("\n" + "=" * 150 + "\n%s  (%d param sets)" % (strat.upper(), len(combos)))
        # 1. choose params on TRAIN (no filter), by mean net return with >= 20 trades
        best, best_s = combos[0], None
        print(HEADER)
        for prm in combos:
            s = stats(run(train, strat, prm, {}, cache))
            lab = "train " + ",".join("%s=%s" % (k, v) for k, v in prm.items() if len(space[k]) > 1) or "train default"
            print(fmt_row(lab[:34], s))
            if s.get("n", 0) >= 20 and (best_s is None or s["mean"] > best_s["mean"]):
                best, best_s = prm, s
        print("chosen on train: %s" % {k: v for k, v in best.items() if len(space[k]) > 1})
        # 2. every filter with the chosen params: all pools / train / test, per universe
        res = {"params": best, "rows": {}}
        print(HEADER)
        for fname, flt in FILTERS.items():
            for part, ps in (("ALL", pools), ("train", train), ("TEST", test)):
                tr = run(ps, strat, best, flt, cache)
                s = stats(tr)
                res["rows"]["%s|%s" % (fname, part)] = s
                print(fmt_row("%s %s" % (fname, part), s))
                if fname == "none" and part == "ALL":
                    for t in tr:
                        all_trades.append(dict(t, strategy=strat))
        # 3. per universe (test part, no filter and combo filter)
        print("  per universe, TEST part:")
        for u in sorted({p.universe for p in pools}):
            for fname in ("none", "liq>=10k", "combo"):
                tr = run([p for p in test if p.universe == u], strat, best, FILTERS[fname], cache)
                s = stats(tr)
                res["rows"]["%s|TEST|%s" % (fname, u)] = s
                print(fmt_row("  %s %s" % (u, fname), s))
        # 4. cost attribution + fill sensitivity on ALL with no filter
        tr0 = run(pools, strat, best, {}, cache)
        tr_nc = run(pools, strat, best, {}, cache, costs={"fee": 0.0, "gas": 0.0, "impact": False})
        tr_sf = run(pools, strat, best, {}, cache, costs={"stop_fill": "stop"})
        tr_sm = run(pools, strat, best, {}, cache, costs={"stop_fill": "mid"})
        tr_sl = run(pools, strat, best, {}, cache, costs={"slip": 0.01})
        tr_dl = run(pools, strat, best, {}, cache, costs={"delay": 1})
        tr_cap = cap_portfolio(tr0)
        for lab, t in (("with costs (ALL)", tr0), ("NO costs (ALL)", tr_nc),
                       ("stops fill at stop px (ALL)", tr_sf), ("stops fill mid stop/low (ALL)", tr_sm),
                       ("+1%/side MEV slippage (ALL)", tr_sl),
                       ("fill 1 bar later (ALL)", tr_dl), ("EUR100 cap, 10 open (ALL)", tr_cap)):
            s = stats(t)
            res["rows"][lab] = s
            print(fmt_row(lab, s))
        summary["results"][strat] = res
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1, default=str)
    if all_trades:
        with open(os.path.join(RESULTS, "trades.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(all_trades[0].keys()))
            w.writeheader()
            w.writerows(all_trades)
    print("\nwrote results/summary.json and results/trades.csv in %.0fs" % (time.time() - t_start))


if __name__ == "__main__":
    main()
