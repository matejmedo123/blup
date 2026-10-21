#!/usr/bin/env python3
"""Exit Planner — stop, target, time stop (and for meme coins scale-outs + a liquidity exit) for a triggered entry.

Examples:
  python3 exit.py                                   # plan the latest triggered entry in trader/entries.json
  python3 exit.py --id TSLA-20261020-orb15 --target-r 2
  python3 exit.py BTC-USD --entry 67448.60 --entry-time 2026-10-20T14:40:00Z --stop-ref 66612.40 --trigger-level 67420
  python3 exit.py --offline --id TSLA-20261020-orb15  # demo on fixture data
"""
from __future__ import annotations

import math
import os
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, html, indicators, market_clock, setups, state  # noqa: E402

UNIT = {"stock": "share", "crypto": "coin", "meme": "token"}
STOP_KINDS = ("auto", "range", "level", "atr")
DEFAULT_TARGET_R = {"stock": 2.0, "crypto": 2.0, "meme": 3.0}
HISTORY_DAYS = {"stock": 3, "crypto": 2, "meme": 3}


# --- price rounding -------------------------------------------------------------------

def _decimals(tick: float) -> int:
    return max(0, int(-math.floor(math.log10(tick) + 1e-9)))


def round_price(x: float, asset: str, tick: float = None, mode: str = "nearest") -> float:
    """Stops round down (never tighter than intended), targets to the nearest tick.

    Meme coins have no tick — keep 6 significant digits instead.
    """
    if x is None or x <= 0:
        return x
    if asset == "meme":
        digits = 5 - int(math.floor(math.log10(abs(x))))
        factor = 10.0 ** digits
        v = (math.floor(x * factor + 1e-9) if mode == "down" else math.floor(x * factor + 0.5 + 1e-9)) / factor
        return float("%.6g" % v)
    tick = tick or 0.01
    n = x / tick
    if mode == "down":
        n = math.floor(n + 1e-9)
    elif mode == "up":
        n = math.ceil(n - 1e-9)
    else:
        n = math.floor(n + 0.5 + 1e-9)  # half-up: 98.565 → 98.57 despite binary floats
    return round(n * tick, _decimals(tick))


# --- the reusable level logic (backtest imports this) ------------------------------------

