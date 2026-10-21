#!/usr/bin/env python3
"""Autopilot — trades for you, but only what clears every gate. Simulator / paper by default.

Each cycle: read the controls → sync the broker → journal fills and exits → manage exits (stock time
stop 3:55 p.m. ET, crypto horizon / target / protective stop) → daily-loss kill switch → look for
fresh triggers on the watchlist → for each one: entry → exit plan → backtest → Time Machine →
rule-based desk → size → risk check → place the order. Every trigger it looks at lands in
trader/autopilot/decisions.jsonl with the reasons it was taken or skipped.

Turning it on (config autopilot.enabled true, or --approve) is a standing approval for orders that pass
every gate. Without it the autopilot runs as a dry run: same analysis, no orders. Meme coins are never
auto-traded. Live money needs the full opt-in in docs/SCHEMAS.md — it never switches to live by itself.

Examples:
  python3 autopilot.py status
  python3 autopilot.py run --once --approve
  python3 autopilot.py loop --approve --interval 60
  python3 autopilot.py pause | resume | kill --confirm KILL | check-live
  python3 autopilot.py replay --from 2026-10-20T13:35:00Z --to 2026-10-20T20:00:00Z --approve --offline
"""
from __future__ import annotations

import argparse
import os
import sys
import time

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import brokers, cli, config, data, fmt, market_clock, setups, skills, state, symbols  # noqa: E402
from shared.brokers import BrokerError, broker_symbol  # noqa: E402

STATE = "autopilot/state.json"
CONTROL = "autopilot/control.json"
DECISIONS = "autopilot/decisions.jsonl"
BOOK = "autopilot/book.json"
INTERVAL = "5m"
STALE_ENTRY_BARS = 3          # an entry that has not filled 15 min after the trigger is cancelled
NO_NEW_STOCK_ENTRIES = (15, 30)  # ET — too little session left for a 2R move before the 3:55 time stop
TM_SEED = 7
APPROVAL_TEXT = "autopilot standing approval (config autopilot.enabled)"
_MODS = {}


def _mod(skill: str, module: str):
    key = skill + "/" + module
    if key not in _MODS:
        _MODS[key] = skills.load(skill, module)
    return _MODS[key]


# --- small state helpers -------------------------------------------------------------------------

def read_control() -> dict:
    c = state.read_json(CONTROL, {}) or {}
    return {"paused": bool(c.get("paused")), "kill": bool(c.get("kill")), "run_once": bool(c.get("run_once")),
            "updated_at": c.get("updated_at"), "by": c.get("by")}


def write_control(by: str = "cli", **changes) -> dict:
    c = read_control()
    c.update(changes)
    c.update(updated_at=market_clock.iso(market_clock.now_utc()), by=by)
    state.write_json(CONTROL, c)
    return c


def _book() -> dict:
    b = state.read_json(BOOK, {}) or {}
    b.setdefault("items", {})
    b.setdefault("handled", {})
    return b


def _today(now) -> str:
    return market_clock.parse_iso(now).date().isoformat()


def _decision(**rec) -> dict:
    base = {"at": market_clock.iso(market_clock.now_utc()), "id": None, "symbol": None, "asset": None, "setup": None,
            "action": "skipped", "reasons": [], "desk": None, "gates": [], "order_id": None,
            "broker_order_id": None, "entry": None, "stop": None, "target": None, "qty": None, "dry_run": False}
    base.update(rec)
    state.append_jsonl(DECISIONS, base)
    return base


def _approved(cfg: dict, approved) -> bool:
    if approved is not None:
        return bool(approved)
    return bool((cfg.get("autopilot") or {}).get("enabled"))


# --- broker sync & bookkeeping ----------------------------------------------------------------------

def _write_broker_files(broker, acct, positions, orders, book, realized_today):
    by_symbol = {it["symbol"]: pid for pid, it in book["items"].items() if it["status"] in ("pending", "open")}
    for p in positions:
        p["plan_id"] = by_symbol.get(p["symbol"])
    state.write_json("broker/positions.json", positions)
    state.write_json("broker/orders.json", orders[-200:])
    unreal = sum(float(p.get("unrealized_pl") or 0) for p in positions)
    line = {"at": market_clock.iso(market_clock.now_utc()), "equity": acct.get("equity"), "cash": acct.get("cash"),
            "unrealized": round(unreal, 2), "realized_today": round(realized_today, 2), "mode": broker.mode}
    state.append_jsonl("broker/equity.jsonl", line)
    return line


def _realized_today(now) -> float:
    day = _today(now)
    total = 0.0
    for t in (state.read_json("journal.json", {}) or {}).get("trades") or []:
        if t.get("status") == "closed" and ((t.get("exit") or {}).get("time") or "")[:10] == day:
            total += float(t.get("pnl_usd") or 0)
    return total


def _find(orders, oid=None, cid=None):
    for o in orders:
        if (oid and o.get("id") == oid) or (cid and o.get("client_order_id") == cid):
            return o
    return None


