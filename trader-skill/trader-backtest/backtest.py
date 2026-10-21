#!/usr/bin/env python3
"""Backtester — replays one setup rule over the last N sessions (stocks) or days (crypto, meme coins).

Same rule code as the scanner and the entry timer, same stop/target logic as the exit
planner, conservative fills (stop first when a bar touches both), fees and slippage included.

Examples:
  python3 backtest.py TSLA --setup orb15 --sessions 60
  python3 backtest.py BTCUSDT --setup asia_range --days 30 --horizon 4h
  python3 backtest.py SOL:<mint> --setup momentum --size-usd 500
  python3 backtest.py --offline TSLA --setup orb15      # demo on fixture data
"""
from __future__ import annotations

import os
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, html, market_clock, setups, skills, state, trade_sim  # noqa: E402

ATR_LOOKBACK_BARS = 300  # Wilder ATR has converged long before this; keeps each trade O(1)


def build_parser():
    p = cli.parser("backtest.py", __doc__)
    p.add_argument("symbol", help="TSLA, BTCUSDT, BTC-USD, SOL:<mint> ...")
    p.add_argument("--setup", help="rule to test, e.g. orb15, gap_and_go, asia_range, momentum (default per asset)")
    p.add_argument("--sessions", type=int, help="stocks: trading sessions of history (default 60)")
    p.add_argument("--days", type=float, help="crypto/meme: calendar days of history (default 30)")
    p.add_argument("--target-r", type=float, help="target as an R multiple (default 2; meme 3)")
    p.add_argument("--stop", default="auto", help="auto | range | level | atr (default auto, same as the exit planner)")
    p.add_argument("--atr-mult", type=float, default=1.5, help="ATR multiple for --stop atr (default 1.5)")
    p.add_argument("--horizon", help="crypto/meme time stop after entry: 1h | 4h | 24h (default from config)")
    p.add_argument("--trail", default="none", help="none | breakeven:1 | atr:2 | pct:5")
    p.add_argument("--fee-bps", type=float, help="fee per side in basis points (default from config costs)")
    p.add_argument("--slippage-bps", type=float, help="slippage per side in basis points (default from config costs)")
    p.add_argument("--size-usd", type=float, help="meme: trade size used for the price-impact estimate")
    p.add_argument("--include-current", action="store_true", help="also test today's / the current window")
    p.add_argument("--interval", help="candle interval (default from config, 5m)")
    return p


def _max_drawdown(rs) -> float:
    peak = cum = 0.0
    worst = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        worst = min(worst, cum - peak)
    return worst


