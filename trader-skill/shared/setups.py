"""Setup rules — one definition used three ways: the scanner finds them, the
entry timer watches them candle by candle, the backtester replays them.

All rules are long-only (shorts are blocked by default in the risk limits) and
act only on *closed* bars. A window is one regular session for stocks and one
UTC day for crypto and meme coins.

Swing setups (kind "series", crypto, meant for 1-hour and 4-hour bars) need days of history — a 200-bar
EMA — so they don't fit a one-day window: ``series_signals`` finds them across a whole candle series.
The backtest lab tests them; the autopilot trades them only when the lab validated them.
"""
from __future__ import annotations

from collections import namedtuple

from . import fmt, indicators, market_clock

Window = namedtuple("Window", "key start end candles prev_close asset interval")

SETUPS = {
    "orb15": {"label": "Opening-range breakout (15 min)", "assets": ("stock",), "kind": "range", "range": "open15"},
    "orb30": {"label": "Opening-range breakout (30 min)", "assets": ("stock",), "kind": "range", "range": "open30"},
    "gap_and_go": {"label": "Gap-and-go", "assets": ("stock",), "kind": "gap"},
    "vwap_reclaim": {"label": "VWAP reclaim", "assets": ("stock", "crypto", "meme"), "kind": "vwap"},
    "bull_flag": {"label": "Bull flag", "assets": ("stock", "crypto", "meme"), "kind": "flag"},
    "asia_range": {"label": "Asia-range breakout", "assets": ("crypto", "meme"), "kind": "range", "range": "asia"},
    "us_open_range": {"label": "US-open range breakout (30 min)", "assets": ("crypto",), "kind": "range",
                      "range": "us_open"},
    "utc_open_range": {"label": "UTC-day opening-range breakout (1 h)", "assets": ("crypto", "meme"),
                       "kind": "range", "range": "utc_open"},
    "momentum": {"label": "Momentum breakout", "assets": ("stock", "crypto", "meme"), "kind": "momentum"},
    # swing setups — whole-series rules for 1h / 4h bars (see series_signals)
    "trend_pullback": {"label": "Trend pullback (back above the 20 EMA in an uptrend)", "assets": ("crypto",),
                       "kind": "series"},
    "oversold_bounce": {"label": "Oversold bounce (RSI(2) under 10 above the 200 EMA)", "assets": ("crypto",),
                        "kind": "series"},
    "band_bounce": {"label": "Bollinger-band bounce above the 200 EMA", "assets": ("crypto",), "kind": "series"},
    "breakout_24": {"label": "24-bar high breakout on 2× volume above the 200 EMA", "assets": ("crypto",),
                    "kind": "series"},
    # daily mean reversion inside an uptrend; Bitcoin's 200-day trend is the switch for the whole market
    "dip_in_uptrend": {"label": "Dip in an uptrend (3 lower daily closes, RSI(2) < 10, BTC above its 200-day average)",
                       "assets": ("crypto",), "kind": "series", "intervals": ("1d",), "needs_btc": True,
                       "cooldown": 1, "stop_atr": 3.0,
                       "exit_rule": {"type": "close_above_sma", "n": 5, "max_bars": 10,
                                     "text": "first daily close above the 5-day average, at most 10 days",
                                     "short": "close > 5-day average (≤ 10 d)"}},
    # daily trend following: few winners, but they run — the steadiest edge crypto has shown
    "trend_breakout": {"label": "Trend breakout (daily close above the 20-day high, BTC above its 200-day average)",
                       "assets": ("crypto",), "kind": "series", "intervals": ("1d",), "needs_btc": True,
                       "cooldown": 1, "stop_atr": 3.0,
                       "exit_rule": {"type": "close_below_low", "n": 10, "max_bars": 60,
                                     "text": "first daily close below the lowest close of the previous 10 days, at "
                                             "most 60 days", "short": "close < 10-day low (≤ 60 d)"}},
}
SERIES_INTERVALS = ("1h", "4h", "1d")
SERIES_WARMUP = 210          # bars before the first signal (the 200-bar EMA needs them)
SERIES_COOLDOWN = 12         # bars after a signal before the same rule may fire again
DEFAULT_SETUP = {"stock": "orb15", "crypto": "asia_range", "meme": "momentum"}

