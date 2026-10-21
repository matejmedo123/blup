#!/usr/bin/env python3
"""Backtest lab — which crypto setups really worked, on which coins, with which exits?

It replays real history for many coins — 5-minute bars for the one-day setups (range breakouts, VWAP
reclaim, momentum …), 1-hour and 4-hour bars for the swing setups (trend pullback, oversold bounce,
band bounce, 24-bar breakout) — and tries a grid of exits for each: target 0.5–5R, a structure stop or
1–3×ATR, four time stops. Fees and slippage are paid on every trade. ``--min-target-r 2`` keeps only
exits that aim for at least 2R (one win pays for two losses).

How it avoids fooling itself:
  1. the exit with the highest certainty (profit chance, below) is chosen on the TRAIN period — the first
     two thirds — with all coins pooled together: one rule for every coin, hundreds of trades, instead of
     a lucky fit per coin;
  2. that exit then runs unchanged on the TEST period (the last third), which the choice never saw;
  3. a coin is VALIDATED for a setup only if the pooled rule held on the test period AND that coin made
     money with it on both periods.
Validated coin + setup + timeframe combinations go into trader/backtests/playbook.json; the autopilot
trades crypto only from that playbook, with those exits.

  win chance     share of trades that ended in profit after fees and slippage
  edge           average net result per trade in R (1R = the amount risked)
  profit chance  how often 20 trades, drawn at random from the test results, added up to a profit

A high win chance alone means nothing — many small wins and a few big losses lose money. The report
shows the highest win chance each setup can reach and what it earned. All of it describes the past.

Examples:
  python3 lab.py                                    # top 25 coins, 5m (180 d) + 1h (365 d) + 4h (730 d)
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
from shared import universe as universe_mod  # noqa: E402
from shared.indicators import Candle  # noqa: E402

LAB_FILE = "backtests/lab-crypto.json"
PLAYBOOK = "backtests/playbook.json"
STORE = "cache/lab"
TIMEFRAMES = {
    "5m": {"kind": "window", "horizons_h": (1, 4, 12, 24)},
    "1h": {"kind": "series", "horizons_h": (12, 24, 48, 72)},
    "4h": {"kind": "series", "horizons_h": (24, 48, 96, 168)},
}
TARGETS_R = (0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0)
STOPS = (("auto", 1.5), ("atr", 1.0), ("atr", 1.5), ("atr", 2.0), ("atr", 3.0))
ATR_LOOKBACK_BARS = 300
PROFIT_TRADES = 20            # "profit chance" = P(sum of this many trades > 0)
BOOTSTRAP_PATHS = 4000
SEED = 7
PLAYBOOK_DAYS = 14            # the autopilot stops trusting a playbook older than this


def build_parser():
    p = cli.parser("lab.py", __doc__)
    p.add_argument("--symbols", help="comma-separated coins (default: the top --top by 24h volume)")
    p.add_argument("--top", type=int, default=25, help="how many coins by 24h volume (default 25)")
    p.add_argument("--timeframes", default="5m,1h,4h", help="any of 5m,1h,4h (default all three)")
    p.add_argument("--days", type=float, default=180, help="days of 5-minute history (default 180)")
    p.add_argument("--swing-days", type=float, default=365,
                   help="days of 1-hour history (default 365; 4-hour bars get twice as much)")
    p.add_argument("--setups", help="comma-separated crypto setups (default: every crypto setup)")
    p.add_argument("--test-frac", type=float, default=1 / 3.0, help="share of each history kept for the test (1/3)")
    p.add_argument("--objective", choices=("profit", "win"), default="profit",
                   help="profit = highest profit chance, i.e. certainty (default); win = highest win chance among "
                        "exits with a net edge")
    p.add_argument("--min-target-r", type=float, default=0.0,
                   help="only exits whose target is at least this many R (e.g. 3 for 3:1 reward to risk)")
    p.add_argument("--min-pooled", type=int, default=100, help="minimum pooled train trades for an exit (100)")
    p.add_argument("--min-pooled-test", type=int, default=50, help="minimum pooled test trades (50)")
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


def history(sym, interval: str, days: float, now_ts: int) -> tuple:
    """(candles, source) for the last ``days`` — reuses the local copy and fetches only the new tail."""
    step = market_clock.interval_seconds(interval)
    start_ts = now_ts - int(days * 86400)
    doc = state.read_json(_store_name(sym, interval), {}) or {}
    rows = doc.get("candles") or []
    if rows and rows[0][0] <= start_ts + 86400 and doc.get("source"):
        tail_days = max(0.01, (now_ts - rows[-1][0]) / 86400.0 + 2 * step / 86400.0)
        series = data.get_candles(sym, interval, days=tail_days, asset="crypto", end=market_clock.iso(now_ts))
        if series.source == doc["source"]:
            seen = {r[0] for r in rows}
            rows += [[c.t, c.o, c.h, c.l, c.c, c.v] for c in series.candles if c.t not in seen]
        else:
            rows = []
    if not rows:
        series = data.get_candles(sym, interval, days=days, asset="crypto", end=market_clock.iso(now_ts))
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


def exit_label(key) -> dict:
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
        if len(rs) < min_n or key[1] < min_target_r:
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

def study_family(setup: str, interval: str, coins: list, now_ts: int, args, exit_mod, cost: float) -> tuple:
    """coins: [(sym, candles, tick)] → (family summary, per-coin rows, per-coin-optimised picks)."""
    days = args.days if interval == "5m" else args.swing_days * (2 if interval == "4h" else 1)
    split_ts = int(now_ts - days * 86400 * args.test_frac)
    pooled_tr, pooled_te, per_coin = {}, {}, []
    for sym, candles, tick in coins:
        tr, te = {}, {}
        trigs = triggers(candles, setup, interval, now_ts)
        for t in trigs:
            bucket = tr if t["entry_ts"] < split_ts else te
            for key, r in grid_outcomes(candles, t, interval, exit_mod, tick, cost).items():
                bucket.setdefault(key, []).append(r)
        for key, rs in tr.items():
            pooled_tr.setdefault(key, []).extend(rs)
        for key, rs in te.items():
            pooled_te.setdefault(key, []).extend(rs)
        per_coin.append((sym, tr, te, len(trigs)))
    fam = {"setup": setup, "label": setups.SETUPS[setup]["label"], "timeframe": interval,
           "train_until": market_clock.iso(split_ts), "coins": sum(1 for _, tr, te, n in per_coin if n),
           "signals": sum(n for _, _, _, n in per_coin)}
    # what the highest win chance looks like, edge or not
    hw = highest_win(pooled_tr, args.min_pooled, args.min_target_r)
    fam["highest_win"] = None if hw is None else {
        "exit": exit_label(hw), "train": stats(pooled_tr[hw]), "test": stats(pooled_te.get(hw, []))}
    best = choose(pooled_tr, args.objective, args.min_pooled, args.min_edge, args.min_target_r)
    rows = []
    if best is None:
        fam.update(exit=None, train=None, test=None, validated=False, validated_coins=[],
                   verdict="no exit had a net edge ≥ %s across all coins on the train period" % fmt.r(args.min_edge))
    else:
        tr_s, te_s = final_stats(pooled_tr[best]), final_stats(pooled_te.get(best, []))
        ok = te_s["n"] >= args.min_pooled_test and te_s["expectancy_r"] >= args.min_edge
        fam.update(exit=exit_label(best), train=tr_s, test=te_s, validated=ok,
                   verdict="held on the test period" if ok else (
                       "only %d test trades" % te_s["n"] if te_s["n"] < args.min_pooled_test else
                       "the edge did not survive the test period (%s per trade)" % fmt.r(te_s["expectancy_r"])))
        for sym, tr, te, n in per_coin:
            if not n:
                continue
            a, b = stats(tr.get(best, [])), stats(te.get(best, []))
            why = []
            if not ok:
                why.append("the setup failed across all coins")
            if (a["n"] or 0) < 10 or (a["expectancy_r"] or 0) <= 0:
                why.append("lost money on this coin in the train period" if a["n"] >= 10 else
                           "only %d train trades on this coin" % a["n"])
            if (b["n"] or 0) < args.min_test:
                why.append("only %d test trades on this coin" % b["n"])
            elif (b["expectancy_r"] or 0) < args.min_edge:
                why.append("test edge %s on this coin" % fmt.r(b["expectancy_r"]))
            if not why:
                b = final_stats(te.get(best, []))
            rows.append({"symbol": sym.key, "display": sym.display, "setup": setup, "timeframe": interval,
                         "exit": exit_label(best), "train": a, "test": b, "validated": not why,
                         "why": "; ".join(why) or "made money with the pooled rule on both periods"})
    fam["validated_coins"] = [r["display"] for r in rows if r["validated"]]
    # the tempting alternative: tune every coin on its own — how much of that survives?
    picks = []
    for sym, tr, te, n in per_coin:
        k = choose(tr, args.objective, 20, args.min_edge, args.min_target_r)
        if k is not None:
            picks.append(stats(te.get(k, []))["expectancy_r"])
    return fam, rows, picks


# --- the run -----------------------------------------------------------------------------------------

def universe(args, cfg) -> tuple:
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
    costs = (cfg.get("costs") or {}).get("crypto") or {}
    fee = args.fee_bps if args.fee_bps is not None else float(costs.get("fee_bps") or 0)
    slip = args.slippage_bps if args.slippage_bps is not None else float(costs.get("slippage_bps") or 0)
    cost = trade_sim.cost_pct(fee, slip)
    tfs = [t.strip() for t in args.timeframes.split(",") if t.strip()]
    for t in tfs:
        if t not in TIMEFRAMES:
            raise ValueError("--timeframes takes 5m, 1h and/or 4h (got %r)" % t)
    wanted = [s.strip() for s in args.setups.split(",")] if args.setups else setups.for_asset("crypto")
    for s in wanted:
        setups.check(s, "crypto")
    exit_mod = skills.load("trader-exit", "exit")
    syms, uname = universe(args, cfg)
    started = time.time()
    notes = []
    families, rows, picks = [], [], []
    for interval in tfs:
        kind = TIMEFRAMES[interval]["kind"]
        fam_setups = [s for s in wanted if (setups.is_series(s) == (kind == "series"))]
        if not fam_setups:
            continue
        days = args.days if interval == "5m" else args.swing_days * (2 if interval == "4h" else 1)

        def load(sym):
            try:
                return sym, history(sym, interval, days, now_ts), None
            except (data.DataUnavailable, symbols.SymbolError, ValueError) as exc:
                return sym, None, str(exc)
        coins = []
        with ThreadPoolExecutor(max_workers=max(1, int(args.workers))) as pool:
            for sym, got, err in pool.map(load, syms):
                if err or not got or not got[0]:
                    notes.append("%s %s skipped: %s" % (sym.display, interval, err or "no candles"))
                    continue
                try:
                    tick = data.lot_info(sym).get("tick")
                except (data.DataUnavailable, ValueError):
                    tick = None
                coins.append((sym, got[0], tick))
        for setup in fam_setups:
            fam, coin_rows, coin_picks = study_family(setup, interval, coins, now_ts, args, exit_mod, cost)
            fam["coins_loaded"] = len(coins)
            families.append(fam)
            rows += coin_rows
            picks += coin_picks
    validated = [r for r in rows if r["validated"]]
    survived = [p for p in picks if p is not None and p > 0]
    families.sort(key=lambda f: (not f["validated"], -((f["test"] or {}).get("expectancy_r") or -9)))
    validated.sort(key=lambda r: -((r["test"] or {}).get("expectancy_r") or 0))
    doc = {
        "generated_at": market_clock.iso(ctx.now), "universe": uname, "coins": len(syms), "timeframes": tfs,
        "days": {"5m": args.days, "1h": args.swing_days, "4h": args.swing_days * 2}, "objective": args.objective,
        "test_frac": args.test_frac,
        "costs": {"fee_bps": fee, "slippage_bps": slip, "round_trip_pct": round(2 * cost, 4)},
        "grid": {"targets_r": list(TARGETS_R), "stops": ["structure"] + ["%g×ATR" % m for k, m in STOPS if k == "atr"],
                 "horizons_h": {k: list(v["horizons_h"]) for k, v in TIMEFRAMES.items() if k in tfs},
                 "exits_per_setup": sum(1 for t in TARGETS_R if t >= args.min_target_r) * len(STOPS) * 4},
        "rules": {"min_target_r": args.min_target_r, "min_pooled": args.min_pooled, "min_pooled_test": args.min_pooled_test, "min_test": args.min_test,
                  "min_edge_r": args.min_edge, "profit_chance_trades": PROFIT_TRADES},
        "summary": {"families": len(families), "families_validated": sum(1 for f in families if f["validated"]),
                    "coins_validated": len(validated), "per_coin_picks": len(picks),
                    "per_coin_survived": len(survived),
                    "per_coin_survival_rate": round(len(survived) / float(len(picks)), 3) if picks else None,
                    "seconds": round(time.time() - started, 1)},
        "families": families, "validated": validated, "coins_detail": rows, "notes": notes,
    }
    state.write_json(LAB_FILE, doc)
    if not args.no_playbook:
        write_playbook(doc, ctx.now)
    report = None if args.no_html else write_report(doc)
    return {"doc": doc, "report": report}


def write_playbook(doc: dict, now) -> dict:
    entries = {}
    for r in doc["validated"]:
        e = r["exit"]
        entries["%s:%s@%s" % (r["symbol"], r["setup"], r["timeframe"])] = {
            "symbol": r["symbol"], "display": r["display"], "setup": r["setup"], "interval": r["timeframe"],
            "stop": e["stop"], "atr_mult": e["atr_mult"], "target_r": e["target_r"], "horizon": e["horizon"],
            "exit_text": e["text"],
            "test": {k: r["test"][k] for k in ("n", "win_rate", "expectancy_r", "profit_chance", "profit_factor")},
            "train": {k: r["train"][k] for k in ("n", "win_rate", "expectancy_r")}}
    pb = {"generated_at": doc["generated_at"],
          "valid_until": market_clock.iso(market_clock.ts(now) + PLAYBOOK_DAYS * 86400),
          "objective": doc["objective"], "costs": doc["costs"], "days": doc["days"],
          "families_validated": doc["summary"]["families_validated"], "entries": entries}
    state.write_json(PLAYBOOK, pb)
    return pb


def load_playbook(now=None, max_age_days: float = PLAYBOOK_DAYS):
    """(playbook, problem) — problem says why it can't be used (missing, stale, unreadable)."""
    pb = state.read_json(PLAYBOOK)
    if not pb or not isinstance(pb.get("entries"), dict):
        return None, "no backtest-lab playbook yet — run trader-backtest/lab.py"
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
    lines = ["BACKTEST LAB · crypto · %s · %s · costs %.2f%% round trip · objective: %s%s" % (
        doc["universe"], ", ".join("%s %gd" % (t, doc["days"][t]) for t in doc["timeframes"]),
        doc["costs"]["round_trip_pct"], "highest win chance with a net edge" if doc["objective"] == "win"
        else "highest profit chance", " · targets ≥ %gR only" % doc["rules"]["min_target_r"]
        if doc["rules"].get("min_target_r") else ""),
        "%d setup × timeframe families · %d held on the test period · %d coin+setup combinations VALIDATED" % (
            s["families"], s["families_validated"], s["coins_validated"]), "",
        "  setup (timeframe)                exit picked on train, all coins pooled     win train → test   "
        "edge train → test   profit chance"]
    for f in doc["families"]:
        name = "%s (%s)" % (f["setup"], f["timeframe"])
        if not f["exit"]:
            lines.append("  %-3s %-28s %s" % ("·", name, f["verdict"]))
            continue
        lines.append("  %-3s %-28s %-42s %-18s %-19s %s" % (
            "✓" if f["validated"] else "·", name, f["exit"]["text"],
            _arrow(f["train"]["win_rate"], f["test"]["win_rate"], _pct),
            _arrow(f["train"]["expectancy_r"], f["test"]["expectancy_r"], fmt.r), _pct(f["test"]["profit_chance"])))
    hw = sorted([f for f in doc["families"] if f["highest_win"]],
                key=lambda f: -(f["highest_win"]["test"]["win_rate"] or 0))[:6]
    if hw:
        lines += ["", "Highest win chance each setup can reach%s — and what it earned (train → test):" % (
            " with a ≥ %gR target" % doc["rules"]["min_target_r"] if doc["rules"].get("min_target_r") else "")]
    for f in hw:
        h = f["highest_win"]
        lines.append("  %-28s %-38s win %-12s edge %s" % (
            "%s (%s)" % (f["setup"], f["timeframe"]), h["exit"]["text"],
            _arrow(h["train"]["win_rate"], h["test"]["win_rate"], _pct),
            _arrow(h["train"]["expectancy_r"], h["test"]["expectancy_r"], fmt.r)))
    lines.append("")
    if doc["validated"]:
        lines.append("VALIDATED — the autopilot may trade these (crypto only from this list):")
        for r in doc["validated"][:20]:
            lines.append("  ✓ %-11s %-16s %-3s %-38s test: win %s · edge %s · profit chance %s · %d trades" % (
                r["display"], r["setup"], r["timeframe"], r["exit"]["text"], _pct(r["test"]["win_rate"]),
                fmt.r(r["test"]["expectancy_r"]), _pct(r["test"]["profit_chance"]), r["test"]["n"]))
    else:
        lines.append("VALIDATED: nothing — no setup kept a net edge after costs on data it never saw. The autopilot "
                     "will not trade crypto until the lab finds something (it re-checks every week).")
    if s["per_coin_picks"]:
        lines.append("Overfitting check: tuning every coin on its own found %d \"winners\" on train; only %d (%s) "
                     "stayed profitable on the test period." % (s["per_coin_picks"], s["per_coin_survived"],
                                                                 _pct(s["per_coin_survival_rate"])))
    lines.append("win = trades that made money after costs · edge = average net R per trade · profit chance = share "
                 "of random 20-trade runs from the test period that ended in profit")
    for n in doc["notes"][:6]:
        lines.append("note: " + n)
    if len(doc["notes"]) > 6:
        lines.append("note: … %d more skipped downloads" % (len(doc["notes"]) - 6))
    return "\n".join(lines)