def run_backtest(sym, setup, series, asset, interval, now_ts, exit_mod, target_r, stop="auto", atr_mult=1.5,
                 horizon_s=None, trailing=None, cost_pct=0.0, tick=None, include_current=False) -> dict:
    step = market_clock.interval_seconds(interval)
    candles = series.candles
    index_of = {c.t: i for i, c in enumerate(candles)}
    today = market_clock.et_date(now_ts - 1) if asset == "stock" else market_clock.from_ts(now_ts - 1).date()
    ws = []
    for w in setups.windows(candles, asset, interval):
        current = w.key == today.isoformat() or w.end > now_ts
        if current and not include_current:
            continue
        ws.append(w)
    trades, skipped = [], []
    for w in ws:
        r = setups.evaluate(setup, w, None, {"pick": "first"})
        if r["status"] != "triggered" or not r.get("trigger"):
            continue
        trig = r["trigger"]
        gi = index_of[trig["t"]]
        entry = trig["price"]
        entry_ts = trig["t"] + step
        hist = candles[max(0, gi - ATR_LOOKBACK_BARS):gi + 1]
        try:
            lv = exit_mod.plan_levels(entry, entry_ts, asset, hist, stop_ref=r.get("stop_ref"),
                                      trigger_level=(r.get("levels") or {}).get("trigger_level"), stop=stop,
                                      atr_mult=atr_mult, target_r=target_r, tick=tick, horizon_s=horizon_s)
        except ValueError as exc:
            skipped.append({"window": w.key, "reason": str(exc)})
            continue
        end_ts = market_clock.ts(lv["time_stop"]["at"])
        if asset == "stock":
            bars = [c for c in w.candles if c.t > trig["t"]]
        else:
            bars = [c for c in candles[gi + 1:gi + 2 + (end_ts - entry_ts) // step] if c.t < end_ts]
        walk = trade_sim.walk(bars, entry, lv["stop"]["price"], lv["target"]["price"], end_ts, step,
                              trailing=trailing, atr_value=lv["atr"])
        risk = lv["risk_per_unit"]
        outcome = walk["outcome"]
        trades.append({
            "window": w.key, "entry_time": market_clock.iso(entry_ts), "entry": entry,
            "stop": lv["stop"]["price"], "target": lv["target"]["price"], "stop_method": lv["stop"]["method"],
            "exit_time": market_clock.iso(walk["exit_t"]) if walk["exit_t"] else None,
            "exit": round(walk["exit_price"], 10), "outcome": outcome,
            "r_gross": round(walk["r_multiple"], 4),
            "r_net": round(trade_sim.net_r(entry, walk["exit_price"], risk, cost_pct), 4),
        })
    n = len(trades)
    hit_t = sum(1 for t in trades if t["outcome"] == "target")
    hit_s = sum(1 for t in trades if t["outcome"] == "stop")
    neither = n - hit_t - hit_s
    rs = [t["r_net"] for t in trades]
    return {
        "windows": len(ws), "triggers": n, "target": hit_t, "stop": hit_s, "neither": neither,
        "p_target": round(hit_t / float(n), 4) if n else 0.0,
        "p_stop": round(hit_s / float(n), 4) if n else 0.0,
        "p_neither": round(neither / float(n), 4) if n else 0.0,
        "win_rate": round(sum(1 for r in rs if r > 0) / float(n), 4) if n else 0.0,
        "avg_r": round(sum(rs) / n, 4) if n else 0.0,
        "expectancy_r": round(sum(rs) / n, 4) if n else 0.0,
        "total_r": round(sum(rs), 4),
        "max_drawdown_r": round(_max_drawdown(rs), 4),
        "trades": trades, "skipped": skipped,
    }


def summary_line(res: dict, asset: str) -> str:
    unit = "session" if asset == "stock" else "day"
    w = res["windows"]
    return "Last %d %s%s: %d trigger%s, %d hit target, %d hit stop, %d neither." % (
        w, unit, "" if w == 1 else "s", res["triggers"], "" if res["triggers"] == 1 else "s",
        res["target"], res["stop"], res["neither"])


def _report(doc, sym, asset):
    title = "Backtest · %s · %s" % (sym.display, setups.SETUPS[doc["setup"]]["label"])
    body = html.tiles([
        ("Windows", fmt.count(doc["windows"]), ""), ("Triggers", fmt.count(doc["triggers"]), "info"),
        ("Hit target", "%d · %s" % (doc["target"], fmt.prob(doc["p_target"])), "good"),
        ("Hit stop", "%d · %s" % (doc["stop"], fmt.prob(doc["p_stop"])), "bad"),
        ("Neither", "%d · %s" % (doc["neither"], fmt.prob(doc["p_neither"])), ""),
        ("Win rate (net)", fmt.prob(doc["win_rate"]), ""),
        ("Avg R (net)", fmt.r(doc["avg_r"]), "good" if doc["avg_r"] > 0 else "bad"),
        ("Total R", fmt.r(doc["total_r"]), "good" if doc["total_r"] > 0 else "bad"),
        ("Max drawdown", fmt.r(doc["max_drawdown_r"]), "warn")])
    body += html.card("Summary", "<p class='summary'>%s</p>%s" % (html.esc(doc["summary"]), "".join(
        "<p class='muted'>%s</p>" % html.esc(w) for w in doc["warnings"])))
    cum, acc = [], 0.0
    for t in doc["trades"]:
        acc += t["r_net"]
        cum.append(acc)
    if cum:
        body += html.card("Cumulative net R per trade", html.line_chart(
            [0.0] + cum, x_labels=["start"] + [t["window"] for t in doc["trades"]], title="cumulative R"))
    p = doc["params"]
    body += html.card("Assumptions", html.table(["Parameter", "Value"], [
        ("Target", "%gR" % p["target_r"]), ("Stop", p["stop"]),
        ("Time stop", p.get("time_stop") or p.get("horizon") or "—"),
        ("Trailing", p.get("trail") or "none"),
        ("Costs per side", "%g bps fee + %g bps slippage%s" % (p["fee_bps"], p["slippage_bps"],
                                                            (" + %.2f%% est. price impact" % p["impact_pct"])
                                                            if p.get("impact_pct") else "")),
        ("Fills", "trigger-candle close; stop first if one bar touches both; gaps through the stop fill at the open")]))
    rows = [(t["window"], t["entry_time"], fmt.price(t["entry"]), fmt.price(t["stop"]), fmt.price(t["target"]),
             t["exit_time"] or "—", fmt.price(t["exit"]), t["outcome"], fmt.r(t["r_gross"]), fmt.r(t["r_net"]))
            for t in doc["trades"]]
    body += html.card("Trades", html.table(["Window", "Entry time", "Entry", "Stop", "Target", "Exit time", "Exit",
                                            "Outcome", "R gross", "R net"], rows)
                      if rows else "<p class='muted'>no triggers in this sample</p>")
    sub = "%s · %s bars · %s → %s" % (doc["source"], doc["params"]["interval"], doc["history"]["first"],
                                      doc["history"]["last"])
    return html.write_report("backtest-%s-%s.html" % (sym.key, doc["setup"]), html.page(title, body, sub, asset))


def run(args, ctx) -> dict:
    """Run the backtest described by parsed ``args`` and write backtests/{key}-{setup}.json.

    Importable so the autopilot can backtest in-process; ``main`` only adds the text output.
    """
    sym = data.as_symbol(args.symbol, args.asset)
    asset = sym.asset
    setup = args.setup or setups.DEFAULT_SETUP[asset]
    setups.check(setup, asset)
    exit_mod = skills.load("trader-exit", "exit")
    interval = args.interval or ctx.cfg.get("scanner", {}).get("interval") or "5m"
    if asset == "stock":
        span = args.sessions or 60
    else:
        span = args.days or 30
    series = data.get_candles(sym, interval, days=span)
    sym = series.symbol
    now_ts = int(ctx.now.timestamp())

    costs = (ctx.cfg.get("costs") or {}).get(asset) or {}
    fee = args.fee_bps if args.fee_bps is not None else float(costs.get("fee_bps") or 0)
    slip = args.slippage_bps if args.slippage_bps is not None else float(costs.get("slippage_bps") or 0)
    cost = trade_sim.cost_pct(fee, slip)
    warnings = list(series.warnings)
    impact = None
    if asset == "meme":
        size = args.size_usd or ctx.cfg["account_size"] * ctx.limits["meme"]["max_position_pct"] / 100.0
        liq = (series.meta.get("pair") or {}).get("liquidity_usd")
        impact = trade_sim.estimate_slippage_pct(size, liq)
        if impact:
            cost += impact
            warnings.append("meme price impact estimated at %.2f%% per side for %s against today's %s liquidity "
                            "(an estimate — past liquidity was different)" % (impact, fmt.money(size, decimals=0),
                                                                              fmt.compact_usd(liq)))
    horizon_s = None
    if asset != "stock":
        horizon_s = market_clock.parse_horizon(args.horizon or ctx.cfg.get("%s_horizon" % asset) or "4h")
    tick = 0.01 if asset == "stock" else (data.lot_info(sym).get("tick") if asset == "crypto" else None)
    target_r = args.target_r if args.target_r is not None else exit_mod.DEFAULT_TARGET_R[asset]
    trailing = exit_mod.parse_trail(args.trail)

    res = run_backtest(sym, setup, series, asset, interval, now_ts, exit_mod, target_r, args.stop, args.atr_mult,
                       horizon_s, trailing, cost, tick, args.include_current)
    if res["triggers"] < 10:
        warnings.append("thin sample: only %d trigger%s — treat these rates as anecdotes, not statistics"
                        % (res["triggers"], "" if res["triggers"] == 1 else "s"))
    if asset == "meme" and (series.meta.get("history_days") or 0) < 7:
        warnings.append("meme coin has only %.1f days of history" % (series.meta.get("history_days") or 0))
    summary = summary_line(res, asset)
    doc = {
        "symbol": sym.display if asset != "stock" else sym.base, "symbol_key": sym.key, "asset": asset,
        "setup": setup, "generated_at": market_clock.iso(ctx.now),
        "params": {("sessions" if asset == "stock" else "days"): span, "interval": interval, "target_r": target_r,
                   "stop": args.stop, "fee_bps": fee, "slippage_bps": slip,
                   "impact_pct": round(impact, 4) if impact else None,
                   "time_stop": "15:55 ET" if asset == "stock" else None,
                   "horizon": None if asset == "stock" else ("%dh" % (horizon_s // 3600) if horizon_s % 3600 == 0
                                                             else "%dm" % (horizon_s // 60)),
                   "trail": args.trail if trailing else None, "include_current": bool(args.include_current)},
        "source": series.source,
        "history": {"bars": len(series.candles), "first": market_clock.iso(series.candles[0].t),
                    "last": market_clock.iso(series.candles[-1].t)},
    }
    doc.update({k: v for k, v in res.items() if k != "skipped"})
    doc["skipped"] = res["skipped"]
    doc["summary"] = summary
    doc["warnings"] = warnings
    doc["report"] = None
    report = None
    if not args.no_html:
        report = _report(doc, sym, asset)
        doc["report"] = state.rel(report)
    out = state.write_json("backtests/%s-%s.json" % (sym.key, setup), doc)
    return {"doc": doc, "sym": sym, "asset": asset, "setup": setup, "res": res, "warnings": warnings, "fee": fee,
            "slip": slip, "impact": impact, "target_r": target_r, "report": report, "out": out}


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    r = run(args, ctx)
    doc, sym, asset, setup, res = r["doc"], r["sym"], r["asset"], r["setup"], r["res"]
    warnings, fee, slip, impact, target_r = r["warnings"], r["fee"], r["slip"], r["impact"], r["target_r"]
    report, out, summary = r["report"], r["out"], doc["summary"]

    lines = ["%s · %s — backtest" % (sym.display, setups.SETUPS[setup]["label"]), summary]
    if res["triggers"]:
        lines.append("Win rate %s · avg %s net per trade · total %s · max drawdown %s" % (
            fmt.prob(res["win_rate"]), fmt.r(res["avg_r"]), fmt.r(res["total_r"]), fmt.r(res["max_drawdown_r"])))
    lines.append("Target %gR, stop %s, %s; costs %g bps fee + %g bps slippage per side%s." % (
        target_r, args.stop, doc["params"]["time_stop"] and "flat by 3:55 p.m. ET" or
        ("%s horizon" % doc["params"]["horizon"]), fee, slip, (" + %.2f%% price impact" % impact) if impact else ""))
    for w in warnings:
        lines.append("note: " + w)
    lines.append("Saved %s" % state.rel(out))
    if report:
        lines.append(cli.report_line(report))
    cli.emit(args, "\n".join(lines), {"backtest": doc, "file": state.rel(out)}, asset)
    cli.maybe_open(args, report)
    return 0


if __name__ == "__main__":
    cli.run(main)