DEFAULT_PARAMS = {
    "orb_cutoff_et": (11, 30),
    "gap_min_pct": 3.0,
    "gap_cutoff_et": (10, 30),
    "vwap_min_below": 3,
    "vwap_warmup_bars": 6,
    "vwap_vol_mult": 1.0,
    "flag_pole_bars": 6,
    "flag_pole_atr": 2.5,
    "flag_pole_min_pct": 1.5,
    "flag_min_bars": 3,
    "flag_max_bars": 10,
    "flag_max_retrace": 0.5,
    "momentum_lookback": 12,
    "momentum_vol_mult": 2.0,
    "momentum_vol_lookback": 24,
    "crypto_cutoff_hours": {"asia": 12, "utc_open": 11, "us_open": 4},
    "min_range_coverage": 0.6,
    "pick": "first",  # "last" = most recent occurrence (scanner, entry); "first" = backtest
}
RANGE_NAMES = {"open15": "opening range", "open30": "opening range", "asia": "Asia range",
               "utc_open": "UTC opening range", "us_open": "US-open range"}


class SetupError(ValueError):
    pass


def check(setup: str, asset: str) -> dict:
    spec = SETUPS.get(setup)
    if not spec:
        raise SetupError("unknown setup %r — choose from %s" % (setup, ", ".join(sorted(SETUPS))))
    if asset not in spec["assets"]:
        raise SetupError("%s is not defined for %s (works for: %s)" % (setup, asset, ", ".join(spec["assets"])))
    return spec


def for_asset(asset: str, kind: str = None) -> list:
    """Setups for an asset class; kind "window" = one-day rules, "series" = swing rules, None = all."""
    out = [k for k, v in SETUPS.items() if asset in v["assets"]]
    if kind == "series":
        return [k for k in out if SETUPS[k]["kind"] == "series"]
    if kind == "window":
        return [k for k in out if SETUPS[k]["kind"] != "series"]
    return out


def is_series(setup: str) -> bool:
    return (SETUPS.get(setup) or {}).get("kind") == "series"


def setup_id(symbol_key: str, window_key: str, setup: str) -> str:
    return "%s-%s-%s" % (symbol_key, window_key.replace("-", ""), setup)


def bar_label(interval: str) -> str:
    return {"1m": "1-min", "5m": "5-min", "15m": "15-min", "30m": "30-min", "1h": "1-hour"}.get(interval, interval)


def _clock(t, asset: str) -> str:
    return market_clock.fmt_et(t) if asset == "stock" else market_clock.from_ts(t).strftime("%H:%M")


def _tz(asset: str) -> str:
    return "ET" if asset == "stock" else "UTC"


# --- windows -------------------------------------------------------------------------

def windows(candles, asset: str, interval: str = "5m") -> list:
    groups = {}
    order = []
    for c in candles:
        d = market_clock.et_date(c.t) if asset == "stock" else market_clock.from_ts(c.t).date()
        if d not in groups:
            groups[d] = []
            order.append(d)
        groups[d].append(c)
    out = []
    prev_close = None
    prev_day = None
    for d in order:
        bars = groups[d]
        if asset == "stock":
            b = market_clock.session_bounds(d)
            if not b:
                continue
            start, end = int(b[0].timestamp()), int(b[1].timestamp())
            consecutive = prev_day is not None and market_clock.next_trading_day(prev_day) == d
        else:
            start = int(market_clock.utc_day_start(market_clock.from_ts(bars[0].t)).timestamp())
            end = start + 86400
            consecutive = prev_day is not None and (d - prev_day).days == 1
        out.append(Window(d.isoformat(), start, end, bars, prev_close if consecutive else None, asset, interval))
        prev_close = bars[-1].c
        prev_day = d
    return out


def window_at(candles, asset: str, interval: str, when_ts: int):
    """The window containing ``when_ts`` (or the last one)."""
    ws = windows(candles, asset, interval)
    for w in ws:
        if w.start <= when_ts < w.end:
            return w
    return ws[-1] if ws else None


# --- evaluation ------------------------------------------------------------------------