def write_report(doc: dict):
    s = doc["summary"]
    body = html.tiles([
        ("Coins", fmt.count(doc["coins"]), "info"), ("Setup × timeframe", fmt.count(s["families"]), ""),
        ("Held on test", fmt.count(s["families_validated"]), "good" if s["families_validated"] else "bad"),
        ("Validated coin+setup", fmt.count(s["coins_validated"]), "good" if s["coins_validated"] else "bad"),
        ("Per-coin tuning survived", _pct(s["per_coin_survival_rate"]), "warn"),
        ("Costs (round trip)", "%.2f%%" % doc["costs"]["round_trip_pct"], "")])
    body += html.card("How to read this", (
        "<p>Every setup was replayed on every coin with %d exits (%s targets × %d stops × 4 time stops). The exit "
        "was chosen on the <b>train</b> period with all coins pooled — one rule, hundreds of trades — and then run "
        "unchanged on the <b>test</b> period it never saw (the last %s of each history). A coin is "
        "<b>validated</b> for a setup only if the pooled rule kept an edge ≥ %s on the test period and that coin "
        "made money with it on both periods.</p><p><b>Win</b> = trades that made money after fees and slippage. "
        "<b>Edge</b> = average net result per trade in R (1R = the amount risked). <b>Profit chance</b> = share of "
        "4,000 random 20-trade runs drawn from the test trades that ended in profit. A high win chance alone means "
        "little: many small wins and a few big losses lose money — the second table shows exactly that.</p>" % (
            doc["grid"]["exits_per_setup"], len(doc["grid"]["targets_r"]), len(doc["grid"]["stops"]),
            _pct(doc["test_frac"]), fmt.r(doc["rules"]["min_edge_r"]))))
    rows = []
    for f in doc["families"]:
        tr, te = f["train"] or {}, f["test"] or {}
        rows.append(("✓ held" if f["validated"] else "—", f["label"], f["timeframe"],
                     f["exit"]["text"] if f["exit"] else "—", _arrow(tr.get("win_rate"), te.get("win_rate"), _pct),
                     _arrow(tr.get("expectancy_r"), te.get("expectancy_r"), fmt.r), _pct(te.get("profit_chance")),
                     "%s / %s" % (tr.get("n", "—"), te.get("n", "—")), ", ".join(f["validated_coins"]) or "—",
                     f["verdict"]))
    body += html.card("Each setup on all coins (exit chosen on train)", html.table(
        ["", "Setup", "Bars", "Exit", "Win train → test", "Edge train → test", "Profit chance (test)",
         "Trades train / test", "Validated coins", "Verdict"], rows))
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
        ["Setup", "Bars", "Exit", "Win train → test", "Edge train → test", "Avg win", "Avg loss"], rows))
    rows = [(r["display"], r["setup"], r["timeframe"], r["exit"]["text"], _pct(r["test"]["win_rate"]),
             fmt.r(r["test"]["expectancy_r"]), _pct(r["test"]["profit_chance"]), r["test"]["n"])
            for r in doc["validated"]]
    body += html.card("Validated — the only crypto the autopilot will trade", html.table(
        ["Coin", "Setup", "Bars", "Exit", "Win (test)", "Edge (test)", "Profit chance (test)", "Test trades"], rows)
        if rows else "<p>Nothing passed. No setup kept a net edge after costs on data it never saw, so the autopilot "
                     "will not trade crypto until a later run finds something.</p>")
    sub = "%s · %s · %s" % (doc["universe"], ", ".join(doc["timeframes"]), doc["generated_at"])
    return html.write_report("lab-crypto.html", html.page("Backtest lab · crypto", body, sub, "crypto"))


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    res = run(args, ctx)
    doc = res["doc"]
    out = text(doc)
    if not args.no_playbook:
        out += "\nPlaybook: %d validated combinations → trader/%s (valid %d days)" % (
            doc["summary"]["coins_validated"], PLAYBOOK, PLAYBOOK_DAYS)
    if res["report"]:
        out += "\n" + cli.report_line(res["report"])
    cli.emit(args, out, {"lab": {k: v for k, v in doc.items() if k not in ("coins_detail",)}}, "crypto")
    cli.maybe_open(args, res["report"])
    return 0


if __name__ == "__main__":
    cli.run(main)
