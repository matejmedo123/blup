#!/usr/bin/env python3
"""Chart Scanner — scan a universe on 5-minute candles and rank day-trading setups.

Stocks: all US tickers (SEC/Nasdaq list) → opening-range breakouts, VWAP
reclaims, gap-and-go, bull flags, high relative volume. Crypto: top coins by
volume → Asia / US-open / UTC-day range breakouts, VWAP reclaims, volume
spikes, funding-rate extremes, breakouts with rising open interest. Meme
coins: DexScreener boosted + new tokens → volume and buy-pressure spikes,
momentum breakouts, first-hour launches — every meme hit is run through
trader-rugcheck and hidden if it fails.

Examples:
  python3 scan.py --asset stock
  python3 scan.py --asset stock --symbols TSLA,NVDA,AMD
  python3 scan.py --asset crypto --top 10
  python3 scan.py --asset meme
  python3 scan.py --asset stock --offline --now 2026-10-20T14:15:00Z
"""
from __future__ import annotations

import os
import sys
import time

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, html, http, indicators, market_clock, setups, skills, state, symbols  # noqa: E402
from shared.sources import yahoo  # noqa: E402

SETUP_LISTS = {
    "stock": ["orb15", "orb30", "gap_and_go", "vwap_reclaim", "bull_flag"],
    "crypto": ["asia_range", "us_open_range", "utc_open_range", "vwap_reclaim", "momentum"],
    "meme": ["momentum"],
}
FLAGS = {
    "high_relvol": "High relative volume",
    "volume_spike": "Volume spike",
    "funding_extreme": "Funding-rate extreme",
    "rising_oi": "Breakout with rising open interest",
    "buy_pressure": "Buy-pressure spike",
    "new_launch": "First-hour launch",
    "rugcheck_risky": "Rugcheck: RISKY",
}
FLAG_SETUPS = {"stock": ["high_relvol"], "crypto": ["funding_extreme", "volume_spike"],
               "meme": ["new_launch", "volume_spike", "buy_pressure"]}
STATUS_BASE = {"triggered": 60, "watching": 38, "flag": 34, "forming": 30, "extended": 18}
RECENT_BARS = 6        # a repeating rule (VWAP, flag, momentum) older than this is "extended"
ONE_SHOT_BARS = 12     # one-per-window breakouts (ranges, gap-and-go) stay fresh for an hour if they hold
EXTENDED_MAX_BARS = 24  # older than this is not worth showing at all
NEAR_TRIGGER_PCT = 0.5
KV_CSS = ("<style>.kv td{padding:3px 6px}.kv td:first-child{white-space:nowrap;color:var(--muted);width:1%}"
          ".card h3{line-height:1.35}</style>")
MEME_CANDLE_TOKENS = 8
MEME_RECENT_BARS = 3


# --- helpers ---------------------------------------------------------------------------

def _sym_str(sym) -> str:
    """A symbol string every other skill can parse back with symbols.parse()."""
    if sym.asset == "meme":
        return "%s:%s" % (sym.chain, sym.address)
    return sym.key


def _et(t, with_date: bool = False) -> str:
    """24-hour New York time — shared fmt_et is 12-hour without a.m./p.m."""
    e = market_clock.to_et(t)
    hm = "%d:%02d" % (e.hour, e.minute)
    return ("%s %d %s" % (e.strftime("%b"), e.day, hm)) if with_date else hm


def _clock(t, asset: str) -> str:
    if asset == "stock":
        return _et(t) + " ET"
    return market_clock.from_ts(t).strftime("%H:%M UTC")


def _score(status, relvol=None, vol_mult=None, fresh=None, gap=None, bonus=0.0) -> float:
    s = STATUS_BASE.get(status, 20)
    if relvol:
        s += min(20.0, max(0.0, (relvol - 1.0) * 8.0))
    if vol_mult:
        s += min(10.0, max(0.0, (vol_mult - 1.0) * 2.5))
    if fresh is not None and status == "triggered":
        s += max(0.0, 10.0 - 2.0 * fresh)
    if gap:
        s += min(10.0, abs(gap))
    return round(max(0.0, min(100.0, s + bonus)), 1)


def _closed(window, now_ts, step) -> list:
    return [c for c in window.candles if c.t + step <= now_ts]


