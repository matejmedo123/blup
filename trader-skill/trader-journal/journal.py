#!/usr/bin/env python3
"""Trade Journal — log every trade, then measure what actually works.

Logs asset class, setup, entry, exit, R result, fees and slippage for each
trade (paper or real) and computes win rate, average R, expectancy, profit
factor and best/worst setups — overall and per asset class. ``--auto`` plays
a plan forward on the candles since the entry (stop / target / time stop), so
paper trades get an honest outcome without anyone typing one in.

Examples:
  python3 journal.py add --plan TSLA-20261020-orb15 --auto
  python3 journal.py add --plan TSLA-20261020-orb15 --exit-price 371.20 --reason manual
  python3 journal.py close trd-TSLA-20261020-orb15 --exit-price 358.10 --reason stop
  python3 journal.py list --open
  python3 journal.py stats --asset crypto
"""
from __future__ import annotations

import os
import re
import sys
from datetime import timedelta

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, html, market_clock, skills, state, symbols, trade_sim  # noqa: E402

REASONS = ("target", "stop", "time", "manual", "liquidity", "rug")


def build_parser():
    p = cli.parser("journal.py", __doc__)
    p.add_argument("action", nargs="?", default="stats", choices=("add", "close", "list", "stats"),
                   help="add a trade, close an open one, list trades or show statistics (default)")
    p.add_argument("trade_id", nargs="?", help="trade id for close (trd-...)")
    p.add_argument("--plan", help="plan id from trader/plan.json (default: the latest plan)")
    p.add_argument("--order", help="order id from trader/orders.json (default: the order sized from the plan)")
    p.add_argument("--auto", action="store_true",
                   help="resolve the outcome from the candles since the entry (paper-trade tracking)")
    p.add_argument("--exit-price", type=float, help="exit (average) fill price")
    p.add_argument("--exit-time", help="exit time, ISO (default: now)")
    p.add_argument("--reason", choices=REASONS, default="manual", help="why the trade ended (default: manual)")
    p.add_argument("--qty", type=float, help="quantity (shares / coins; USD amount for meme coins)")
    p.add_argument("--fees", type=float, help="fees in USD (default: from config costs)")
    p.add_argument("--slippage", type=float, help="slippage in USD (default: estimated for --auto, else 0)")
    p.add_argument("--notes", default="", help="free-text notes")
    p.add_argument("--open-only", "--open-trades", dest="open_only", action="store_true",
                   help="list: only open trades")
    return p


# --- state helpers -------------------------------------------------------------------------------------

def _doc() -> dict:
    return state.read_json("journal.json", {}) or {"trades": []}


def _save(doc: dict) -> None:
    state.write_json("journal.json", doc)


def symbol_of(obj: dict) -> symbols.Symbol:
    if obj.get("asset") == "meme" and obj.get("chain") and obj.get("address"):
        return symbols.meme_symbol(obj["chain"], obj["address"], obj.get("name", ""))
    return data.as_symbol(obj["symbol"], obj.get("asset"))


def load_plan(plan_id: str = None) -> dict:
    doc = state.read_json("plan.json", {}) or {}
    plans = doc.get("plans") or {}
    pid = plan_id or doc.get("latest")
    if not pid or pid not in plans:
        raise ValueError("plan %r not found in trader/plan.json — run /trader-exit first" % pid)
    return plans[pid]


def find_order(plan: dict, order_id: str = None):
    orders = (state.read_json("orders.json", {}) or {}).get("orders") or []
    if order_id:
        for o in orders:
            if o.get("id") == order_id:
                return o
        raise ValueError("order %r not found in trader/orders.json" % order_id)
    mine = [o for o in orders if o.get("plan_id") == plan.get("id")]
    approved = [o for o in mine if o.get("status") == "approved"]
    return (approved or mine or [None])[-1]


def default_qty(plan: dict, cfg: dict, limits: dict) -> tuple:
    """No order on file: size it the way /trader-sizer would."""
    try:
        sizer = skills.load("trader-sizer", "size")
        o = sizer.size_order(plan, cfg, limits)
        return o["qty"], o["qty_unit"], "sized like /trader-sizer (no order on file)"
    except (ImportError, ValueError, data.DataUnavailable) as exc:
        raise ValueError("no order for this plan and could not size one (%s) — pass --qty" % exc)


# --- the trade record ----------------------------------------------------------------------------------