def _result(setup, window, status, rule, levels, trigger=None, rng=None, notes=None, bars_seen=0):
    spec = SETUPS[setup]
    return {"setup": setup, "label": spec["label"], "direction": "long", "status": status, "rule": rule,
            "levels": {k: (round(v, 10) if isinstance(v, float) else v) for k, v in levels.items()},
            "range": rng, "trigger": trigger, "stop_ref": levels.get("stop_ref"),
            "notes": notes or [], "window": window.key, "bars_seen": bars_seen}


def _trigger(bar, index, step):
    return {"index": index, "t": bar.t, "time": market_clock.iso(bar.t), "close_time": market_clock.iso(bar.t + step),
            "price": bar.c, "candle": {"o": bar.o, "h": bar.h, "l": bar.l, "c": bar.c, "v": bar.v}}


def evaluate(setup: str, window: Window, now_ts: int = None, params: dict = None, since_ts: int = None) -> dict:
    spec = check(setup, window.asset)
    if spec["kind"] == "series":
        raise SetupError("%s is a multi-day swing setup for 1h/4h bars — test it with trader-backtest/lab.py"
                         % setup)
    p = dict(DEFAULT_PARAMS)
    p.update(params or {})
    step = market_clock.interval_seconds(window.interval)
    bars = [c for c in window.candles if now_ts is None or c.t + step <= now_ts]
    kind = spec["kind"]
    if kind == "range":
        return _eval_range(setup, spec["range"], window, bars, step, p, now_ts)
    if kind == "gap":
        return _eval_gap(setup, window, bars, step, p, since_ts)
    if kind == "vwap":
        return _eval_vwap(setup, window, bars, step, p, since_ts)
    if kind == "flag":
        return _eval_flag(setup, window, bars, step, p, since_ts)
    return _eval_momentum(setup, window, bars, step, p, since_ts)


def range_bounds(range_name: str, window: Window):
    if range_name in ("open15", "open30"):
        minutes = 15 if range_name == "open15" else 30
        return window.start, window.start + minutes * 60
    d = market_clock.from_ts(window.start).date()
    rs, re_ = market_clock.crypto_ranges(d)[range_name]
    return int(rs.timestamp()), int(re_.timestamp())


def _range_cutoff(range_name: str, window: Window, range_end: int, p: dict) -> int:
    if window.asset == "stock":
        d = market_clock.et_date(window.start)
        hh, mm = p["orb_cutoff_et"]
        return min(int(market_clock.et_to_utc(d, hh, mm).timestamp()), window.end)
    hours = p["crypto_cutoff_hours"].get(range_name, 8)
    return min(range_end + int(hours * 3600), window.end)


def _eval_range(setup, range_name, window, bars, step, p, now_ts):
    rs, re_ = range_bounds(range_name, window)
    cutoff = _range_cutoff(range_name, window, re_, p)
    label = bar_label(window.interval)
    name = RANGE_NAMES[range_name]
    span = "%s–%s %s" % (_clock(rs, window.asset), _clock(re_, window.asset), _tz(window.asset))
    rng_bars = [c for c in bars if rs <= c.t < re_]
    rng = {"start": market_clock.iso(rs), "end": market_clock.iso(re_)}
    now = now_ts if now_ts is not None else (bars[-1].t + step if bars else rs)
    if not rng_bars:
        status = "forming" if now < re_ else "none"
        return _result(setup, window, status, "%s close above the %s high (%s)" % (label, name, span), {},
                       rng=rng, notes=["no bars in the range yet" if status == "forming" else "range has no data"],
                       bars_seen=len(bars))
    hi = max(c.h for c in rng_bars)
    lo = min(c.l for c in rng_bars)
    levels = {"range_high": hi, "range_low": lo, "trigger_level": hi, "stop_ref": lo}
    rule = "%s close above %s high %s (%s)" % (label, name, fmt.price(hi), span)
    if now < re_:
        return _result(setup, window, "forming", rule, levels, rng=rng,
                       notes=["range still forming until %s %s" % (_clock(re_, window.asset), _tz(window.asset))],
                       bars_seen=len(bars))
    expected = (re_ - rs) / float(step)
    if len(rng_bars) < expected * p["min_range_coverage"]:
        return _result(setup, window, "none", rule, levels, rng=rng,
                       notes=["range has gaps (%d of %d bars)" % (len(rng_bars), int(expected))], bars_seen=len(bars))
    after = [(i, c) for i, c in enumerate(bars) if c.t >= re_]
    for i, c in after:
        if c.t >= cutoff:
            return _result(setup, window, "expired", rule, levels, rng=rng,
                           notes=["no breakout before the %s %s cutoff" % (_clock(cutoff, window.asset),
                                                                         _tz(window.asset))], bars_seen=len(bars))
        if c.c > hi:
            return _result(setup, window, "triggered", rule, levels, _trigger(c, i, step), rng,
                           ["the %s candle closed above the %s" % (_clock(c.t, window.asset), name)], len(bars))
        if c.c < lo:
            return _result(setup, window, "invalidated", rule, levels, rng=rng,
                           notes=["the %s candle closed below the %s low first" % (_clock(c.t, window.asset), name)],
                           bars_seen=len(bars))
    status = "expired" if now >= cutoff else "watching"
    return _result(setup, window, status, rule, levels, rng=rng, bars_seen=len(bars),
                   notes=["waiting for a %s close above %s" % (label, fmt.price(hi))] if status == "watching" else
                   ["no breakout before the cutoff"])