def _hit(sym, window_key, interval, setup, label, status, rule, levels, trigger, metrics, flags, notes, score,
         last_price, now, entry_setup=None) -> dict:
    trig = None
    if trigger:
        trig = {"time": trigger["time"], "close_time": trigger["close_time"], "price": trigger["price"]}
    return {
        "id": setups.setup_id(sym.key, window_key, setup), "symbol": _sym_str(sym), "display": sym.display,
        "name": sym.name, "asset": sym.asset, "setup": setup, "label": label, "entry_setup": entry_setup or setup,
        "direction": "long", "status": status, "score": score, "last_price": last_price,
        "as_of": market_clock.iso(now), "interval": interval, "window": window_key, "rule": rule,
        "levels": levels, "trigger": trig, "metrics": metrics, "flags": list(flags), "notes": list(notes),
        "rugcheck": None, "chart": None,
    }


def _from_result(r, sym, window, bars, step, now_ts, interval, metrics, flags, now, bonus=0.0):
    """Turn a setups.evaluate() result into a scanner hit, or None if it is not worth showing."""
    status = r["status"]
    last = bars[-1].c if bars else None
    fresh = None
    notes = list(r["notes"])
    if status == "triggered":
        age = (now_ts - (r["trigger"]["t"] + step)) // step
        if age >= EXTENDED_MAX_BARS:
            return None
        one_shot = setups.SETUPS[r["setup"]]["kind"] in ("range", "gap")
        level = r["levels"].get("trigger_level")
        if age >= (ONE_SHOT_BARS if one_shot else RECENT_BARS):
            status = "extended"
            notes.append("triggered %d bars ago — price has moved on" % age)
        elif level and last is not None and last < level:
            status = "extended"
            notes.append("back below the trigger level %s — the breakout is failing" % fmt.price(level))
        fresh = age
    elif status in ("watching", "forming"):
        level = r["levels"].get("trigger_level")
        near = bool(level and last and abs(last / level - 1) * 100 <= NEAR_TRIGGER_PCT)
        if not (r["setup"] == "bull_flag" or near):
            return None
        if near:
            notes.append("price %s is within %.1f%% of the trigger %s" % (fmt.price(last), NEAR_TRIGGER_PCT,
                                                                           fmt.price(level)))
    else:
        return None
    score = _score(status, metrics.get("relvol"), metrics.get("volume_mult"), fresh, metrics.get("gap_pct")
                   if r["setup"] == "gap_and_go" else None, bonus)
    return _hit(sym, window.key, interval, r["setup"], r["label"], status, r["rule"], r["levels"], r["trigger"],
                metrics, flags, notes, score, last, now)


def _chart_spec(hit, bars):
    lv = hit["levels"]
    lines = []
    if lv.get("range_high") is not None:
        lines.append({"price": lv["range_high"], "label": "range high", "color": "blue", "dash": True})
    elif lv.get("trigger_level") is not None:
        lines.append({"price": lv["trigger_level"], "label": "trigger", "color": "blue", "dash": True})
    if lv.get("stop_ref") is not None:
        lines.append({"price": lv["stop_ref"], "label": "stop ref", "color": "red", "dash": True})
    if lv.get("vwap") is not None and lv.get("vwap") != lv.get("trigger_level"):
        lines.append({"price": lv["vwap"], "label": "VWAP", "color": "gray", "dash": True})
    markers = []
    if hit.get("trigger"):
        t = market_clock.ts(hit["trigger"]["time"])
        markers.append({"t": t, "price": hit["trigger"]["price"], "color": "blue", "shape": "dot"})
    return bars, lines, markers


# --- stocks ------------------------------------------------------------------------------

def _prefilter(tickers, keep, deadline, notes):
    """Bulk pre-filter with Yahoo spark (20 tickers per call): keep the biggest gappers/movers."""
    ranked = []
    for i in range(0, len(tickers), 20):
        if time.monotonic() > deadline:
            notes.append("pre-filter stopped at the time budget (%d of %d tickers ranked)" % (i, len(tickers)))
            break
        batch = tickers[i:i + 20]
        try:
            sp = yahoo.spark(batch)
        except http.SourceError:
            continue
        for t, d in sp.items():
            closes, prev = d.get("closes") or [], d.get("prev_close")
            if not closes or not prev:
                continue
            gap = abs(closes[0] / prev - 1)
            move = abs(closes[-1] / closes[0] - 1)
            ranked.append((gap + move, t))
    if not ranked:
        notes.append("bulk pre-filter unavailable — scanning the first %d tickers" % keep)
        return tickers[:keep]
    ranked.sort(reverse=True)
    return [t for _, t in ranked[:keep]]


