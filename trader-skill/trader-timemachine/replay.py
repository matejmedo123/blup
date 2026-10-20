#!/usr/bin/env python3
"""Time Machine — replay the rest of the trade 10,000 times before risking a dollar.

Takes the plan written by /trader-exit (entry, stop, target, time stop), loads the
symbol's own 5-minute history up to the entry (never past it), and builds
simulated paths by block-bootstrapping real bars matched to the same time of day,
scaled to recent volatility. Every path is walked bar by bar with the same
stop/target/time-stop logic the backtester uses.

Examples:
  python3 replay.py                                   # latest plan in trader/plan.json
  python3 replay.py --id TSLA-20261020-orb15 --paths 10000 --seed 7
  python3 replay.py --id BTCUSD-20261020-asia_range --horizon 4h
  python3 replay.py --offline --now 2026-10-20T14:15:00Z
"""
from __future__ import annotations

import contextlib
import io
import math
import os
import random
import re
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, indicators, market_clock, setups, skills, state, symbols, trade_sim  # noqa: E402
from shared.indicators import Candle  # noqa: E402

DEFAULT_PATHS = 10000
DEFAULT_SEED = 7
DEFAULT_BLOCK = 6          # 6 × 5-min = 30-minute blocks keep short-term momentum and volatility clustering
HISTORY_DAYS = {"stock": 60, "crypto": 60, "meme": 30}
RUG_DROP = 0.90            # liquidity pulled → price collapses 90 %
VOL_CLAMP = (0.6, 1.8)
THIN_DAYS = 3.0
THIN_WIDEN = 1.25
OUTCOMES = ("target", "stop", "neither", "rug")
_MEME_KEY = re.compile(r"^(solana|base|ethereum|bsc)-(.+?)-\d{8}-")


def build_parser():
    p = cli.parser("replay.py", __doc__)
    p.add_argument("--id", help="plan id from trader/plan.json (default: the latest plan)")
    p.add_argument("--paths", type=int, default=DEFAULT_PATHS, help="number of simulated paths (default 10000)")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED, help="random seed — same seed, same result (default 7)")
    p.add_argument("--horizon", help="crypto/meme only: replay window, e.g. 1h, 4h, 24h (default: the plan's)")
    p.add_argument("--block", type=int, default=DEFAULT_BLOCK, help="bootstrap block length in bars (default 6)")
    rug = p.add_mutually_exclusive_group()
    rug.add_argument("--rug-share", type=float, help="meme only: share of paths that end in a rug pull (0–1)")
    rug.add_argument("--no-rug", action="store_true", help="meme only: switch the rug-pull scenario off")
    p.add_argument("--size-usd", type=float, help="meme only: position size for the exit-slippage estimate")
    p.add_argument("--with-backtest", action="store_true",
                   help="run /trader-backtest first if there is no backtest of this setup on file")
    p.add_argument("--sample", type=int, default=200, help="paths kept for the fan chart (default 200)")
    p.add_argument("--keep-drift", action="store_true",
                   help="keep the history's average trend (default: removed — past drift is not a forecast)")
    return p


# --- inputs -------------------------------------------------------------------------------

def load_plan(plan_id: str = None) -> dict:
    doc = state.read_json("plan.json") or {}
    plans = doc.get("plans") or {}
    if not plans:
        raise ValueError("no plan in trader/plan.json — run /trader-exit first to set entry, stop and target")
    pid = plan_id or doc.get("latest")
    if pid not in plans:
        raise ValueError("plan %r not found in trader/plan.json (have: %s)" % (pid, ", ".join(sorted(plans))))
    return plans[pid]


def plan_symbol(plan: dict) -> symbols.Symbol:
    asset = plan.get("asset")
    if asset == "meme":
        if plan.get("chain") and plan.get("address"):
            return symbols.meme_symbol(plan["chain"], plan["address"], plan.get("name") or "")
        for cand in (plan.get("symbol_raw"), plan.get("symbol")):
            try:
                s = symbols.parse(cand, asset="meme")
            except (symbols.SymbolError, TypeError):
                continue
            if s.address:
                return s
        m = _MEME_KEY.match(plan.get("id") or "")
        if m:
            return symbols.meme_symbol(m.group(1), m.group(2))
        raise ValueError("plan %s has no token address — re-run /trader-exit" % plan.get("id"))
    return data.as_symbol(plan.get("symbol_raw") or plan["symbol"], asset)


def _num(x):
    return float(x) if x is not None else None


