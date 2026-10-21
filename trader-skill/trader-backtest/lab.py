#!/usr/bin/env python3
"""Backtest lab — which crypto setups really worked, on which coins, with which exits?

It replays real history for many coins — 5-minute bars for the one-day setups (range breakouts, VWAP
reclaim, momentum …), 1-hour and 4-hour bars for the swing setups (trend pullback, oversold bounce,
band bounce, 24-bar breakout) — and tries a grid of exits for each: target 0.5–5R, a structure stop or
1–3×ATR, four time stops. Fees and slippage are paid on every trade. ``--min-target-r 2`` keeps only
exits that aim for at least 2R (one win pays for two losses).

How it avoids fooling itself (walk-forward):
  1. the history is cut into four equal periods (``--folds 3``). For each of the last three, the exit with
     the highest certainty (profit chance, below) is chosen on everything BEFORE it, with all coins pooled —
     one rule for every coin, hundreds of trades, not a lucky fit per coin — and then traded, unchanged,
     in that period, which the choice never saw;
  2. a setup HOLDS only if that out-of-sample result made money in every one of those periods;
  3. a coin is VALIDATED for a held setup only if it made money out of sample, including the latest period.
Validated coin + setup + timeframe combinations go into trader/backtests/playbook.json — with the exit
chosen last — and the autopilot trades crypto only from that playbook.

  win chance     share of trades that ended in profit after fees and slippage
  edge           average net result per trade in R (1R = the amount risked)
  profit chance  how often 20 trades, drawn at random from the out-of-sample results, added up to a profit

A high win chance alone means nothing — many small wins and a few big losses lose money. The report
shows the highest win chance each setup can reach and what it earned. All of it describes the past.

Examples:
  python3 lab.py                                    # top 25 coins, 5m (180 d) + 1h (365 d) + 4h (730 d) + 1d (~8 y)
  python3 lab.py --symbols BTCUSDT,ETHUSDT,SOLUSDT --timeframes 1h
  python3 lab.py --top 40 --objective win            # highest share of winning trades instead
  python3 lab.py --min-target-r 2                      # only exits that aim for 2R or more
  python3 lab.py --fee-bps 25                       # e.g. Alpaca's crypto taker fee
"""
from __future__ import annotations

import math
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, html, market_clock, setups, skills, state, symbols, trade_sim  # noqa: E402
from shared import indicators, universe as universe_mod  # noqa: E402
from shared.indicators import Candle  # noqa: E402