def _analyze_stock(series, now_ts, now, interval, cfg_s, wanted, charts):
    sym = series.symbol
    step = series.step
    ws = setups.windows(series.candles, "stock", interval)
    window = setups.window_at(series.candles, "stock", interval, now_ts - 1)
    if window is None:
        return [], "no session"
    bars = _closed(window, now_ts, step)
    if not bars:
        return [], "no closed bars yet"
    hist = [w for w in ws if w.start < window.start][-20:]
    last = bars[-1].c
    if last < float(cfg_s.get("min_price") or 0):
        return [], "price below min_price"
    if hist:
        avg_vol = sum(sum(c.v for c in w.candles) for w in hist) / float(len(hist))
        if avg_vol < float(cfg_s.get("min_avg_volume") or 0):
            return [], "average volume below min_avg_volume"
    relvol = indicators.relative_volume(bars, [w.candles for w in hist])
    gap = (bars[0].o / window.prev_close - 1) * 100 if window.prev_close else None
    change = (last / window.prev_close - 1) * 100 if window.prev_close else None
    vw = indicators.vwap(bars)[-1]
    metrics = {"relvol": round(relvol, 2) if relvol else None, "gap_pct": round(gap, 2) if gap is not None else None,
               "change_pct": round(change, 2) if change is not None else None, "liquidity_usd": None,
               "funding_rate": None, "oi_change_pct": None, "volume_mult": None}
    flags = ["high_relvol"] if relvol and relvol >= float(cfg_s.get("relvol_min") or 2.0) else []
    params = {"pick": "last", "gap_min_pct": float(cfg_s.get("gap_min_pct") or 3.0)}
    hits = []
    for setup in SETUP_LISTS["stock"]:
        if wanted and setup not in wanted:
            continue
        r = setups.evaluate(setup, window, now_ts, params)
        h = _from_result(r, sym, window, bars, step, now_ts, interval, metrics, flags, now)
        if h:
            h["levels"].setdefault("vwap", vw)
            if relvol:
                h["notes"].append("relative volume %.1f×" % relvol)
            hits.append(h)
            charts[h["id"]] = _chart_spec(h, bars)
    if not hits and flags and (not wanted or "high_relvol" in wanted):
        levels = {"trigger_level": max(c.h for c in bars), "stop_ref": min(c.l for c in bars[-6:]), "vwap": vw}
        h = _hit(sym, window.key, interval, "high_relvol", FLAGS["high_relvol"], "flag",
                 "Volume is %.1f× normal for this time of day — watch for a 5-min close above the high of day %s"
                 % (relvol, fmt.price(levels["trigger_level"])), levels, None, metrics, flags,
                 ["no candle rule triggered yet — the entry timer will watch a momentum breakout"],
                 _score("flag", relvol), last, now, entry_setup="momentum")
        hits.append(h)
        charts[h["id"]] = _chart_spec(h, bars)
    return hits, None


def scan_stocks(ctx, args, now, now_ts, wanted, charts):
    cfg_s = ctx.cfg.get("scanner") or {}
    interval = args.interval or cfg_s.get("interval") or "5m"
    notes = []
    if args.symbols:
        tickers, uname = [s.strip().upper() for s in args.symbols.split(",") if s.strip()], "custom list"
    elif args.watchlist:
        tickers, uname = list(ctx.cfg["watchlists"].get("stocks") or []), "watchlist"
    else:
        uni = data.stock_universe(ctx.cfg)
        tickers, uname = [r["ticker"] for r in uni["tickers"]], "US stocks (%s)" % uni["source"]
        notes.extend(uni.get("warnings") or [])
    total = len(tickers)
    max_symbols = int(args.max_symbols or cfg_s.get("max_symbols") or 300)
    budget = float(args.time_budget or cfg_s.get("time_budget_sec") or 240)
    deadline = time.monotonic() + budget
    candidates = tickers if total <= max_symbols else _prefilter(tickers, max_symbols, deadline, notes)
    hits, scanned, skipped, filtered, budget_hit = [], 0, 0, 0, False
    for t in candidates:
        if time.monotonic() > deadline:
            budget_hit = True
            notes.append("time budget of %ds reached" % budget)
            break
        try:
            series = data.get_candles(t, interval, days=21, asset="stock")
        except (data.DataUnavailable, symbols.SymbolError):
            skipped += 1
            continue
        scanned += 1
        found, why = _analyze_stock(series, now_ts, now, interval, cfg_s, wanted, charts)
        if why and why.startswith(("price", "average")):
            filtered += 1
        hits.extend(found)
    state_ = market_clock.market_status(now)
    if state_["state"] != "open":
        notes.append("US market is %s — results use the latest session" % state_["state"])
    uni = {"name": uname, "total": total, "scanned": scanned, "skipped": skipped, "filtered": filtered,
           "hidden": 0, "candidates": len(candidates), "time_budget_hit": budget_hit}
    uni["noun"] = "US stocks" if uname.startswith("US stocks") else "symbols"
    return hits, [], uni, notes, interval