def _costs(cfg: dict, asset: str) -> tuple:
    c = (cfg.get("costs") or {}).get(asset) or {}
    return float(c.get("fee_bps") or 0), float(c.get("slippage_bps") or 0)


def finalize(trade: dict, cfg: dict, exit_price: float, exit_time: str, reason: str, fees=None,
             slippage=None, estimate_slippage: bool = False) -> dict:
    entry = trade["entry"]["price"]
    qty = float(trade["qty"])
    meme = trade["asset"] == "meme"
    entry_notional = qty if meme else qty * entry
    exit_notional = qty * exit_price / entry if meme else qty * exit_price
    fee_bps, slip_bps = _costs(cfg, trade["asset"])
    if fees is None:
        fees = (entry_notional + exit_notional) * fee_bps / 10000.0
    if slippage is None:
        slippage = (entry_notional + exit_notional) * slip_bps / 10000.0 if estimate_slippage else 0.0
    gross = (qty * (exit_price / entry - 1.0)) if meme else qty * (exit_price - entry)
    pnl = gross - fees - slippage
    rpu = trade["risk_per_unit"]
    risk_usd = qty * rpu / entry if meme else qty * rpu
    trade.update(status="closed",
                 exit={"time": exit_time, "price": exit_price, "reason": reason},
                 fees_usd=round(fees, 2), slippage_usd=round(slippage, 2), pnl_usd=round(pnl, 2),
                 r_multiple=round((exit_price - entry) / rpu, 3) if rpu else None,
                 r_net=round(pnl / risk_usd, 3) if risk_usd else None)
    trade.pop("mark", None)
    return trade


def new_trade(plan: dict, order, qty, qty_unit, qty_source, notes: str) -> dict:
    sym = symbol_of(plan)
    entry = float(plan["entry"]["price"])
    stop = float(plan["stop"]["price"])
    return {
        "id": "trd-" + plan["id"], "plan_id": plan["id"], "order_id": (order or {}).get("id"),
        "symbol": plan.get("symbol") or sym.raw, "symbol_key": sym.key,
        "display": plan.get("symbol_display") or sym.display,
        "asset": plan.get("asset") or sym.asset, "setup": plan.get("setup") or "manual",
        "direction": plan.get("direction") or "long", "status": "open",
        "qty": qty, "qty_unit": qty_unit, "qty_source": qty_source,
        "entry": {"time": plan["entry"]["time"], "price": entry},
        "exit": None, "stop": stop, "target": (plan.get("target") or {}).get("price"),
        "risk_per_unit": round(entry - stop, 10),
        "fees_usd": 0.0, "slippage_usd": 0.0, "pnl_usd": None, "r_multiple": None,
        "paper": bool((order or {}).get("paper", True)), "notes": notes, "chart": None,
        "logged_at": market_clock.iso(market_clock.now_utc()),
        "chain": sym.chain or None, "address": sym.address or None,
    }


def _candles_since(plan: dict, extra_before: int = 40):
    """Candles from a little before the entry up to now (closed bars only)."""
    sym = symbol_of(plan)
    interval = plan.get("interval") or "5m"
    now = market_clock.now_utc()
    entry_dt = market_clock.parse_iso(plan["entry"]["time"])
    if sym.asset == "stock":
        d, n = market_clock.et_date(now), 1
        while d > market_clock.et_date(entry_dt) and n < 60:
            d -= timedelta(days=1)
            if market_clock.is_trading_day(d):
                n += 1
        days = n + 1
    else:
        days = max(1.0, (now - entry_dt).total_seconds() / 86400.0 + 1.0)
    return data.get_candles(sym, interval, days=days)


def auto_outcome(plan: dict) -> dict:
    series = _candles_since(plan)
    entry_ts = market_clock.ts(plan["entry"]["time"])
    bars = [c for c in series.candles if c.t >= entry_ts]
    end_at = (plan.get("time_stop") or {}).get("at") or (plan.get("horizon") or {}).get("end")
    end_ts = market_clock.ts(end_at) if end_at else None
    scale = [{"fraction": float(s["fraction"]), "price": float(s["price"])} for s in plan.get("scale_out") or []
             if s.get("price")]
    res = trade_sim.walk(bars, float(plan["entry"]["price"]), float(plan["stop"]["price"]),
                         float(plan["target"]["price"]), end_ts, series.step, plan.get("trailing"), scale,
                         plan.get("atr"))
    res["series"] = series
    res["bars_available"] = len(bars)
    return res