def _open_trade(item: dict, fill: dict, cfg: dict, limits: dict) -> dict:
    journal = _mod("trader-journal", "journal")
    plan = (state.read_json("plan.json", {}) or {}).get("plans", {}).get(item["plan_id"])
    order = _order_by_id(item["order_id"])
    qty = float(fill.get("filled_qty") or item["qty"])
    trade = journal.new_trade(plan, order, qty, item.get("qty_unit") or "shares", "autopilot fill",
                              "opened by the autopilot (%s)" % item["mode"])
    price = float(fill["filled_avg_price"])
    trade.update(entry={"time": fill.get("filled_at") or market_clock.iso(market_clock.now_utc()), "price": price},
                 risk_per_unit=round(price - float(plan["stop"]["price"]), 10), source="autopilot",
                 broker=item["broker"], broker_order_id=item.get("broker_order_id"),
                 paper=item["mode"] != "live")
    if trade["risk_per_unit"] <= 0:  # filled at or below the stop: keep R meaningful against the planned risk
        trade["risk_per_unit"] = float(plan["risk_per_unit"])
    journal.save_trade(trade)
    return trade


def _close_trade(item: dict, exit_order: dict, reason: str, cfg: dict) -> dict:
    journal = _mod("trader-journal", "journal")
    trade = journal.get_trade(item.get("trade_id"))
    if not trade:
        return None
    price = float(exit_order.get("filled_avg_price") or 0)
    at = exit_order.get("filled_at") or market_clock.iso(market_clock.now_utc())
    journal.finalize(trade, cfg, price, at, reason)
    trade["exit"]["broker_order_id"] = exit_order.get("id")
    if reason == "manual" and item.get("exit_note"):
        trade["notes"] = (trade.get("notes") or "") + " · " + item["exit_note"]
    journal.save_trade(trade)
    return trade


def _order_by_id(oid: str):
    for o in (state.read_json("orders.json", {}) or {}).get("orders") or []:
        if o.get("id") == oid:
            return o
    return None


def _update_order(oid: str, **fields) -> None:
    doc = state.read_json("orders.json", {}) or {}
    for o in doc.get("orders") or []:
        if o.get("id") == oid:
            o.update(fields)
    state.write_json("orders.json", doc)