# --- crypto --------------------------------------------------------------------------------

def scan_crypto(ctx, args, now, now_ts, wanted, charts):
    cfg_s = ctx.cfg.get("scanner") or {}
    interval = args.interval or cfg_s.get("interval") or "5m"
    quote = ctx.cfg.get("quote_currency") or "USDT"
    notes = []
    if args.symbols or args.watchlist:
        raw = args.symbols.split(",") if args.symbols else (ctx.cfg["watchlists"].get("crypto") or [])
        syms = [symbols.parse(s.strip(), asset="crypto", quote=quote) for s in raw if s.strip()]
        uname = "custom list" if args.symbols else "watchlist"
    else:
        n = int(cfg_s.get("top_n_crypto") or 30)
        uni = data.crypto_universe(n, quote)
        syms = [c["symbol"] for c in uni["coins"]]
        uname = "top %d by volume via %s" % (n, uni["source"])
        notes.extend(uni.get("warnings") or [])
    hits, scanned, skipped = [], 0, 0
    deadline = time.monotonic() + float(args.time_budget or cfg_s.get("time_budget_sec") or 240)
    for sym in syms:
        if time.monotonic() > deadline:
            notes.append("time budget reached")
            break
        try:
            series = data.get_candles(sym, interval, days=3)
        except data.DataUnavailable:
            skipped += 1
            continue
        scanned += 1
        found = _analyze_crypto(series, now_ts, now, interval, wanted, charts)
        hits.extend(found)
    uni = {"name": uname, "total": len(syms), "scanned": scanned, "skipped": skipped, "hidden": 0, "noun": "coins"}
    ctxt = market_clock.crypto_context(now)
    notes.append("crypto session: %s%s · US cash market %s" % (ctxt["session"], " (weekend liquidity)" if
                                                                ctxt["weekend"] else "", ctxt["us_market"]))
    return hits, [], uni, notes, interval


def _analyze_crypto(series, now_ts, now, interval, wanted, charts):
    sym = series.symbol
    step = series.step
    window = setups.window_at(series.candles, "crypto", interval, now_ts - 1)
    if window is None:
        return []
    bars = _closed(window, now_ts, step)
    closed_all = [c for c in series.candles if c.t + step <= now_ts]
    if not bars or not closed_all:
        return []
    last = closed_all[-1].c
    day_ago = [c for c in closed_all if c.t <= closed_all[-1].t - 86400 + step]
    change = (last / day_ago[-1].c - 1) * 100 if day_ago else None
    vol_mult = indicators.volume_spike(closed_all[-49:])
    deriv = data.derivatives(sym)
    funding, oi1h = deriv.get("funding_rate"), deriv.get("oi_change_pct_1h")
    metrics = {"relvol": None, "gap_pct": None, "change_pct": round(change, 2) if change is not None else None,
               "liquidity_usd": None, "funding_rate": funding,
               "oi_change_pct": round(oi1h, 2) if oi1h is not None else None,
               "volume_mult": round(vol_mult, 2) if vol_mult else None}
    sym_flags = []
    if funding is not None and abs(funding) >= 0.0005:
        sym_flags.append("funding_extreme")
    if vol_mult and vol_mult >= 3:
        sym_flags.append("volume_spike")
    hits = []
    for setup in SETUP_LISTS["crypto"]:
        if wanted and setup not in wanted:
            continue
        r = setups.evaluate(setup, window, now_ts, {"pick": "last"})
        flags = list(sym_flags)
        bonus = 4.0 if setups.SETUPS[setup]["kind"] == "range" else 0.0
        if r["status"] == "triggered" and setups.SETUPS[setup]["kind"] in ("range", "momentum") \
                and oi1h is not None and oi1h >= 2:
            flags.append("rising_oi")
            bonus += 10.0
        h = _from_result(r, sym, window, bars, step, now_ts, interval, metrics, flags, now, bonus)
        if not h:
            continue
        if "rising_oi" in flags:
            h["notes"].append("breakout with rising open interest (+%.1f%% in the last hour, %s)"
                              % (oi1h, deriv.get("oi_source")))
        hits.append(h)
        charts[h["id"]] = _chart_spec(h, bars)
    if not hits and sym_flags:
        primary = sym_flags[0]
        if not wanted or primary in wanted:
            levels = {"trigger_level": max(c.h for c in closed_all[-12:]), "stop_ref": min(c.l for c in closed_all[-6:])}
            if primary == "funding_extreme":
                crowd = "crowded longs (longs pay shorts)" if funding > 0 else "crowded shorts (shorts pay longs)"
                rule = "Funding %+.3f%% per 8h — %s; squeezes are likely either way" % (funding * 100, crowd)
            else:
                rule = "Last 5-min volume %.1f× the recent median — watch for a close above %s" % (
                    vol_mult, fmt.price(levels["trigger_level"]))
            h = _hit(sym, window.key, interval, primary, FLAGS[primary], "flag", rule, levels, None, metrics,
                     sym_flags, ["flag only — the entry timer will watch a momentum breakout"],
                     _score("flag", vol_mult=vol_mult, bonus=6.0 if primary == "funding_extreme" else 0.0),
                     last, now, entry_setup="momentum")
            hits.append(h)
            charts[h["id"]] = _chart_spec(h, bars)
    return hits