def trade_levels(plan: dict) -> dict:
    entry = _num((plan.get("entry") or {}).get("price"))
    stop = _num((plan.get("stop") or {}).get("price"))
    target = _num((plan.get("target") or {}).get("price"))
    if not entry or stop is None or target is None:
        raise ValueError("plan %s needs entry, stop and target prices" % plan.get("id"))
    if not stop < entry < target:
        raise ValueError("plan %s must have stop < entry < target for a long trade" % plan.get("id"))
    return {"entry": entry, "stop": stop, "target": target, "risk": entry - stop}


def horizon_window(plan: dict, asset: str, entry_ts: int, horizon_arg: str, cfg: dict):
    """→ (horizon_end_ts, time_stop_ts, label, warnings)."""
    warnings = []
    if asset == "stock":
        if horizon_arg:
            warnings.append("--horizon is ignored for stocks: the replay runs to the 4:00 p.m. close")
        d = market_clock.et_date(entry_ts)
        close = market_clock.session_close_time(d)
        end = market_clock.ts((plan.get("horizon") or {}).get("end") or close)
        ts_at = (plan.get("time_stop") or {}).get("at")
        time_stop = market_clock.ts(ts_at) if ts_at else market_clock.ts(market_clock.flat_by(d))
        label = "rest of the session to the %s ET close" % market_clock.fmt_et_ampm(end)
        return end, min(time_stop, end), label, warnings
    if horizon_arg:
        secs = market_clock.parse_horizon(horizon_arg)
        end = entry_ts + secs
        return end, end, "next %s" % _hours_label(secs), warnings
    plan_end = (plan.get("horizon") or {}).get("end")
    if plan_end:
        end = market_clock.ts(plan_end)
    else:
        key = "meme_horizon" if asset == "meme" else "crypto_horizon"
        end = entry_ts + market_clock.parse_horizon(cfg.get(key) or "4h")
    ts_at = (plan.get("time_stop") or {}).get("at")
    time_stop = min(market_clock.ts(ts_at), end) if ts_at else end
    return end, time_stop, "next %s" % _hours_label(end - entry_ts), warnings


def _hours_label(secs: int) -> str:
    h = secs / 3600.0
    if h < 1:
        return "%d minutes" % round(secs / 60.0)
    if abs(h - round(h)) < 1e-9:
        return "%d hour%s" % (round(h), "" if round(h) == 1 else "s")
    return "%.1f hours" % h


# --- history → bar records ------------------------------------------------------------

def bar_records(candles, asset: str, step: int):
    """Each bar as log-moves relative to the previous close: (t, r_close, r_high, r_low, bucket, run_id).

    Using high/low relative to the previous close keeps each bar's real intrabar range,
    so jump moves and fat tails survive the bootstrap. Stocks never bridge the overnight
    gap (the first bar of a session is measured from its own open) — gaps are ignored.
    """
    recs = []
    prev = None
    run = 0
    last_bucket = None
    for c in candles:
        if c.o <= 0 or c.c <= 0:
            prev = None
            continue
        if asset == "stock":
            new_session = prev is None or market_clock.et_date(prev.t) != market_clock.et_date(c.t)
            bucket = market_clock.stock_bucket(c.t)
        else:
            new_session = prev is None or c.t - prev.t != step
            bucket = market_clock.crypto_bucket(c.t)
        base = c.o if new_session else prev.c
        if new_session or bucket != last_bucket:
            run += 1
        recs.append((c.t, math.log(c.c / base), math.log(max(c.h, c.o, c.c) / base),
                     math.log(min(c.l, c.o, c.c) / base), bucket, run))
        prev = c
        last_bucket = bucket
    return recs


def _recent_cut(recs, asset: str, entry_ts: int):
    """Records from the last 5 sessions (stocks) or the last 2 days (crypto, meme)."""
    if asset == "stock":
        dates = []
        for r in recs:
            d = market_clock.et_date(r[0])
            if not dates or dates[-1] != d:
                dates.append(d)
        keep = set(dates[-5:])
        return lambda r: market_clock.et_date(r[0]) in keep
    return lambda r: r[0] >= entry_ts - 2 * 86400


def _clamp(x: float) -> float:
    return max(VOL_CLAMP[0], min(VOL_CLAMP[1], x))