def _eval_gap(setup, window, bars, step, p, since_ts):
    label = bar_label(window.interval)
    if not bars:
        return _result(setup, window, "forming", "%s close above the first bar's high after a gap up" % label, {})
    first = bars[0]
    if window.prev_close is None:
        return _result(setup, window, "none", "needs the previous session's close", {}, notes=["no previous close"],
                       bars_seen=len(bars))
    gap = (first.o / window.prev_close - 1) * 100
    levels = {"gap_pct": gap, "prev_close": window.prev_close, "open": first.o, "first_high": first.h,
              "first_low": first.l, "trigger_level": first.h, "stop_ref": first.l}
    rule = "Gap %s: %s close above the first %s high %s while above VWAP" % (
        fmt.pct(gap, 1, True), label, label, fmt.price(first.h))
    if gap < p["gap_min_pct"]:
        return _result(setup, window, "none", rule, levels, notes=["gap below %.1f%%" % p["gap_min_pct"]],
                       bars_seen=len(bars))
    hh, mm = p["gap_cutoff_et"]
    cutoff = int(market_clock.et_to_utc(market_clock.et_date(window.start), hh, mm).timestamp())
    vw = indicators.vwap(bars)
    for i in range(1, len(bars)):
        c = bars[i]
        if since_ts is not None and c.t < since_ts:
            continue
        if c.t >= cutoff:
            return _result(setup, window, "expired", rule, levels, notes=["no follow-through before 10:30 ET"],
                           bars_seen=len(bars))
        if c.c < window.prev_close or c.c < first.l:
            return _result(setup, window, "invalidated", rule, levels,
                           notes=["gap failed: closed below %s" % fmt.price(max(window.prev_close, first.l))],
                           bars_seen=len(bars))
        if c.c > first.h and c.c > vw[i]:
            return _result(setup, window, "triggered", rule, dict(levels, vwap=vw[i]), _trigger(c, i, step),
                           notes=["the %s candle closed above the first-bar high" % _clock(c.t, window.asset)],
                           bars_seen=len(bars))
    return _result(setup, window, "watching", rule, levels, bars_seen=len(bars))


def _eval_vwap(setup, window, bars, step, p, since_ts):
    label = bar_label(window.interval)
    if len(bars) < 2:
        return _result(setup, window, "forming", "%s close back above VWAP after %d+ closes below" % (
            label, p["vwap_min_below"]), {}, bars_seen=len(bars))
    vw = indicators.vwap(bars)
    below, run_low, vol_sum = 0, None, 0.0
    found = None
    for i, c in enumerate(bars):
        avg_vol = vol_sum / i if i else 0.0
        vol_sum += c.v
        if c.c < vw[i]:
            below += 1
            run_low = c.l if run_low is None else min(run_low, c.l)
            continue
        if (below >= p["vwap_min_below"] and i >= p["vwap_warmup_bars"]
                and c.v >= p["vwap_vol_mult"] * avg_vol and (since_ts is None or c.t >= since_ts)):
            levels = {"vwap": vw[i], "trigger_level": vw[i], "stop_ref": run_low, "bars_below": below}
            found = _result(setup, window, "triggered",
                            "%s close back above VWAP (%s) after %d closes below" % (label, fmt.price(vw[i]), below),
                            levels, _trigger(c, i, step),
                            notes=["the %s candle reclaimed VWAP on above-average volume" % _clock(c.t, window.asset)],
                            bars_seen=len(bars))
            if p.get("pick") != "last":
                return found
        below, run_low = 0, None
    if found and below < p["vwap_min_below"]:
        return found
    last = len(bars) - 1
    levels = {"vwap": vw[last], "trigger_level": vw[last]}
    if below >= p["vwap_min_below"]:
        levels["stop_ref"] = run_low
        return _result(setup, window, "watching", "%s close back above VWAP (now %s)" % (label, fmt.price(vw[last])),
                       levels, notes=["%d closes below VWAP so far" % below], bars_seen=len(bars))
    return _result(setup, window, "none", "%s close back above VWAP after %d+ closes below" % (
        label, p["vwap_min_below"]), levels, notes=["price has not lost VWAP"], bars_seen=len(bars))