# --- meme coins ----------------------------------------------------------------------------

def _meme_flags(pair) -> list:
    vol = pair.get("volume") or {}
    tx = pair.get("txns") or {}
    flags = []
    h1, h6 = vol.get("h1") or 0.0, vol.get("h6") or 0.0
    if h6 > 0 and h1 >= 2 * (h6 / 6.0):
        flags.append("volume_spike")
    b1, s1 = tx.get("h1", {}).get("buys", 0), tx.get("h1", {}).get("sells", 0)
    b5, s5 = tx.get("m5", {}).get("buys", 0), tx.get("m5", {}).get("sells", 0)
    if s1 and b1 / float(s1) >= 1.5 and b5 > s5:
        flags.append("buy_pressure")
    age = pair.get("age_hours")
    if age is not None and age < 1 and (pair.get("liquidity_usd") or 0) >= 10000:
        flags.append("new_launch")
    return flags


def _meme_rule(flag, pair) -> str:
    vol, tx = pair.get("volume") or {}, pair.get("txns") or {}
    if flag == "new_launch":
        return "Launched %d min ago with %s liquidity — first-hour launch" % (
            max(1, int((pair.get("age_hours") or 0) * 60)), fmt.compact_usd(pair.get("liquidity_usd")))
    if flag == "volume_spike":
        base = (vol.get("h6") or 0) / 6.0
        return "Last-hour volume %s is %.1f× the 6h hourly average" % (
            fmt.compact_usd(vol.get("h1")), (vol.get("h1") or 0) / base if base else 0)
    b1, s1 = tx.get("h1", {}).get("buys", 0), tx.get("h1", {}).get("sells", 0)
    return "Buy pressure: %d buys vs %d sells in the last hour" % (b1, s1)