# --- charts ---------------------------------------------------------------------------------------------

def _safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.\-]", "_", text)


def trade_chart(trade: dict, series=None):
    """reports/trade-{id}.html — the trade on its candles. Returns the path or None without data."""
    plan_like = {"symbol": trade["symbol"], "asset": trade["asset"], "entry": trade["entry"],
                 "interval": "5m", "chain": trade.get("chain"), "address": trade.get("address")}
    try:
        series = series or _candles_since(plan_like)
    except data.DataUnavailable:
        return None
    step = series.step
    entry_ts = market_clock.ts(trade["entry"]["time"])
    exit_ts = market_clock.ts(trade["exit"]["time"]) if trade.get("exit") else series.candles[-1].t + step
    lo, hi = entry_ts - 36 * step, exit_ts + 12 * step
    candles = [c for c in series.candles if lo <= c.t <= hi]
    if not candles:
        return None

    def bar_at(t):
        best = None
        for c in candles:
            if c.t < t <= c.t + step or c.t == t:
                return c.t
            if c.t <= t:
                best = c.t
        return best
    lines = [{"price": trade["entry"]["price"], "label": "Entry", "color": "blue"},
             {"price": trade["stop"], "label": "Stop", "color": "red", "dash": True}]
    if trade.get("target"):
        lines.append({"price": trade["target"], "label": "Target", "color": "green", "dash": True})
    markers = [{"t": bar_at(entry_ts), "price": trade["entry"]["price"], "label": "in", "color": "blue",
                "shape": "up"}]
    if trade.get("exit"):
        good = (trade.get("r_multiple") or 0) >= 0
        markers.append({"t": bar_at(exit_ts), "price": trade["exit"]["price"], "label": "out",
                        "color": "green" if good else "red", "shape": "down"})
    tiles = [("Result", fmt.r(trade.get("r_multiple")) if trade.get("exit") else "open",
              "good" if (trade.get("r_multiple") or 0) > 0 else "bad" if trade.get("exit") else "info"),
             ("P&L", fmt.money(trade.get("pnl_usd")) if trade.get("exit") else "n/a", ""),
             ("Entry", fmt.price(trade["entry"]["price"]), ""),
             ("Exit", fmt.price((trade.get("exit") or {}).get("price")), ""),
             ("Fees + slippage", fmt.money((trade.get("fees_usd") or 0) + (trade.get("slippage_usd") or 0)), "")]
    body = html.tiles(tiles) + html.card("", html.candle_chart(candles, lines, markers, asset=trade["asset"]))
    body += html.card("Details", html.table(["Field", "Value"], [
        ("Setup", trade.get("setup")), ("Quantity", fmt.qty(trade["qty"], trade.get("qty_unit", ""))),
        ("Entry time", trade["entry"]["time"]), ("Exit time", (trade.get("exit") or {}).get("time") or "open"),
        ("Exit reason", (trade.get("exit") or {}).get("reason") or "open"),
        ("Mode", "paper" if trade.get("paper", True) else "live"), ("Notes", trade.get("notes") or "")]))
    page = html.page("%s · %s" % (trade["display"], trade.get("setup")), body,
                     "Trade %s · %s" % (trade["id"], "PAPER" if trade.get("paper", True) else "LIVE"),
                     trade["asset"])
    return html.write_report("trade-%s.html" % _safe_name(trade["id"]), page)


# --- statistics --------------------------------------------------------------------------------------------

def summarize(trades: list) -> dict:
    closed = [t for t in trades if t.get("status") == "closed" and t.get("r_multiple") is not None]
    rs = [float(t["r_multiple"]) for t in closed]
    # expectancy is what you actually keep: R after fees and slippage when the trade recorded it
    nets = [float(t["r_net"]) if t.get("r_net") is not None else float(t["r_multiple"]) for t in closed]
    pnls = [float(t.get("pnl_usd") or 0) for t in closed]
    wins = [t for t in closed if float(t.get("pnl_usd") or 0) > 0]
    gp = sum(p for p in pnls if p > 0)
    gl = -sum(p for p in pnls if p < 0)
    return {
        "trades": len(closed), "open": sum(1 for t in trades if t.get("status") == "open"),
        "wins": len(wins), "losses": sum(1 for p in pnls if p < 0),
        "win_rate": (len(wins) / float(len(closed))) if closed else None,
        "avg_r": (sum(rs) / len(rs)) if rs else None,
        "expectancy_r": (sum(nets) / len(nets)) if nets else None,
        "expectancy_usd": (sum(pnls) / len(pnls)) if pnls else None,
        "profit_factor": (gp / gl) if gl > 0 else None,  # None with wins and no losses = "∞"
        "total_r": sum(rs), "total_r_net": sum(nets), "total_pnl_usd": round(sum(pnls), 2),
        "fees_usd": round(sum(float(t.get("fees_usd") or 0) + float(t.get("slippage_usd") or 0) for t in closed), 2),
    }