def _eval_flag(setup, window, bars, step, p, since_ts):
    label = bar_label(window.interval)
    atrs = indicators.atr(bars) if bars else []
    pole = None
    flag = []
    last_note = []
    found = None
    for j, c in enumerate(bars):
        if pole is not None:
            flag_high = max(b.h for b in flag) if flag else pole["high"]
            if len(flag) >= p["flag_min_bars"] and c.c > flag_high and (since_ts is None or c.t >= since_ts):
                flag_low = min(b.l for b in flag)
                levels = {"pole_low": pole["low"], "pole_high": pole["high"], "flag_high": flag_high,
                          "flag_low": flag_low, "trigger_level": flag_high, "stop_ref": flag_low}
                rule = "%s close above the flag high %s (pole %s in %d bars)" % (
                    label, fmt.price(flag_high), fmt.pct((pole["high"] / pole["low"] - 1) * 100, 1, True),
                    pole["bars"])
                found = _result(setup, window, "triggered", rule, levels, _trigger(c, j, step),
                                notes=["the %s candle broke out of the flag" % _clock(c.t, window.asset)],
                                bars_seen=len(bars))
                if p.get("pick") != "last":
                    return found
                pole, flag = None, []
                continue
            floor = pole["high"] - p["flag_max_retrace"] * (pole["high"] - pole["low"])
            if c.l < floor or len(flag) >= p["flag_max_bars"]:
                last_note = ["last flag failed (%s)" % ("retraced more than half the pole" if c.l < floor
                                                         else "consolidated too long")]
                pole, flag = None, []
            elif c.h > pole["high"] and len(flag) < p["flag_min_bars"]:
                pole.update(high=c.h, end=j, bars=j - pole["start"] + 1)
                flag = []
                continue
            else:
                flag.append(c)
                continue
        lo_from = max(0, j - p["flag_pole_bars"])
        if j - lo_from < 2:
            continue
        seg = bars[lo_from:j]
        lo_i = lo_from + min(range(len(seg)), key=lambda k: seg[k].l)
        low = bars[lo_i].l
        rise = c.h - low
        need = max(p["flag_pole_atr"] * atrs[j], p["flag_pole_min_pct"] / 100.0 * low)
        if j - lo_i >= 2 and rise >= need and c.c >= low + 0.6 * rise:
            pole = {"start": lo_i, "end": j, "low": low, "high": c.h, "bars": j - lo_i + 1}
            flag = []
    if found and (pole is None or len(flag) < p["flag_min_bars"]):
        return found
    if pole is not None:
        flag_high = max(b.h for b in flag) if flag else pole["high"]
        levels = {"pole_low": pole["low"], "pole_high": pole["high"], "flag_high": flag_high,
                  "trigger_level": flag_high}
        if flag:
            levels.update(flag_low=min(b.l for b in flag), stop_ref=min(b.l for b in flag))
        status = "watching" if len(flag) >= p["flag_min_bars"] else "forming"
        return _result(setup, window, status, "%s close above the flag high %s" % (label, fmt.price(flag_high)),
                       levels, notes=["%d flag bars so far" % len(flag)], bars_seen=len(bars))
    return _result(setup, window, "none", "%s close above a bull-flag high" % label, {},
                   notes=last_note or ["no pole yet"], bars_seen=len(bars))