def scan_meme(ctx, args, now, now_ts, wanted, charts):
    cfg_s = ctx.cfg.get("scanner") or {}
    interval = args.interval or cfg_s.get("interval") or "5m"
    chains = ctx.cfg.get("meme_chains") or ["solana"]
    notes = []
    if args.symbols or args.watchlist:
        raw = args.symbols.split(",") if args.symbols else (ctx.cfg["watchlists"].get("meme") or [])
        tokens = []
        for s in raw:
            if not s.strip():
                continue
            try:
                sym, pair, _pairs, w = data.resolve_meme(s.strip())
            except data.DataUnavailable as exc:
                notes.append(str(exc))
                continue
            notes.extend(w)
            tokens.append({"symbol": sym, "pair": pair, "tags": ["requested"], "links": []})
        uname = "custom list" if args.symbols else "watchlist"
    else:
        uni = data.meme_universe(chains)
        tokens = uni["tokens"]
        notes.extend(uni.get("warnings") or [])
        uname = "DexScreener boosted + new tokens on %s" % ", ".join(chains)
    try:
        rc_mod = skills.load("trader-rugcheck", "rugcheck")
    except ImportError as exc:
        rc_mod = None
        notes.append("trader-rugcheck is not installed — every meme hit is hidden (fail closed): %s" % exc)
    active = sorted(tokens, key=lambda t: -((t["pair"].get("volume") or {}).get("h1") or 0))
    with_candles = {id(t) for t in active[:MEME_CANDLE_TOKENS]}
    hits, hidden, scanned = [], [], 0
    day_key = market_clock.from_ts(now_ts - 1).date().isoformat()
    for tok in tokens:
        sym, pair = tok["symbol"], tok["pair"]
        scanned += 1
        flags = _meme_flags(pair)
        hit, bars = None, None
        if id(tok) in with_candles and (not wanted or "momentum" in wanted):
            try:
                series = data.get_candles(sym, interval, days=3)
                window = setups.window_at(series.candles, "meme", interval, now_ts - 1)
                bars = _closed(window, now_ts, series.step) if window else []
                if window and bars:
                    r = setups.evaluate("momentum", window, now_ts, {"pick": "last"})
                    if r["status"] == "triggered":
                        age = (now_ts - (r["trigger"]["t"] + series.step)) // series.step
                        if age < MEME_RECENT_BARS:
                            metrics = _meme_metrics(pair, r["levels"].get("volume_mult"))
                            hit = _hit(sym, window.key, interval, "momentum", r["label"], "triggered", r["rule"],
                                       r["levels"], r["trigger"], metrics, flags, r["notes"],
                                       _score("triggered", vol_mult=r["levels"].get("volume_mult"), fresh=age),
                                       bars[-1].c, now)
            except data.DataUnavailable:
                notes.append("%s: no candles available — judged on DexScreener pair stats only" % sym.display)
        if hit is None:
            primary = [f for f in FLAG_SETUPS["meme"] if f in flags and (not wanted or f in wanted)]
            if not primary:
                continue
            levels = {"trigger_level": max(c.h for c in bars[-12:]) if bars else None,
                      "stop_ref": min(c.l for c in bars[-6:]) if bars else None}
            hit = _hit(sym, day_key, interval, primary[0], FLAGS[primary[0]], "flag", _meme_rule(primary[0], pair),
                       {k: v for k, v in levels.items() if v is not None}, None, _meme_metrics(pair, None), flags,
                       ["flag only — the entry timer will watch a momentum breakout"],
                       _score("flag", bonus=4.0 if primary[0] == "new_launch" else 0.0),
                       pair.get("price_usd"), now, entry_setup="momentum")
        hit["notes"].extend("DexScreener: %s" % t.replace("_", " ") for t in tok.get("tags") or [])
        # the safety gate — fail closed
        if rc_mod is None:
            hidden.append({"symbol": hit["symbol"], "display": hit["display"], "reason": "rugcheck not installed"})
            continue
        try:
            rc = rc_mod.check(sym, pair)
        except Exception as exc:  # noqa: BLE001 — any failure hides the hit
            hidden.append({"symbol": hit["symbol"], "display": hit["display"],
                           "reason": "rugcheck failed (%s) — hidden to be safe" % exc})
            continue
        hit["rugcheck"] = rc_mod.summary(rc)
        if rc["verdict"] == "DANGER":
            hidden.append({"symbol": hit["symbol"], "display": hit["display"], "verdict": "DANGER",
                           "reason": "rugcheck DANGER: " + "; ".join(rc["reasons"][:3])})
            continue
        if rc["verdict"] == "RISKY":
            hit["flags"].append("rugcheck_risky")
            hit["score"] = round(max(0.0, hit["score"] - 10), 1)
        hits.append(hit)
        if bars:
            charts[hit["id"]] = _chart_spec(hit, bars)
    uni = {"name": uname, "total": len(tokens), "scanned": scanned, "skipped": 0, "hidden": len(hidden),
           "noun": "meme tokens"}
    return hits, hidden, uni, notes, interval


def _meme_metrics(pair, vol_mult) -> dict:
    tx = (pair.get("txns") or {}).get("h1") or {}
    return {"relvol": None, "gap_pct": None, "change_pct": (pair.get("price_change") or {}).get("h1"),
            "liquidity_usd": pair.get("liquidity_usd"), "funding_rate": None, "oi_change_pct": None,
            "volume_mult": round(vol_mult, 2) if vol_mult else None,
            "volume_h1_usd": (pair.get("volume") or {}).get("h1"), "buys_h1": tx.get("buys"),
            "sells_h1": tx.get("sells"),
            "age_hours": round(pair["age_hours"], 2) if pair.get("age_hours") is not None else None}


# --- output --------------------------------------------------------------------------------

def _header(asset, uni, n_hits) -> str:
    plural = "" if n_hits == 1 else "s"
    if asset == "stock":
        return "%s of %s %s scanned, %d setup%s" % (fmt.count(uni["scanned"]), fmt.count(uni["total"]), uni["noun"],
                                                    n_hits, plural)
    if asset == "crypto":
        return "%d of %d coins scanned (%s), %d setup%s" % (uni["scanned"], uni["total"], uni["name"], n_hits, plural)
    return "%d meme tokens scanned (%s), %d setup%s shown, %d hidden by rugcheck" % (
        uni["scanned"], uni["name"], n_hits, plural, uni["hidden"])