def by_setup(trades: list) -> list:
    groups = {}
    for t in trades:
        if t.get("status") == "closed" and t.get("r_multiple") is not None:
            groups.setdefault(t.get("setup") or "manual", []).append(t)
    rows = []
    for setup, ts_ in groups.items():
        s = summarize(ts_)
        rows.append(dict(s, setup=setup))
    rows.sort(key=lambda r: -(r["avg_r"] or 0))
    return rows


def compute_stats(trades: list, asset: str = None) -> dict:
    pool = [t for t in trades if not asset or t.get("asset") == asset]
    setups = by_setup(pool)
    out = {"overall": summarize(pool), "by_asset": {}, "by_setup": setups,
           "best_setup": setups[0] if setups else None, "worst_setup": setups[-1] if len(setups) > 1 else None}
    for a in ("stock", "crypto", "meme"):
        sub = [t for t in pool if t.get("asset") == a]
        if sub:
            out["by_asset"][a] = summarize(sub)
    return out


def _pf(s: dict) -> str:
    if s.get("profit_factor") is not None:
        return "%.2f" % s["profit_factor"]
    return "∞" if s.get("wins") and not s.get("losses") else "n/a"


def _summary_line(s: dict) -> str:
    if not s["trades"]:
        return "no closed trades yet (%d open)" % s["open"]
    return "%d closed · win rate %s · avg %s gross · expectancy %s net (%s) · profit factor %s · P&L %s" % (
        s["trades"], fmt.prob(s["win_rate"]), fmt.r(s["avg_r"]), fmt.r(s["expectancy_r"]),
        fmt.money(s["expectancy_usd"]), _pf(s), fmt.money(s["total_pnl_usd"]))


def journal_report(trades: list, stats: dict):
    o = stats["overall"]
    tiles = [("Closed trades", str(o["trades"]), ""), ("Open", str(o["open"]), "info"),
             ("Win rate", fmt.prob(o["win_rate"]), ""), ("Average R", fmt.r(o["avg_r"]),
                                                          "good" if (o["avg_r"] or 0) > 0 else "bad"),
             ("Expectancy", fmt.money(o["expectancy_usd"]), ""), ("Profit factor", _pf(o), ""),
             ("Total P&L", fmt.money(o["total_pnl_usd"]), "good" if o["total_pnl_usd"] > 0 else "bad")]
    closed = sorted([t for t in trades if t.get("status") == "closed" and t.get("r_multiple") is not None],
                    key=lambda t: t["exit"]["time"])
    cum, run = [], 0.0
    for t in closed:
        run += float(t["r_net"]) if t.get("r_net") is not None else float(t["r_multiple"])
        cum.append(run)
    body = html.tiles(tiles)
    if cum:
        body += html.card("Cumulative R (net of costs)", html.line_chart([0.0] + cum, x_labels=["start"] + [
            t["exit"]["time"][5:10] for t in closed]))
    body += html.card("By asset class", html.table(
        ["Asset", "Closed", "Win rate", "Avg R", "Expectancy $", "Profit factor", "P&L"],
        [(a, s["trades"], fmt.prob(s["win_rate"]), fmt.r(s["avg_r"]), fmt.money(s["expectancy_usd"]),
          _pf(s), fmt.money(s["total_pnl_usd"])) for a, s in stats["by_asset"].items()]))
    body += html.card("By setup", html.table(
        ["Setup", "Closed", "Win rate", "Avg R", "Total R", "P&L"],
        [(s["setup"], s["trades"], fmt.prob(s["win_rate"]), fmt.r(s["avg_r"]), fmt.r(s["total_r"]),
          fmt.money(s["total_pnl_usd"])) for s in stats["by_setup"]]))
    rows = []
    for t in sorted(trades, key=lambda t: t["entry"]["time"], reverse=True):
        name = "trade-%s.html" % _safe_name(t["id"])
        link = html.Html("<a href='%s'>%s</a>" % (html.esc(name), html.esc(t["display"]))) if t.get("chart") \
            else t["display"]
        ex = t.get("exit") or {}
        rows.append((link, t["asset"], t.get("setup"), t["entry"]["time"][:16].replace("T", " "),
                     fmt.price(t["entry"]["price"]), fmt.price(ex.get("price")), ex.get("reason") or "open",
                     fmt.r(t.get("r_multiple")) if ex else "open", fmt.money(t.get("pnl_usd")) if ex else "",
                     "paper" if t.get("paper", True) else "LIVE"))
    body += html.card("Trades", html.table(["Symbol", "Asset", "Setup", "Entry (UTC)", "Entry", "Exit", "Reason",
                                            "R", "P&L", "Mode"], rows))
    assets = sorted({t["asset"] for t in trades}) or None
    page = html.page("Trade Journal", body, "%d trades · %s" % (len(trades), _summary_line(o)), assets)
    return html.write_report("journal.html", page)