def reconcile(broker, book: dict, positions: list, orders: list, cfg: dict, limits: dict) -> list:
    """Turn broker fills into journal entries: entries open trades, exits close them."""
    actions = []
    now = market_clock.now_utc()
    step = market_clock.interval_seconds(INTERVAL)
    pos_by = {p["symbol"]: p for p in positions}
    for pid, it in book["items"].items():
        if it["status"] == "pending":
            o = _find(orders, it.get("broker_order_id"), it.get("order_id"))
            if o and o.get("status") == "filled":
                trade = _open_trade(it, o, cfg, limits)
                it.update(status="open", filled_at=o.get("filled_at"), entry_fill=o.get("filled_avg_price"),
                          trade_id=trade["id"], qty=float(o.get("filled_qty") or it["qty"]))
                _update_order(it["order_id"], status="filled", filled_avg_price=o.get("filled_avg_price"))
                actions.append("filled %s %s @ %s" % (fmt.qty(it["qty"]), it["symbol"], fmt.price(o["filled_avg_price"])))
                if it["asset"] == "crypto":
                    try:
                        so = broker.place_stop(it["symbol"], it["qty"], it["stop"], client_order_id=it["order_id"] + "-stop",
                                               asset="crypto")
                        it["stop_order_id"] = so.get("id")
                        actions.append("protective stop %s for %s" % (fmt.price(it["stop"]), it["symbol"]))
                    except BrokerError as exc:
                        it["stop_error"] = str(exc)
                        actions.append("could not place the protective stop for %s: %s" % (it["symbol"], exc))
            elif o and o.get("status") in ("canceled", "expired", "rejected"):
                it["status"] = "canceled"
                _update_order(it["order_id"], status=o["status"])
                actions.append("entry for %s %s" % (it["symbol"], o["status"]))
            elif now.timestamp() - market_clock.ts(it["placed_at"]) > STALE_ENTRY_BARS * step:
                try:
                    broker.cancel(it.get("broker_order_id"))
                except BrokerError:
                    pass
                it["status"] = "canceled"
                _update_order(it["order_id"], status="canceled")
                actions.append("entry for %s not filled within %d min — cancelled so a late fill can't happen"
                               % (it["symbol"], STALE_ENTRY_BARS * step // 60))
        elif it["status"] == "open":
            p = pos_by.get(it["symbol"])
            if p and float(p.get("qty") or 0) > 1e-9:
                continue
            sells = [o for o in orders if o.get("symbol") == it["symbol"] and o.get("side") == "sell"
                     and o.get("status") == "filled" and (o.get("filled_at") or "") >= (it.get("filled_at") or "")]
            if not sells:
                continue
            ex = sorted(sells, key=lambda o: o.get("filled_at") or "")[-1]
            leg = ex.get("leg")
            if leg in ("stop", "target"):
                reason = leg
            elif ex.get("id") == it.get("stop_order_id"):
                reason = "stop"
            else:
                reason = it.get("exit_reason") or "manual"
            trade = _close_trade(it, ex, reason, cfg)
            it.update(status="closed", closed_at=ex.get("filled_at"), exit_price=ex.get("filled_avg_price"),
                      exit_reason=reason, pnl_usd=(trade or {}).get("pnl_usd"))
            _update_order(it["order_id"], status="closed")
            actions.append("closed %s (%s) @ %s · P&L %s" % (it["symbol"], reason, fmt.price(ex.get("filled_avg_price")),
                                                          fmt.money((trade or {}).get("pnl_usd"))))
    return actions


def manage_exits(broker, book: dict, positions: list, orders: list) -> list:
    """Time stops for everything; target/stop management for crypto (Alpaca has no crypto brackets)."""
    actions = []
    now_ts = market_clock.now_utc().timestamp()
    pos_by = {p["symbol"]: p for p in positions}
    for it in book["items"].values():
        if it["status"] != "open":
            continue
        p = pos_by.get(it["symbol"])
        if not p:
            continue
        reason = None
        if now_ts >= market_clock.ts(it["time_stop"]):
            reason = "time"
        elif it["asset"] == "crypto" and p.get("last") is not None:
            if float(p["last"]) >= float(it["target"]):
                reason = "target"
            elif float(p["last"]) <= float(it["stop"]) and not it.get("stop_order_id"):
                reason = "stop"
        if not reason:
            continue
        for o in orders:
            if o.get("symbol") == it["symbol"] and o.get("status") in ("new", "held", "accepted", "pending_new"):
                try:
                    broker.cancel(o["id"])
                except BrokerError:
                    pass
        it["exit_reason"] = reason
        try:
            broker.close_position(it["symbol"])
            actions.append("%s exit for %s" % (reason, it["symbol"]))
        except BrokerError as exc:
            actions.append("could not close %s: %s" % (it["symbol"], exc))
    return actions


def kill(broker, book: dict, cfg: dict, reason: str) -> list:
    actions = ["KILL: %s" % reason]
    flatten = bool((cfg.get("autopilot") or {}).get("flatten_on_kill", True))
    for it in book["items"].values():
        if it["status"] == "open" and flatten:
            it["exit_reason"], it["exit_note"] = "manual", "kill switch: %s" % reason
        elif it["status"] == "pending":
            it["status"] = "canceled"
            _update_order(it["order_id"], status="canceled")
    try:
        broker.cancel_all()
        actions.append("cancelled all open orders")
        if flatten:
            broker.close_all()
            actions.append("closed all positions")
    except BrokerError as exc:
        actions.append("kill incomplete: %s" % exc)
    return actions


# --- finding and judging triggers -------------------------------------------------------------------------

def watchlist(cfg: dict) -> dict:
    ap = cfg.get("autopilot") or {}
    wl = ap.get("watchlist") or {}
    base = cfg.get("watchlists") or {}
    out = {}
    for asset, key in (("stock", "stocks"), ("crypto", "crypto")):
        if asset not in (ap.get("assets") or ["stock", "crypto"]):
            continue
        out[asset] = list(wl.get(key) or wl.get(asset) or base.get(key) or [])
    return out  # meme coins are never on it


def find_triggers(cfg: dict, book: dict, memo: dict) -> tuple:
    ap = cfg.get("autopilot") or {}
    max_age = int((ap.get("gates") or {}).get("max_trigger_age_bars", 1))
    now = market_clock.now_utc()
    now_ts = int(now.timestamp())
    step = market_clock.interval_seconds(INTERVAL)
    handled = book["handled"].setdefault(_today(now), {})
    found, notes = [], []
    holding = {it["data_key"] for it in book["items"].values() if it["status"] in ("pending", "open")}
    for asset, syms in watchlist(cfg).items():
        if asset == "stock":
            st = market_clock.market_status(now)
            if st["state"] != "open":
                notes.append("US market %s — no new stock entries" % st["state"])
                continue
            et = market_clock.to_et(now)
            if (et.hour, et.minute) >= NO_NEW_STOCK_ENTRIES:
                notes.append("after 3:30 p.m. ET — no new stock entries")
                continue
        for raw in syms:
            try:
                sym = data.as_symbol(raw, asset)
                key = (sym.key, asset)
                if key not in memo:
                    memo[key] = data.get_candles(sym, INTERVAL, days=3 if asset == "stock" else 2)
                series = memo[key]
            except (data.DataUnavailable, symbols.SymbolError, ValueError) as exc:
                notes.append("%s: %s" % (raw, exc))
                continue
            if not series.candles:
                continue
            w = setups.window_at(series.candles, asset, INTERVAL, now_ts - 1)
            if not w or not (w.start <= now_ts - 1 < w.end):
                continue
            seen_bar = None
            for setup in (ap.get("setups") or {}).get(asset) or []:
                if setup not in setups.SETUPS or asset not in setups.SETUPS[setup]["assets"]:
                    continue
                r = setups.evaluate(setup, w, now_ts, {"pick": "last"})
                trig = r.get("trigger")
                if r["status"] != "triggered" or not trig:
                    continue
                age = (now_ts - (trig["t"] + step)) // step
                sid = setups.setup_id(sym.key, w.key, setup)
                if age > max_age or sid in handled:
                    continue
                cand = {"id": sid, "sym": sym, "asset": asset, "setup": setup, "result": r, "series": series,
                        "window": w, "trigger": trig}
                if sym.key in holding:
                    cand["skip"] = "already holding or waiting on %s" % sym.display
                elif seen_bar == trig["t"]:
                    cand["skip"] = "same candle already judged via another rule for %s" % sym.display
                seen_bar = seen_bar or trig["t"]
                found.append(cand)
    return found, notes


def _write_entry(c: dict) -> None:
    r, sym, trig = c["result"], c["sym"], c["trigger"]
    exit_mod = _mod("trader-exit", "exit")
    doc = state.read_json("entries.json", {}) or {}
    doc.setdefault("entries", {})[c["id"]] = {
        "id": c["id"], "symbol": exit_mod._canonical(sym), "symbol_display": sym.display, "symbol_key": sym.key,
        "asset": c["asset"], "setup": c["setup"], "label": r["label"], "direction": "long", "status": "triggered",
        "previous_status": None, "rule": r.get("rule", ""), "levels": r.get("levels") or {}, "range": r.get("range"),
        "trigger": {"time": trig["time"], "close_time": trig["close_time"], "price": trig["price"],
                    "candle": trig["candle"]},
        "entry_price": trig["price"], "checked_at": market_clock.iso(market_clock.now_utc()), "interval": INTERVAL,
        "source": c["series"].source, "notes": r.get("notes") or [], "origin": "autopilot",
    }
    doc.setdefault("latest", c["id"])
    state.write_json("entries.json", doc)


def make_plan(c: dict, cfg: dict) -> dict:
    exit_mod = _mod("trader-exit", "exit")
    sym, asset, trig, r = c["sym"], c["asset"], c["trigger"], c["result"]
    step = market_clock.interval_seconds(INTERVAL)
    entry_ts = trig["t"] + step
    until = [x for x in c["series"].candles if x.t + step <= entry_ts]
    tick = 0.01 if asset == "stock" else (data.lot_info(sym).get("tick") or None)
    horizon_s = None if asset == "stock" else market_clock.parse_horizon(cfg.get("crypto_horizon") or "4h")
    levels = r.get("levels") or {}
    lv = exit_mod.plan_levels(trig["price"], entry_ts, asset, until, stop_ref=levels.get("stop_ref"),
                              trigger_level=levels.get("trigger_level"), stop="auto", atr_mult=1.5,
                              target_r=exit_mod.DEFAULT_TARGET_R[asset], tick=tick, horizon_s=horizon_s)
    if lv["stop"]["method"] == "range_low":
        lv["stop"]["note"] = exit_mod.structure_note(c["setup"])
    plan = {"id": c["id"], "symbol": exit_mod._canonical(sym), "symbol_display": sym.display, "symbol_key": sym.key,
            "asset": asset, "setup": c["setup"], "label": r["label"], "direction": "long",
            "entry": {"price": float(trig["price"]), "time": market_clock.iso(entry_ts)},
            "stop": lv["stop"], "target": lv["target"], "risk_per_unit": lv["risk_per_unit"],
            "time_stop": lv["time_stop"], "horizon": lv["horizon"], "trailing": None, "scale_out": [],
            "liquidity_exit": None, "atr": lv["atr"], "interval": INTERVAL, "source": c["series"].source,
            "created_at": market_clock.iso(market_clock.now_utc()), "chart": None, "origin": "autopilot"}
    doc = state.read_json("plan.json", {}) or {}
    doc.setdefault("plans", {})[plan["id"]] = plan
    doc.setdefault("latest", plan["id"])
    state.write_json("plan.json", doc)
    return plan


def _ctx(args, cfg, limits):
    return cli.Context(args=args, cfg=cfg, limits=limits, home=config.trader_home())


def ensure_backtest(c: dict, plan: dict, cfg: dict, limits: dict) -> dict:
    """Backtest the rule on this symbol — once per symbol, rule and day."""
    rel = "backtests/%s-%s.json" % (c["sym"].key, c["setup"])
    doc = state.read_json(rel)
    today = _today(market_clock.now_utc())
    if doc and (doc.get("generated_at") or "")[:10] == today:
        return doc
    bt = _mod("trader-backtest", "backtest")
    args = bt.build_parser().parse_args([plan["symbol"], "--setup", c["setup"], "--asset", c["asset"], "--no-html"])
    return bt.run(args, _ctx(args, cfg, limits))["doc"]


def run_timemachine(plan: dict, cfg: dict, limits: dict) -> dict:
    tm = _mod("trader-timemachine", "replay")
    paths = int(((cfg.get("autopilot") or {}).get("gates") or {}).get("tm_paths") or 2000)
    args = tm.build_parser().parse_args(["--id", plan["id"], "--paths", str(paths), "--seed", str(TM_SEED),
                                         "--no-html"])
    res, _, _ = tm.run_replay(args, _ctx(args, cfg, limits))
    return res


def _count_today(book: dict, now) -> int:
    day = _today(now)
    return sum(1 for it in book["items"].values() if (it.get("placed_at") or "")[:10] == day)


def judge(c: dict, cfg: dict, limits: dict, broker, book: dict, approved: bool, acct: dict) -> dict:
    """Everything between "a rule fired" and "an order is at the broker". Returns the decision record."""
    sym, asset = c["sym"], c["asset"]
    base = {"id": c["id"], "symbol": sym.display, "asset": asset, "setup": c["setup"]}
    if c.get("skip"):
        return _decision(reasons=[c["skip"]], **base)
    ap = cfg.get("autopilot") or {}
    _write_entry(c)
    plan = make_plan(c, cfg)
    base.update(entry=plan["entry"]["price"], stop=plan["stop"]["price"], target=plan["target"]["price"])
    ensure_backtest(c, plan, cfg, limits)
    run_timemachine(plan, cfg, limits)
    desk = _mod("trader-desk", "desk").auto_review(plan["id"], cfg, limits, force=True, symbol=plan["symbol"])
    blocking = [o for o in desk.get("objections") or [] if o.get("severity") in ("critical", "major")]
    gates = [{"name": g["name"], "ok": g["ok"], "detail": g["detail"]} for g in desk.get("gates") or []]
    desk_info = {"status": desk.get("status"), "objections": len(desk.get("objections") or [])}
    if desk.get("status") != "GO":
        reasons = ["desk %s: %s" % (desk.get("status"), o["text"]) for o in blocking] or \
                  ["desk %s: %s" % (desk.get("status"), b) for b in desk.get("blockers") or []] or \
                  ["desk %s" % desk.get("status")]
        return _decision(reasons=reasons, desk=desk_info, gates=gates, **base)
    now = market_clock.now_utc()
    max_new = int(ap.get("max_new_trades_per_day", 3))
    if _count_today(book, now) >= max_new:
        return _decision(reasons=["daily cap reached: %d new trades today (autopilot.max_new_trades_per_day)" % max_new],
                         desk=desk_info, gates=gates, **base)
    lim = limits.get(asset) or {}
    busy = [it for it in book["items"].values() if it["status"] in ("pending", "open")]
    for scope, cap, n in ((asset, lim.get("max_open_positions"), sum(1 for it in busy if it["asset"] == asset)),
                          ("global", (limits.get("global") or {}).get("max_open_positions"), len(busy))):
        if cap is not None and n >= int(cap):
            return _decision(reasons=["%d open/pending %s position(s) — max %s" % (n, scope, cap)], desk=desk_info,
                             gates=gates, **base)
    sizer = _mod("trader-sizer", "size")
    risk = _mod("trader-risk", "risk")
    try:
        order = sizer.size_order(plan, cfg, limits, account=acct.get("equity") or None)
    except ValueError as exc:
        return _decision(reasons=["sizer: %s" % exc], desk=desk_info, gates=gates, **base)
    order["origin"] = "autopilot"
    sizer.save_order(order)
    res = risk.evaluate(order, cfg, limits)
    risk.save_result(order["id"], res)
    gates += [{"name": "risk · " + ch["name"], "ok": ch["ok"], "detail": ch["detail"]} for ch in res["checks"]]
    base.update(order_id=order["id"], qty=order["qty"])
    if res["result"] != "PASS":
        return _decision(reasons=["risk BLOCK: %s" % r for r in res["reasons"]], desk=desk_info, gates=gates, **base)
    bsym = broker_symbol(plan["symbol"], asset)
    text = "BUY %s %s, limit %s, stop %s, target %s — %s" % (
        fmt.qty(order["qty"]), bsym, fmt.price(order["limit_price"]), fmt.price(order["stop_price"]),
        fmt.price(order["target_price"]), broker.mode.upper())
    cash = float(acct.get("buying_power") or acct.get("cash") or 0)
    if order["notional_usd"] > cash + 1e-6:
        return _decision(reasons=["not enough buying power: %s needed, %s available" % (
            fmt.money(order["notional_usd"]), fmt.money(cash))], desk=desk_info, gates=gates, **base)
    if not approved:
        return _decision(reasons=["dry run — the autopilot is not enabled (autopilot.enabled or --approve); "
                                  "it would have placed: " + text], desk=desk_info, gates=gates, dry_run=True, **base)
    try:
        bo = broker.place_entry({"client_order_id": order["id"], "symbol": bsym, "asset": asset, "qty": order["qty"],
                                 "limit_price": order["limit_price"], "stop_price": order["stop_price"],
                                 "target_price": order["target_price"]})
    except BrokerError as exc:
        _update_order(order["id"], status="error", error=str(exc))
        return _decision(action="error", reasons=["broker refused: %s" % exc], desk=desk_info, gates=gates, **base)
    state.append_jsonl("approvals.jsonl", {
        "ts": market_clock.iso(now), "ticket_id": None, "order_id": order["id"], "ticket_hash": res["order_hash"],
        "ticket_text": text, "mode": broker.mode, "user_reply": APPROVAL_TEXT, "approved": True, "asset": asset,
        "symbol": order["symbol"], "source": "autopilot"})
    _update_order(order["id"], status="submitted", broker=broker.name, broker_order_id=bo.get("id"))
    book["items"][plan["id"]] = {
        "plan_id": plan["id"], "order_id": order["id"], "broker_order_id": bo.get("id"), "broker": broker.name,
        "mode": broker.mode, "symbol": bsym, "data_key": sym.key, "asset": asset, "qty": order["qty"],
        "qty_unit": order.get("qty_unit"), "stop": order["stop_price"], "target": order["target_price"],
        "time_stop": plan["time_stop"]["at"], "status": "pending", "placed_at": market_clock.iso(now)}
    return _decision(action="taken", reasons=["desk GO, risk PASS — " + text], desk=desk_info, gates=gates,
                     broker_order_id=bo.get("id"), **base)


# --- the cycle ------------------------------------------------------------------------------------------

def _state(**fields) -> dict:
    st = state.read_json(STATE, {}) or {}
    st.update(fields)
    state.write_json(STATE, st)
    return st


def _today_summary(book: dict, now, kill_reason=None) -> dict:
    day = _today(now)
    taken = skipped = 0
    for d in state.read_jsonl(DECISIONS):
        if (d.get("at") or "")[:10] != day:
            continue
        if d.get("action") == "taken":
            taken += 1
        elif d.get("action") == "skipped":
            skipped += 1
    return {"date": day, "trades_opened": taken, "realized_pnl": round(_realized_today(now), 2), "skipped": skipped,
            "kill_reason": kill_reason}


def _cycle(approved=None) -> dict:
    cfg, limits = config.load_config(), config.load_limits()
    ap = cfg.get("autopilot") or {}
    now = market_clock.now_utc()
    now_iso = market_clock.iso(now)
    interval = int(ap.get("interval_sec") or 60)
    approved = _approved(cfg, approved)
    prev = state.read_json(STATE, {}) or {}
    control = read_control()
    common = {"interval_sec": interval, "last_cycle": now_iso,
              "next_cycle": market_clock.iso(now.timestamp() + interval), "cycles": int(prev.get("cycles") or 0) + 1,
              "started_at": prev.get("started_at") or now_iso, "approved": approved, "dry_run": not approved}
    try:
        broker = brokers.get(cfg)
    except BrokerError as exc:
        _state(status="error", mode=brokers.mode_of(cfg), broker=ap.get("broker") or "simulator", message=str(exc),
               last_errors=(prev.get("last_errors") or [])[-9:] + [{"at": now_iso, "error": str(exc)}], **common)
        return {"status": "error", "message": str(exc), "actions": [], "errors": [str(exc)]}
    common.update(mode=broker.mode, broker=broker.name)
    book = _book()
    actions, errors = [], []

    def sync():
        broker.sync()
        acct, pos, ords = broker.account(), broker.positions(), broker.orders()
        return acct, pos, ords

    acct, positions, orders = sync()
    actions += reconcile(broker, book, positions, orders, cfg, limits)

    kill_reason = None
    if control["kill"]:
        kill_reason = "kill switch (%s)" % (control.get("by") or "control")
    else:
        unreal = sum(float(p.get("unrealized_pl") or 0) for p in positions)
        realized = _realized_today(now)
        cap = (limits.get("global") or {}).get("max_daily_loss_usd")
        if cap is not None and realized + unreal <= -float(cap):
            kill_reason = "daily loss %s reached the %s limit" % (fmt.money(realized + unreal), fmt.money(cap))
    if kill_reason:
        actions += kill(broker, book, cfg, kill_reason)
        acct, positions, orders = sync()
        actions += reconcile(broker, book, positions, orders, cfg, limits)
        write_control(by="autopilot", kill=False, paused=True, run_once=False)
        state.write_json(BOOK, book)
        line = _write_broker_files(broker, acct, positions, orders, book, _realized_today(now))
        msg = "KILLED — %s. Orders cancelled%s. Resume to trade again." % (
            kill_reason, ", positions closed" if ap.get("flatten_on_kill", True) else "")
        _state(status="killed", message=msg, today=_today_summary(book, now, kill_reason), equity=line, **common)
        return {"status": "killed", "message": msg, "actions": actions, "errors": errors}

    exits = manage_exits(broker, book, positions, orders)
    if exits:
        actions += exits
        acct, positions, orders = sync()
        actions += reconcile(broker, book, positions, orders, cfg, limits)

    status = "paused" if control["paused"] and not control["run_once"] else "running"
    if prev.get("status") == "killed" and control["paused"]:
        status = "killed"
    decisions = []
    if status == "running":
        memo = {}
        try:
            cands, notes = find_triggers(cfg, book, memo)
        except Exception as exc:  # a bad symbol must not stop exits from being managed next cycle
            cands, notes = [], []
            errors.append("trigger scan: %s: %s" % (type(exc).__name__, exc))
        handled = book["handled"].setdefault(_today(now), {})
        for c in cands:
            try:
                d = judge(c, cfg, limits, broker, book, approved, acct)
            except (data.DataUnavailable, ValueError, BrokerError) as exc:
                d = _decision(action="error", id=c["id"], symbol=c["sym"].display, asset=c["asset"], setup=c["setup"],
                              reasons=["%s: %s" % (type(exc).__name__, exc)])
                errors.append("%s: %s" % (c["id"], exc))
            handled[c["id"]] = d["action"]
            decisions.append(d)
            if d["action"] == "taken":
                acct = broker.account()
        if control["run_once"]:
            write_control(by="autopilot", run_once=False)
    state.write_json(BOOK, book)
    if decisions:
        acct, positions, orders = sync()
    line = _write_broker_files(broker, acct, positions, orders, book, _realized_today(now))
    open_n = sum(1 for it in book["items"].values() if it["status"] == "open")
    pend_n = sum(1 for it in book["items"].values() if it["status"] == "pending")
    wl = watchlist(cfg)
    msg = "%s · watching %d symbols · %d open, %d pending%s" % (
        status, sum(len(v) for v in wl.values()), open_n, pend_n, "" if approved else " · DRY RUN (not enabled)")
    taken = [d for d in decisions if d["action"] == "taken"]
    if taken:
        msg += " · placed " + ", ".join("%s %s" % (d["symbol"], d["setup"]) for d in taken)
    last_errors = (prev.get("last_errors") or [])
    last_errors = (last_errors + [{"at": now_iso, "error": e} for e in errors])[-10:]
    _state(status=status, message=msg, today=_today_summary(book, now), equity=line, last_errors=last_errors, **common)
    actions += ["%s %s %s" % (d["action"], d["symbol"], d["setup"]) for d in decisions]
    return {"status": status, "message": msg, "actions": actions, "errors": errors,
            "decisions": [{"id": d["id"], "action": d["action"], "reasons": d["reasons"]} for d in decisions]}


def run_cycle(now=None, approved=None) -> dict:
    """One autopilot cycle. Thread-safe to call from the dashboard; never raises.

    now: optional ISO time to pin the clock for this cycle (replays). approved: True/False overrides
    config autopilot.enabled for this cycle (the dashboard's --autopilot flag passes True).
    """
    saved = os.environ.get("TRADER_NOW")
    try:
        if now:
            os.environ["TRADER_NOW"] = market_clock.iso(market_clock.parse_iso(now))
        config.ensure_home()
        return _cycle(approved)
    except Exception as exc:  # never let the dashboard thread die
        err = "%s: %s" % (type(exc).__name__, exc)
        try:
            prev = state.read_json(STATE, {}) or {}
            _state(status="error", message=err, last_cycle=market_clock.iso(market_clock.now_utc()),
                   last_errors=(prev.get("last_errors") or [])[-9:] + [
                       {"at": market_clock.iso(market_clock.now_utc()), "error": err}])
        except Exception:
            pass
        return {"status": "error", "message": err, "actions": [], "errors": [err]}
    finally:
        if now:
            if saved is None:
                os.environ.pop("TRADER_NOW", None)
            else:
                os.environ["TRADER_NOW"] = saved


# --- CLI ----------------------------------------------------------------------------------------------------

def build_parser():
    p = cli.parser("autopilot.py", __doc__)
    p.add_argument("action", choices=("status", "run", "loop", "pause", "resume", "kill", "replay", "check-live"))
    p.add_argument("--once", action="store_true", help="run: a single cycle (default)")
    p.add_argument("--approve", action="store_true",
                   help="standing approval for this run (otherwise config autopilot.enabled decides; else dry run)")
    p.add_argument("--interval", type=int, help="loop: seconds between cycles (default config autopilot.interval_sec)")
    p.add_argument("--max-cycles", type=int, help="loop: stop after N cycles")
    p.add_argument("--confirm", help='kill: must be "KILL"')
    p.add_argument("--from", dest="start", help="replay: start time (ISO)")
    p.add_argument("--to", dest="end", help="replay: end time (ISO)")
    p.add_argument("--step", default="5m", help="replay: clock step (default 5m)")
    return p


def status_text(cfg: dict) -> str:
    st = state.read_json(STATE, {}) or {}
    ok_live, missing = brokers.live_readiness(cfg)
    lines = ["AUTOPILOT · %s · broker %s" % ((st.get("mode") or brokers.mode_of(cfg)).upper(),
                                            st.get("broker") or (cfg.get("autopilot") or {}).get("broker")),
             "Status: %s — %s" % (st.get("status") or "never run", st.get("message") or ""),
             "Standing approval: %s" % ("yes (autopilot.enabled)" if (cfg.get("autopilot") or {}).get("enabled")
                                        else "no — dry run unless you pass --approve")]
    if st.get("last_cycle"):
        lines.append("Last cycle %s · %d cycles" % (st["last_cycle"], st.get("cycles") or 0))
    t = st.get("today") or {}
    if t:
        lines.append("Today %s: %d opened · %d skipped · realized %s" % (
            t.get("date"), t.get("trades_opened", 0), t.get("skipped", 0), fmt.money(t.get("realized_pnl"))))
    for p in state.read_json("broker/positions.json", []) or []:
        lines.append("  %s %s @ %s · last %s · %s" % (fmt.qty(p["qty"]), p["symbol"], fmt.price(p["avg_entry"]),
                                                    fmt.price(p.get("last")), fmt.money(p.get("unrealized_pl"))))
    lines.append("Live trading: %s" % ("READY (all opt-in steps done)" if ok_live else "off"))
    return "\n".join(lines)


def replay(args, cfg) -> dict:
    if not args.start or not args.end:
        raise ValueError("replay needs --from and --to")
    t = market_clock.ts(args.start)
    end = market_clock.ts(args.end)
    step = market_clock.parse_horizon(args.step)
    approved = True if args.approve else None
    started = time.time()
    n = 0
    results = []
    while t <= end:
        res = run_cycle(market_clock.iso(t), approved)
        n += 1
        if res.get("actions"):
            results.append({"at": market_clock.iso(t), "actions": res["actions"]})
        t += step
    os.environ["TRADER_NOW"] = market_clock.iso(end)
    return {"cycles": n, "seconds": round(time.time() - started, 1), "events": results}


def replay_text(rep: dict) -> str:
    lines = ["AUTOPILOT REPLAY · %d cycles in %.1f s" % (rep["cycles"], rep["seconds"])]
    for ev in rep["events"]:
        for a in ev["actions"]:
            lines.append("  %s  %s" % (market_clock.fmt_utc(ev["at"]), a))
    decisions = state.read_jsonl(DECISIONS)
    taken = [d for d in decisions if d.get("action") == "taken"]
    skipped = [d for d in decisions if d.get("action") == "skipped"]
    lines.append("Decisions: %d taken · %d skipped · %d errors" % (
        len(taken), len(skipped), sum(1 for d in decisions if d.get("action") == "error")))
    for d in skipped[:12]:
        lines.append("  skipped %-8s %-14s %s" % (d["symbol"], d["setup"], (d["reasons"] or [""])[0][:110]))
    trades = [t for t in (state.read_json("journal.json", {}) or {}).get("trades") or [] if t.get("source") == "autopilot"]
    for t in trades:
        ex = t.get("exit") or {}
        lines.append("  trade %s %s %s → %s (%s) · %s · %s" % (
            t["display"], fmt.qty(t["qty"]), fmt.price(t["entry"]["price"]), fmt.price(ex.get("price")),
            ex.get("reason") or "open", fmt.r(t.get("r_multiple")), fmt.money(t.get("pnl_usd"))))
    st = state.read_json(STATE, {}) or {}
    eq = st.get("equity") or {}
    lines.append("Equity %s · cash %s · %s" % (fmt.money(eq.get("equity")), fmt.money(eq.get("cash")), st.get("message")))
    return "\n".join(lines)


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    cfg = ctx.cfg
    if args.action == "check-live":
        ok, missing = brokers.live_readiness(cfg)
        text = "Live trading is %s." % ("READY — every opt-in step is in place" if ok else "OFF") + "".join(
            "\n  missing: %s" % m for m in missing)
        cli.emit(args, text, {"live_ready": ok, "missing": missing})
        return 0
    if args.action == "pause":
        write_control(paused=True)
        cli.emit(args, "Paused — no new entries; exits and time stops keep running.", read_control())
        return 0
    if args.action == "resume":
        write_control(paused=False, kill=False)
        cli.emit(args, "Resumed — new entries allowed on the next cycle.", read_control())
        return 0
    if args.action == "kill":
        if args.confirm != "KILL":
            cli.fail('kill needs --confirm KILL (it cancels every order and closes every position)')
        write_control(kill=True)
        res = run_cycle(approved=False)
        cli.emit(args, "\n".join([res["message"]] + ["  " + a for a in res["actions"]]), res)
        return 0
    if args.action == "status":
        cli.emit(args, status_text(cfg), {"state": state.read_json(STATE, {}), "control": read_control(),
                                         "live_ready": brokers.live_readiness(cfg)[0]})
        return 0
    approved = True if args.approve else None
    if args.action == "run":
        res = run_cycle(approved=approved)
        cli.emit(args, "\n".join([res["message"]] + ["  " + a for a in res["actions"]] +
                                 ["  error: " + e for e in res["errors"]]), res)
        return 0 if res["status"] != "error" else 1
    if args.action == "replay":
        rep = replay(args, cfg)
        cli.emit(args, replay_text(rep), rep)
        return 0
    # loop
    interval = int(args.interval or (cfg.get("autopilot") or {}).get("interval_sec") or 60)
    n = 0
    while True:
        res = run_cycle(approved=approved)
        n += 1
        if not args.json:
            print("%s  %s" % (market_clock.iso(market_clock.now_utc()), res["message"]))
            for a in res["actions"]:
                print("    " + a)
            sys.stdout.flush()
        if args.max_cycles and n >= args.max_cycles:
            break
        if os.environ.get("TRADER_NOW"):
            print("clock is pinned (--now/--offline) — one cycle per loop makes no sense; stopping")
            break
        waited = 0
        while waited < interval:
            time.sleep(1)
            waited += 1
            if read_control()["run_once"]:
                break
    return 0


if __name__ == "__main__":
    cli.run(main)