def _dedupe(hits) -> list:
    """ORB-15 and ORB-30 often fire on the same candle at the same level — show it once."""
    best = {}
    order = []
    for h in hits:
        trig = h.get("trigger") or {}
        level = h["levels"].get("trigger_level")
        key = (h["symbol"], trig.get("time"), round(level, 8) if level and trig else h["setup"])
        if key not in best:
            order.append(key)
            best[key] = h
        elif h["score"] > best[key]["score"]:
            best[key] = h
    return [best[k] for k in order]


def _hit_line(i, h) -> str:
    when = ""
    if h.get("trigger"):
        when = " · %s" % _clock(market_clock.ts(h["trigger"]["time"]), h["asset"])
    m = h["metrics"]
    extra = []
    if m.get("relvol"):
        extra.append("relvol %.1f×" % m["relvol"])
    if m.get("volume_mult") and h["asset"] != "stock":
        extra.append("vol %.1f×" % m["volume_mult"])
    if m.get("liquidity_usd"):
        extra.append("liq %s" % fmt.compact_usd(m["liquidity_usd"]))
    flags = [f for f in h["flags"] if f != h["setup"]]
    if flags:
        extra.append("flags: " + ", ".join(flags))
    if h.get("rugcheck"):
        extra.append("rugcheck %s %d" % (h["rugcheck"]["verdict"], h["rugcheck"]["score"]))
    name = h["display"] if h["asset"] != "meme" else (h["name"] or h["display"])
    return "%3d. %-12s %-10s %-34s %s · %s%s%s · score %.0f" % (
        i, name[:12], h["status"].upper(), h["label"][:34], fmt.price(h["last_price"]), h["rule"], when,
        (" · " + " · ".join(extra)) if extra else "", h["score"])


def write_report(asset, hits, hidden, uni, header, notes, charts, now):
    tone = {"triggered": "good", "watching": "info", "forming": "info", "flag": "warn", "extended": ""}
    cards = []
    for h in hits:
        spec = charts.get(h["id"])
        title = "<h3>%s · %s</h3>" % (html.esc(h["name"] or h["display"] if h["asset"] == "meme" else h["display"]),
                                      html.esc(h["label"]))
        pill = "<p>%s <span class='muted'>score %.0f</span></p>" % (
            html.pill(h["status"].upper(), tone.get(h["status"], "")), h["score"])
        chart = html.mini_chart(*spec, asset=asset) if spec else ""
        rows = [["Price", fmt.price(h["last_price"])], ["Rule", h["rule"]]]
        lv = h["levels"]
        if lv.get("trigger_level") is not None:
            rows.append(["Trigger level", fmt.price(lv["trigger_level"])])
        if lv.get("stop_ref") is not None:
            rows.append(["Stop reference", fmt.price(lv["stop_ref"])])
        if h.get("trigger"):
            rows.append(["Triggered", _clock(market_clock.ts(h["trigger"]["time"]), asset)])
        m = h["metrics"]
        for key, label, f in (("relvol", "Relative volume", lambda v: "%.1f×" % v),
                              ("gap_pct", "Gap", lambda v: fmt.pct(v, 1, True)),
                              ("change_pct", "Change", lambda v: fmt.pct(v, 1, True)),
                              ("funding_rate", "Funding / 8h", lambda v: fmt.pct(v * 100, 3, True)),
                              ("oi_change_pct", "Open interest 1h", lambda v: fmt.pct(v, 1, True)),
                              ("liquidity_usd", "Liquidity", fmt.compact_usd),
                              ("volume_h1_usd", "Volume 1h", fmt.compact_usd),
                              ("age_hours", "Pair age", lambda v: "%.1f h" % v)):
            if m.get(key) is not None:
                rows.append([label, f(m[key])])
        if h["flags"]:
            rows.append(["Flags", ", ".join(h["flags"])])
        if h.get("rugcheck"):
            rows.append(["Rugcheck", "%s (%d/100)" % (h["rugcheck"]["verdict"], h["rugcheck"]["score"])])
        legend = ""
        if spec:
            legend = "<p class='sub'>%s</p>" % " ".join(
                "<span style='color:%s'>━ %s</span>" % (html.COLORS.get(ln.get("color"), "#6e7781"),
                                                         html.esc(ln.get("label", ""))) for ln in spec[1])
        kv = "".join("<tr><td>%s</td><td>%s</td></tr>" % (html.esc(k), html.esc(v)) for k, v in rows)
        cards.append("<section class='card'>%s%s%s%s<div class='table-wrap'><table class='kv'>%s</table></div>"
                     "</section>" % (title, pill, chart, legend, kv))
    body = [html.tiles([("Universe", uni["name"]), ("Scanned", "%s of %s" % (fmt.count(uni["scanned"]),
                                                                             fmt.count(uni["total"]))),
                        ("Setups", str(len(hits)), "good" if hits else ""),
                        ("Hidden by rugcheck", str(len(hidden)), "bad" if hidden else "")])]
    body.append("<div class='grid'>%s</div>" % "".join(cards) if cards else
                html.card("", "<p class='muted'>No setups right now.</p>"))
    if hidden:
        body.append(html.card("Hidden by rugcheck", html.table(["Token", "Why"], [[x["display"], x["reason"]]
                                                                                  for x in hidden])))
    if notes:
        body.append(html.card("Notes", "<ul>%s</ul>" % "".join("<li>%s</li>" % html.esc(n) for n in notes)))
    title = "Chart Scanner · %s" % {"stock": "US stocks", "crypto": "Crypto", "meme": "Meme coins"}[asset]
    page = html.page(title, "".join(body), subtitle="%s · as of %s" % (header, market_clock.iso(now)), asset=asset,
                     extra_head=KV_CSS)
    day = (market_clock.et_date(now) if asset == "stock" else now.date()).strftime("%Y%m%d")
    return html.write_report("scan-%s-%s.html" % (asset, day), page)