def _eval_momentum(setup, window, bars, step, p, since_ts):
    n, vol_n, mult = p["momentum_lookback"], p["momentum_vol_lookback"], p["momentum_vol_mult"]
    label = bar_label(window.interval)
    found = None
    for i in range(n, len(bars)):
        c = bars[i]
        if since_ts is not None and c.t < since_ts:
            continue
        prior = bars[i - n:i]
        hi = max(b.h for b in prior)
        med = indicators.median([b.v for b in bars[max(0, i - vol_n):i]])
        if c.c > hi and med and c.v >= mult * med:
            stop = min(b.l for b in bars[max(0, i - 6):i + 1])
            levels = {"trigger_level": hi, "stop_ref": stop, "volume_mult": c.v / med}
            rule = "%s close above the %d-bar high %s on %.1f× volume" % (label, n, fmt.price(hi), c.v / med)
            found = _result(setup, window, "triggered", rule, levels, _trigger(c, i, step),
                            notes=["the %s candle broke the %d-bar high on %.1f× median volume"
                                   % (_clock(c.t, window.asset), n, c.v / med)], bars_seen=len(bars))
            if p.get("pick") != "last":
                return found
    if found:
        return found
    if len(bars) <= n:
        return _result(setup, window, "forming", "%s close above the %d-bar high on %.0f×+ volume" % (label, n, mult),
                       {}, notes=["needs %d bars of context" % n], bars_seen=len(bars))
    hi = max(b.h for b in bars[-n:])
    levels = {"trigger_level": hi, "stop_ref": min(b.l for b in bars[-6:])}
    return _result(setup, window, "watching", "%s close above the %d-bar high %s on %.0f×+ volume" % (
        label, n, fmt.price(hi), mult), levels, bars_seen=len(bars))


# --- swing setups across a whole series ------------------------------------------------------------

def regime_map(candles, n: int = 200) -> dict:
    """{bar open time: close above its n-bar simple average} — Bitcoin's trend, the switch for every coin."""
    cl = [c.c for c in candles]
    avg = indicators.sma(cl, n)
    return {c.t: (i >= n - 1 and cl[i] > avg[i]) for i, c in enumerate(candles)}


def exit_rule(setup: str):
    return (SETUPS.get(setup) or {}).get("exit_rule")


def rule_says_exit(rule: dict, closes: list, j: int) -> bool:
    """Does the close at index j meet the exit rule? closes = all closes up to and including j."""
    n = int(rule.get("n") or 5)
    if j < n:
        return False
    if rule.get("type") == "close_above_sma":
        return closes[j] > sum(closes[j - n + 1:j + 1]) / float(n)
    if rule.get("type") == "close_below_low":
        return closes[j] < min(closes[j - n:j])
    return False


def _series_context(candles) -> dict:
    cl = [c.c for c in candles]
    return {"close": cl, "ema20": indicators.ema(cl, 20), "ema50": indicators.ema(cl, 50),
            "ema200": indicators.ema(cl, 200), "rsi14": indicators.rsi(cl, 14), "rsi2": indicators.rsi(cl, 2),
            "sma5": indicators.sma(cl, 5), "sma50": indicators.sma(cl, 50), "sma200": indicators.sma(cl, 200),
            "bb_low": indicators.bollinger_lower(cl, 20, 2.0)}