# --- actions ------------------------------------------------------------------------------------------------

def _upsert(trade: dict) -> None:
    doc = _doc()
    trades = [t for t in doc.get("trades") or [] if t.get("id") != trade["id"]]
    trades.append(trade)
    _save({"trades": trades})


def _write_reports(args, trade, series=None):
    if args.no_html:
        return None, None
    chart = trade_chart(trade, series)
    if chart:
        trade["chart"] = state.rel(chart)
        _upsert(trade)
    trades = _doc().get("trades") or []
    return chart, journal_report(trades, compute_stats(trades))


def _trade_text(trade: dict) -> str:
    entry = trade["entry"]
    if trade["status"] == "open":
        mark = trade.get("mark")
        tail = " · mark %s (%s)" % (fmt.price(mark["price"]), fmt.r(mark["r"])) if mark else ""
        return "OPEN %s %s · entry %s at %s%s" % (trade["display"], trade.get("setup"), fmt.price(entry["price"]),
                                                  entry["time"], tail)
    ex = trade["exit"]
    return "CLOSED %s %s · %s → %s (%s) · %s · P&L %s (fees %s, slippage %s)" % (
        trade["display"], trade.get("setup"), fmt.price(entry["price"]), fmt.price(ex["price"]), ex["reason"],
        fmt.r(trade["r_multiple"]), fmt.money(trade["pnl_usd"]), fmt.money(trade["fees_usd"]),
        fmt.money(trade["slippage_usd"]))


def action_add(args, ctx) -> tuple:
    plan = load_plan(args.plan)
    tid = "trd-" + plan["id"]
    existing = next((t for t in _doc().get("trades") or [] if t.get("id") == tid), None)
    if existing and existing.get("status") == "closed":
        raise ValueError("%s is already closed in the journal" % tid)
    order = find_order(plan, args.order)
    if args.qty is not None:
        qty, unit, src = args.qty, ("usd" if plan.get("asset") == "meme" else
                                    "shares" if plan.get("asset") == "stock" else "coins"), "--qty"
    elif order:
        qty, unit, src = order["qty"], order.get("qty_unit"), "order %s" % order["id"]
    else:
        qty, unit, src = default_qty(plan, ctx.cfg, ctx.limits)
    trade = existing or new_trade(plan, order, qty, unit, src, args.notes)
    if args.notes:
        trade["notes"] = args.notes
    series = None
    notes = []
    if args.auto:
        res = auto_outcome(plan)
        series = res.pop("series")
        if res["outcome"] in ("target", "stop", "time"):
            finalize(trade, ctx.cfg, round(res["exit_price"], 10), market_clock.iso(res["exit_t"]), res["outcome"],
                     args.fees, args.slippage, estimate_slippage=True)
            if res.get("partials"):
                trade["partials"] = [dict(p, t=market_clock.iso(p["t"])) for p in res["partials"]]
            if res.get("stopped_by") == "trailing":
                notes.append("stopped out by the trailing stop at %s" % fmt.price(res["final_stop"]))
        else:
            trade["status"] = "open"
            if res["bars_available"]:
                last = series.candles[-1]
                trade["mark"] = {"price": last.c, "time": market_clock.iso(last.t + series.step),
                                 "r": round((last.c - trade["entry"]["price"]) / trade["risk_per_unit"], 3)}
            notes.append("no stop, target or time stop yet — trade stays OPEN (%d bars since entry)"
                         % res["bars_available"])
        if trade["asset"] == "meme" and plan.get("liquidity_exit"):
            notes.append("the liquidity exit (pool drop) cannot be replayed from candles — watch it with /trader-alerts")
    elif args.exit_price is not None:
        exit_time = market_clock.iso(market_clock.parse_iso(args.exit_time)) if args.exit_time else \
            market_clock.iso(market_clock.now_utc())
        finalize(trade, ctx.cfg, args.exit_price, exit_time, args.reason, args.fees, args.slippage)
    _upsert(trade)
    chart, report = _write_reports(args, trade, series)
    lines = ["JOURNAL — " + _trade_text(trade), "Quantity %s (%s)" % (fmt.qty(trade["qty"], trade.get("qty_unit")),
                                                                 trade.get("qty_source"))]
    lines += ["  note: " + n for n in notes]
    if report:
        lines.append(cli.report_line(report))
    cli.maybe_open(args, report)
    return "\n".join(lines), {"trade": trade, "notes": notes, "report": cli.rel(report),
                              "chart": cli.rel(chart)}, trade["asset"]