def build_parser():
    p = cli.parser("scan.py", __doc__)
    p.add_argument("--symbols", help="comma-separated symbols instead of the full universe")
    p.add_argument("--watchlist", action="store_true", help="scan the watchlist from trader/config.json")
    p.add_argument("--setups", help="comma-separated setups/flags to look for (default: all for the asset class)")
    p.add_argument("--max-symbols", type=int, help="how many stocks get a full 5-min scan (default config 300)")
    p.add_argument("--time-budget", type=float, help="stop scanning after this many seconds (default config 240)")
    p.add_argument("--top", type=int, default=25, help="show the best N hits (default 25)")
    p.add_argument("--interval", choices=("1m", "5m", "15m"), help="candle size (default 5m)")
    return p


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    asset = args.asset or "stock"
    now = market_clock.now_utc()
    now_ts = int(now.timestamp())
    wanted = None
    if args.setups:
        wanted = {s.strip() for s in args.setups.split(",") if s.strip()}
        allowed = set(SETUP_LISTS[asset]) | set(FLAG_SETUPS[asset])
        bad = sorted(wanted - allowed)
        if bad:
            raise ValueError("unknown setup(s) for %s: %s — choose from %s" % (asset, ", ".join(bad),
                                                                            ", ".join(sorted(allowed))))
    charts = {}
    scan = {"stock": scan_stocks, "crypto": scan_crypto, "meme": scan_meme}[asset]
    hits, hidden, uni, notes, interval = scan(ctx, args, now, now_ts, wanted, charts)
    hits = _dedupe(hits)
    header = _header(asset, uni, len(hits))
    hits.sort(key=lambda h: (-h["score"], h["display"]))
    shown = hits[: max(1, args.top)]
    path = None
    if not args.no_html:
        path = write_report(asset, shown, hidden, uni, header, notes, charts, now)
        for h in shown:
            h["chart"] = state.rel(path)
    payload = {"generated_at": market_clock.iso(now), "asset": asset, "interval": interval, "universe": uni,
               "setups": shown, "hidden": hidden, "warnings": notes}
    state.write_json("setups.json", payload)
    state.write_json("setups-%s.json" % asset, payload)
    lines = ["Chart Scanner · %s · %s bars · as of %s" % (
        {"stock": "US stocks", "crypto": "crypto", "meme": "meme coins"}[asset], interval,
        (_et(now, True) + " ET") if asset == "stock" else market_clock.fmt_utc(now, True)), header]
    if not shown:
        lines.append("  No setups right now.")
    for i, h in enumerate(shown, 1):
        lines.append(_hit_line(i, h))
    if len(hits) > len(shown):
        lines.append("  … %d more (raise --top)" % (len(hits) - len(shown)))
    for x in hidden:
        lines.append("  hidden: %s — %s" % (x["display"], x["reason"]))
    for n in notes:
        lines.append("  note: " + n)
    lines.append("Saved: trader/setups.json")
    if path:
        lines.append(cli.report_line(path))
    cli.emit(args, "\n".join(lines), payload, asset)
    cli.maybe_open(args, path)
    return 0


if __name__ == "__main__":
    cli.run(main)