def _horizon_label(seconds: int) -> str:
    if seconds % 3600 == 0:
        return "%dh" % (seconds // 3600)
    return "%dm" % (seconds // 60)


def _time_stop(entry_time_ts: int, asset: str, horizon_s: int = None, swing: bool = False) -> tuple:
    """(time_stop dict, horizon dict). Stocks: flat by 3:55 p.m. ET (unless held for days: swing);
    crypto/meme: entry + horizon."""
    if asset == "stock" and not swing:
        d = market_clock.et_date(entry_time_ts - 1)
        flat = market_clock.flat_by(d)
        close = market_clock.session_close_time(d)
        if flat is not None:
            at = max(int(flat.timestamp()), entry_time_ts)
            label = "rest of the session (%s ET close)" % market_clock.fmt_et_ampm(close)
            return ({"at": market_clock.iso(at), "rule": "flat by %s ET" % market_clock.fmt_et_ampm(flat)},
                    {"end": market_clock.iso(close), "label": label})
        horizon_s = horizon_s or 4 * 3600  # not a session day (ad hoc input): fall back to a fixed horizon
    horizon_s = int(horizon_s or 4 * 3600)
    end = entry_time_ts + horizon_s
    hl = _horizon_label(horizon_s)
    return ({"at": market_clock.iso(end), "rule": "exit by %s (%s horizon)" % (market_clock.fmt_utc(end), hl)},
            {"end": market_clock.iso(end), "label": "next %s" % hl})


def plan_levels(entry, entry_time_ts, asset, candles_until_entry, stop_ref=None, trigger_level=None, stop="auto",
                atr_mult=1.5, target_r=2.0, tick=None, horizon_s=None, swing: bool = False) -> dict:
    """Stop, target and time stop for a long entry.

    auto: the structural stop (range/flag low) when it is within 4×ATR — far stops make the
    position tiny and the R-target unreachable — else just below the breakout level (1×ATR),
    else entry − atr_mult×ATR.
    """
    entry = float(entry)
    atr = indicators.last_atr(list(candles_until_entry), 14) if candles_until_entry else 0.0
    method, note, price = None, "", None
    kind = str(stop if stop is not None else "auto").strip().lower()
    if kind not in STOP_KINDS:
        try:
            price, method, note = float(kind), "price", "manual stop"
        except ValueError:
            raise ValueError("--stop must be auto, range, level, atr or a price (got %r)" % stop)
    if kind in ("auto", "range") and stop_ref is not None and 0 < entry - stop_ref:
        if kind == "range" or (atr > 0 and entry - stop_ref <= 4 * atr):
            price, method, note = stop_ref, "range_low", "below the structure low (range/flag/swing low)"
    if price is None and kind in ("auto", "level") and trigger_level is not None and atr > 0:
        lvl = trigger_level - atr
        if lvl < entry:
            price, method = lvl, "below_level"
            note = "just below the breakout level (1×ATR)"
            if stop_ref is not None and kind == "auto":
                note += " — the structure low %s is more than 4×ATR away" % fmt.price(stop_ref)
    if price is None:
        if atr <= 0:
            if stop_ref is not None and stop_ref < entry:
                price, method, note = stop_ref, "range_low", "below the structure low (no ATR history)"
            else:
                raise ValueError("not enough candles to size an ATR stop — pass --stop PRICE")
        else:
            price, method, note = entry - atr_mult * atr, "atr", "%.1f×ATR below entry" % atr_mult
    stop_px = round_price(price, asset, tick, "down")
    if stop_px is None or stop_px >= entry:
        raise ValueError("stop %s must be below entry %s for a long trade" % (fmt.price(stop_px), fmt.price(entry)))
    risk = entry - stop_px
    target_px = round_price(entry + float(target_r) * risk, asset, tick, "nearest")
    time_stop, horizon = _time_stop(int(entry_time_ts), asset, horizon_s, swing)
    return {
        "stop": {"price": stop_px, "method": method, "note": note},
        "target": {"price": target_px, "r_multiple": float(target_r)},
        "risk_per_unit": round(risk, 10),
        "atr": round(atr, 10),
        "time_stop": time_stop,
        "horizon": horizon,
    }


# --- parsing helpers ------------------------------------------------------------------------

def parse_trail(text):
    if not text or str(text).lower() == "none":
        return None
    kind, _, value = str(text).partition(":")
    kind = kind.strip().lower()
    names = {"breakeven": "breakeven_at_r", "be": "breakeven_at_r", "atr": "atr", "pct": "pct"}
    if kind not in names:
        raise ValueError("--trail must be none, breakeven:R, atr:K or pct:P (got %r)" % text)
    try:
        v = float(value) if value else (1.0 if names[kind] == "breakeven_at_r" else 2.0)
    except ValueError:
        raise ValueError("--trail value must be a number (got %r)" % text)
    return {"type": names[kind], "value": v}


def parse_scale(text, entry: float, asset: str) -> list:
    out = []
    if not text or str(text).lower() == "none":
        return out
    total = 0.0
    for part in str(text).split(","):
        frac, _, mult = part.strip().partition("@")
        try:
            frac, mult = float(frac), float(mult.rstrip("xX"))
        except ValueError:
            raise ValueError("--scale must look like 0.5@2,0.25@4 (got %r)" % text)
        if not (0 < frac <= 1) or mult <= 1:
            raise ValueError("--scale fractions must be in (0, 1] and multiples above 1 (got %r)" % part)
        total += frac
        note = "sell %d%% at %g×" % (round(frac * 100), mult)
        if abs(frac * mult - 1.0) < 1e-9:
            note += " — recovers the initial stake"
        out.append({"fraction": frac, "at_multiple": mult, "price": round_price(entry * mult, asset, None, "nearest"),
                    "note": note})
    if total > 1.0 + 1e-9:
        raise ValueError("--scale fractions add up to more than 100%")
    return sorted(out, key=lambda s: s["at_multiple"])


def structure_note(setup: str) -> str:
    """'below the opening range low' etc. — what the structural stop actually sits under."""
    spec = setups.SETUPS.get(setup, {})
    where = {"range": "the %s low" % setups.RANGE_NAMES.get(spec.get("range"), "range"),
             "flag": "the flag low", "vwap": "the low of the dip under VWAP",
             "gap": "the first bar's low", "momentum": "the recent swing low"}.get(spec.get("kind"), "the structure low")
    return "below %s" % where


def _stop_reason(plan_stop: dict, setup: str, risk: float, atr: float, asset: str) -> str:
    unit = UNIT[asset]
    why = plan_stop["note"]
    ratio = (" = %.1f× ATR" % (risk / atr)) if atr else ""
    return "Stop: %s (%s risk per %s%s)." % (why, fmt.price(risk), unit, ratio)


# --- main -------------------------------------------------------------------------------------

def build_parser():
    p = cli.parser("exit.py", __doc__)
    p.add_argument("symbol", nargs="?", help="ad-hoc plan for this symbol (needs --entry and --entry-time)")
    p.add_argument("--id", help="entry id from trader/entries.json (default: latest triggered entry)")
    p.add_argument("--entry", type=float, help="ad hoc: entry price")
    p.add_argument("--entry-time", help="ad hoc: entry fill time (ISO, default now)")
    p.add_argument("--stop-ref", type=float, help="ad hoc: structural stop reference (range/flag low)")
    p.add_argument("--trigger-level", type=float, help="ad hoc: the breakout level")
    p.add_argument("--setup", default="manual", help="ad hoc: setup name for the plan id (default manual)")
    p.add_argument("--stop", default="auto", help="auto | range | level | atr | a price (default auto)")
    p.add_argument("--atr-mult", type=float, default=1.5, help="ATR multiple for --stop atr (default 1.5)")
    p.add_argument("--target-r", type=float, help="target as an R multiple (default 2; meme 3)")
    p.add_argument("--horizon", help="crypto/meme time stop: 1h | 4h | 24h (default from config)")
    p.add_argument("--trail", default="none", help="none | breakeven:1 | atr:2 | pct:5 (default none)")
    p.add_argument("--scale", help="meme scale-outs, e.g. 0.5@2,0.25@4 (default 0.5@2)")
    p.add_argument("--liq-drop", type=float, default=30.0, help="meme: exit if pool liquidity drops this %% (default 30)")
    p.add_argument("--interval", help="candle interval (default from config, 5m)")
    return p


def _load_entry(entry_id):
    entries = (state.read_json("entries.json", {}) or {}).get("entries") or {}
    if entry_id:
        rec = entries.get(entry_id)
        if not rec:
            raise ValueError("no entry %r in trader/entries.json — run trader-entry first or pass a symbol + --entry"
                             % entry_id)
        return rec
    latest = (state.read_json("entries.json", {}) or {}).get("latest")
    if latest and (entries.get(latest) or {}).get("status") == "triggered":
        return entries[latest]
    triggered = [e for e in entries.values() if e.get("status") == "triggered"]
    if not triggered:
        raise ValueError("no triggered entry in trader/entries.json — run trader-entry, or pass SYMBOL --entry PRICE")
    return max(triggered, key=lambda e: e.get("checked_at") or "")


def _canonical(sym) -> str:
    if sym.asset == "meme":
        return "%s:%s" % (sym.chain, sym.address)
    if sym.asset == "crypto":
        return sym.display
    return sym.base


def _chart(plan, candles, step, asset, title):
    entry_ts = market_clock.ts(plan["entry"]["time"])
    w = setups.window_at(candles, asset, plan.get("interval", "5m"), entry_ts - 1) if candles else None
    bars = list(w.candles) if w else []
    if asset != "stock" and candles:  # include the bars after entry up to the horizon if we already have them
        end = market_clock.ts(plan["horizon"]["end"])
        start = (w.start if w else entry_ts - 86400)
        bars = [c for c in candles if start <= c.t < end]
    lines = [{"price": plan["target"]["price"], "label": "Target", "color": "green"},
             {"price": plan["entry"]["price"], "label": "Entry", "color": "blue"},
             {"price": plan["stop"]["price"], "label": "Stop", "color": "red"}]
    for s in plan.get("scale_out") or []:
        if s["price"] <= plan["target"]["price"] * 1.15:
            lines.append({"price": s["price"], "label": "Sell %d%%" % round(s["fraction"] * 100), "color": "amber",
                          "dash": True})
    markers = []
    trig_t = entry_ts - step
    if any(c.t == trig_t for c in bars):
        markers.append({"t": trig_t, "price": plan["entry"]["price"], "label": "Entry", "color": "blue",
                        "shape": "up"})
    return html.candle_chart(bars, lines, markers, (), asset=asset, title=title)


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    interval = args.interval or ctx.cfg.get("scanner", {}).get("interval") or "5m"
    step = market_clock.interval_seconds(interval)

    if args.symbol:
        if args.entry is None:
            raise ValueError("ad hoc plans need --entry PRICE (and usually --entry-time)")
        sym = data.as_symbol(args.symbol, args.asset)
        entry_time = market_clock.parse_iso(args.entry_time) if args.entry_time else ctx.now
        entry_ts = int(entry_time.timestamp())
        rec = {"symbol": None, "asset": sym.asset, "setup": args.setup, "direction": "long",
               "entry_price": args.entry, "levels": {"stop_ref": args.stop_ref, "trigger_level": args.trigger_level},
               "trigger": {"close_time": market_clock.iso(entry_ts)},
               "label": setups.SETUPS.get(args.setup, {}).get("label", "Manual entry")}
    else:
        rec = _load_entry(args.id)
        sym = data.as_symbol(rec["symbol"], rec.get("asset"))
        entry_ts = market_clock.ts(rec["trigger"]["close_time"])
    asset = sym.asset
    series = data.get_candles(sym, interval, days=HISTORY_DAYS[asset])
    sym = series.symbol
    if args.symbol:
        window_key = (market_clock.et_date(entry_ts - 1) if asset == "stock"
                      else market_clock.from_ts(entry_ts - 1).date()).isoformat()
        plan_id = setups.setup_id(sym.key, window_key, args.setup)
    else:
        plan_id = rec["id"]
    until_entry = [c for c in series.candles if c.t + step <= entry_ts]

    tick = None
    if asset == "stock":
        tick = 0.01
    elif asset == "crypto":
        tick = data.lot_info(sym).get("tick") or None
    horizon_s = None
    if asset != "stock":
        horizon_s = market_clock.parse_horizon(args.horizon or ctx.cfg.get("%s_horizon" % asset) or "4h")
    target_r = args.target_r if args.target_r is not None else DEFAULT_TARGET_R[asset]
    levels = rec.get("levels") or {}
    lv = plan_levels(rec["entry_price"], entry_ts, asset, until_entry, stop_ref=levels.get("stop_ref"),
                     trigger_level=levels.get("trigger_level"), stop=args.stop, atr_mult=args.atr_mult,
                     target_r=target_r, tick=tick, horizon_s=horizon_s)

    entry_px = float(rec["entry_price"])
    if lv["stop"]["method"] == "range_low":
        lv["stop"]["note"] = structure_note(rec.get("setup") or args.setup)
    scale_out, liquidity_exit = [], None
    if asset == "meme":
        scale_out = parse_scale(args.scale if args.scale is not None else "0.5@2", entry_px, asset)
        pair = series.meta.get("pair") or {}
        liq = pair.get("liquidity_usd")
        if liq:
            liquidity_exit = {"drop_pct": args.liq_drop, "liquidity_at_entry_usd": liq,
                              "exit_below_usd": round(liq * (1 - args.liq_drop / 100.0), 2)}
    elif args.scale:
        scale_out = parse_scale(args.scale, entry_px, asset)

    plan = {
        "id": plan_id, "symbol": _canonical(sym), "symbol_display": sym.display, "symbol_key": sym.key,
        "asset": asset, "setup": rec.get("setup") or args.setup, "label": rec.get("label", ""), "direction": "long",
        "entry": {"price": entry_px, "time": market_clock.iso(entry_ts)},
        "stop": lv["stop"], "target": lv["target"], "risk_per_unit": lv["risk_per_unit"],
        "time_stop": lv["time_stop"], "horizon": lv["horizon"],
        "trailing": parse_trail(args.trail), "scale_out": scale_out, "liquidity_exit": liquidity_exit,
        "atr": lv["atr"], "interval": interval, "source": series.source,
        "created_at": market_clock.iso(ctx.now), "chart": None,
    }

    report = None
    if not args.no_html:
        title = "Exit plan · %s · %s" % (sym.display, plan["label"] or plan["setup"])
        body = html.tiles([
            ("Get in", fmt.price(entry_px), "info"), ("Stop", fmt.price(plan["stop"]["price"]), "bad"),
            ("Target", "%s (%gR)" % (fmt.price(plan["target"]["price"]), target_r), "good"),
            ("Risk / %s" % UNIT[asset], fmt.price(plan["risk_per_unit"]), ""),
            ("Time stop", plan["time_stop"]["rule"], "warn")])
        body += html.card("Chart", _chart(plan, series.candles, step, asset, title))
        rows = [("Entry", fmt.price(entry_px), market_clock.iso(entry_ts)),
                ("Stop", fmt.price(plan["stop"]["price"]), plan["stop"]["note"]),
                ("Target", fmt.price(plan["target"]["price"]), "%gR" % target_r),
                ("Time stop", plan["time_stop"]["at"], plan["time_stop"]["rule"]),
                ("Horizon", plan["horizon"]["end"], plan["horizon"]["label"]),
                ("Trailing", "—" if not plan["trailing"] else "%s %g" % (plan["trailing"]["type"],
                                                                        plan["trailing"]["value"]), "")]
        for s in scale_out:
            rows.append(("Scale-out", fmt.price(s["price"]), s["note"]))
        if liquidity_exit:
            rows.append(("Liquidity exit", fmt.compact_usd(liquidity_exit["exit_below_usd"]),
                         "exit if pool liquidity drops %g%% from %s" % (liquidity_exit["drop_pct"],
                                                                        fmt.compact_usd(liquidity_exit["liquidity_at_entry_usd"]))))
        body += html.card("Plan", html.table(["Level", "Value", "Why"], rows))
        report = html.write_report("plan-%s.html" % plan_id, html.page(
            title, body, "%s · %s bars · ATR %s" % (series.source, interval, fmt.price(plan["atr"])), asset))
        plan["chart"] = state.rel(report)

    def save(doc):
        doc.setdefault("plans", {})[plan_id] = plan
        doc["latest"] = plan_id
    state.update_json("plan.json", save, {})  # the autopilot writes plans too — neither may lose the other's

    lines = ["%s · %s — exit plan" % (sym.display, plan["label"] or plan["setup"]),
             "Get in %s · Stop %s · Target %s (%gR) · Time stop %s" % (
                 fmt.price(entry_px), fmt.price(plan["stop"]["price"]), fmt.price(plan["target"]["price"]), target_r,
                 plan["time_stop"]["rule"].replace("flat by ", "").replace("exit by ", "")),
             _stop_reason(plan["stop"], plan["setup"], plan["risk_per_unit"], plan["atr"], asset),
             "Horizon: %s. Trailing: %s." % (plan["horizon"]["label"],
                                             "none" if not plan["trailing"] else "%s %g" % (
                                                 plan["trailing"]["type"], plan["trailing"]["value"]))]
    for s in scale_out:
        extra = " (beyond the target — only if you let a runner go)" if s["price"] > plan["target"]["price"] else ""
        lines.append("Scale-out: %s (%s)%s." % (s["note"], fmt.price(s["price"]), extra))
    if liquidity_exit:
        lines.append("Liquidity exit: get out if pool liquidity drops %g%% (below %s)."
                     % (liquidity_exit["drop_pct"], fmt.compact_usd(liquidity_exit["exit_below_usd"])))
    if asset == "meme":
        lines.append("DEX swaps have no stop orders — set price alerts (trader-alerts) and exit manually.")
    for w in series.warnings:
        lines.append("note: " + w)
    if report:
        lines.append(cli.report_line(report))
    cli.emit(args, "\n".join(lines), {"plan": plan, "report": state.rel(report) if report else None}, asset)
    cli.maybe_open(args, report)
    return 0


if __name__ == "__main__":
    cli.run(main)
