#!/usr/bin/env python3
"""Entry Timer — watches one setup candle by candle and says exactly when to get in.

Examples:
  python3 entry.py --id TSLA-20261020-orb15          # a setup from trader/setups.json
  python3 entry.py TSLA --setup orb15
  python3 entry.py BTC-USD --setup asia_range
  python3 entry.py SOL:<mint> --setup momentum --size-usd 500
  python3 entry.py TSLA --follow --every 60 --max-minutes 90
  python3 entry.py --offline TSLA --now 2026-10-20T14:15:00Z   # demo on fixture data
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

from shared import cli, data, fmt, html, market_clock, setups, state, trade_sim  # noqa: E402

HISTORY_DAYS = {"stock": 3, "crypto": 2, "meme": 3}
REPEATING = ("momentum", "vwap", "flag")  # setups that can fire many times a day
FINAL = ("triggered", "invalidated", "expired", "blocked")


def build_parser():
    p = cli.parser("entry.py", __doc__)
    p.add_argument("symbol", nargs="?", help="symbol to watch (TSLA, BTC-USD, SOL:<mint>) — or use --id")
    p.add_argument("--id", help="setup id from trader/setups.json (or a previously watched entry)")
    p.add_argument("--setup", help="rule to watch, e.g. orb15, asia_range, momentum (default per asset)")
    p.add_argument("--size-usd", type=float, help="meme: trade size for the slippage check "
                                                  "(default account × meme max position %%)")
    p.add_argument("--interval", help="candle interval (default from config, 5m)")
    p.add_argument("--follow", action="store_true", help="keep checking until triggered / invalidated / expired")
    p.add_argument("--every", type=int, default=60, help="seconds between checks with --follow (default 60)")
    p.add_argument("--max-minutes", type=int, default=120, help="give up following after N minutes (default 120)")
    return p


def _clock(t, asset: str) -> str:
    return (market_clock.fmt_et(t) + " ET") if asset == "stock" else market_clock.from_ts(t).strftime("%H:%M UTC")


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _resolve(args, ctx):
    """→ (symbol string, asset, setup name, given id or None, scanner hit or None)."""
    if args.id:
        hits = (state.read_json("setups.json", {}) or {}).get("setups") or []
        for h in hits:
            if h.get("id") == args.id:
                setup = args.setup or h.get("entry_setup") or h.get("setup")
                if setup not in setups.SETUPS:
                    setup = setups.DEFAULT_SETUP.get(h.get("asset"), "momentum")
                return h["symbol"], h.get("asset"), setup, args.id, h
        rec = ((state.read_json("entries.json", {}) or {}).get("entries") or {}).get(args.id)
        if rec:
            return rec["symbol"], rec.get("asset"), args.setup or rec["setup"], args.id, None
        raise ValueError("no setup %r in trader/setups.json or trader/entries.json — run trader-scanner first, "
                         "or pass a symbol and --setup" % args.id)
    if not args.symbol:
        raise ValueError("pass a symbol (e.g. TSLA) or --id SETUP_ID")
    return args.symbol, args.asset, args.setup, None, None


def _canonical(sym) -> str:
    if sym.asset == "meme":
        return "%s:%s" % (sym.chain, sym.address)
    if sym.asset == "crypto":
        return sym.display
    return sym.base


def _rugcheck_file(sym):
    p = state.home() / "rugcheck" / ("%s-%s.json" % (sym.chain, sym.address))
    if not p.exists():
        return None
    try:
        import json
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def check_once(args, ctx, symbol, asset, setup, given_id, hit) -> dict:
    interval = args.interval or ctx.cfg.get("scanner", {}).get("interval") or "5m"
    step = market_clock.interval_seconds(interval)
    sym = data.as_symbol(symbol, asset)
    asset = sym.asset
    setup = setup or setups.DEFAULT_SETUP[asset]
    spec = setups.check(setup, asset)
    series = data.get_candles(sym, interval, days=HISTORY_DAYS[asset])
    sym = series.symbol
    now = ctx.now
    now_ts = int(now.timestamp())
    window = setups.window_at(series.candles, asset, interval, now_ts - 1)
    if window is None:
        raise data.DataUnavailable("no candles for %s" % sym.display)
    waiting_open = False
    market = None
    if asset == "stock":
        market = market_clock.market_status(now)
        today = market_clock.et_date(now)
        if (market_clock.from_ts(window.start).date() != today and market["trading_day"]
                and market["opens_at"] and now_ts < market_clock.ts(market["opens_at"])):
            waiting_open = True
    entry_id = given_id or setups.setup_id(sym.key, window.key, setup)

    doc = state.read_json("entries.json", {}) or {}
    entries = doc.setdefault("entries", {})
    old = entries.get(entry_id) or {}
    watch_started = old.get("watch_started") or market_clock.iso(now)
    params, since = {}, None
    if spec["kind"] in REPEATING:
        params["pick"] = "last"
        since = market_clock.ts(watch_started) - step

    notes, warnings = [], list(series.warnings)
    if waiting_open:
        r = {"setup": setup, "label": spec["label"], "status": "forming", "levels": {}, "range": None,
             "trigger": None, "stop_ref": None, "notes": ["waiting for the 9:30 ET open"],
             "rule": "%s — evaluated once the session opens" % spec["label"]}
        bars = []
    else:
        r = setups.evaluate(setup, window, now_ts, params, since)
        bars = [c for c in window.candles if c.t + step <= now_ts]
    status = r["status"]
    if status == "none":
        status = "watching"
    notes.extend(r.get("notes") or [])

    liquidity_check = None
    if asset == "meme":
        lim = ctx.limits["meme"]
        pair = series.meta.get("pair") or {}
        liq = pair.get("liquidity_usd")
        size = args.size_usd if args.size_usd else ctx.cfg["account_size"] * lim["max_position_pct"] / 100.0
        est = trade_sim.estimate_slippage_pct(size, liq)
        ok = bool(liq) and liq >= lim["min_liquidity_usd"] and est is not None and est <= lim["max_slippage_pct"]
        liquidity_check = {"liquidity_usd": liq, "size_usd": round(size, 2),
                           "est_slippage_pct": round(est, 4) if est is not None else None,
                           "max_slippage_pct": lim["max_slippage_pct"], "min_liquidity_usd": lim["min_liquidity_usd"],
                           "ok": ok}
        if status == "triggered" and not ok:
            status = "blocked"
            if not liq or liq < lim["min_liquidity_usd"]:
                notes.insert(0, "pool liquidity %s is below the %s minimum" % (
                    fmt.compact_usd(liq), fmt.compact_usd(lim["min_liquidity_usd"])))
            else:
                notes.insert(0, "estimated slippage %.2f%% for %s exceeds the %.1f%% limit" % (
                    est, fmt.money(size, decimals=0), lim["max_slippage_pct"]))
        rc = _rugcheck_file(sym)
        if rc is None:
            warnings.append("no rugcheck on file for this token — run trader-rugcheck before anything else")
        elif rc.get("verdict") == "DANGER":
            warnings.append("rugcheck verdict DANGER (%s) — the risk manager will block this trade"
                            % "; ".join(rc.get("reasons") or [])[:160])

    trig = r.get("trigger")
    entry_price = trig["price"] if trig and status in ("triggered", "blocked") else None
    history = list(old.get("history") or [])
    if not history or history[-1].get("status") != status:
        history.append({"at": market_clock.iso(now), "status": status})
    rec = {
        "id": entry_id, "symbol": _canonical(sym), "symbol_display": sym.display, "symbol_key": sym.key,
        "asset": asset, "setup": setup, "label": spec["label"], "direction": "long",
        "status": status, "previous_status": old.get("status"),
        "rule": r.get("rule", ""), "levels": r.get("levels") or {}, "range": r.get("range"),
        "trigger": ({"time": trig["time"], "close_time": trig["close_time"], "price": trig["price"],
                     "candle": trig["candle"]} if trig and status in ("triggered", "blocked") else None),
        "entry_price": entry_price, "checked_at": market_clock.iso(now), "watch_started": watch_started,
        "liquidity_check": liquidity_check, "history": history[-50:], "interval": interval,
        "source": series.source, "notes": notes, "warnings": warnings,
        "market": market["state"] if market else None, "chart": old.get("chart"),
    }
    if hit:
        rec["scanner"] = {"setup": hit.get("setup"), "score": hit.get("score"), "flags": hit.get("flags")}

    report = None
    if not args.no_html:
        report = _report(rec, bars, step, series)
        rec["chart"] = state.rel(report)
    entries[entry_id] = rec
    doc["latest"] = entry_id
    state.write_json("entries.json", doc)
    return {"record": rec, "report": report, "bars": bars, "series": series, "market": market}


def _report(rec, bars, step, series):
    asset = rec["asset"]
    lv = rec["levels"] or {}
    lines, shades, markers = [], [], []
    if lv.get("trigger_level") is not None:
        lines.append({"price": lv["trigger_level"], "label": "Trigger", "color": "blue", "dash": True})
    if lv.get("stop_ref") is not None:
        lines.append({"price": lv["stop_ref"], "label": "Stop ref", "color": "red", "dash": True})
    if rec.get("range"):
        shades.append({"t0": market_clock.ts(rec["range"]["start"]), "t1": market_clock.ts(rec["range"]["end"]),
                       "label": "range", "color": "blue"})
    if rec.get("trigger"):
        markers.append({"t": market_clock.ts(rec["trigger"]["time"]), "price": rec["trigger"]["price"],
                        "label": "Entry", "color": "green" if rec["status"] == "triggered" else "amber",
                        "shape": "up"})
    title = "Entry · %s · %s" % (rec["symbol_display"], rec["label"])
    tone = {"triggered": "good", "invalidated": "bad", "expired": "bad", "blocked": "bad"}.get(rec["status"], "info")
    tiles = [("Status", rec["status"].upper(), tone),
             ("Trigger level", fmt.price(lv.get("trigger_level")) if lv.get("trigger_level") else "—", ""),
             ("Get in", fmt.price(rec["entry_price"]) if rec["entry_price"] else "—", "good" if rec["entry_price"] else ""),
             ("Stop ref", fmt.price(lv.get("stop_ref")) if lv.get("stop_ref") else "—", "")]
    if rec.get("liquidity_check"):
        lc = rec["liquidity_check"]
        tiles.append(("Liquidity", fmt.compact_usd(lc["liquidity_usd"]), "good" if lc["ok"] else "bad"))
        tiles.append(("Est. slippage", "%.2f%%" % lc["est_slippage_pct"] if lc["est_slippage_pct"] is not None else "n/a",
                      "good" if lc["ok"] else "bad"))
    body = html.tiles(tiles)
    body += html.card("Rule", "<p>%s</p>%s" % (html.esc(rec["rule"]), "".join(
        "<p class='muted'>%s</p>" % html.esc(n) for n in rec["notes"] + rec["warnings"])))
    body += html.card("Chart", html.candle_chart(bars, lines, markers, shades, asset=asset, title=title)
                      if bars else "<p class='muted'>no closed candles in this window yet</p>")
    hist = [(h["at"], h["status"]) for h in rec["history"]]
    body += html.card("Status history", html.table(["Checked", "Status"], hist))
    return html.write_report("entry-%s.html" % rec["id"], html.page(
        title, body, "checked %s · %s · %s bars" % (rec["checked_at"], series.source, rec["interval"]), asset))


def describe(rec, implied_watching: bool = True) -> str:
    asset = rec["asset"]
    lv = rec["levels"] or {}
    label = setups.bar_label(rec["interval"])
    spec = setups.SETUPS[rec["setup"]]
    lines = ["%s · %s" % (rec["symbol_display"], rec["label"])]
    if spec["kind"] == "range" and lv.get("range_high") is not None and rec.get("range"):
        name = setups.RANGE_NAMES[spec["range"]]
        rs, re_ = market_clock.ts(rec["range"]["start"]), market_clock.ts(rec["range"]["end"])
        if asset == "stock":
            span = "%s–%s ET" % (market_clock.fmt_et(rs), market_clock.fmt_et(re_))
        else:
            span = "%s–%s UTC" % (market_clock.from_ts(rs).strftime("%H:%M"), market_clock.from_ts(re_).strftime("%H:%M"))
        lines.append("%s high %s (%s). Rule: %s close above." % (_cap(name), fmt.price(lv["range_high"]), span, label))
        what = "the %s" % name
    else:
        lvl = lv.get("trigger_level")
        lines.append(("Trigger level %s. Rule: %s." % (fmt.price(lvl), rec["rule"])) if lvl else
                     ("Rule: %s." % rec["rule"]))
        what = "the trigger level"
    prev = rec.get("previous_status")
    status = rec["status"]
    if prev and prev != status:
        head = "%s → %s" % (_cap(prev), status.upper())
    elif not prev and status in ("triggered", "blocked") and implied_watching:
        head = "Watching → %s" % status.upper()
    else:
        head = status.upper()
    note = (rec.get("notes") or [""])[0]
    trig = rec.get("trigger")
    if status == "triggered" and trig:
        t = market_clock.ts(trig["time"])
        fresh = market_clock.ts(trig["close_time"]) >= market_clock.ts(rec["checked_at"]) - 60 * 5
        when = "just closed" if fresh else "closed"
        tail = "the %s candle %s above %s. Get in %s." % (_clock(t, asset).replace(" ET", ""), when, what,
                                                          fmt.price(trig["price"]))
        if asset != "stock":
            tail = "the %s candle %s above %s. Get in %s." % (_clock(t, asset), when, what, fmt.price(trig["price"]))
        if not fresh:
            tail += " (trigger was %d min ago — price may have moved)" % (
                (market_clock.ts(rec["checked_at"]) - market_clock.ts(trig["close_time"])) // 60)
        lines.append("Status: %s — %s" % (head, tail))
        if asset != "stock" and spec["kind"] == "range" and lv.get("range_high") is not None:
            lines.append("%s %s high %s — %s close above at %s" % (
                rec["symbol_display"].split("/")[0], setups.RANGE_NAMES[spec["range"]], fmt.price(lv["range_high"]),
                label, _clock(t, asset)))
    elif status == "blocked" and trig:
        lines.append("Status: %s — trigger seen at %s but %s. Do not enter." % (head, fmt.price(trig["price"]), note))
    else:
        lines.append("Status: %s — %s" % (head, note or rec["rule"]))
    lc = rec.get("liquidity_check")
    if lc:
        lines.append("Liquidity %s · est. slippage %s for %s (limit %.1f%%, min %s) — %s" % (
            fmt.compact_usd(lc["liquidity_usd"]),
            ("%.2f%%" % lc["est_slippage_pct"]) if lc["est_slippage_pct"] is not None else "n/a",
            fmt.money(lc["size_usd"], decimals=0), lc["max_slippage_pct"], fmt.compact_usd(lc["min_liquidity_usd"]),
            "ok" if lc["ok"] else "NOT ok"))
    for w in rec.get("warnings") or []:
        lines.append("note: " + w)
    return "\n".join(lines)


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    symbol, asset, setup, given_id, hit = _resolve(args, ctx)
    res = check_once(args, ctx, symbol, asset, setup, given_id, hit)
    extra = []
    if args.follow:
        if data.pinned_clock():
            extra.append("--follow ignored: the clock is pinned/offline, so this was a single check")
        else:
            deadline = time.time() + args.max_minutes * 60
            last = res["record"]["status"]
            while res["record"]["status"] not in FINAL and time.time() < deadline:
                if not args.json:
                    print("%s  %s — next check in %ds" % (market_clock.iso(ctx.now), last.upper(), args.every))
                    sys.stdout.flush()
                time.sleep(max(5, args.every))
                res = check_once(args, ctx, res["record"]["symbol"], res["record"]["asset"], res["record"]["setup"],
                                 res["record"]["id"], hit)
                last = res["record"]["status"]
            if res["record"]["status"] not in FINAL:
                extra.append("stopped following after %d minutes — still %s" % (args.max_minutes, last))
    rec = res["record"]
    text = describe(rec)
    market = res.get("market")
    if market and market["state"] != "open":
        text += "\nMarket %s%s." % (market["state"], (" — next open %s" % market["next_open"]) if market.get("next_open")
                                    else "")
    for e in extra:
        text += "\n" + e
    if res["report"]:
        text += "\n" + cli.report_line(res["report"])
    cli.emit(args, text, {"entry": rec, "report": state.rel(res["report"]) if res["report"] else None},
             rec["asset"])
    cli.maybe_open(args, res["report"])
    return 0


if __name__ == "__main__":
    cli.run(main)