def action_close(args, ctx) -> tuple:
    doc = _doc()
    trades = doc.get("trades") or []
    open_trades = [t for t in trades if t.get("status") == "open"]
    tid = args.trade_id or (open_trades[-1]["id"] if open_trades else None)
    trade = next((t for t in trades if t.get("id") == tid), None)
    if not trade:
        raise ValueError("trade %r not found in trader/journal.json" % tid)
    if trade.get("status") != "open":
        raise ValueError("%s is already closed" % tid)
    if args.auto:
        args.plan = trade["plan_id"]
        return action_add(args, ctx)
    if args.exit_price is None:
        raise ValueError("close needs --exit-price (or --auto)")
    exit_time = market_clock.iso(market_clock.parse_iso(args.exit_time)) if args.exit_time else \
        market_clock.iso(market_clock.now_utc())
    finalize(trade, ctx.cfg, args.exit_price, exit_time, args.reason, args.fees, args.slippage)
    _upsert(trade)
    chart, report = _write_reports(args, trade)
    lines = ["JOURNAL — " + _trade_text(trade)]
    if report:
        lines.append(cli.report_line(report))
    cli.maybe_open(args, report)
    return "\n".join(lines), {"trade": trade, "report": cli.rel(report), "chart": cli.rel(chart)}, trade["asset"]


def action_list(args, ctx) -> tuple:
    trades = _doc().get("trades") or []
    if args.open_only:
        trades = [t for t in trades if t.get("status") == "open"]
    if args.asset:
        trades = [t for t in trades if t.get("asset") == args.asset]
    lines = ["JOURNAL — %d trade(s)" % len(trades)] + ["  " + _trade_text(t) for t in trades]
    assets = sorted({t["asset"] for t in trades}) or None
    return "\n".join(lines), {"trades": trades}, assets


def action_stats(args, ctx) -> tuple:
    trades = _doc().get("trades") or []
    stats = compute_stats(trades, args.asset)
    o = stats["overall"]
    scope = args.asset or "all asset classes"
    lines = ["JOURNAL STATS — %s" % scope, "Overall: " + _summary_line(o)]
    for a, s in stats["by_asset"].items():
        lines.append("  %-6s %s" % (a, _summary_line(s)))
    if stats["best_setup"]:
        b = stats["best_setup"]
        line = "Best setup: %s (%s avg over %d)" % (b["setup"], fmt.r(b["avg_r"]), b["trades"])
        if stats["worst_setup"]:
            w = stats["worst_setup"]
            line += " · worst: %s (%s avg over %d)" % (w["setup"], fmt.r(w["avg_r"]), w["trades"])
        lines.append(line)
    if o["trades"] and o["trades"] < 20:
        lines.append("  note: %d trade%s is a small sample — treat these numbers as anecdotes, not edges"
                     % (o["trades"], "" if o["trades"] == 1 else "s"))
    report = None
    if not args.no_html:
        report = journal_report(trades, compute_stats(trades))
        lines.append(cli.report_line(report))
        cli.maybe_open(args, report)
    assets = sorted({t["asset"] for t in trades}) or None
    return "\n".join(lines), {"stats": stats, "report": cli.rel(report)}, assets


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    handler = {"add": action_add, "close": action_close, "list": action_list, "stats": action_stats}[args.action]
    text, payload, asset = handler(args, ctx)
    cli.emit(args, text, payload, asset)
    return 0


if __name__ == "__main__":
    cli.run(main)