def _series_hit(setup: str, candles, i: int, x: dict, context: dict = None):
    """(rule text, levels) when ``setup`` fires on the close of bar i, else None."""
    c, cl = candles[i], x["close"]
    if setup == "dip_in_uptrend":
        btc_up = (context or {}).get("btc_up")
        if not btc_up or not btc_up.get(c.t):
            return None  # Bitcoin below its 200-day average: the whole market is in a downtrend — stand aside
        if not (cl[i] > x["sma200"][i] and cl[i] > x["sma50"][i] and cl[i] < cl[i - 1] < cl[i - 2] < cl[i - 3]
                and x["rsi2"][i] < 10):
            return None
        return ("3 lower closes in a row, RSI(2) %.1f, above the 50- and 200-day averages, Bitcoin above its "
                "200-day average" % x["rsi2"][i], {"trigger_level": cl[i], "stop_ref": None, "sma5": x["sma5"][i],
                                                   "sma50": x["sma50"][i], "sma200": x["sma200"][i]})
    if setup == "trend_breakout":
        btc_up = (context or {}).get("btc_up")
        if not btc_up or not btc_up.get(c.t):
            return None
        hi = max(cl[i - 20:i])
        if cl[i] <= hi:
            return None
        return ("daily close above the 20-day high %s, Bitcoin above its 200-day average" % fmt.price(hi),
                {"trigger_level": hi, "stop_ref": None, "low10": min(cl[i - 10:i])})
    if cl[i] <= x["ema200"][i]:
        return None  # every swing rule here is long-only and wants the long-term trend up
    low10 = min(b.l for b in candles[i - 9:i + 1])
    if setup == "trend_pullback":
        if (x["ema50"][i] > x["ema200"][i] and min(x["rsi14"][i - 6:i]) < 40
                and cl[i - 1] < x["ema20"][i - 1] and cl[i] > x["ema20"][i]):
            return ("close back above the 20 EMA %s after an RSI(14) dip below 40, 50 EMA above the 200 EMA"
                    % fmt.price(x["ema20"][i]), {"trigger_level": x["ema20"][i], "stop_ref": low10,
                                                 "ema200": x["ema200"][i]})
    elif setup == "oversold_bounce":
        if x["rsi2"][i] < 10:
            return ("RSI(2) %.1f — oversold inside an uptrend (close above the 200 EMA %s)" % (
                x["rsi2"][i], fmt.price(x["ema200"][i])), {"trigger_level": cl[i], "stop_ref": low10,
                                                            "ema200": x["ema200"][i]})
    elif setup == "band_bounce":
        if cl[i - 1] < x["bb_low"][i - 1] and cl[i] > x["bb_low"][i]:
            return ("close back inside the lower Bollinger band %s above the 200 EMA" % fmt.price(x["bb_low"][i]),
                    {"trigger_level": x["bb_low"][i], "stop_ref": low10, "ema200": x["ema200"][i]})
    elif setup == "breakout_24":
        prior = candles[i - 24:i]
        hi = max(b.h for b in prior)
        med = indicators.median([b.v for b in prior])
        if cl[i] > hi and med and c.v >= 2 * med:
            return ("close above the 24-bar high %s on %.1f× volume" % (fmt.price(hi), c.v / med),
                    {"trigger_level": hi, "stop_ref": min(b.l for b in candles[i - 5:i + 1]),
                     "ema200": x["ema200"][i]})
    return None


def series_signals(setup: str, candles, interval: str = "1h", start_ts: int = None, context: dict = None) -> list:
    """Every bar where a swing setup fired (closed bars only), with a cool-down between signals.

    context: {"btc_up": regime_map(btc_daily_candles)} for setups that need Bitcoin's trend (needs_btc).

    Returns trigger dicts shaped like ``evaluate`` results: setup, label, rule, levels, stop_ref, trigger, window.
    """
    spec = SETUPS.get(setup) or {}
    if spec.get("kind") != "series":
        raise SetupError("%s is not a swing setup" % setup)
    step = market_clock.interval_seconds(interval)
    if len(candles) <= SERIES_WARMUP:
        return []
    x = _series_context(candles)
    out, last = [], None
    cooldown = int(spec.get("cooldown") or SERIES_COOLDOWN)
    for i in range(SERIES_WARMUP, len(candles)):
        if last is not None and i - last < cooldown:
            continue
        hit = _series_hit(setup, candles, i, x, context)
        if not hit:
            continue
        last = i
        if start_ts is not None and candles[i].t < start_ts:
            continue
        rule, levels = hit
        key = market_clock.from_ts(candles[i].t).strftime("%Y-%m-%dT%H%M")
        out.append({"setup": setup, "label": spec["label"], "direction": "long", "status": "triggered",
                    "rule": "%s %s" % (bar_label(interval), rule),
                    "levels": {k: (round(v, 10) if isinstance(v, float) else v) for k, v in levels.items()},
                    "range": None, "stop_ref": levels.get("stop_ref"), "trigger": _trigger(candles[i], i, step),
                    "notes": ["the %s %s candle closed on the signal" % (_clock(candles[i].t, "crypto"),
                                                                           bar_label(interval))],
                    "window": key, "bars_seen": i + 1, "interval": interval})
    return out
