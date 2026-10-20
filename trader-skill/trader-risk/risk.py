#!/usr/bin/env python3
"""Risk Manager — PASS or BLOCK a proposed trade against trader/limits.json.

Every order the sizer proposes goes through here before a ticket can exist.
Limits are separate per asset class (stock / crypto / meme) plus a global
layer, and a meme coin that has not passed /trader-rugcheck recently is
always BLOCKED. A BLOCK is a normal result, not an error (exit code 0).

Examples:
  python3 risk.py                                   # newest proposed order
  python3 risk.py --order ord-TSLA-20261020-141500
  python3 risk.py --symbol TSLA --qty 40 --entry 364.18 --stop 358.32       # ad hoc what-if
  python3 risk.py --symbol SOL:<mint> --notional 100 --entry 0.0047 --stop 0.0043
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, market_clock, state, symbols, trade_sim  # noqa: E402

OPTION_SYMBOL = re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")
HASH_FIELDS = ("symbol", "asset", "side", "qty", "qty_unit", "limit_price", "stop_price", "target_price")


def build_parser():
    p = cli.parser("risk.py", __doc__)
    p.add_argument("--order", help="order id from trader/orders.json (default: newest proposed order)")
    g = p.add_argument_group("ad hoc check (nothing is saved except the risk log)")
    g.add_argument("--symbol", help="symbol to check without an order (TSLA, BTCUSDT, SOL:<mint> ...)")
    g.add_argument("--qty", type=float, help="quantity (shares / coins; USD amount for meme coins)")
    g.add_argument("--notional", type=float, help="position value in USD (instead of --qty)")
    g.add_argument("--entry", type=float, help="entry price")
    g.add_argument("--stop", type=float, help="stop price")
    g.add_argument("--target", type=float, help="target price (optional)")
    g.add_argument("--side", choices=("buy", "sell"), default="buy", help="sell = open a short")
    g.add_argument("--leverage", type=float, default=1.0, help="leverage / margin multiple (default 1)")
    return p


# --- helpers ---------------------------------------------------------------------------------------

def order_hash(order: dict) -> str:
    """Fingerprint of the fields a ticket is built from — any change invalidates the risk check."""
    core = {k: order.get(k) for k in HASH_FIELDS}
    blob = json.dumps(core, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def symbol_of(obj: dict) -> symbols.Symbol:
    if obj.get("asset") == "meme" and obj.get("chain") and obj.get("address"):
        return symbols.meme_symbol(obj["chain"], obj["address"], obj.get("name", ""))
    raw = str(obj.get("symbol") or "").replace(" ", "").upper()
    m = OPTION_SYMBOL.match(raw)
    if m:  # an option contract is never a valid ticker — keep it so the check can block it by name
        return symbols.Symbol(raw=raw, asset="stock", base=re.match(r"^[A-Z]+", raw).group(0))
    return data.as_symbol(obj["symbol"], obj.get("asset"))


def day_of(ts_value, asset: str) -> str:
    """Trading day: New York date for stocks, UTC date for 24/7 markets."""
    dt = market_clock.parse_iso(ts_value)
    return (market_clock.et_date(dt) if asset == "stock" else dt.date()).isoformat()


def _orders() -> list:
    return (state.read_json("orders.json", {}) or {}).get("orders") or []


def _trades() -> list:
    return (state.read_json("journal.json", {}) or {}).get("trades") or []


def _tickets() -> list:
    return (state.read_json("tickets.json", {}) or {}).get("tickets") or []


def _order_by_id(oid: str):
    for o in _orders():
        if o.get("id") == oid:
            return o
    return None


def open_book(now_iso: str) -> list:
    """Open positions: journal trades still open + tickets approved today that the journal has not seen."""
    trades = _trades()
    book = []
    journaled = {t.get("order_id") for t in trades if t.get("order_id")}
    for t in trades:
        if t.get("status") == "open":
            qty = float(t.get("qty") or 0)
            entry = float((t.get("entry") or {}).get("price") or 0)
            notional = qty if t.get("asset") == "meme" else qty * entry
            book.append({"asset": t.get("asset"), "symbol": t.get("symbol"), "notional": notional, "source": t["id"]})
    for tk in _tickets():
        if tk.get("status") != "approved" or tk.get("order_id") in journaled:
            continue
        o = _order_by_id(tk.get("order_id"))
        if not o or day_of(tk.get("approved_at") or tk.get("created_at"), o["asset"]) != day_of(now_iso, o["asset"]):
            continue
        book.append({"asset": o["asset"], "symbol": o.get("symbol"), "notional": float(o.get("notional_usd") or 0),
                     "source": tk["id"]})
    return book


def realized_loss_today(now_iso: str, asset: str = None) -> float:
    loss = 0.0
    for t in _trades():
        if t.get("status") != "closed" or (asset and t.get("asset") != asset):
            continue
        ex = (t.get("exit") or {}).get("time")
        if not ex or day_of(ex, t.get("asset")) != day_of(now_iso, t.get("asset")):
            continue
        pnl = float(t.get("pnl_usd") or 0)
        if pnl < 0:
            loss += -pnl
    return loss


def trades_today(now_iso: str, asset: str = None) -> int:
    n = 0
    for a in state.read_jsonl("approvals.jsonl"):
        if not a.get("approved"):
            continue
        a_asset = a.get("asset") or (_order_by_id(a.get("order_id")) or {}).get("asset") or "stock"
        if asset and a_asset != asset:
            continue
        if day_of(a.get("ts"), a_asset) == day_of(now_iso, a_asset):
            n += 1
    return n


def rugcheck_status(sym: symbols.Symbol, lim: dict, now) -> tuple:
    """(ok, detail, report) — fail closed: no file, a stale file or the wrong verdict all BLOCK."""
    name = "rugcheck/%s-%s.json" % (sym.chain, sym.address)
    rc = state.read_json(name)
    if not rc:
        return False, "no rugcheck on file for %s — run /trader-rugcheck first" % sym.display, None
    allowed = lim.get("required_rugcheck_verdicts") or ["SAFE"]
    verdict = rc.get("verdict")
    age_min = None
    if rc.get("checked_at"):
        age_min = (now - market_clock.parse_iso(rc["checked_at"])).total_seconds() / 60.0
    max_age = float(lim.get("rugcheck_max_age_minutes", 60))
    reasons = "; ".join(rc.get("reasons") or [])
    if verdict not in allowed:
        return False, "rugcheck %s (score %s): %s" % (verdict, rc.get("score"), reasons or "see report"), rc
    if age_min is None or age_min > max_age:
        return False, "rugcheck is %s old (max %d min) — liquidity can vanish, run /trader-rugcheck again" % (
            "%.0f min" % age_min if age_min is not None else "of unknown age", max_age), rc
    return True, "rugcheck %s, score %s, %.0f min old" % (verdict, rc.get("score"), age_min), rc


# --- the checks --------------------------------------------------------------------------------------

def evaluate(order: dict, cfg: dict, limits: dict) -> dict:
    now = market_clock.now_utc()
    now_iso = market_clock.iso(now)
    sym = symbol_of(order)
    asset = order.get("asset") or sym.asset
    lim = limits.get(asset) or {}
    glob = limits.get("global") or {}
    account = float(cfg.get("account_size") or 0)
    checks = []
    warnings = []

    def add(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    entry = float(order.get("entry_price") or 0)
    stop = order.get("stop_price")
    stop = float(stop) if stop is not None else None
    qty = float(order.get("qty") or 0)
    notional = float(order.get("notional_usd") or (qty if asset == "meme" else qty * entry))
    if stop is not None and entry > 0:
        rpu = entry - stop
        risk_usd = notional * rpu / entry if asset == "meme" else qty * rpu
    else:
        risk_usd = None

    blocked = {str(s).upper() for s in limits.get("blocked_symbols") or []}
    names = {str(x).upper() for x in (order.get("symbol"), sym.key, sym.base, sym.display, sym.address) if x}
    hit = sorted(names & blocked)
    add("blocked_symbols", not hit, "on the blocked list: %s" % ", ".join(hit) if hit else "not on the blocked list")

    side = order.get("side") or "buy"
    if stop is None:
        add("stop_defined", False, "no stop — every trade needs a stop")
    elif side == "buy" and stop >= entry:
        add("stop_defined", False, "stop %s is not below entry %s" % (fmt.price(stop), fmt.price(entry)))
    else:
        add("stop_defined", True, "stop %s (%s below entry)" % (fmt.price(stop), fmt.pct((entry - stop) / entry * 100)))

    if side == "sell":
        allowed = asset != "meme" and bool(lim.get("allow_shorts"))
        add("no_shorts", allowed, "short selling %s" % ("allowed by limits" if allowed else "is not allowed"))
    else:
        add("no_shorts", True, "long only")
    lev = float(order.get("leverage") or 1.0)
    if lev > 1.0:
        key = "allow_margin" if asset == "stock" else "allow_leverage"
        allowed = asset != "meme" and bool(lim.get(key))
        add("no_leverage", allowed, "%.1fx %s %s" % (lev, "margin" if asset == "stock" else "leverage",
                                                    "allowed by limits" if allowed else "is not allowed"))
    else:
        add("no_leverage", True, "no leverage / margin")
    if asset == "stock" and OPTION_SYMBOL.match(str(order.get("symbol") or sym.raw).replace(" ", "").upper()):
        allowed = bool(lim.get("allow_options"))
        add("no_options", allowed, "options %s" % ("allowed by limits" if allowed else "are not allowed"))

    max_risk = lim.get("max_risk_per_trade_usd")
    if risk_usd is not None and max_risk is not None:
        add("max_risk_per_trade", risk_usd <= float(max_risk) + 1e-9,
            "%s %s %s" % (fmt.money(risk_usd), "≤" if risk_usd <= float(max_risk) + 1e-9 else ">", fmt.money(max_risk)))

    if account > 0 and lim.get("max_position_pct") is not None:
        pos_pct = 100.0 * notional / account
        cap = float(lim["max_position_pct"])
        add("max_position_pct", pos_pct <= cap + 1e-6,
            "%s = %s of account (max %s)" % (fmt.money(notional), fmt.pct(pos_pct, 2), fmt.pct(cap, 0)))

    book = open_book(now_iso)
    n_class = sum(1 for b in book if b["asset"] == asset)
    if lim.get("max_open_positions") is not None:
        cap = int(lim["max_open_positions"])
        add("max_open_positions", n_class < cap, "%d open %s position(s), max %d" % (n_class, asset, cap))
    if glob.get("max_open_positions") is not None:
        cap = int(glob["max_open_positions"])
        add("max_open_positions_global", len(book) < cap, "%d open position(s) in total, max %d" % (len(book), cap))

    for scope, lim_value, loss in (
            (asset, lim.get("max_daily_loss_usd"), realized_loss_today(now_iso, asset)),
            ("global", glob.get("max_daily_loss_usd"), realized_loss_today(now_iso))):
        if lim_value is None:
            continue
        lim_value = float(lim_value)
        name = "max_daily_loss" + ("" if scope == asset else "_global")
        if loss >= lim_value:
            add(name, False, "already lost %s today (%s limit %s) — done for the day" % (
                fmt.money(loss), scope, fmt.money(lim_value)))
        elif risk_usd is not None and loss + risk_usd > lim_value + 1e-9:
            add(name, False, "lost %s today; this trade risks %s more → over the %s %s daily limit" % (
                fmt.money(loss), fmt.money(risk_usd), scope, fmt.money(lim_value)))
        else:
            add(name, True, "lost %s today, limit %s (%s)" % (fmt.money(loss), fmt.money(lim_value), scope))

    for scope, cap, n in ((asset, lim.get("max_daily_trades"), trades_today(now_iso, asset)),
                          ("global", glob.get("max_daily_trades"), trades_today(now_iso))):
        if cap is None:
            continue
        name = "max_daily_trades" + ("" if scope == asset else "_global")
        add(name, n < int(cap), "%d trade(s) approved today, max %d (%s)" % (n, int(cap), scope))

    if asset in ("crypto", "meme") and lim.get("max_total_exposure_pct") is not None and account > 0:
        exposure = sum(b["notional"] for b in book if b["asset"] == asset) + notional
        cap = float(lim["max_total_exposure_pct"])
        pct = 100.0 * exposure / account
        add("max_total_exposure", pct <= cap + 1e-6, "%s exposure %s = %s of account (max %s)" % (
            asset, fmt.money(exposure), fmt.pct(pct, 2), fmt.pct(cap, 0)))

    if asset == "meme":
        ok, detail, _rc = rugcheck_status(sym, lim, now)
        add("rugcheck_passed", ok, detail)
        liq = order.get("liquidity_usd")
        if liq is None:
            try:
                liq = data.get_pair(sym).get("liquidity_usd")
            except data.DataUnavailable:
                liq = None
        min_liq = float(lim.get("min_liquidity_usd", 0))
        if liq is None:
            add("min_liquidity", False, "pool liquidity unknown — cannot verify")
        else:
            liq = float(liq)
            add("min_liquidity", liq >= min_liq, "pool liquidity %s (min %s)" % (fmt.compact_usd(liq),
                                                                               fmt.compact_usd(min_liq)))
            slip = order.get("est_slippage_pct")
            if slip is None:
                slip = trade_sim.estimate_slippage_pct(notional, liq)
            max_slip = float(lim.get("max_slippage_pct", 3.0))
            add("max_slippage", slip is not None and slip <= max_slip + 1e-9,
                "estimated slippage %s (max %s)" % (fmt.pct(slip, 2), fmt.pct(max_slip, 1)))
            pool_pct = 100.0 * notional / liq if liq else None
            max_pool = float(lim.get("max_pct_of_pool", 1.0))
            add("max_pct_of_pool", pool_pct is not None and pool_pct <= max_pool + 1e-9,
                "%s of the pool (max %s)" % (fmt.pct(pool_pct, 2), fmt.pct(max_pool, 1)))

    if asset == "stock":
        st = market_clock.market_status(now)
        if st["state"] != "open":
            warnings.append("US market is %s right now (next open %s) — a day order would wait or be rejected"
                            % (st["state"], st.get("next_open") or "n/a"))

    failed = [c for c in checks if not c["ok"]]
    return {
        "result": "BLOCK" if failed else "PASS",
        "checked_at": now_iso,
        "order_hash": order_hash(order),
        "reasons": [c["detail"] for c in failed],
        "checks": checks,
        "warnings": warnings,
    }


# --- order selection --------------------------------------------------------------------------------

def pick_order(order_id: str = None) -> dict:
    orders = _orders()
    if not orders:
        raise ValueError("no orders in trader/orders.json — run /trader-sizer first")
    if order_id:
        for o in orders:
            if o.get("id") == order_id:
                return o
        raise ValueError("order %r not found in trader/orders.json" % order_id)
    proposed = [o for o in orders if o.get("status") == "proposed"]
    if not proposed:
        raise ValueError("no proposed orders waiting for a risk check (pass --order ID to re-check one)")
    return proposed[-1]


def save_result(order_id: str, risk: dict) -> dict:
    doc = state.read_json("orders.json", {}) or {}
    saved = None
    for o in doc.get("orders") or []:
        if o.get("id") == order_id:
            o["risk"] = risk
            o["status"] = "risk_pass" if risk["result"] == "PASS" else "risk_block"
            saved = o
    state.write_json("orders.json", doc)
    return saved


def adhoc_order(args, cfg: dict) -> dict:
    if args.entry is None:
        raise ValueError("ad hoc checks need --entry (and --stop)")
    sym = symbol_of({"symbol": args.symbol, "asset": args.asset})
    if sym.asset == "meme":
        sym = data.resolve_meme(sym)[0]
    if args.notional is not None:
        notional = float(args.notional)
        qty = notional if sym.asset == "meme" else notional / args.entry
    elif args.qty is not None:
        qty = float(args.qty)
        notional = qty if sym.asset == "meme" else qty * args.entry
    else:
        raise ValueError("ad hoc checks need --qty or --notional")
    o = {"id": "adhoc", "symbol": args.symbol, "asset": sym.asset, "side": args.side, "qty": qty,
         "qty_unit": "usd" if sym.asset == "meme" else ("shares" if sym.asset == "stock" else "coins"),
         "entry_price": args.entry, "limit_price": None, "stop_price": args.stop, "target_price": args.target,
         "notional_usd": notional, "leverage": args.leverage,
         "display": sym.raw if OPTION_SYMBOL.match(sym.raw) else sym.display}
    if sym.asset == "meme":
        o.update(chain=sym.chain, address=sym.address, name=sym.name)
    return o


def _describe(order: dict) -> str:
    if order.get("asset") == "meme":
        return "BUY %s of %s" % (fmt.money(order.get("qty")), order.get("name") or order.get("display") or order["symbol"])
    side = "SELL SHORT" if order.get("side") == "sell" else "BUY"
    return "%s %s %s" % (side, fmt.qty(order.get("qty")), order.get("display") or order.get("symbol"))


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    adhoc = bool(args.symbol)
    order = adhoc_order(args, ctx.cfg) if adhoc else pick_order(args.order)
    risk = evaluate(order, ctx.cfg, ctx.limits)
    if not adhoc:
        save_result(order["id"], risk)
    state.append_jsonl("risk_log.jsonl", {"ts": risk["checked_at"], "order_id": order.get("id"),
                                          "symbol": order.get("symbol"), "asset": order.get("asset"),
                                          "result": risk["result"], "reasons": risk["reasons"], "adhoc": adhoc})
    head = "RISK CHECK — %s (%s)" % (_describe(order), "ad hoc, not saved" if adhoc else order["id"])
    if risk["result"] == "PASS":
        verdict = "PASS ✓  all %d checks passed" % len(risk["checks"])
    else:
        verdict = "BLOCK ✗ — " + "; ".join(risk["reasons"])
    lines = [head, verdict]
    for c in risk["checks"]:
        lines.append("  %s %-26s %s" % ("✓" if c["ok"] else "✗", c["name"], c["detail"]))
    for w in risk["warnings"]:
        lines.append("  ! " + w)
    if risk["result"] == "PASS" and not adhoc:
        lines.append("Next: /trader-broker prepares the ticket (still needs your explicit yes).")
    elif not adhoc:
        lines.append("Blocked trades never get a ticket. Fix the reason or skip this trade.")
    cli.emit(args, "\n".join(lines), {"order_id": order.get("id"), "risk": risk, "adhoc": adhoc},
             order.get("asset"))
    return 0


if __name__ == "__main__":
    cli.run(main)