def bucket_scales(recs, asset: str, entry_ts: int, keep_drift: bool = False) -> dict:
    """Per time-of-day bucket: recent realized vol ÷ that bucket's full-sample vol (clamped), and its mean drift.

    Comparing a bucket with itself keeps a wild launch hour or a quiet month from skewing the
    other buckets. The mean is removed unless --keep-drift: a few days' trend is not a forecast.
    """
    is_recent = _recent_cut(recs, asset, entry_ts)
    all_r = [r[1] for r in recs]
    recent_all = [r[1] for r in recs if is_recent(r)]
    full_all = indicators.stdev(all_r)
    glob = _clamp(indicators.stdev(recent_all) / full_all) if full_all > 0 and len(recent_all) >= 20 else 1.0
    out = {"_global": {"scale": glob, "mean": 0.0, "full_vol": full_all,
                       "recent_vol": indicators.stdev(recent_all) if len(recent_all) >= 2 else None, "n": len(recs)}}
    by = {}
    for r in recs:
        by.setdefault(r[4], ([], []))
        by[r[4]][0].append(r[1])
        if is_recent(r):
            by[r[4]][1].append(r[1])
    for b, (full_r, rec_r) in by.items():
        full = indicators.stdev(full_r)
        if full > 0 and len(rec_r) >= 20:
            scale = _clamp(indicators.stdev(rec_r) / full)
        else:
            scale = glob
        mean = 0.0 if keep_drift or not full_r else sum(full_r) / len(full_r)
        out[b] = {"scale": scale, "mean": mean, "full_vol": full, "recent_vol": indicators.stdev(rec_r)
                  if len(rec_r) >= 2 else None, "n": len(full_r)}
    return out


def history_info(recs, candles, asset: str, step: int, source: str) -> dict:
    span = (candles[-1].t - candles[0].t + step) / 86400.0 if candles else 0.0
    if asset == "stock":
        sessions = len({market_clock.et_date(c.t) for c in candles})
        thin = sessions < THIN_DAYS
    else:
        sessions = None
        thin = span < THIN_DAYS
    return {"sessions": sessions, "days": round(span, 2), "bars": len(candles),
            "first": market_clock.iso(candles[0].t) if candles else None,
            "last": market_clock.iso(candles[-1].t) if candles else None,
            "thin_sample": thin, "source": source}


# --- meme specifics ----------------------------------------------------------------------

def rugcheck_file(sym: symbols.Symbol):
    return state.read_json("rugcheck/%s-%s.json" % (sym.chain, sym.address))


def rug_share_for(sym, asset, args, horizon_secs, warnings):
    if asset != "meme" or args.no_rug:
        return 0.0, "off"
    if args.rug_share is not None:
        if not 0.0 <= args.rug_share < 1.0:
            raise ValueError("--rug-share must be between 0 and 1")
        return float(args.rug_share), "set with --rug-share"
    rc = rugcheck_file(sym)
    if rc and rc.get("score") is not None:
        score = float(rc["score"])
        base = 0.03 if score >= 80 else 0.06 if score >= 60 else 0.12 if score >= 40 else 0.25
        why = "rugcheck score %d (%s)" % (score, rc.get("verdict", "?"))
    else:
        base = 0.15
        why = "no rugcheck on file — assumed high risk"
        warnings.append("no /trader-rugcheck result for this token — rug share assumed at 15%/day; run it first")
    return max(0.01, base * horizon_secs / 86400.0), why


def matching_order(plan_id: str):
    doc = state.read_json("orders.json") or {}
    found = [o for o in doc.get("orders") or [] if o.get("plan_id") == plan_id and o.get("status") != "cancelled"]
    return found[-1] if found else None


def meme_liquidity(plan: dict, sym) -> float:
    liq = (plan.get("liquidity_exit") or {}).get("liquidity_at_entry_usd")
    if liq:
        return float(liq)
    try:
        return float(data.get_pair(sym).get("liquidity_usd") or 0) or None
    except data.DataUnavailable:
        return None


# --- position for the $ expected value -----------------------------------------------------