LAB_FILE = "backtests/lab-crypto.json"
PLAYBOOK = "backtests/playbook.json"
LAB_FILE_ETF = "backtests/lab-etf.json"
PLAYBOOK_ETF = "backtests/playbook-etf.json"
DEFAULT_ETFS = ("SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "DBC", "UUP", "XLE", "XLF", "XLK", "SMH")
STORE = "cache/lab"
TIMEFRAMES = {
    "5m": {"kind": "window", "horizons_h": (1, 4, 12, 24)},
    "1h": {"kind": "series", "horizons_h": (12, 24, 48, 72)},
    "4h": {"kind": "series", "horizons_h": (24, 48, 96, 168)},
    "1d": {"kind": "series", "horizons_h": (240,)},   # rule-exit setups: the exit is part of the rule, no grid
}
RULE_KEY = ("rule", 0.0, 0)
RUNNER_KEY = ("runner", 0.0, 0)  # the same trades when part of a winner rides on (setups with a runner rule)
RUNNER_MIN_CHANCE_DROP = 0.03     # riding on may lower the profit chance by at most this much
TARGETS_R = (0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0)
STOPS = (("auto", 1.5), ("atr", 1.0), ("atr", 1.5), ("atr", 2.0), ("atr", 3.0))
ATR_LOOKBACK_BARS = 300
PROFIT_TRADES = 20            # "profit chance" = P(sum of this many trades > 0)
BOOTSTRAP_PATHS = 4000
SEED = 7
PLAYBOOK_DAYS = 14            # the autopilot stops trusting a playbook older than this


def build_parser():
    p = cli.parser("lab.py", __doc__)
    p.add_argument("--etf", action="store_true",
                   help="the daily ETF trend on autopilot.etf_trend.symbols (gold, the dollar, commodities, bonds, "
                        "energy, the indexes) instead of crypto")
    p.add_argument("--symbols", help="comma-separated coins or ETFs (default: the top --top coins by 24h volume, or "
                                     "autopilot.etf_trend.symbols)")
    p.add_argument("--top", type=int, default=25, help="how many coins by 24h volume (default 25)")
    p.add_argument("--timeframes", default="5m,1h,4h,1d", help="any of 5m,1h,4h,1d (default all four)")
    p.add_argument("--days", type=float, default=180, help="days of 5-minute history (default 180)")
    p.add_argument("--swing-days", type=float, default=365,
                   help="days of 1-hour history (default 365; 4-hour bars get twice as much)")
    p.add_argument("--daily-days", type=float, default=3000, help="days of daily history (default 3000, ~8 years)")
    p.add_argument("--setups", help="comma-separated crypto setups (default: every crypto setup)")
    p.add_argument("--folds", type=int, default=3,
                   help="walk-forward periods: the history is cut into FOLDS + 1 parts and every part after the first "
                        "is traded with an exit chosen on the parts before it (default 3)")
    p.add_argument("--objective", choices=("profit", "win"), default="profit",
                   help="profit = highest profit chance, i.e. certainty (default); win = highest win chance among "
                        "exits with a net edge")
    p.add_argument("--min-target-r", type=float, default=0.0,
                   help="only exits whose target is at least this many R (e.g. 3 for 3:1 reward to risk)")
    p.add_argument("--min-pooled", type=int, default=100, help="minimum pooled train trades for an exit (100)")
    p.add_argument("--min-pooled-test", type=int, default=50, help="minimum out-of-sample trades, all coins (50)")
    p.add_argument("--min-fold-test", type=int, default=10, help="minimum trades in each walk-forward period (10)")
    p.add_argument("--min-test", type=int, default=10, help="minimum test trades for one coin (10)")
    p.add_argument("--min-edge", type=float, default=0.05, help="minimum net edge in R per trade (0.05)")
    p.add_argument("--fee-bps", type=float, help="fee per side (default config costs.crypto)")
    p.add_argument("--slippage-bps", type=float, help="slippage per side (default config costs.crypto)")
    p.add_argument("--workers", type=int, default=4, help="parallel downloads (default 4)")
    p.add_argument("--no-playbook", action="store_true", help="don't write trader/backtests/playbook.json")
    return p


# --- candles: a local store that only downloads what is new ---------------------------------------

def _store_name(sym, interval: str) -> str:
    return "%s/%s-%s.json" % (STORE, sym.key, interval)


def history(sym, interval: str, days: float, now_ts: int, asset: str = "crypto") -> tuple:
    """(candles, source) for the last ``days`` — reuses the local copy and fetches only the new tail."""
    step = market_clock.interval_seconds(interval)
    start_ts = now_ts - int(days * 86400)
    doc = state.read_json(_store_name(sym, interval), {}) or {}
    rows = doc.get("candles") or []
    if rows and rows[0][0] <= start_ts + 86400 and doc.get("source"):
        tail_days = max(0.01, (now_ts - rows[-1][0]) / 86400.0 + 2 * step / 86400.0)
        series = data.get_candles(sym, interval, days=tail_days, asset=asset, end=market_clock.iso(now_ts))
        if series.source == doc["source"]:
            seen = {r[0] for r in rows}
            rows += [[c.t, c.o, c.h, c.l, c.c, c.v] for c in series.candles if c.t not in seen]
        else:
            rows = []
    if not rows:
        series = data.get_candles(sym, interval, days=days, asset=asset, end=market_clock.iso(now_ts))
        rows = [[c.t, c.o, c.h, c.l, c.c, c.v] for c in series.candles]
        doc["source"] = series.source
    rows = sorted((r for r in rows if r[0] + step <= now_ts), key=lambda r: r[0])
    state.write_json(_store_name(sym, interval), {"symbol": sym.key, "interval": interval, "source": doc["source"],
                                                  "updated_at": market_clock.iso(now_ts), "candles": rows})
    return [Candle(*r) for r in rows if r[0] >= start_ts], doc["source"]


# --- triggers and the exit grid --------------------------------------------------------------------

def triggers(candles, setup: str, interval: str, now_ts: int) -> list:
    """Every finished signal: one per UTC day for the one-day setups, cool-down spaced for swing setups."""
    step = market_clock.interval_seconds(interval)
    last_entry = now_ts - max(TIMEFRAMES[interval]["horizons_h"]) * 3600  # its trade must have had time to finish
    out = []
    if setups.is_series(setup):
        for r in setups.series_signals(setup, candles, interval):
            trig = r["trigger"]
            if trig["t"] + step <= last_entry:
                out.append({"key": r["window"], "gi": trig["index"], "entry": trig["price"],
                            "entry_ts": trig["t"] + step, "stop_ref": r.get("stop_ref"),
                            "trigger_level": (r.get("levels") or {}).get("trigger_level")})
        return out
    index_of = {c.t: i for i, c in enumerate(candles)}
    for w in setups.windows(candles, "crypto", interval):
        if w.end > now_ts:
            continue
        r = setups.evaluate(setup, w, None, {"pick": "first"})
        if r["status"] != "triggered" or not r.get("trigger"):
            continue
        trig = r["trigger"]
        if trig["t"] + step > last_entry:
            continue
        out.append({"key": w.key, "gi": index_of[trig["t"]], "entry": trig["price"], "entry_ts": trig["t"] + step,
                    "stop_ref": r.get("stop_ref"), "trigger_level": (r.get("levels") or {}).get("trigger_level")})
    return out


def grid_outcomes(candles, trig: dict, interval: str, exit_mod, tick, cost: float) -> dict:
    """Net R for every (stop, target, horizon) in the grid — one walk per stop.

    Same fills as the backtester: the entry is the signal candle's close, a bar that touches both the
    stop and the target counts as a stop, a gap through the stop fills at the open.
    """
    step = market_clock.interval_seconds(interval)
    horizons = TIMEFRAMES[interval]["horizons_h"]
    gi, entry, entry_ts = trig["gi"], trig["entry"], trig["entry_ts"]
    hist = candles[max(0, gi - ATR_LOOKBACK_BARS):gi + 1]
    max_end = entry_ts + max(horizons) * 3600
    bars = []
    for c in candles[gi + 1:gi + 2 + (max_end - entry_ts) // step]:
        if c.t >= max_end:
            break
        bars.append(c)
    if not bars:
        return {}
    cut = {h: sum(1 for b in bars if b.t < entry_ts + h * 3600) for h in horizons}
    out = {}
    for kind, mult in STOPS:
        try:
            lv = exit_mod.plan_levels(entry, entry_ts, "crypto", hist, stop_ref=trig["stop_ref"],
                                      trigger_level=trig["trigger_level"], stop=kind, atr_mult=mult, target_r=1.0,
                                      tick=tick, horizon_s=3600)
        except ValueError:
            continue
        stop = lv["stop"]["price"]
        risk = entry - stop
        if risk <= 0:
            continue
        targets = [exit_mod.round_price(entry + r * risk, "crypto", tick, "nearest") for r in TARGETS_R]
        first_hit = [None] * len(targets)
        stop_i = stop_fill = None
        for i, b in enumerate(bars):
            if b.o <= stop:
                stop_i, stop_fill = i, b.o
                break
            if b.l <= stop:
                stop_i, stop_fill = i, stop
                break
            for k, tp in enumerate(targets):
                if first_hit[k] is None and b.h >= tp:
                    first_hit[k] = i
        skey = "atr:%g" % mult if kind == "atr" else "auto"
        for h, c_n in cut.items():
            if c_n == 0:
                continue
            for k, r_t in enumerate(TARGETS_R):
                if first_hit[k] is not None and first_hit[k] < c_n:
                    px = targets[k]
                elif stop_i is not None and stop_i < c_n:
                    px = stop_fill
                else:
                    px = bars[c_n - 1].c
                out[(skey, r_t, h)] = trade_sim.net_r(entry, px, risk, cost)
    return out


# --- statistics ----------------------------------------------------------------------------------

def _phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def stats(rs: list) -> dict:
    n = len(rs)
    if not n:
        return {"n": 0, "win_rate": None, "expectancy_r": None, "total_r": 0.0, "profit_factor": None,
                "avg_win_r": None, "avg_loss_r": None, "max_drawdown_r": 0.0, "profit_chance": None}
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    mean = sum(rs) / n
    sd = math.sqrt(sum((r - mean) ** 2 for r in rs) / (n - 1)) if n > 1 else 0.0
    peak = cum = dd = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        dd = min(dd, cum - peak)
    gl = -sum(losses)
    return {"n": n, "win_rate": round(len(wins) / float(n), 4), "expectancy_r": round(mean, 4),
            "total_r": round(sum(rs), 3), "profit_factor": round(sum(wins) / gl, 3) if gl > 0 else None,
            "avg_win_r": round(sum(wins) / len(wins), 3) if wins else None,
            "avg_loss_r": round(sum(losses) / len(losses), 3) if losses else None,
            "max_drawdown_r": round(dd, 3),
            # normal approximation — good enough to rank; reported numbers use the bootstrap below
            "profit_chance": round(_phi(mean / sd * math.sqrt(PROFIT_TRADES)), 4) if sd > 0 else (
                1.0 if mean > 0 else 0.0)}


def bootstrap_profit_chance(rs: list, k: int = PROFIT_TRADES, paths: int = BOOTSTRAP_PATHS, seed: int = SEED):
    if not rs:
        return None
    rng = random.Random(seed)
    n = len(rs)
    hits = 0
    for _ in range(paths):
        if sum(rs[int(rng.random() * n)] for _ in range(k)) > 0:
            hits += 1
    return round(hits / float(paths), 4)


def final_stats(rs: list) -> dict:
    s = stats(rs)
    s["profit_chance"] = bootstrap_profit_chance(rs)
    return s


def exit_label(key, setup: str = None) -> dict:
    if key[0] == "rule":
        spec = setups.SETUPS.get(setup) or {}
        rule = spec.get("exit_rule") or {}
        return {"stop": "rule", "atr_mult": float(spec.get("stop_atr") or 3.0), "target_r": None,
                "horizon": "%dd" % int(rule.get("max_bars") or 10), "exit_rule": rule,
                "text": "exit %s · %s" % (rule.get("short") or rule.get("text") or "rule", setups.stop_text(setup))}
    stop, target, hours = key
    atr = stop.startswith("atr:")
    return {"stop": "atr" if atr else "auto", "atr_mult": float(stop.split(":")[1]) if atr else 1.5,
            "target_r": target, "horizon": "%dh" % hours,
            "text": "%gR target · %s · %dh" % (target, ("%s×ATR stop" % stop.split(":")[1]) if atr
                                                else "structure stop", hours)}


def choose(by_key: dict, objective: str, min_n: int, min_edge: float, min_target_r: float = 0.0):
    """Best exit on the given (train) trades: highest win chance among exits with an edge, or highest profit chance."""
    best, best_score = None, None
    for key, rs in by_key.items():
        if key[0] == "runner" or len(rs) < min_n or (key[1] < min_target_r and key[0] != "rule"):
            continue
        s = stats(rs)
        if s["expectancy_r"] < min_edge:
            continue
        score = (s["win_rate"], s["profit_chance"], s["expectancy_r"]) if objective == "win" else \
            (s["profit_chance"], s["expectancy_r"], s["win_rate"])
        if best_score is None or score > best_score:
            best, best_score = key, score
    return best


def highest_win(by_key: dict, min_n: int, min_target_r: float = 0.0):
    """The exit with the highest win chance, edge or not — to show what a high win chance costs."""
    best, best_score = None, None
    for key, rs in by_key.items():
        if len(rs) < min_n or key[1] < min_target_r:
            continue
        s = stats(rs)
        score = (s["win_rate"], s["expectancy_r"])
        if best_score is None or score > best_score:
            best, best_score = key, score
    return best


# --- one setup on one timeframe, all coins -------------------------------------------------------------

def tf_days(interval: str, args) -> float:
    return {"5m": args.days, "1h": args.swing_days, "4h": args.swing_days * 2, "1d": args.daily_days}[interval]


def setup_fits(setup: str, interval: str) -> bool:
    spec = setups.SETUPS[setup]
    if spec["kind"] != "series":
        return interval == "5m"
    return interval in (spec.get("intervals") or ("1h", "4h"))


def rule_trades(candles, setup: str, interval: str, cost: float, context: dict = None, exits: dict = None) -> list:
    """Trades of a rule-exit setup, one at a time per coin: [(entry_ts, {RULE_KEY: net R})].

    Entry at the signal close; exit at the first close that meets the rule, at the protective stop
    (the setup's stop rule; gaps fill at the open) or at the close of the last allowed bar.
    """
    spec = setups.SETUPS[setup]
    rule = spec["exit_rule"]
    step = market_clock.interval_seconds(interval)
    closes = [c.c for c in candles]
    atrs = indicators.atr(candles)
    cache = {("ema", int(rule["n"])): indicators.ema(closes, int(rule["n"]))} if rule["type"] == "close_below_ema" else {}
    ride = setups.runner(setup)
    if ride:
        rr = ride["exit_rule"]
        cache[("ema", int(rr["n"]))] = indicators.ema(closes, int(rr["n"]))
        trend = indicators.sma(closes, int(ride.get("min_sma") or 200))
    out, busy = [], -1
    for r in setups.series_signals(setup, candles, interval, context=context):
        i = r["trigger"]["index"]
        if i <= busy:
            continue
        entry = candles[i].c
        stop = setups.rule_stop(setup, candles, i, r.get("levels") or {}, atrs[i])
        if stop <= 0 or stop >= entry:
            continue
        px, j, how = None, i, "stop"
        for j in range(i + 1, min(len(candles), i + 1 + int(rule["max_bars"]))):
            b = candles[j]
            if b.o <= stop:
                px = b.o
                break
            if b.l <= stop:
                px = stop
                break
            if setups.rule_says_exit(rule, closes, j, cache):
                px, how = b.c, "rule"
                break
        else:
            if j == i + int(rule["max_bars"]):
                px, how = candles[j].c, "time"
        if px is None:
            break  # the last trade has not finished yet
        res = {RULE_KEY: trade_sim.net_r(entry, px, entry - stop, cost)}
        ride_end = candles[j].t + step
        if ride:
            if how == "stop":
                res[RUNNER_KEY] = res[RULE_KEY]
            else:
                res[RUNNER_KEY], ride_end = _with_runner(ride, candles, closes, cache, trend, j, entry, stop,
                                                         res[RULE_KEY], cost, step)
        if exits is not None:  # when each trade ended — the health check orders trades the way the bot closes them
            exits[candles[i].t + step] = (candles[j].t + step, ride_end)
        out.append((candles[i].t + step, res))
        busy = j
    return out


def _with_runner(ride, candles, closes, cache, trend, j, entry, stop, r_main, cost, step=86400):
    """Net R of the whole trade when part of it rides on after the exit rule fired at bar j (price px).

    Only a winner rides, and only while the coin is above its long average; the part left in leaves at
    the first close that meets the runner's rule, or at the buy price (its stop moves there), or after
    max_bars. A ride that has not finished yet is valued at the last close.
    """
    if r_main <= 0 or j < int(ride.get("min_sma") or 200) - 1 or closes[j] <= trend[j]:
        return r_main, candles[j].t + step
    rule, keep = ride["exit_rule"], float(ride["keep"])
    be = max(stop, entry)
    rpx, k = None, j
    for k in range(j + 1, min(len(candles), j + 1 + int(rule["max_bars"]))):
        b = candles[k]
        if b.o <= be:
            rpx = b.o
            break
        if b.l <= be:
            rpx = be
            break
        if setups.rule_says_exit(rule, closes, k, cache):
            rpx = b.c
            break
    if rpx is None:
        rpx = candles[k].c
    return (1 - keep) * r_main + keep * trade_sim.net_r(entry, rpx, entry - stop, cost), candles[k].t + step


def runner_verdict(setup: str, without: dict, ride_rs: list, folds: list) -> dict:
    """Does letting part of a winner ride beat selling it all — on the walk-forward periods nobody tuned on?"""
    ride = setups.runner(setup)
    with_ = final_stats(ride_rs)
    gain = with_["expectancy_r"] - without["expectancy_r"]
    drop = without["profit_chance"] - with_["profit_chance"]
    helps = gain > 0 and drop <= RUNNER_MIN_CHANCE_DROP
    words = setups.keep_text(float(ride["keep"]))
    if helps:
        why = "keeping %s in until %s added %s per trade on unseen periods (%s → %s), profit chance %s → %s" % (
            words, ride["exit_rule"]["short"], fmt.r(gain), fmt.r(without["expectancy_r"]), fmt.r(with_["expectancy_r"]),
            fmt.pct(100 * without["profit_chance"], 0), fmt.pct(100 * with_["profit_chance"], 0))
    elif gain <= 0:
        why = "keeping %s in did not pay on unseen periods (%s per trade) — the bot sells everything" % (
            words, fmt.r(gain))
    else:
        why = "keeping %s in added %s per trade but cut the profit chance by %s — the bot sells everything" % (
            words, fmt.r(gain), fmt.pct(100 * drop, 0))
    return {"keep": float(ride["keep"]), "min_sma": int(ride.get("min_sma") or 200), "exit_rule": ride["exit_rule"],
            "test": with_, "test_without": without, "gain_r": round(gain, 3), "helps": helps, "why": why,
            "folds": [{"without_r": round(a, 3), "with_r": round(b, 3)} for a, b in folds]}


def study_family(setup: str, interval: str, coins: list, now_ts: int, args, exit_mod, cost: float,
                 context: dict = None) -> tuple:
    """Walk-forward test of one setup on one timeframe across all coins.

    The history is cut into folds + 1 equal periods. In fold k the exit is chosen on everything before period
    k + 1 (all coins pooled) and then traded, unchanged, in period k + 1. The setup holds only if that
    out-of-sample result made money in every period; the exit to trade is the one chosen last.
    coins: [(sym, candles, tick)] → (family summary, per-coin rows, per-coin-optimised test edges).
    """
    start_ts = int(now_ts - tf_days(interval, args) * 86400)
    k = max(1, int(args.folds))
    bounds = [int(start_ts + i * (now_ts - start_ts) / float(k + 1)) for i in range(1, k + 1)] + [int(now_ts)]
    rule = setups.exit_rule(setup)
    # a rule-exit setup has nothing to choose, so the training data only has to show it made money at all
    min_n = max(20, args.min_pooled // 4) if rule else args.min_pooled
    per_coin, ends = [], {}
    for sym, candles, tick in coins:
        if rule:
            ends[sym.key] = {}
            per_coin.append((sym, rule_trades(candles, setup, interval, cost, context, ends[sym.key])))
        else:
            per_coin.append((sym, [(t["entry_ts"], grid_outcomes(candles, t, interval, exit_mod, tick, cost))
                                   for t in triggers(candles, setup, interval, now_ts)]))

    def pool(lo, hi, only=None):
        out = {}
        for sym, trades in per_coin:
            if only is not None and sym.key != only:
                continue
            for ts, res in trades:
                if lo <= ts < hi:
                    for key, r in res.items():
                        out.setdefault(key, []).append(r)
        return out

    folds, oos, oos_coin, best = [], [], {sym.key: [] for sym, _ in per_coin}, None
    ride_oos, ride_coin, ride_folds = [], {sym.key: [] for sym, _ in per_coin}, []
    timed, ride_timed = [], []  # [entry time, R] of every out-of-sample trade, for shared/health.py
    for i in range(k):
        train, test = pool(start_ts, bounds[i]), pool(bounds[i], bounds[i + 1])
        b = choose(train, args.objective, min_n, args.min_edge, args.min_target_r)
        if b is not None:
            for sym, trades in per_coin:
                for ts, res in trades:
                    if bounds[i] <= ts < bounds[i + 1] and b in res:
                        end, ride_end = ends.get(sym.key, {}).get(ts, (ts, ts))
                        timed.append([int(end), round(res[b], 4)])
                        if RUNNER_KEY in res and b == RULE_KEY:
                            ride_timed.append([int(ride_end), round(res[RUNNER_KEY], 4)])
        if b == RULE_KEY and RUNNER_KEY in test:
            ride_oos += test[RUNNER_KEY]
            ride_folds.append((stats(test.get(RULE_KEY, []))["expectancy_r"], stats(test[RUNNER_KEY])["expectancy_r"]))
            for sym, trades in per_coin:
                ride_coin[sym.key] += [res[RUNNER_KEY] for ts, res in trades
                                       if bounds[i] <= ts < bounds[i + 1] and RUNNER_KEY in res]
        f = {"train_until": market_clock.iso(bounds[i]), "test_until": market_clock.iso(bounds[i + 1]),
             "exit": exit_label(b, setup) if b else None, "train": stats(train[b]) if b else None,
             "test": stats(test.get(b, [])) if b else None}
        folds.append(f)
        best = b
        if b is None:
            continue
        oos += test.get(b, [])
        for sym, trades in per_coin:
            oos_coin[sym.key] += [res[b] for ts, res in trades if bounds[i] <= ts < bounds[i + 1] and b in res]
    last_train, last_test = pool(start_ts, bounds[k - 1]), pool(bounds[k - 1], bounds[k])
    fam = {"setup": setup, "label": setups.SETUPS[setup]["label"], "timeframe": interval,
           "train_until": market_clock.iso(bounds[k - 1]), "coins": sum(1 for _, t in per_coin if t),
           "signals": sum(len(t) for _, t in per_coin), "folds": folds}
    # what the highest win chance looks like, edge or not
    hw = None if rule else highest_win(last_train, args.min_pooled, args.min_target_r)
    fam["highest_win"] = None if hw is None else {
        "exit": exit_label(hw), "train": stats(last_train[hw]), "test": stats(last_test.get(hw, []))}
    rows, verdict = [], None
    missing = [i + 1 for i, f in enumerate(folds) if not f["exit"]]
    thin = [i + 1 for i, f in enumerate(folds) if f["exit"] and f["test"]["n"] < args.min_fold_test]
    losing = [(i + 1, f["test"]["expectancy_r"]) for i, f in enumerate(folds)
              if f["exit"] and f["test"]["n"] and f["test"]["expectancy_r"] <= 0]
    oos_s = final_stats(oos) if oos else stats([])
    if missing:
        verdict = "no exit had a net edge ≥ %s on the training data of period%s %s" % (
            fmt.r(args.min_edge), "" if len(missing) == 1 else "s", ", ".join(map(str, missing)))
    elif thin:
        verdict = "too few trades in walk-forward period%s %s" % ("" if len(thin) == 1 else "s",
                                                                    ", ".join(map(str, thin)))
    elif losing:
        verdict = "lost money in walk-forward period%s %s" % (
            "" if len(losing) == 1 else "s", ", ".join("%d (%s)" % (i, fmt.r(e)) for i, e in losing))
    elif oos_s["n"] < args.min_pooled_test:
        verdict = "only %d out-of-sample trades" % oos_s["n"]
    elif oos_s["expectancy_r"] < args.min_edge:
        verdict = "out-of-sample edge %s is below %s" % (fmt.r(oos_s["expectancy_r"]), fmt.r(args.min_edge))
    ok = verdict is None
    if best is None:
        fam.update(exit=None, train=None, test=oos_s if oos else None, validated=False, verdict=verdict)
    else:
        fam.update(exit=exit_label(best, setup), train=final_stats(last_train[best]), test=oos_s, validated=ok,
                   verdict=verdict or "made money in all %d walk-forward periods" % k)
        for sym, trades in per_coin:
            if not trades:
                continue
            a = stats(pool(start_ts, bounds[k - 1], sym.key).get(best, []))
            b = stats(oos_coin[sym.key])
            recent = stats(pool(bounds[k - 1], bounds[k], sym.key).get(best, []))
            why = []
            if not ok:
                why.append("the setup failed across all coins")
            if b["n"] < args.min_test:
                why.append("only %d out-of-sample trades on this coin" % b["n"])
            elif b["expectancy_r"] < args.min_edge:
                why.append("out-of-sample edge %s on this coin" % fmt.r(b["expectancy_r"]))
            if recent["n"] and recent["expectancy_r"] < 0:
                why.append("lost money on this coin in the latest period (%s)" % fmt.r(recent["expectancy_r"]))
            if not why:
                b = final_stats(oos_coin[sym.key])
            rows.append({"symbol": sym.key, "display": sym.display, "setup": setup, "timeframe": interval,
                         "exit": exit_label(best, setup), "train": a, "test": b, "recent": recent,
                         "validated": not why,
                         "why": "; ".join(why) or "made money out of sample, including the latest period"})
    fam["validated_coins"] = [r["display"] for r in rows if r["validated"]]
    fam["runner"] = runner_verdict(setup, oos_s, ride_oos, ride_folds) if (best == RULE_KEY and ride_oos) else None
    # every out-of-sample trade as [exit time, R] in time order, so the autopilot can tell whether its own results
    # look like these
    fam["test_trades"] = sorted(timed)
    if fam["runner"]:
        fam["runner"]["test_trades"] = sorted(ride_timed)
    for r in rows:
        if fam["runner"] and ride_coin.get(r["symbol"]):
            r["runner"] = stats(ride_coin[r["symbol"]])
    # the tempting alternative: tune every coin on its own — how much of that survives?
    picks = []
    for sym, _ in ([] if rule else per_coin):
        key = choose(pool(start_ts, bounds[k - 1], sym.key), args.objective, 20, args.min_edge, args.min_target_r)
        if key is not None:
            picks.append(stats(pool(bounds[k - 1], bounds[k], sym.key).get(key, []))["expectancy_r"])
    return fam, rows, picks


# --- the run -----------------------------------------------------------------------------------------

def universe(args, cfg) -> tuple:
    if getattr(args, "etf", False):
        raw = args.symbols.split(",") if args.symbols else \
            (((cfg.get("autopilot") or {}).get("etf_trend") or {}).get("symbols") or DEFAULT_ETFS)
        return [symbols.parse(s.strip(), asset="stock") for s in raw if s.strip()], \
            "your list" if args.symbols else "%d ETFs (autopilot.etf_trend.symbols)" % len(raw)
    quote = cfg.get("quote_currency") or "USDT"
    if args.symbols:
        return [symbols.parse(s.strip(), asset="crypto", quote=quote) for s in args.symbols.split(",") if s.strip()], \
            "your list"
    uni = data.crypto_universe(args.top + 5, quote)  # a few spares for the gold tokens dropped below
    coins = [c["symbol"] for c in uni["coins"] if c["symbol"].base not in universe_mod.COMMODITY_BACKED]
    return coins[:args.top], "top %d by 24h volume (%s)" % (args.top, uni["source"])


def run(args, ctx) -> dict:
    cfg = ctx.cfg
    now_ts = int(ctx.now.timestamp())
    asset = "stock" if getattr(args, "etf", False) else "crypto"
    costs = (cfg.get("costs") or {}).get(asset) or {}
    fee = args.fee_bps if args.fee_bps is not None else float(costs.get("fee_bps") or 0)
    slip = args.slippage_bps if args.slippage_bps is not None else float(costs.get("slippage_bps") or 0)
    cost = trade_sim.cost_pct(fee, slip)
    tfs = ["1d"] if asset == "stock" else [t.strip() for t in args.timeframes.split(",") if t.strip()]
    for t in tfs:
        if t not in TIMEFRAMES:
            raise ValueError("--timeframes takes 5m, 1h and/or 4h (got %r)" % t)
    wanted = [s.strip() for s in args.setups.split(",")] if args.setups else \
        (setups.for_asset("stock", "series") if asset == "stock" else setups.for_asset("crypto"))
    for s in wanted:
        setups.check(s, asset)
    exit_mod = skills.load("trader-exit", "exit")
    syms, uname = universe(args, cfg)
    started = time.time()
    notes = []
    families, rows, picks = [], [], []
    for interval in tfs:
        fam_setups = [s for s in wanted if setup_fits(s, interval)]
        if not fam_setups:
            continue
        days = tf_days(interval, args)

        def load(sym):
            try:
                return sym, history(sym, interval, days, now_ts, asset), None
            except (data.DataUnavailable, symbols.SymbolError, ValueError) as exc:
                return sym, None, str(exc)
        coins = []
        with ThreadPoolExecutor(max_workers=max(1, int(args.workers))) as pool:
            for sym, got, err in pool.map(load, syms):
                if err or not got or not got[0]:
                    notes.append("%s %s skipped: %s" % (sym.display, interval, err or "no candles"))
                    continue
                try:
                    tick = 0.01 if asset == "stock" else data.lot_info(sym).get("tick")
                except (data.DataUnavailable, ValueError):
                    tick = None
                coins.append((sym, got[0], tick))
        context = None
        if any(setups.SETUPS[st].get("needs_btc") for st in fam_setups):
            btc = next((c for sym, c, _ in coins if sym.base == "BTC"), None)
            if btc is None:
                try:
                    btc = history(data.as_symbol("BTCUSDT", "crypto"), interval, days, now_ts)[0]
                except (data.DataUnavailable, ValueError) as exc:
                    notes.append("BTC %s unavailable for the market regime: %s" % (interval, exc))
            context = {"btc_up": setups.regime_map(btc)} if btc else {"btc_up": {}}
        for setup in fam_setups:
            fam, coin_rows, coin_picks = study_family(setup, interval, coins, now_ts, args, exit_mod, cost, context)
            fam["coins_loaded"] = len(coins)
            families.append(fam)
            rows += coin_rows
            picks += coin_picks
    validated = [r for r in rows if r["validated"]]
    survived = [p for p in picks if p is not None and p > 0]
    families.sort(key=lambda f: (not f["validated"], -((f["test"] or {}).get("expectancy_r") or -9)))
    validated.sort(key=lambda r: -((r["test"] or {}).get("expectancy_r") or 0))
    doc = {
        "generated_at": market_clock.iso(ctx.now), "asset": "etf" if asset == "stock" else "crypto",
        "universe": uname, "coins": len(syms), "timeframes": tfs,
        "days": {t: tf_days(t, args) for t in TIMEFRAMES}, "objective": args.objective,
        "folds": args.folds,
        "costs": {"fee_bps": fee, "slippage_bps": slip, "round_trip_pct": round(2 * cost, 4)},
        "grid": {"targets_r": list(TARGETS_R), "stops": ["structure"] + ["%g×ATR" % m for k, m in STOPS if k == "atr"],
                 "rule_exits": {st: setups.SETUPS[st]["exit_rule"]["text"] for st in wanted if setups.exit_rule(st)},
                 "horizons_h": {k: list(v["horizons_h"]) for k, v in TIMEFRAMES.items() if k in tfs},
                 "exits_per_setup": sum(1 for t in TARGETS_R if t >= args.min_target_r) * len(STOPS) * 4},
        "rules": {"min_target_r": args.min_target_r, "min_pooled": args.min_pooled, "min_fold_test": args.min_fold_test, "min_pooled_test": args.min_pooled_test, "min_test": args.min_test,
                  "min_edge_r": args.min_edge, "profit_chance_trades": PROFIT_TRADES},
        "summary": {"families": len(families), "families_validated": sum(1 for f in families if f["validated"]),
                    "coins_validated": len(validated), "per_coin_picks": len(picks),
                    "per_coin_survived": len(survived),
                    "per_coin_survival_rate": round(len(survived) / float(len(picks)), 3) if picks else None,
                    "seconds": round(time.time() - started, 1)},
        "families": families, "validated": validated, "coins_detail": rows, "notes": notes,
    }
    state.write_json(LAB_FILE_ETF if asset == "stock" else LAB_FILE, doc)
    if not args.no_playbook:
        write_playbook(doc, ctx.now, PLAYBOOK_ETF if asset == "stock" else PLAYBOOK)
    report = None if args.no_html else write_report(doc)
    return {"doc": doc, "report": report}


def write_playbook(doc: dict, now, path: str = PLAYBOOK) -> dict:
    entries = {}
    for r in doc["validated"]:
        e = r["exit"]
        entries["%s:%s@%s" % (r["symbol"], r["setup"], r["timeframe"])] = {
            "symbol": r["symbol"], "display": r["display"], "setup": r["setup"], "interval": r["timeframe"],
            "stop": e["stop"], "atr_mult": e["atr_mult"], "target_r": e["target_r"], "horizon": e["horizon"],
            "exit_rule": e.get("exit_rule"), "exit_text": e["text"],
            "test": {k: r["test"][k] for k in ("n", "win_rate", "expectancy_r", "profit_chance", "profit_factor")},
            "train": {k: r["train"][k] for k in ("n", "win_rate", "expectancy_r")}}
        fam = next((f for f in doc.get("families") or []
                    if f["setup"] == r["setup"] and f["timeframe"] == r["timeframe"]), {})
        ride = fam.get("runner")
        if ride:
            entries["%s:%s@%s" % (r["symbol"], r["setup"], r["timeframe"])]["runner"] = {
                "keep": ride["keep"], "min_sma": ride["min_sma"], "exit_rule": ride["exit_rule"], "helps": ride["helps"],
                "why": ride["why"], "gain_r": ride["gain_r"],
                "test": {k: ride["test"][k] for k in ("n", "win_rate", "expectancy_r", "profit_chance")}}
    pb = {"generated_at": doc["generated_at"],
          "valid_until": market_clock.iso(market_clock.ts(now) + PLAYBOOK_DAYS * 86400),
          "objective": doc["objective"], "costs": doc["costs"], "days": doc["days"],
          "families_validated": doc["summary"]["families_validated"], "entries": entries}
    state.write_json(path, pb)
    return pb


def load_playbook(now=None, max_age_days: float = PLAYBOOK_DAYS, path: str = PLAYBOOK):
    """(playbook, problem) — problem says why it can't be used (missing, stale, unreadable)."""
    pb = state.read_json(path)
    if not pb or not isinstance(pb.get("entries"), dict):
        return None, "no backtest-lab playbook yet — run trader-backtest/lab.py%s" % (
            " --etf" if path == PLAYBOOK_ETF else "")
    now_ts = market_clock.ts(now or market_clock.now_utc())
    age_d = (now_ts - market_clock.ts(pb["generated_at"])) / 86400.0
    if age_d > max_age_days:
        return None, "the backtest-lab playbook is %.0f days old (limit %g) — run trader-backtest/lab.py" % (
            age_d, max_age_days)
    return pb, None


# --- output ------------------------------------------------------------------------------------------

def _pct(x) -> str:
    return "—" if x is None else "%.0f%%" % (100 * x)


def _arrow(a, b, f) -> str:
    return "%s → %s" % (f(a) if a is not None else "—", f(b) if b is not None else "—")


def text(doc: dict) -> str:
    s = doc["summary"]
    lines = ["BACKTEST LAB · %s · %s · %s · costs %.2f%% round trip · objective: %s%s" % (doc.get("asset") or "crypto",
        doc["universe"], ", ".join("%s %gd" % (t, doc["days"][t]) for t in doc["timeframes"]),
        doc["costs"]["round_trip_pct"], "highest win chance with a net edge" if doc["objective"] == "win"
        else "highest profit chance", " · targets ≥ %gR only" % doc["rules"]["min_target_r"]
        if doc["rules"].get("min_target_r") else ""),
        "%d setup × timeframe families · %d held in all %d walk-forward periods · %d coin+setup combinations "
        "VALIDATED" % (s["families"], s["families_validated"], doc["folds"], s["coins_validated"]), "",
        "  setup (timeframe)           latest exit (all coins pooled)        edge per period, out of sample   "
        "win · edge out of sample · profit chance"]
    for f in doc["families"]:
        name = "%s (%s)" % (f["setup"], f["timeframe"])
        per = " / ".join(fmt.r((x.get("test") or {}).get("expectancy_r")) if x.get("exit") else "—"
                         for x in f.get("folds") or [])
        if not f["exit"]:
            lines.append("  %-3s %-24s %-37s %-32s %s" % ("·", name, "—", per, f["verdict"]))
            continue
        lines.append("  %-3s %-24s %-37s %-32s %s · %s · %s%s" % (
            "✓" if f["validated"] else "·", name, f["exit"]["text"], per, _pct(f["test"]["win_rate"]),
            fmt.r(f["test"]["expectancy_r"]), _pct(f["test"]["profit_chance"]),
            "" if f["validated"] else "  — " + f["verdict"]))
        if f.get("runner"):
            ride = f["runner"]
            lines.append("      %s let winners ride: %s (per period %s)" % (
                "✓" if ride["helps"] else "✗", ride["why"],
                " / ".join("%s → %s" % (fmt.r(x["without_r"]), fmt.r(x["with_r"])) for x in ride["folds"])))
    hw = sorted([f for f in doc["families"] if f["highest_win"]],
                key=lambda f: -(f["highest_win"]["test"]["win_rate"] or 0))[:6]
    if hw:
        lines += ["", "Highest win chance each setup can reach%s — and what it earned (training → latest period):" % (
            " with a ≥ %gR target" % doc["rules"]["min_target_r"] if doc["rules"].get("min_target_r") else "")]
    for f in hw:
        h = f["highest_win"]
        lines.append("  %-28s %-38s win %-12s edge %s" % (
            "%s (%s)" % (f["setup"], f["timeframe"]), h["exit"]["text"],
            _arrow(h["train"]["win_rate"], h["test"]["win_rate"], _pct),
            _arrow(h["train"]["expectancy_r"], h["test"]["expectancy_r"], fmt.r)))
    lines.append("")
    if doc["validated"]:
        lines.append("VALIDATED — the autopilot may trade these (%s only from this list):" % (
            "ETFs" if doc.get("asset") == "etf" else "crypto"))
        for r in doc["validated"][:20]:
            lines.append("  ✓ %-11s %-16s %-3s %-38s out of sample: win %s · edge %s · profit chance %s · %d trades" % (
                r["display"], r["setup"], r["timeframe"], r["exit"]["text"], _pct(r["test"]["win_rate"]),
                fmt.r(r["test"]["expectancy_r"]), _pct(r["test"]["profit_chance"]), r["test"]["n"]))
    else:
        lines.append("VALIDATED: nothing — no setup made money after costs in every period it was tested on unseen "
                     "data. The autopilot will not trade crypto until the lab finds something (it re-checks weekly).")
    if s["per_coin_picks"]:
        lines.append("Overfitting check: tuning every coin on its own found %d \"winners\" in training; only %d (%s) "
                     "stayed profitable in the latest period." % (s["per_coin_picks"], s["per_coin_survived"],
                                                                   _pct(s["per_coin_survival_rate"])))
    lines.append("win = trades that made money after costs · edge = average net R per trade · profit chance = share "
                 "of random 20-trade runs from the out-of-sample trades that ended in profit")
    for n in doc["notes"][:6]:
        lines.append("note: " + n)
    if len(doc["notes"]) > 6:
        lines.append("note: … %d more skipped downloads" % (len(doc["notes"]) - 6))
    return "\n".join(lines)


def write_report(doc: dict):
    s = doc["summary"]
    body = html.tiles([
        ("Coins", fmt.count(doc["coins"]), "info"), ("Setup × timeframe", fmt.count(s["families"]), ""),
        ("Held in every period", fmt.count(s["families_validated"]), "good" if s["families_validated"] else "bad"),
        ("Validated coin+setup", fmt.count(s["coins_validated"]), "good" if s["coins_validated"] else "bad"),
        ("Per-coin tuning survived", _pct(s["per_coin_survival_rate"]), "warn"),
        ("Costs (round trip)", "%.2f%%" % doc["costs"]["round_trip_pct"], "")])
    body += html.card("How to read this", (
        "<p>Every setup was replayed on every coin with %d exits (%s targets × %d stops × 4 time stops). The history "
        "is cut into %d equal periods; for each of the last %d, the exit was chosen on everything before it with all "
        "coins pooled — one rule, hundreds of trades — and then traded, unchanged, in that period, which the choice "
        "never saw (walk-forward). A setup <b>holds</b> only if it made money in every one of those periods with an "
        "average edge ≥ %s; a coin is <b>validated</b> only if it made money out of sample, including the latest "
        "period.</p><p><b>Win</b> = trades that made money after fees and slippage. <b>Edge</b> = average net "
        "result per trade in R (1R = the amount risked). <b>Profit chance</b> = share of 4,000 random 20-trade runs "
        "drawn from the out-of-sample trades that ended in profit. A high win chance alone means little: many small "
        "wins and a few big losses lose money — the second table shows exactly that.</p>" % (
            doc["grid"]["exits_per_setup"], len(doc["grid"]["targets_r"]), len(doc["grid"]["stops"]),
            doc["folds"] + 1, doc["folds"], fmt.r(doc["rules"]["min_edge_r"]))))
    rows = []
    for f in doc["families"]:
        te = f["test"] or {}
        per = " / ".join(fmt.r((x.get("test") or {}).get("expectancy_r")) if x.get("exit") else "—"
                         for x in f.get("folds") or [])
        rows.append(("✓ held" if f["validated"] else "—", f["label"], f["timeframe"],
                     f["exit"]["text"] if f["exit"] else "—", per, _pct(te.get("win_rate")),
                     fmt.r(te.get("expectancy_r")) if te else "—", _pct(te.get("profit_chance")), te.get("n", "—"),
                     ", ".join(f["validated_coins"]) or "—",
                     f["verdict"] + (" · let winners ride: " + f["runner"]["why"] if f.get("runner") else "")))
    body += html.card("Each setup on all coins — walk-forward, out of sample", html.table(
        ["", "Setup", "Bars", "Latest exit", "Edge per period", "Win", "Edge", "Profit chance", "Trades",
         "Validated coins", "Verdict"], rows))
    rows = []
    for f in sorted([f for f in doc["families"] if f["highest_win"]],
                    key=lambda f: -(f["highest_win"]["test"]["win_rate"] or 0)):
        h = f["highest_win"]
        rows.append((f["label"], f["timeframe"], h["exit"]["text"],
                     _arrow(h["train"]["win_rate"], h["test"]["win_rate"], _pct),
                     _arrow(h["train"]["expectancy_r"], h["test"]["expectancy_r"], fmt.r),
                     _arrow(h["train"]["avg_win_r"], h["test"]["avg_win_r"], fmt.r),
                     _arrow(h["train"]["avg_loss_r"], h["test"]["avg_loss_r"], fmt.r)))
    body += html.card("The highest win chance each setup can reach — and what it earned", html.table(
        ["Setup", "Bars", "Exit", "Win training → latest", "Edge training → latest", "Avg win", "Avg loss"], rows))
    rows = [(r["display"], r["setup"], r["timeframe"], r["exit"]["text"], _pct(r["test"]["win_rate"]),
             fmt.r(r["test"]["expectancy_r"]), _pct(r["test"]["profit_chance"]), r["test"]["n"])
            for r in doc["validated"]]
    body += html.card("Validated — the only crypto the autopilot will trade", html.table(
        ["Coin", "Setup", "Bars", "Exit", "Win", "Edge", "Profit chance", "Out-of-sample trades"], rows)
        if rows else "<p>Nothing passed. No setup made money after costs in every period it was tested on unseen "
                     "data, so the autopilot will not trade crypto until a later run finds something.</p>")
    sub = "%s · %s · %s" % (doc["universe"], ", ".join(doc["timeframes"]), doc["generated_at"])
    name = doc.get("asset") or "crypto"
    return html.write_report("lab-%s.html" % name, html.page("Backtest lab · %s" % name, body, sub,
                                                              "stock" if name == "etf" else "crypto"))


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    res = run(args, ctx)
    doc = res["doc"]
    out = text(doc)
    if not args.no_playbook:
        out += "\nPlaybook: %d validated combinations → trader/%s (valid %d days)" % (
            doc["summary"]["coins_validated"], PLAYBOOK_ETF if doc.get("asset") == "etf" else PLAYBOOK, PLAYBOOK_DAYS)
    if res["report"]:
        out += "\n" + cli.report_line(res["report"])
    cli.emit(args, out, {"lab": {k: v for k, v in doc.items() if k not in ("coins_detail",)}},
             "stock" if doc.get("asset") == "etf" else "crypto")
    cli.maybe_open(args, res["report"])
    return 0


if __name__ == "__main__":
    cli.run(main)