def position(plan, asset, lv, order, ctx, size_usd_arg) -> dict:
    risk = lv["risk"]
    if order and order.get("qty"):
        qty = float(order["qty"])
        unit = order.get("qty_unit") or ("usd" if asset == "meme" else "shares" if asset == "stock" else "coins")
        risk_usd = qty * risk / lv["entry"] if unit == "usd" else qty * risk
        return {"qty": qty, "unit": unit, "risk_usd": risk_usd, "source": "trader/orders.json (%s)" % order.get("id")}
    account = float(ctx.cfg.get("account_size") or 0)
    risk_pct = float(ctx.cfg.get("risk_per_trade_pct") or 0)
    budget = account * risk_pct / 100.0
    cap_pct = float((ctx.limits.get(asset) or {}).get("max_position_pct") or 100)
    cap_usd = account * cap_pct / 100.0
    if asset == "meme":
        usd = size_usd_arg or min(budget * lv["entry"] / risk, cap_usd)
        capped = not size_usd_arg and budget * lv["entry"] / risk > cap_usd
        return {"qty": round(usd, 2), "unit": "usd", "risk_usd": usd * risk / lv["entry"],
                "source": "--size-usd" if size_usd_arg else
                "assumed: %.2g%% account risk%s" % (risk_pct, ", capped at %g%% of the account" % cap_pct if capped else "")}
    qty = budget / risk
    if qty * lv["entry"] > cap_usd:
        qty = cap_usd / lv["entry"]
        why = "assumed: %.2g%% account risk, capped at max position %g%%" % (risk_pct, cap_pct)
    else:
        why = "assumed: %.2g%% account risk" % risk_pct
    if asset == "stock":
        qty = math.floor(qty + 1e-9) if not ctx.cfg.get("fractional_shares") else math.floor(qty * 1e4) / 1e4
        unit = "shares"
    else:
        qty = math.floor(qty * 1e6) / 1e6
        unit = "coins"
    return {"qty": qty, "unit": unit, "risk_usd": qty * risk, "source": why}


# --- simulation ------------------------------------------------------------------------------

def _bucket_index(recs):
    by = {}
    for i, r in enumerate(recs):
        by.setdefault(r[4], []).append(i)
    return by


def simulate(recs, lv, entry_ts, horizon_end, time_stop, step, asset, scales, block_len, n_paths, seed,
             trailing=None, scale_out=None, atr_value=None, rug_share=0.0, exit_slip_pct=0.0, keep=200):
    """Run n_paths block-bootstrap paths; each is walked with trade_sim.walk (the backtester's own logic)."""
    rng = random.Random(seed)
    steps = int((horizon_end - entry_ts) // step)
    if steps <= 0:
        raise ValueError("nothing left to replay: the horizon ends at or before the entry")
    bucket_fn = market_clock.stock_bucket if asset == "stock" else market_clock.crypto_bucket
    step_bucket = [bucket_fn(entry_ts + k * step) for k in range(steps)]
    by_bucket = _bucket_index(recs)
    pool_all = list(range(len(recs)))
    def adj(r, k):
        st = scales.get(r[4]) or scales["_global"]
        return (r[k] - st["mean"]) * st["scale"]
    rc = [adj(r, 1) for r in recs]
    rh = [adj(r, 2) for r in recs]
    rl = [adj(r, 3) for r in recs]
    run = [r[5] for r in recs]
    entry, stop, target, risk = lv["entry"], lv["stop"], lv["target"], lv["risk"]
    levels = [{"fraction": float(s["fraction"]), "price": float(s["price"])} for s in (scale_out or [])
              if s.get("price") and s.get("fraction")]
    exp = math.exp
    counts = dict.fromkeys(OUTCOMES, 0)
    closes = []
    rug_closes = []
    r_values = []
    reservoirs = {k: [] for k in OUTCOMES}
    seen = dict.fromkeys(OUTCOMES, 0)
    times = [entry_ts + k * step for k in range(steps)]
    for _ in range(n_paths):
        rug_at = int(rng.random() * steps) if rug_share and rng.random() < rug_share else -1
        bars = []
        px = entry
        cur_bucket, pos, left = None, 0, 0
        for k in range(steps):
            t = times[k]
            if rug_at >= 0 and k >= rug_at:
                if k == rug_at:
                    px = px * (1.0 - RUG_DROP)
                bars.append(Candle(t, px, px, px, px, 0.0))
                continue
            b = step_bucket[k]
            if left <= 0 or b != cur_bucket or pos >= len(pool) or run[pool[pos]] != run[pool[pos - 1]]:
                pool = by_bucket.get(b) or pool_all
                pos = int(rng.random() * len(pool))
                left = block_len
                cur_bucket = b
            i = pool[pos]
            pos += 1
            left -= 1
            o = px
            c = o * exp(rc[i])
            h = o * exp(rh[i])
            lo = o * exp(rl[i])
            if h < c:
                h = c
            if h < o:
                h = o
            if lo > c:
                lo = c
            if lo > o:
                lo = o
            bars.append(Candle(t, o, h, lo, c, 0.0))
            px = c
        res = trade_sim.walk(bars, entry, stop, target, end_ts=time_stop, step=step, trailing=trailing,
                             scale_out=levels, atr_value=atr_value)
        outcome = res["outcome"]
        rugged = rug_at >= 0 and outcome == "stop" and res["exit_t"] == times[rug_at]
        if rugged:
            outcome = "rug"
        elif outcome != "target" and outcome != "stop":
            outcome = "neither"
        avg_exit = res["exit_price"]
        if exit_slip_pct and outcome in ("stop", "neither", "rug"):
            remaining = 1.0 - sum(p["fraction"] for p in res["partials"])
            avg_exit -= remaining * res["last_fill"] * exit_slip_pct / 100.0
        r_mult = (avg_exit - entry) / risk
        counts[outcome] += 1
        if rug_at >= 0:
            rug_closes.append(bars[-1].c)
        else:
            closes.append(bars[-1].c)
        r_values.append(r_mult)
        # reservoir sampling per outcome keeps memory flat for long horizons
        seen[outcome] += 1
        res_list = reservoirs[outcome]
        if len(res_list) < keep:
            res_list.append([b.c for b in bars])
        else:
            j = int(rng.random() * seen[outcome])
            if j < keep:
                res_list[j] = [b.c for b in bars]
    used = [(scales.get(b) or scales["_global"])["scale"] for b in step_bucket]
    return {"steps": steps, "counts": counts, "closes": closes, "rug_closes": rug_closes, "r": r_values,
            "reservoirs": reservoirs,
            "times": times + [horizon_end], "avg_scale": sum(used) / len(used)}


def stratified_sample(reservoirs, counts, n_paths, keep, entry):
    """Pick ``keep`` paths so each outcome's share of the fan chart matches its probability."""
    want = {}
    for k in OUTCOMES:
        if counts[k]:
            want[k] = max(1, int(round(keep * counts[k] / float(n_paths))))
    while sum(want.values()) > keep:
        biggest = max(want, key=lambda k: want[k])
        want[biggest] -= 1
    out = []
    for k in OUTCOMES:
        for prices in reservoirs[k][:want.get(k, 0)]:
            out.append({"outcome": k, "prices": [_sig(entry)] + [_sig(p) for p in prices]})
    # interleave so a partially drawn chart already shows the mix of colours
    random.Random(1).shuffle(out)
    return out


def _sig(x: float) -> float:
    return float("%.6g" % x)


def histogram_bins(closes, lv, bins: int = 40, rug_excluded: int = 0):
    """Bins of closing prices. Rug-pull paths (−90 %) are counted separately so they don't flatten the chart."""
    s = sorted(closes)
    lo = min(indicators.percentile(s, 0.5), lv["stop"])
    hi = max(indicators.percentile(s, 99.5), lv["target"])
    span = (hi - lo) or abs(hi) * 0.01 or 1.0
    lo -= span * 0.02
    hi += span * 0.02
    edges = [lo + (hi - lo) * k / bins for k in range(bins + 1)]
    counts = [0] * bins
    for v in closes:
        k = int((v - lo) / (hi - lo) * bins)
        counts[min(bins - 1, max(0, k))] += 1  # outliers (e.g. rug pulls) pile into the edge bins
    return {"edges": [_sig(e) for e in edges], "counts": counts, "clipped": True, "rug_excluded": rug_excluded}


# --- backtest comparison ------------------------------------------------------------------------

def backtest_comparison(sym, plan, run_if_missing: bool, warnings):
    names = [n for n in (plan.get("setup"), plan.get("entry_setup")) if n]
    for name in names:
        rel_path = "backtests/%s-%s.json" % (sym.key, name)
        doc = state.read_json(rel_path)
        if doc:
            return _bt_summary(doc, rel_path)
    if not run_if_missing or not names:
        return None
    setup = next((n for n in names if n in setups.SETUPS), None)
    if not setup:
        warnings.append("no backtestable setup on this plan — skipped the historical check")
        return None
    try:
        bt = skills.load("trader-backtest", "backtest")
    except ImportError:
        warnings.append("trader-backtest is not installed — no historical check")
        return None
    argv = [sym.raw or sym.display, "--setup", setup, "--no-html", "--asset", sym.asset]
    if sym.asset == "meme":
        argv[0] = "%s:%s" % (sym.chain, sym.address)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            bt.main(argv)
    except SystemExit:
        pass
    except Exception as exc:  # the comparison is optional; never let it sink the replay
        warnings.append("backtest failed: %s" % exc)
        return None
    rel_path = "backtests/%s-%s.json" % (sym.key, setup)
    doc = state.read_json(rel_path)
    if not doc:
        warnings.append("backtest produced no file — no historical check")
        return None
    return _bt_summary(doc, rel_path)


def _bt_summary(doc: dict, rel_path: str) -> dict:
    return {"file": rel_path, "windows": doc.get("windows"), "triggers": doc.get("triggers"),
            "p_target": doc.get("p_target"), "p_stop": doc.get("p_stop"), "p_neither": doc.get("p_neither"),
            "avg_r": doc.get("avg_r") if doc.get("avg_r") is not None else doc.get("expectancy_r"),
            "summary": doc.get("summary")}


# --- text --------------------------------------------------------------------------------------

def _pct(p) -> str:
    return "%.0f%%" % (100.0 * p)


def _usd_signed(x: float) -> str:
    sign = "+" if x >= 0 else "-"
    return sign + ("$%s" % "{:,.0f}".format(abs(x)) if abs(x) >= 10 else "$%.2f" % abs(x))


def _position_phrase(pos: dict, sym) -> str:
    if pos["unit"] == "usd":
        return "a %s position" % fmt.money(pos["qty"], decimals=0 if pos["qty"] >= 100 else 2)
    if pos["unit"] == "shares":
        return "%s share%s" % (fmt.qty(pos["qty"]), "" if pos["qty"] == 1 else "s")
    return "%s %s" % (fmt.qty(pos["qty"]), sym.base)


def _name(sym) -> str:
    return sym.short if sym.asset == "meme" else sym.base


def summary_text(res: dict, sym) -> str:
    p = res["probabilities"]
    stock = res["asset"] == "stock"
    when = "the rest of today" if stock else "the %s" % res["horizon_label"]
    hist = res["history"]
    hist_desc = ("%d sessions" % hist["sessions"]) if stock else ("%.1f days" % hist["days"]).replace(".0 days", " days")
    method = "block bootstrap matched to time of day, scaled to recent volatility"
    parts = ["Entry %s, stop %s, target %s." % (fmt.price(res["entry"]), fmt.price(res["stop"]), fmt.price(res["target"])),
             "I replayed %s %s times from %s's own %s candles (%s, %s)." % (
                 when, fmt.count(res["n_paths"]), _name(sym), setups.bar_label(res["interval"]), hist_desc, method)]
    tail = "by the close" if stock else "within the window"
    probs = "Target first: %s · Stop first: %s · Neither %s: %s" % (_pct(p["target"]), _pct(p["stop"]), tail,
                                                                    _pct(p["neither"]))
    if res["asset"] == "meme":
        probs += " · Rug pull: %s" % _pct(p["rug"])
    parts.append(probs + ".")
    ev = res["expected_value"]
    parts.append("Expected value %+.2fR (≈ %s on %s)." % (ev["r"], _usd_signed(ev["usd"]),
                                                         _position_phrase(res["position"], sym)))
    c = res["close"]
    parts.append("9 in 10 replays close between %s and %s (median %s)." % (fmt.price(c["p5"]), fmt.price(c["p95"]),
                                                                           fmt.price(c["median"])))
    bt = res.get("backtest")
    if bt and bt.get("triggers"):
        parts.append("Backtest of this setup: %s target / %s stop over %d triggers." % (
            _pct(bt.get("p_target") or 0), _pct(bt.get("p_stop") or 0), bt["triggers"]))
    elif bt:
        parts.append("The backtest found no triggers of this setup to compare with.")
    else:
        parts.append("No backtest on file — run /trader-backtest to compare with real history.")
    if hist["thin_sample"]:
        parts.append("Only %s of history: the sample is thin, so I widened the uncertainty — treat these numbers "
                     "loosely." % hist_desc)
    if res["method"]["rug_share"]:
        parts.append("%s of replays include a rug pull (liquidity pulled, price −90%%), from %s." % (
            _pct(res["method"]["rug_share"]), res["method"]["rug_basis"]))
    parts.append("This is a statistical simulation of past price behaviour, not a prediction — it ignores news "
                 "shocks and gaps.")
    return " ".join(parts)


def text_report(res: dict, sym, report_path) -> str:
    p = res["probabilities"]
    lines = ["Time Machine · %s · %s" % (sym.display, res.get("setup_label") or res.get("setup") or "trade"),
             "Entry %s · Stop %s · Target %s · %d bars · %s" % (
                 fmt.price(res["entry"]), fmt.price(res["stop"]), fmt.price(res["target"]), res["steps"],
                 res["horizon_label"]),
             "%s replays (seed %d) from %s" % (fmt.count(res["n_paths"]), res["seed"], _history_line(res)), ""]
    rows = [("Target first", p["target"]), ("Stop first", p["stop"]), ("Neither", p["neither"])]
    if res["asset"] == "meme":
        rows.append(("Rug pull", p["rug"]))
    for label, val in rows:
        lines.append("  %-13s %5.1f%%  %s" % (label, 100 * val, "█" * int(round(val * 30))))
    ev = res["expected_value"]
    c = res["close"]
    lines += ["",
              "Expected value  %+.2fR  (≈ %s on %s)" % (ev["r"], _usd_signed(ev["usd"]),
                                                     _position_phrase(res["position"], sym)),
              "9 in 10 close between %s and %s · median %s" % (fmt.price(c["p5"]), fmt.price(c["p95"]),
                                                               fmt.price(c["median"]))]
    bt = res.get("backtest")
    if bt and bt.get("triggers"):
        lines.append("Backtest: %s target / %s stop / %s neither over %d triggers" % (
            _pct(bt.get("p_target") or 0), _pct(bt.get("p_stop") or 0), _pct(bt.get("p_neither") or 0),
            bt["triggers"]))
    for w in res["warnings"]:
        lines.append("  ! " + w)
    lines += ["", res["summary"]]
    if report_path:
        lines += ["", cli.report_line(report_path)]
    return "\n".join(lines)


def _history_line(res) -> str:
    h = res["history"]
    if res["asset"] == "stock":
        return "%d sessions of %s candles (%s)" % (h["sessions"], setups.bar_label(res["interval"]), h["source"])
    return "%.1f days of %s candles (%s)" % (h["days"], setups.bar_label(res["interval"]), h["source"])


# --- main --------------------------------------------------------------------------------------

def run_replay(args, ctx) -> tuple:
    plan = load_plan(args.id)
    sym = plan_symbol(plan)
    asset = sym.asset
    if args.paths < 100 or args.paths > 200000:
        raise ValueError("--paths must be between 100 and 200,000")
    if args.block < 1:
        raise ValueError("--block must be at least 1")
    lv = trade_levels(plan)
    interval = plan.get("interval") or "5m"
    step = market_clock.interval_seconds(interval)
    entry_ts = market_clock.ts((plan.get("entry") or {}).get("time") or market_clock.now_utc())
    warnings = []
    horizon_end, time_stop, horizon_label, hw = horizon_window(plan, asset, entry_ts, args.horizon, ctx.cfg)
    warnings += hw

    series = data.get_candles(sym, interval, days=HISTORY_DAYS[asset], end=market_clock.iso(entry_ts))
    if len(series.candles) < 30:
        raise data.DataUnavailable("only %d candles of history for %s — not enough to replay" % (
            len(series.candles), sym.display))
    warnings += [w for w in series.warnings if w not in warnings]
    if asset == "meme":
        sym = series.symbol if series.symbol.address else sym
    recs = bar_records(series.candles, asset, step)
    hist = history_info(recs, series.candles, asset, step, series.source)
    scales = bucket_scales(recs, asset, entry_ts, args.keep_drift)
    if hist["thin_sample"]:
        for st in scales.values():
            st["scale"] *= THIN_WIDEN
        warnings.append("thin sample: only %s of history — volatility widened ×%.2f" % (
            ("%d sessions" % hist["sessions"]) if asset == "stock" else ("%.1f days" % hist["days"]), THIN_WIDEN))

    rug_share, rug_basis = rug_share_for(sym, asset, args, horizon_end - entry_ts, warnings)
    order = matching_order(plan.get("id"))
    exit_slip = 0.0
    liquidity = None
    if asset == "meme":
        liquidity = meme_liquidity(plan, sym)
        size_usd = None
        if order and (order.get("qty_unit") == "usd"):
            size_usd = float(order.get("qty") or 0)
        size_usd = size_usd or args.size_usd or float(ctx.cfg.get("account_size") or 0) * float(
            (ctx.limits.get("meme") or {}).get("max_position_pct") or 0) / 100.0
        exit_slip = trade_sim.estimate_slippage_pct(size_usd, liquidity) or 0.0
        if liquidity is None:
            warnings.append("pool liquidity unknown — exit slippage not modelled")
    pos = position(plan, asset, lv, order, ctx, args.size_usd)

    sim = simulate(recs, lv, entry_ts, horizon_end, time_stop, step, asset, scales, args.block, args.paths,
                   args.seed, trailing=plan.get("trailing"), scale_out=plan.get("scale_out"),
                   atr_value=plan.get("atr"), rug_share=rug_share, exit_slip_pct=exit_slip, keep=args.sample)
    n = float(args.paths)
    probs = {k: sim["counts"][k] / n for k in OUTCOMES}
    closes_sorted = sorted(sim["closes"] + sim["rug_closes"])
    ev_r = sum(sim["r"]) / n
    buckets = {}
    for r in recs:
        buckets[r[4]] = buckets.get(r[4], 0) + 1
    entry_day = market_clock.et_date(entry_ts) if asset == "stock" else market_clock.from_ts(entry_ts).date()
    res = {
        "id": plan.get("id"), "symbol": plan.get("symbol") or sym.display, "symbol_key": sym.key,
        "display": sym.display, "asset": asset, "setup": plan.get("setup"),
        "setup_label": setups.SETUPS.get(plan.get("setup"), {}).get("label") or plan.get("setup"),
        "generated_at": market_clock.iso(market_clock.now_utc()), "seed": args.seed, "n_paths": args.paths,
        "interval": interval, "entry": lv["entry"], "stop": lv["stop"], "target": lv["target"],
        "risk_per_unit": lv["risk"], "entry_time": market_clock.iso(entry_ts),
        "time_stop": market_clock.iso(time_stop), "horizon_end": market_clock.iso(horizon_end),
        "horizon_label": horizon_label, "steps": sim["steps"],
        "history": hist,
        "method": {"kind": "block bootstrap", "block_len": args.block, "buckets": buckets,
                   "vol_scale": round(sim["avg_scale"], 4),
                   "bucket_scales": {b: round(v["scale"], 4) for b, v in scales.items() if b != "_global"},
                   "drift_removed": not args.keep_drift,
                   "full_vol_per_bar": scales["_global"]["full_vol"],
                   "recent_vol_per_bar": scales["_global"]["recent_vol"],
                   "rug_share": round(rug_share, 4), "rug_basis": rug_basis,
                   "exit_slippage_pct": round(exit_slip, 4), "liquidity_usd": liquidity,
                   "trailing": plan.get("trailing"), "scale_out": plan.get("scale_out") or []},
        "probabilities": {k: round(v, 4) for k, v in probs.items()},
        "counts": sim["counts"],
        "expected_value": {"r": round(ev_r, 4), "usd": round(ev_r * pos["risk_usd"], 2), "qty": pos["qty"],
                           "qty_unit": pos["unit"], "risk_usd": round(pos["risk_usd"], 2), "basis": pos["source"]},
        "position": pos,
        "close": {"median": _sig(indicators.percentile(closes_sorted, 50)),
                  "mean": _sig(sum(closes_sorted) / n),
                  "p5": _sig(indicators.percentile(closes_sorted, 5)),
                  "p95": _sig(indicators.percentile(closes_sorted, 95))},
        "histogram": histogram_bins(sim["closes"] or sim["rug_closes"], lv, rug_excluded=len(sim["rug_closes"])
                                    if sim["closes"] else 0),
        "sample_paths": stratified_sample(sim["reservoirs"], sim["counts"], args.paths, args.sample, lv["entry"]),
        "path_times": [market_clock.iso(t) for t in sim["times"]],
        "backtest": backtest_comparison(sym, plan, args.with_backtest, warnings),
        "warnings": warnings,
    }
    res["summary"] = summary_text(res, sym)
    rel_json = "timemachine/%s-%s.json" % (sym.key, entry_day.strftime("%Y%m%d"))
    res["file"] = rel_json
    report_path = None
    if not args.no_html:
        report = skills.load("trader-timemachine", "report")
        report_path = report.write(res)
        res["report"] = state.rel(report_path)
    state.write_json(rel_json, res)
    return res, sym, report_path


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    res, sym, report_path = run_replay(args, ctx)
    payload = {k: v for k, v in res.items() if k not in ("sample_paths", "path_times")}
    cli.emit(args, text_report(res, sym, report_path), payload, res["asset"])
    cli.maybe_open(args, report_path)
    return 0


if __name__ == "__main__":
    cli.run(main)
