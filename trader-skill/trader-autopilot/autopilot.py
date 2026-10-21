#!/usr/bin/env python3
"""Autopilot — trades for you around the clock, but only what clears every gate. Simulator / paper by default.

Each cycle: read the controls → sync the broker → journal fills and exits → learn from the closed
trades (pause losing setups, cool off losing symbols, smaller size after a losing streak, pause on a
drawdown) → manage exits (stock time stop 3:55 p.m. ET, crypto horizon / target / protective stop) →
daily-loss kill switch → scan its own universe (liquid US stocks ranked by today's movement plus
the day's most active names in the session; the most traded coins 24/7) once per closed 5-min bar →
for each fresh trigger: entry → exit plan → backtest → Time Machine → latest news and SEC filings →
rule-based desk → optional AI desk (veto only) → size → risk check → place the order. Every trigger it
looks at lands in trader/autopilot/decisions.jsonl with the reasons it was taken or skipped.

Turning it on (config autopilot.enabled true, or --approve) is a standing approval for orders that pass
every gate. Without it the autopilot runs as a dry run: same analysis, no orders. Meme coins are never
auto-traded. Live money needs the full opt-in in docs/SCHEMAS.md — it never switches to live by itself.

Examples:
  python3 autopilot.py daemon --approve            # 24/7: one instance per trader/ folder, stops on SIGTERM
  python3 autopilot.py status
  python3 autopilot.py run --once --approve
  python3 autopilot.py loop --approve --interval 60
  python3 autopilot.py universe [--refresh] | learned | notify-test
  python3 autopilot.py pause | resume | kill --confirm KILL | check-live
  python3 autopilot.py profile --risk 2 --leverage 1.5 --capital 1000 [--write]   # the backtested daily-trend setup
  python3 autopilot.py check                       # is it normal? did it do what the rules say?
  python3 autopilot.py replay --from 2026-10-20T13:35:00Z --to 2026-10-20T20:00:00Z --approve --offline
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import signal
import socket
import sys
import threading
import time

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import adapt, brokers, cli, config, data, fmt, market_clock, notify, setups, skills, state  # noqa: E402
from shared import health, indicators, shadow, symbols, universe  # noqa: E402
from shared.brokers import BrokerError, broker_symbol  # noqa: E402

STATE = "autopilot/state.json"
CONTROL = "autopilot/control.json"
DECISIONS = "autopilot/decisions.jsonl"
BOOK = "autopilot/book.json"
SCAN = "autopilot/scan.json"
HEARTBEAT = "autopilot/heartbeat.json"
LOCK = "autopilot/daemon.lock"
INTERVAL = "5m"
STALE_ENTRY_BARS = 3          # an entry that has not filled 15 min after the trigger is cancelled
NO_NEW_STOCK_ENTRIES = (15, 30)  # ET — too little session left for a 2R move before the 3:55 time stop
TM_SEED = 7
APPROVAL_TEXT = "autopilot standing approval (config autopilot.enabled)"
STALE_LOCK_SEC = 600
ERROR_ALERT_AFTER = 5         # consecutive failed cycles before an "error" notification
MAX_BACKOFF_SEC = 900
_MODS = {}
_PROCESS = {"started_at": None}


def _mod(skill: str, module: str):
    key = skill + "/" + module
    if key not in _MODS:
        _MODS[key] = skills.load(skill, module)
    return _MODS[key]


# --- small state helpers -------------------------------------------------------------------------

def read_control() -> dict:
    c = state.read_json(CONTROL, {}) or {}
    return {"paused": bool(c.get("paused")), "kill": bool(c.get("kill")), "run_once": bool(c.get("run_once")),
            "updated_at": c.get("updated_at"), "by": c.get("by"), "dd_reset_at": c.get("dd_reset_at")}


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
            "broker_order_id": None, "entry": None, "stop": None, "target": None, "qty": None, "dry_run": False,
            "ai": None}
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
        if p["plan_id"]:
            it = book["items"][p["plan_id"]]
            p["story"] = position_story(it)
            p["riding"] = (it.get("runner") or {}).get("status") == "riding"
    state.write_json("broker/positions.json", positions)
    state.write_json("broker/orders.json", orders[-200:])
    unreal = sum(float(p.get("unrealized_pl") or 0) for p in positions)
    line = {"at": market_clock.iso(market_clock.now_utc()), "equity": acct.get("equity"), "cash": acct.get("cash"),
            "unrealized": round(unreal, 2), "realized_today": round(realized_today, 2), "mode": broker.mode}
    for k in ("borrowed", "interest_paid", "interest_earned"):  # only when leverage or cash interest is in play
        if acct.get(k):
            line[k] = acct[k]
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
    if reason in ("manual", "rule") and item.get("exit_note"):
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
            ride = it.get("runner") or {}
            if ride.get("status") == "selling":
                o = _find(orders, ride.get("sell_order_id"))
                if o and o.get("status") == "filled":
                    actions += start_ride(broker, it, o, cfg)
                elif (o and o.get("status") in ("canceled", "expired", "rejected")) or (
                        not o and now.timestamp() - market_clock.ts(ride.get("asked_at") or it["placed_at"]) > 6 * step):
                    # its protective stop is already cancelled, so sell everything now rather than wait
                    ride["status"] = "failed"
                    what = o["status"] if o else "not seen at the broker after %d min" % (6 * step // 60)
                    it["exit_note"] = (it.get("exit_note") or "exit rule") + " · the partial sale was %s" % what
                    it["exit_reason"], it["stop_order_id"] = "rule", None
                    try:
                        broker.close_position(it["symbol"])
                        actions.append("partial sale of %s %s — sold everything instead" % (it["symbol"], what))
                    except BrokerError as exc:
                        actions.append("partial sale of %s %s and closing failed (%s) — the bot watches the stop"
                                       % (it["symbol"], what, exc))
                continue
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
            line = "closed %s (%s) @ %s · P&L %s" % (it["symbol"], reason, fmt.price(ex.get("filled_avg_price")),
                                                    fmt.money((trade or {}).get("pnl_usd")))
            actions.append(line)
            t = trade or {}
            notify.send("trade_closed", "%s closed %s · %s" % (it["symbol"], fmt.r(t.get("r_multiple")),
                                                                fmt.money(t.get("pnl_usd"))),
                        "%s exit @ %s (%s, %s). Entry %s, qty %s." % (
                            reason, fmt.price(ex.get("filled_avg_price")), it["mode"], it["broker"],
                            fmt.price(it.get("entry_fill")), fmt.qty(it["qty"])), cfg)
    return actions


def rule_exit_due(it: dict) -> str:
    """'' or why a rule-exit position should close now: a bar that closed after the fill met the rule."""
    rule = it.get("exit_rule") or {}
    if rule.get("type") not in ("close_above_sma", "close_below_low", "close_below_ema"):
        return ""
    interval, n = rule.get("interval") or "1d", int(rule.get("n") or 5)
    step = market_clock.interval_seconds(interval)
    need = 4 * n if rule["type"] == "close_below_ema" else n + 3  # an EMA needs a run-in to settle
    try:
        days = need * step / 86400.0 if it.get("asset", "crypto") != "stock" else need + 5  # stocks: sessions
        bars = data.get_candles(it["data_key"], interval, days=days, asset=it.get("asset") or "crypto").candles
    except (data.DataUnavailable, ValueError, KeyError):
        return ""
    since = (it.get("runner") or {}).get("since") or it.get("filled_at") or it["placed_at"]
    if len(bars) <= n or bars[-1].t + step <= market_clock.ts(since):
        return ""
    closes = [b.c for b in bars]
    if not setups.rule_says_exit(rule, closes, len(closes) - 1):
        return ""
    if rule["type"] == "close_above_sma":
        return "the %s close %s is above the %d-bar average %s" % (
            setups.bar_label(interval), fmt.price(closes[-1]), n, fmt.price(sum(closes[-n:]) / float(n)))
    if rule["type"] == "close_below_ema":
        return "the %s close %s is below the %d-bar EMA %s — the trend is broken" % (
            setups.bar_label(interval), fmt.price(closes[-1]), n, fmt.price(indicators.ema(closes, n)[-1]))
    return "the %s close %s is below the lowest close of the previous %d bars (%s)" % (
        setups.bar_label(interval), fmt.price(closes[-1]), n, fmt.price(min(closes[-n - 1:-1])))


# --- letting part of a winner ride ----------------------------------------------------------------------

def ride_check(it: dict, p: dict, cfg: dict = None) -> tuple:
    """(ok, why not): may part of this position ride on now that its exit rule fired?"""
    ride = it.get("runner") or {}
    cfg = cfg or config.load_config()
    c = (cfg.get("costs") or {}).get(it["asset"]) or {}
    round_trip = 2 * (float(c.get("fee_bps") or 0) + float(c.get("slippage_bps") or 0)) / 10000.0
    entry = float(it.get("entry_fill") or it.get("entry_plan") or 0)
    last = float(p.get("last") or 0)
    if not entry or last <= entry * (1 + round_trip):
        return False, "not in profit after costs (%s vs entry %s)" % (fmt.price(last), fmt.price(entry))
    n = int(ride.get("min_sma") or 200)
    try:
        bars = data.get_candles(it["data_key"], "1d", days=n + 20, asset=it["asset"]).candles
    except (data.DataUnavailable, ValueError, KeyError) as exc:
        return False, "no daily prices to check the %d-day average (%s)" % (n, exc)
    closes = [b.c for b in bars]
    if len(closes) < n:
        return False, "only %d daily closes — the %d-day average needs %d" % (len(closes), n, n)
    avg = sum(closes[-n:]) / float(n)
    if closes[-1] <= avg:
        return False, "the coin is below its %d-day average (%s ≤ %s) — no trend left to ride" % (
            n, fmt.price(closes[-1]), fmt.price(avg))
    step = data.lot_info(data.as_symbol(it["data_key"], it["asset"])).get("step") or 0.000001
    floor_to = _mod("trader-sizer", "size").floor_to
    sell = floor_to(float(it["qty"]) * (1 - float(ride["keep"])), step)
    keep = round(float(it["qty"]) - sell, 10)
    if sell <= 0 or keep <= 0:
        return False, "the position is too small to split (%s)" % fmt.qty(it["qty"])
    ride.update(sell_qty=sell, keep_qty=keep)
    return True, None


def sell_part(broker, it: dict, orders: list, cfg: dict = None) -> list:
    """Sell the part that leaves now; the rest rides on with its stop at the buy price."""
    ride = it["runner"]
    for o in orders:  # the protective stop covers the whole position — a new one comes for the part that stays
        if o.get("symbol") == it["symbol"] and o.get("status") in ("new", "held", "accepted", "pending_new"):
            try:
                broker.cancel(o["id"])
            except BrokerError:
                pass
    try:
        o = broker.place_exit(it["symbol"], ride["sell_qty"], "market", client_order_id=it["order_id"] + "-part",
                              asset=it["asset"])
    except BrokerError as exc:
        ride["status"] = "failed"
        it["exit_note"] = it.get("exit_note", "") + " · could not sell part (%s) — selling everything" % exc
        return ["could not sell part of %s: %s — closing all of it" % (it["symbol"], exc)]
    ride.update(status="selling", sell_order_id=o.get("id"), asked_at=market_clock.iso(market_clock.now_utc()))
    if o.get("status") == "filled":
        return start_ride(broker, it, o, cfg)
    return ["%s: selling %s of %s — %s will ride on" % (it["symbol"], setups.keep_text(1 - ride["keep"]),
                                                       fmt.qty(it["qty"]), setups.keep_text(ride["keep"]))]


def start_ride(broker, it: dict, sold: dict, cfg: dict = None) -> list:
    """The partial sale filled: book it as its own closed trade, keep the rest as a new open trade."""
    cfg = cfg or config.load_config()
    journal = _mod("trader-journal", "journal")
    ride = it["runner"]
    sold_qty = float(sold.get("filled_qty") or ride["sell_qty"])
    keep_qty = round(float(it["qty"]) - sold_qty, 10)
    price = float(sold.get("filled_avg_price") or 0)
    at = sold.get("filled_at") or market_clock.iso(market_clock.now_utc())
    entry = float(it.get("entry_fill") or it.get("entry_plan"))
    first = journal.get_trade(it.get("trade_id"))
    rest = None
    if first:
        rest = copy.deepcopy(first)
        first["qty"] = sold_qty
        journal.finalize(first, cfg, price, at, "rule")
        first["exit"]["broker_order_id"] = sold.get("id")
        first["runner"] = {"part": "sold", "of_qty": float(it["qty"])}
        first["notes"] = (first.get("notes") or "") + " · " + (it.get("exit_note") or "exit rule") + \
            " · sold %s; %s ride on as %s" % (setups.keep_text(1 - ride["keep"]), setups.keep_text(ride["keep"]),
                                              first["id"] + "-ride")
        journal.save_trade(first)
        rest.update(id=first["id"] + "-ride", qty=keep_qty, stop=max(float(rest.get("stop") or 0), entry),
                    runner={"part": "ride", "from": first["id"]},
                    notes="the %s left riding the trend after %s; stop at the buy price" % (
                        setups.keep_text(ride["keep"]), first["id"]))
        journal.save_trade(rest)
    rpu = float((first or {}).get("risk_per_unit") or 0) or (entry - float(it["stop"]))
    days = int(ride["exit_rule"].get("max_bars") or 250)
    now = market_clock.now_utc()
    ride.update(status="riding", since=at, sold_qty=sold_qty, sold_price=price, sold_at=at,
                sold_r=round((price - entry) / rpu, 2) if rpu > 0 else None, part_trade_id=(first or {}).get("id"))
    it.update(qty=keep_qty, trade_id=(rest or {}).get("id", it.get("trade_id")), stop=max(float(it["stop"]), entry),
              exit_rule=ride["exit_rule"], target=round(entry + RIDE_TARGET_R * rpu, 10) if rpu > 0 else it["target"],
              time_stop=market_clock.iso(now.timestamp() + days * 86400))
    it.pop("exit_note", None)
    acts = ["%s: sold %s at %s (%s) — %s ride on until %s, stop moved to the buy price %s" % (
        it["symbol"], fmt.qty(sold_qty), fmt.price(price), fmt.r(ride["sold_r"]), fmt.qty(keep_qty),
        ride["exit_rule"]["short"], fmt.price(it["stop"]))]
    if it["asset"] == "crypto":
        try:
            so = broker.place_stop(it["symbol"], keep_qty, it["stop"], client_order_id=it["order_id"] + "-ride-stop",
                                   asset="crypto")
            it["stop_order_id"] = so.get("id")
        except BrokerError as exc:
            it["stop_order_id"] = None  # the bot itself watches the stop until a new order goes in
            acts.append("could not place the new stop for %s: %s — the bot watches it" % (it["symbol"], exc))
    notify.send("trade_closed", "%s: sold %s %s, %s ride on" % (
        it["symbol"], setups.keep_text(1 - ride["keep"]), fmt.r(ride["sold_r"]), setups.keep_text(ride["keep"])),
        position_story(it), cfg)
    return acts


def position_story(it: dict) -> str:
    """What the bot holds and what it will do next — in plain words."""
    ride = it.get("runner") or {}
    entry = it.get("entry_fill") or it.get("entry_plan")
    head = "%s %s bought at %s (%s)." % (fmt.qty(it.get("qty")), it.get("symbol"), fmt.price(entry),
                                         it.get("setup") or "setup")
    if ride.get("status") == "riding":
        return ("%s Sold %s at %s (%s) on %s. The rest rides the trend: it is sold at the %s, and the stop sits at "
                "the buy price %s, so this part can no longer turn into a loss." % (
                    "%s %s left of a trend trade bought at %s." % (fmt.qty(it.get("qty")), it.get("symbol"),
                                                                    fmt.price(entry)),
                    fmt.qty(ride.get("sold_qty")), fmt.price(ride.get("sold_price")), fmt.r(ride.get("sold_r")),
                    str(ride.get("sold_at") or "")[:10], (ride.get("exit_rule") or {}).get("text"),
                    fmt.price(it.get("stop"))))
    rule = it.get("exit_rule") or {}
    parts = [head, "Stop %s." % fmt.price(it.get("stop"))]
    if rule:
        parts.append("Sells at the %s." % rule.get("text"))
    else:
        parts.append("Target %s, time stop %s." % (fmt.price(it.get("target")), str(it.get("time_stop") or "")[:16]))
    if ride.get("status") == "planned":
        parts.append("If that comes in profit while the coin is above its %d-day average, it sells only %s and lets "
                     "%s ride until the %s." % (int(ride.get("min_sma") or 200), setups.keep_text(1 - ride["keep"]),
                                                setups.keep_text(ride["keep"]), (ride.get("exit_rule") or {}).get("text")))
    if ride.get("status") == "selling":
        parts.append("Selling %s now; %s will ride on." % (setups.keep_text(1 - ride["keep"]),
                                                          setups.keep_text(ride["keep"])))
    return " ".join(parts)


def manage_exits(broker, book: dict, positions: list, orders: list, cfg: dict = None) -> list:
    """Time stops for everything; target/stop management for crypto (Alpaca has no crypto brackets); exit rules."""
    actions = []
    now_ts = market_clock.now_utc().timestamp()
    pos_by = {p["symbol"]: p for p in positions}
    for it in book["items"].values():
        if it["status"] != "open" or (it.get("runner") or {}).get("status") == "selling":
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
        if not reason and it.get("exit_rule") and (
                it["asset"] != "stock" or market_clock.market_status(market_clock.now_utc())["state"] == "open"):
            why = rule_exit_due(it)
            if why:
                reason = "rule"
                it["exit_note"] = "exit rule: " + why
        if not reason:
            continue
        if reason == "rule" and (it.get("runner") or {}).get("status") == "planned":
            ok, why_not = ride_check(it, p, cfg)
            if ok:
                actions += sell_part(broker, it, orders, cfg)
                if (it.get("runner") or {}).get("status") != "failed":
                    continue
            else:
                it["runner"]["status"] = "skipped"
                it["exit_note"] += " · sold everything: " + why_not
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


def watched(cfg: dict, broker=None, now=None) -> tuple:
    """The symbols to scan this cycle: the self-picked universe (or the watchlists), never meme coins."""
    assets = (cfg.get("autopilot") or {}).get("assets") or ["stock", "crypto"]
    notes = []
    try:
        uni = universe.current(cfg, now=now, broker=broker)
    except Exception as exc:  # a broken universe source must not stop the bot — fall back to the watchlists
        uni = watchlist(cfg)
        notes.append("universe unavailable (%s: %s) — scanning the watchlists" % (type(exc).__name__, exc))
    return {a: list(uni.get(a) or []) for a in ("stock", "crypto") if a in assets}, notes


SERIES_HISTORY_DAYS = {"1h": 12, "4h": 45, "1d": 300}   # enough closed bars for the 200-bar averages
RULE_TARGET_CAP_R = 10.0   # rule-exit plans still carry a target (brackets, gates); it is far away on purpose
RIDE_TARGET_R = 100.0      # the part that rides on has no real target — the trend decides


def add_playbook_coins(uni: dict, pbs: dict, cfg: dict, limits: dict, broker=None) -> list:
    """Validated coins are watched even when they are not in today's top by volume (exclusions still win)."""
    if "crypto" not in uni or not pbs.get("required") or not pbs.get("playbook"):
        return []
    have = set()
    for raw in uni["crypto"]:
        try:
            have.add(data.as_symbol(raw, "crypto").key)
        except (symbols.SymbolError, ValueError):
            continue
    blocked = {str(x).upper() for x in ((cfg.get("autopilot") or {}).get("universe") or {}).get("exclude") or []}
    blocked |= {str(x).upper() for x in limits.get("blocked_symbols") or []}
    try:
        tradable = broker.tradable("crypto") if broker is not None else None
    except Exception:
        tradable = None
    added = []
    for key, entries in sorted(pbs["by_coin"].items()):
        if key in have or key in blocked:
            continue
        sym = data.as_symbol(key, "crypto")
        if sym.base in blocked or sym.display.upper() in blocked or (tradable is not None and sym.base not in tradable):
            continue
        uni["crypto"].append(key)
        added.append(key)
    return added


def playbook_state(cfg: dict, now=None) -> dict:
    """Is crypto gated by the backtest lab, and which coin+setup+timeframe combinations did it validate?"""
    pb_cfg = (cfg.get("autopilot") or {}).get("playbook") or {}
    required = bool(pb_cfg.get("required_for_crypto", True))
    lab = _mod("trader-backtest", "lab")
    pb, problem = lab.load_playbook(now, float(pb_cfg.get("max_age_days") or lab.PLAYBOOK_DAYS))
    only_setups, only_tfs = pb_cfg.get("setups"), pb_cfg.get("timeframes")
    by_coin = {}
    for key, e in ((pb or {}).get("entries") or {}).items():
        if (only_setups and e.get("setup") not in only_setups) or (only_tfs and e.get("interval") not in only_tfs):
            continue
        by_coin.setdefault(e["symbol"], []).append(dict(e, key=key))
    return {"required": required, "playbook": pb, "problem": problem, "by_coin": by_coin}


def last_closed_bar(now_ts: int, step: int) -> int:
    """Open time of the newest closed bar."""
    return (int(now_ts) // step - 1) * step


def find_triggers(cfg: dict, book: dict, memo: dict, uni: dict = None, pbs: dict = None) -> tuple:
    """Look at every watched symbol once per closed 5-min bar, within the per-cycle time budget.

    Symbols the budget did not reach roll over to the next cycle of the same bar (and to the next bar,
    whose trigger-age check still accepts a one-bar-old trigger). Returns (candidates, notes).
    """
    ap = cfg.get("autopilot") or {}
    max_age = int((ap.get("gates") or {}).get("max_trigger_age_bars", 1))
    now = market_clock.now_utc()
    now_ts = int(now.timestamp())
    step = market_clock.interval_seconds(INTERVAL)
    bar = last_closed_bar(now_ts, step)
    handled = book["handled"].setdefault(_today(now), {})
    found, notes = [], []
    holding = {it["data_key"] for it in book["items"].values() if it["status"] in ("pending", "open")}
    uni = watchlist(cfg) if uni is None else uni
    pbs = pbs or {"required": False, "by_coin": {}}
    scan = state.read_json(SCAN, {}) or {}
    deadline = time.monotonic() + float(ap.get("scan_time_budget_sec") or 40)
    for asset, syms in uni.items():
        if asset == "stock":
            st = market_clock.market_status(now)
            if st["state"] != "open":
                notes.append("US market %s — no new stock entries" % st["state"])
                continue
            et = market_clock.to_et(now)
            if (et.hour, et.minute) >= NO_NEW_STOCK_ENTRIES:
                notes.append("after 3:30 p.m. ET — no new stock entries")
                continue
        if asset == "crypto" and pbs["required"]:
            # crypto is traded only from what the backtest lab validated on data it never saw
            if not pbs.get("playbook"):
                notes.append("crypto: %s" % pbs.get("problem"))
                continue
            gated = []
            for raw in syms:
                try:
                    k = data.as_symbol(raw, asset).key
                except (symbols.SymbolError, ValueError):
                    continue
                if k in pbs["by_coin"]:
                    gated.append(raw)
            if not gated:
                notes.append("crypto: none of the %d watched coins is validated in the backtest-lab playbook (%d "
                             "combinations)" % (len(syms), len(pbs["playbook"].get("entries") or {})))
                continue
            syms = gated
        sc = scan.get(asset) or {}
        if sc.get("bar") != bar:
            sc = {"bar": bar, "done": [], "total": len(syms), "finished_at": None}
        done = list(sc.get("done") or [])
        todo = [raw for raw in syms if raw not in done]
        for raw in todo:
            if time.monotonic() > deadline:
                notes.append("scan time budget reached — %d %s symbol(s) left for the next cycle"
                             % (len(syms) - len(done), asset))
                break
            done.append(raw)
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
            entries = pbs["by_coin"].get(sym.key) if asset == "crypto" and pbs["required"] else None
            for e in [e for e in entries or [] if e["interval"] != INTERVAL]:
                found += _series_candidates(sym, e, memo, handled, holding, now_ts, max_age, notes)
            w = setups.window_at(series.candles, asset, INTERVAL, now_ts - 1)
            if not w or not (w.start <= now_ts - 1 < w.end):
                continue
            seen_bar = None
            if entries is None:
                wanted = [(st, None) for st in (ap.get("setups") or {}).get(asset) or []]
            else:  # the playbook decides which setups, and with which exits
                wanted = [(e["setup"], e) for e in entries if e["interval"] == INTERVAL]
            for setup, entry in wanted:
                if setup not in setups.SETUPS or asset not in setups.SETUPS[setup]["assets"] or setups.is_series(setup):
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
                        "window": w, "trigger": trig, "interval": INTERVAL, "playbook": entry}
                if sym.key in holding:
                    cand["skip"] = "already holding or waiting on %s" % sym.display
                elif seen_bar == trig["t"]:
                    cand["skip"] = "same candle already judged via another rule for %s" % sym.display
                seen_bar = seen_bar or trig["t"]
                found.append(cand)
        sc.update(done=done, total=len(syms))
        if len(done) >= len(syms) and not sc.get("finished_at"):
            sc["finished_at"] = market_clock.iso(now)
        scan[asset] = sc
    state.write_json(SCAN, scan)
    return found, notes


def _series_candidates(sym, e: dict, memo: dict, handled: dict, holding: set, now_ts: int, max_age: int,
                       notes: list, asset: str = "crypto") -> list:
    """A validated swing or daily setup (1h / 4h / 1d bars) that fired on the newest closed bar."""
    interval = e["interval"]
    step = market_clock.interval_seconds(interval)
    days = SERIES_HISTORY_DAYS.get(interval, 45)

    def candles(s, a=asset):
        key = (s.key, a, interval)
        if key not in memo:
            memo[key] = data.get_candles(s, interval, days=days, asset=a)
        return memo[key]
    try:
        series = candles(sym)
        context = None
        if (setups.SETUPS.get(e["setup"]) or {}).get("needs_btc"):  # Bitcoin's 200-day trend switches it on and off
            context = {"btc_up": setups.regime_map(candles(data.as_symbol("BTCUSDT", "crypto"), "crypto").candles)}
    except (data.DataUnavailable, ValueError) as exc:
        notes.append("%s %s: %s" % (sym.display, interval, exc))
        return []
    if not series.candles:
        return []
    last_t = series.candles[-1].t
    out = []
    for r in setups.series_signals(e["setup"], series.candles, interval, start_ts=last_t - max_age * step,
                                   context=context):
        trig = r["trigger"]
        age = (now_ts - (trig["t"] + step)) // step
        if asset == "stock":  # weekends and holidays: fresh means the newest closed session
            age = 0 if trig["index"] == len(series.candles) - 1 else max_age + 1
        sid = setups.setup_id(sym.key, r["window"], e["setup"])
        if age > max_age or sid in handled:
            continue
        cand = {"id": sid, "sym": sym, "asset": asset, "setup": e["setup"], "result": r, "series": series,
                "window": None, "trigger": trig, "interval": interval, "playbook": e}
        if sym.key in holding:
            cand["skip"] = "already holding or waiting on %s" % sym.display
        out.append(cand)
    return out


ETF_FIRST_ENTRY = (9, 45)  # ET — yesterday's daily bar is closed and the opening auction is over


def crypto_bull(memo: dict) -> tuple:
    """(True/False/None, text): is Bitcoin's last daily close above its 200-day average?"""
    key = ("BTCUSDT", "crypto", "1d")
    try:
        if key not in memo:
            memo[key] = data.get_candles(data.as_symbol("BTCUSDT", "crypto"), "1d", days=SERIES_HISTORY_DAYS["1d"],
                                         asset="crypto")
        bars = memo[key].candles
    except (data.DataUnavailable, ValueError) as exc:
        return None, "Bitcoin's daily prices are unavailable (%s)" % exc
    if len(bars) < 200:
        return None, "only %d daily Bitcoin closes — the 200-day average needs 200" % len(bars)
    avg = sum(b.c for b in bars[-200:]) / 200.0
    up = bars[-1].c > avg
    return up, "Bitcoin %s its 200-day average (%s vs %s)" % ("above" if up else "below", fmt.price(bars[-1].c),
                                                             fmt.price(avg))


def etf_playbook(cfg: dict, now=None) -> dict:
    ec = (cfg.get("autopilot") or {}).get("etf_trend") or {}
    lab = _mod("trader-backtest", "lab")
    pb, problem = lab.load_playbook(now, float(((cfg.get("autopilot") or {}).get("playbook") or {}).get(
        "max_age_days") or lab.PLAYBOOK_DAYS), lab.PLAYBOOK_ETF)
    by_symbol = {}
    for key, e in ((pb or {}).get("entries") or {}).items():
        by_symbol.setdefault(e["symbol"], []).append(dict(e, key=key))
    return {"required": bool(ec.get("required_lab", True)), "playbook": pb, "problem": problem,
            "by_symbol": by_symbol}


def etf_candidates(cfg: dict, book: dict, memo: dict, now=None) -> tuple:
    """While crypto is in a bear market, the same trend rule on ETFs that move unlike crypto — held for days."""
    ec = (cfg.get("autopilot") or {}).get("etf_trend") or {}
    if not ec.get("enabled"):
        return [], []
    now = now or market_clock.now_utc()
    if market_clock.market_status(now)["state"] != "open":
        return [], []
    et = market_clock.to_et(now)
    if (et.hour, et.minute) < ETF_FIRST_ENTRY or (et.hour, et.minute) >= NO_NEW_STOCK_ENTRIES:
        return [], []
    if ec.get("when", "crypto_bear") == "crypto_bear":
        up, why = crypto_bull(memo)
        if up is None:
            return [], ["ETF trend: %s — waiting" % why]
        if up:
            return [], ["ETF trend waits: crypto is in a bull market (%s)" % why]
    pbs = etf_playbook(cfg, now)
    if pbs["required"] and not pbs["playbook"]:
        return [], ["ETF trend: %s" % pbs["problem"]]
    wanted = [str(x).upper() for x in ec.get("symbols") or []]
    holding = {it["data_key"] for it in book["items"].values() if it["status"] in ("pending", "open")}
    handled = book["handled"].setdefault(_today(now), {})
    found, notes = [], []
    for raw in wanted:
        sym = data.as_symbol(raw, "stock")
        entries = pbs["by_symbol"].get(sym.key) if pbs["required"] else \
            [{"symbol": sym.key, "setup": "etf_trend", "interval": "1d", "key": "%s:etf_trend@1d" % sym.key}]
        for e in entries or []:
            found += _series_candidates(sym, e, memo, handled, holding, int(now.timestamp()), 0, notes, "stock")
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
        "entry_price": trig["price"], "checked_at": market_clock.iso(market_clock.now_utc()),
        "interval": c.get("interval") or INTERVAL, "source": c["series"].source, "notes": r.get("notes") or [],
        "origin": "autopilot", "playbook": (c.get("playbook") or {}).get("key"),
    }
    doc.setdefault("latest", c["id"])
    state.write_json("entries.json", doc)


def make_plan(c: dict, cfg: dict) -> dict:
    exit_mod = _mod("trader-exit", "exit")
    sym, asset, trig, r = c["sym"], c["asset"], c["trigger"], c["result"]
    interval = c.get("interval") or INTERVAL
    step = market_clock.interval_seconds(interval)
    entry_ts = trig["t"] + step
    until = [x for x in c["series"].candles if x.t + step <= entry_ts]
    tick = 0.01 if asset == "stock" else (data.lot_info(sym).get("tick") or None)
    horizon_s = None if asset == "stock" else market_clock.parse_horizon(cfg.get("crypto_horizon") or "4h")
    levels = r.get("levels") or {}
    pb = c.get("playbook")
    stop, atr_mult, target_r = "auto", 1.5, exit_mod.DEFAULT_TARGET_R[asset]
    rule = (pb or {}).get("exit_rule") or setups.exit_rule(c["setup"])
    if rule:  # rule-exit setups: the setup's own stop rule, a far target cap, the rule's longest hold
        stop_px = setups.rule_stop(c["setup"], until, len(until) - 1, levels, indicators.last_atr(until))
        stop, target_r = repr(float(stop_px)), RULE_TARGET_CAP_R
        horizon_s = int(rule.get("max_bars") or 10) * step
    elif pb:  # trade it exactly the way the backtest lab validated it
        stop, atr_mult = pb["stop"], float(pb["atr_mult"])
        target_r = float(pb["target_r"]) if pb.get("target_r") is not None else RULE_TARGET_CAP_R
        horizon_s = market_clock.parse_horizon(pb["horizon"])
    swing = asset == "stock" and interval == "1d"
    lv = exit_mod.plan_levels(trig["price"], entry_ts, asset, until, stop_ref=levels.get("stop_ref"),
                              trigger_level=levels.get("trigger_level"), stop=stop, atr_mult=atr_mult,
                              target_r=target_r, tick=tick, horizon_s=horizon_s, swing=swing)
    if lv["stop"]["method"] == "range_low":
        lv["stop"]["note"] = exit_mod.structure_note(c["setup"])
    if rule:
        lv["stop"].update(method="rule", note=setups.stop_text(c["setup"]))
    plan = {"id": c["id"], "symbol": exit_mod._canonical(sym), "symbol_display": sym.display, "symbol_key": sym.key,
            "asset": asset, "setup": c["setup"], "label": r["label"], "direction": "long",
            "entry": {"price": float(trig["price"]), "time": market_clock.iso(entry_ts)},
            "stop": lv["stop"], "target": lv["target"], "risk_per_unit": lv["risk_per_unit"],
            "time_stop": lv["time_stop"], "horizon": lv["horizon"], "trailing": None, "scale_out": [],
            "liquidity_exit": None, "atr": lv["atr"], "interval": interval, "source": c["series"].source,
            "created_at": market_clock.iso(market_clock.now_utc()), "chart": None, "origin": "autopilot",
            "playbook": (pb or {}).get("key"), "swing": swing,
            "exit_rule": dict(rule, interval=interval) if rule else None}
    if rule:
        plan["target"]["note"] = "a far cap — the exit rule decides: %s" % rule.get("text")
    plan["runner"], plan["runner_note"] = runner_plan(c, cfg)
    doc = state.read_json("plan.json", {}) or {}
    doc.setdefault("plans", {})[plan["id"]] = plan
    doc.setdefault("latest", plan["id"])
    state.write_json("plan.json", doc)
    return plan


def runner_plan(c: dict, cfg: dict) -> tuple:
    """(runner, note): whether this trade will let part of a winner ride on, and why (not).

    Only for setups with a runner rule, only when you turned it on (autopilot.runner.enabled), and — unless
    you say otherwise — only when this week's lab run found that riding on paid on periods nobody tuned on.
    """
    ride = setups.runner(c["setup"])
    rc = (cfg.get("autopilot") or {}).get("runner") or {}
    if not ride:
        return None, None
    if not rc.get("enabled"):
        return None, "let winners ride is off (autopilot.runner.enabled) — sells everything at the exit rule"
    verdict = (c.get("playbook") or {}).get("runner")
    if rc.get("require_lab", True) and not (verdict and verdict.get("helps")):
        return None, ("the lab %s — sells everything at the exit rule" % (
            "has not checked riding on yet" if not verdict else "says: " + verdict.get("why", "it did not pay")))
    keep = float(rc.get("keep") or ride["keep"])
    out = {"keep": keep, "min_sma": int(ride.get("min_sma") or 200),
           "exit_rule": dict(ride["exit_rule"], interval="1d"), "status": "planned",
           "lab": (verdict or {}).get("why")}
    return out, "if the exit comes in profit while the coin is above its %d-day average: sell %s, %s ride on " \
                "until %s" % (out["min_sma"], setups.keep_text(1 - keep), setups.keep_text(keep),
                              ride["exit_rule"]["short"])


def _ctx(args, cfg, limits):
    return cli.Context(args=args, cfg=cfg, limits=limits, home=config.trader_home())


def ensure_backtest(c: dict, plan: dict, cfg: dict, limits: dict) -> dict:
    """Backtest the rule on this symbol — once per symbol, rule and day (or take the backtest lab's validation)."""
    rel = "backtests/%s-%s.json" % (c["sym"].key, c["setup"])
    pb = c.get("playbook")
    if pb:  # validated out of sample by the lab, with these exact exits: that is the evidence the desk reads
        te = pb["test"]
        doc = {"symbol": c["sym"].display, "symbol_key": c["sym"].key, "asset": c["asset"], "setup": c["setup"],
               "generated_at": market_clock.iso(market_clock.now_utc()), "source": "backtest lab",
               "triggers": te["n"], "expectancy_r": te["expectancy_r"], "win_rate": te["win_rate"],
               "summary": "Backtest lab, unseen test period (%s bars): %d trades, win %.0f%%, profit chance %.0f%%" % (
                   pb["interval"], te["n"], 100 * (te["win_rate"] or 0), 100 * (te.get("profit_chance") or 0)),
               "params": {"interval": pb["interval"], "target_r": pb["target_r"], "stop": pb["stop"],
                          "atr_mult": pb["atr_mult"], "horizon": pb["horizon"]}, "playbook": pb.get("key")}
        state.write_json(rel, doc)
        return doc
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


def _news_scope(plan: dict) -> str:
    sym = data.as_symbol(plan["symbol"], plan["asset"])
    return "%s:%s" % (plan["asset"], sym.key if plan["asset"] == "stock" else sym.base)


def refresh_news(plan: dict, cfg: dict) -> str:
    """Fetch the latest headlines and filings for this symbol right before the desk reads them."""
    ng = (cfg.get("autopilot") or {}).get("news_gate") or {}
    if not ng.get("enabled", True) or not ng.get("refresh_before_trade", True):
        return "news refresh before trades is off"
    scope = _news_scope(plan)
    feed = state.read_json("news_feed.json", {}) or {}
    last = (feed.get("refreshed") or {}).get(scope)
    now = market_clock.now_utc()
    max_age = float(ng.get("refresh_max_age_minutes") or 10) * 60
    if last and 0 <= now.timestamp() - market_clock.ts(last) <= max_age:
        return "news for %s fetched %d min ago" % (scope, (now.timestamp() - market_clock.ts(last)) // 60)
    try:
        res = _mod("trader-news", "news").refresh_feed(symbols=[plan["symbol"]], now=market_clock.iso(now))
    except Exception as exc:  # a news outage is noted by the desk ("no feed data"), it does not crash the cycle
        return "news refresh failed: %s: %s" % (type(exc).__name__, exc)
    bad = ["%s %s" % (k, v) for k, v in sorted((res.get("sources") or {}).items()) if str(v).startswith("error")]
    return "news refreshed for %s (%d new)%s" % (scope, res.get("new") or 0,
                                                 " · " + "; ".join(bad)[:200] if bad else "")


def _scaled(cfg: dict, limits: dict, asset: str, mult: float) -> tuple:
    """Risk per trade times ``mult``. Smaller also shrinks the per-trade cap; larger never lifts limits.json."""
    if abs(mult - 1) < 1e-9:
        return cfg, limits
    cfg2, lim2 = copy.deepcopy(cfg), copy.deepcopy(limits)
    cfg2["risk_per_trade_pct"] = float(cfg.get("risk_per_trade_pct", 0.5)) * mult
    lim = lim2.get(asset) or {}
    if mult < 1 and lim.get("max_risk_per_trade_usd") is not None:
        lim["max_risk_per_trade_usd"] = float(lim["max_risk_per_trade_usd"]) * mult
    return cfg2, lim2


DEFAULT_RISK_TIERS = ((0.9, 2.0), (0.8, 1.5), (0.7, 1.0), (0.0, 0.5))


def confidence_mult(entry: dict, cfg: dict) -> tuple:
    """(multiplier, reason): size by how sure the backtest lab is — its profit chance on trades it never saw.

    Bigger only with enough unseen trades behind it, never above max_risk_mult, never past limits.json.
    """
    pb_cfg = (cfg.get("autopilot") or {}).get("playbook") or {}
    if not entry or not pb_cfg.get("confidence_sizing", True):
        return 1.0, None
    te = entry.get("test") or {}
    pc, n = float(te.get("profit_chance") or 0), int(te.get("n") or 0)
    tiers = pb_cfg.get("risk_tiers") or DEFAULT_RISK_TIERS
    mult = 1.0
    for threshold, m in sorted(([float(a), float(b)] for a, b in tiers), reverse=True):
        if pc >= threshold:
            mult = m
            break
    why = "profit chance %.0f%% over %d unseen trades" % (100 * pc, n)
    min_n = int(pb_cfg.get("boost_min_test_trades") or 30)
    if mult > 1 and n < min_n:
        mult, why = 1.0, why + " — too few to size up (want ≥ %d)" % min_n
    mult = min(mult, float(pb_cfg.get("max_risk_mult") or 2.0))
    base = float(cfg.get("risk_per_trade_pct", 0.5))
    top = pb_cfg.get("max_risk_pct")
    if top is not None and base > 0 and base * mult > float(top) + 1e-9:
        mult, why = float(top) / base, why + " — capped at %g%% per trade (playbook.max_risk_pct)" % float(top)
    return mult, why


def ai_review(plan: dict, desk: dict, cfg: dict) -> tuple:
    """Optional Claude review of a trade the rule-based desk already passed — it can only say no.

    Returns (block_reasons or None, gate, info).
    """
    ai_cfg = cfg.get("ai_desk") or {}
    ai = _mod("trader-desk", "ai_desk")
    case = state.read_json("desk/%s/case.json" % plan["id"], {}) or {}
    res = ai.review(case, desk, cfg)
    status = res.get("status")
    info = {"status": status, "model": res.get("model"), "usd": (res.get("usage") or {}).get("usd")}
    if status == "GO":
        return None, {"name": "AI desk", "ok": True, "detail": "GO (%s)" % res.get("model")}, info
    if status in ("NO-GO", "WAIT"):
        objs = [o for o in res.get("objections") or [] if o.get("severity") in ("critical", "major")]
        reasons = ["AI desk %s: %s" % (status, o.get("text")) for o in objs] or \
                  ["AI desk %s: %s" % (status, (res.get("decision_text") or "no reason given")[:300])]
        return reasons, {"name": "AI desk", "ok": False, "detail": "%s (%s)" % (status, res.get("model"))}, info
    why = res.get("reason") or status or "unknown"
    if ai_cfg.get("on_unavailable") == "skip":
        return (["AI desk unavailable (%s) — ai_desk.on_unavailable is \"skip\"" % why],
                {"name": "AI desk", "ok": False, "detail": "unavailable: %s" % why}, info)
    return None, {"name": "AI desk", "ok": True, "detail": "unavailable (%s) — rule-based decision used" % why}, info


def judge(c: dict, cfg: dict, limits: dict, broker, book: dict, approved: bool, acct: dict,
          learned: dict = None) -> dict:
    """Everything between "a rule fired" and "an order is at the broker". Returns the decision record."""
    sym, asset = c["sym"], c["asset"]
    base = {"id": c["id"], "symbol": sym.display, "asset": asset, "setup": c["setup"]}
    if c.get("skip"):
        return _decision(reasons=[c["skip"]], **base)
    # one position per symbol: two setups firing on the same coin in one cycle must not both buy it — the broker
    # holds one position, and the first exit rule would close the other trade too
    held = [it for it in book["items"].values() if it["status"] in ("pending", "open") and it.get("data_key") == sym.key]
    if held:
        return _decision(reasons=["already holding or waiting on %s (%s)" % (sym.display, held[0].get("setup") or
                                                                         held[0].get("plan_id"))], **base)
    if learned is not None:
        ok, why = adapt.check(learned, asset, c["setup"], sym.key)
        if not ok:
            return _decision(reasons=["learned from its record: %s" % why], **base)
    ap = cfg.get("autopilot") or {}
    _write_entry(c)
    plan = make_plan(c, cfg)
    base.update(entry=plan["entry"]["price"], stop=plan["stop"]["price"], target=plan["target"]["price"])
    ensure_backtest(c, plan, cfg, limits)
    if not plan.get("exit_rule"):  # the replay models stop / target / time only — a rule exit is the lab's job
        run_timemachine(plan, cfg, limits)
    news_note = refresh_news(plan, cfg)
    desk = _mod("trader-desk", "desk").auto_review(plan["id"], cfg, limits, force=True, symbol=plan["symbol"])
    blocking = [o for o in desk.get("objections") or [] if o.get("severity") in ("critical", "major")]
    gates = [{"name": g["name"], "ok": g["ok"], "detail": g["detail"]} for g in desk.get("gates") or []]
    gates.append({"name": "news refresh", "ok": not news_note.startswith("news refresh failed"), "detail": news_note})
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
    mult = adapt.risk_mult(learned) if learned is not None else 1.0
    if mult < 1:
        gates.append({"name": "learned · risk multiplier", "ok": True,
                      "detail": "risk × %g — %s" % (mult, (learned or {}).get("risk_reason") or "losing streak")})
    conf, conf_why = confidence_mult(c.get("playbook"), cfg)
    if conf_why:
        gates.append({"name": "confidence sizing", "ok": True,
                      "detail": "risk × %g — %s%s" % (conf, conf_why, " (limits.json still caps it)" if conf > 1
                                                       else "")})
    mult *= conf
    if plan.get("runner_note"):
        gates.append({"name": "let winners ride", "ok": True, "detail": plan["runner_note"]})
    lev, lev_why = config.leverage(cfg, limits, asset, broker.name)
    if lev_why:
        gates.append({"name": "leverage", "ok": True, "detail": lev_why})
    s_cfg, s_limits = _scaled(cfg, limits, asset, mult)
    try:
        order = sizer.size_order(plan, s_cfg, s_limits, account=acct.get("equity") or None, leverage=lev)
    except ValueError as exc:
        return _decision(reasons=["sizer: %s" % exc], desk=desk_info, gates=gates, **base)
    order["origin"] = "autopilot"
    sizer.save_order(order)
    res = risk.evaluate(order, s_cfg, s_limits)
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
    if acct.get("cash") is not None and float(acct.get("equity") or 0) > 0:
        # never more borrowed money than the leverage you allowed, whatever the broker would lend
        cash = min(cash, float(acct["cash"]) + (lev - 1) * float(acct["equity"]))
    if order["notional_usd"] > cash + 1e-6:
        return _decision(reasons=["not enough buying power: %s needed, %s available%s" % (
            fmt.money(order["notional_usd"]), fmt.money(cash), " at %g× leverage" % lev if lev > 1 else "")],
            desk=desk_info, gates=gates, **base)
    if not approved:
        return _decision(reasons=["dry run — the autopilot is not enabled (autopilot.enabled or --approve); "
                                  "it would have placed: " + text], desk=desk_info, gates=gates, dry_run=True, **base)
    ai_info = None
    if (cfg.get("ai_desk") or {}).get("enabled"):
        # last, because it is the only step that costs money — and it can only say no
        block, gate, ai_info = ai_review(plan, desk, cfg)
        gates.append(gate)
        if block:
            _update_order(order["id"], status="canceled", error="AI desk: no")
            return _decision(reasons=block, desk=desk_info, gates=gates, ai=ai_info, **base)
    try:
        bo = broker.place_entry({"client_order_id": order["id"], "symbol": bsym, "asset": asset, "qty": order["qty"],
                                 "limit_price": order["limit_price"], "stop_price": order["stop_price"],
                                 "target_price": order["target_price"], "leverage": lev,
                                 "swing": bool(plan.get("swing"))})
    except BrokerError as exc:
        _update_order(order["id"], status="error", error=str(exc))
        return _decision(action="error", reasons=["broker refused: %s" % exc], desk=desk_info, gates=gates, ai=ai_info,
                         **base)
    state.append_jsonl("approvals.jsonl", {
        "ts": market_clock.iso(now), "ticket_id": None, "order_id": order["id"], "ticket_hash": res["order_hash"],
        "ticket_text": text, "mode": broker.mode, "user_reply": APPROVAL_TEXT, "approved": True, "asset": asset,
        "symbol": order["symbol"], "source": "autopilot"})
    _update_order(order["id"], status="submitted", broker=broker.name, broker_order_id=bo.get("id"))
    book["items"][plan["id"]] = {
        "plan_id": plan["id"], "order_id": order["id"], "broker_order_id": bo.get("id"), "broker": broker.name,
        "mode": broker.mode, "symbol": bsym, "data_key": sym.key, "asset": asset, "qty": order["qty"],
        "qty_unit": order.get("qty_unit"), "stop": order["stop_price"], "target": order["target_price"],
        "time_stop": plan["time_stop"]["at"], "status": "pending", "placed_at": market_clock.iso(now),
        "exit_rule": plan.get("exit_rule"), "interval": plan.get("interval"), "leverage": lev,
        "runner": plan.get("runner"), "setup": c["setup"], "entry_plan": plan["entry"]["price"],
        "swing": bool(plan.get("swing"))}
    notify.send("trade_opened", "BUY %s %s (%s)" % (fmt.qty(order["qty"]), bsym, c["setup"]),
                "%s. Risk %s%s. Desk GO, risk PASS%s." % (
                    text, fmt.money(order.get("risk_usd")), " (risk × %g)" % mult if abs(mult - 1) > 1e-9 else "",
                    ", AI desk %s" % ai_info["status"] if ai_info else ""), cfg)
    return _decision(action="taken", reasons=["desk GO, risk PASS — " + text], desk=desk_info, gates=gates,
                     broker_order_id=bo.get("id"), ai=ai_info, **base)


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


def _universe_counts_only(cfg: dict) -> dict:
    """What is being watched, without refreshing anything (paused / killed cycles)."""
    assets = (cfg.get("autopilot") or {}).get("assets") or ["stock", "crypto"]
    doc = state.read_json("autopilot/universe.json", {}) or {}
    if doc.get("stock") or doc.get("crypto"):
        return {a: list((doc.get(a) or {}).get("symbols") or []) for a in ("stock", "crypto") if a in assets}
    return watchlist(cfg)


def learn(cfg: dict, control: dict, now, actions: list) -> dict:
    """Re-read the autopilot's own closed trades and equity; turn what changed into actions + notifications."""
    try:
        doc = adapt.evaluate(cfg, now=market_clock.iso(now))
    except Exception as exc:  # learning is a brake, not an engine — never let it stop the cycle
        actions.append("learning skipped: %s: %s" % (type(exc).__name__, exc))
        return {"enabled": False}
    for ev in doc.get("new_events") or []:
        actions.append("learned: %s" % ev.get("text"))
        if ev.get("kind") != "drawdown_pause":  # that one gets its own "paused" notification
            notify.send("learned", (ev.get("text") or "")[:110], ev.get("text") or "", cfg)
    return doc


def check_health(cfg: dict, control: dict, now, actions: list) -> dict:
    """Is the bot's record still what the backtest promised? A new alarm pauses new entries (exits keep running)."""
    try:
        doc = health.update(cfg, now, control)
    except Exception as exc:  # a check, not an engine — never let it stop the cycle
        actions.append("health check skipped: %s: %s" % (type(exc).__name__, exc))
        return {}
    if doc.get("new_alarm"):
        actions.append("HEALTH ALARM: " + doc.get("text", ""))
        if health.settings(cfg).get("pause_on_alarm", True):
            actions.append("PAUSED by the health check — resume to trade again")
            notify.send("paused", "Autopilot paused — results unlike the backtest",
                        doc.get("text", "") + ". Exits keep running; look at autopilot.py check, then resume.", cfg,
                        priority="high")
            return dict(doc, pause=True)
        notify.send("learned", "Health alarm", doc.get("text", ""), cfg)
    return doc


def run_checks(cfg: dict, now=None) -> dict:
    """Both checks now: is it normal (health) and did it do what the rules say (shadow)."""
    now = now or market_clock.now_utc()
    out = {"health": health.update(cfg, now, read_control())}
    try:
        out["shadow"] = shadow.run(cfg, now)
    except Exception as exc:
        out["shadow"] = {"verdict": "error", "text": "%s: %s" % (type(exc).__name__, exc), "rows": [], "problems": []}
    return out


def _daily_shadow(cfg: dict) -> None:
    """Background, once a UTC day after the daily close: backtest vs reality, with a notification on problems."""
    try:
        doc = shadow.run(cfg)
    except Exception as exc:
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": market_clock.iso(market_clock.now_utc()),
                                                            "task": "shadow", "error": "%s: %s" % (type(exc).__name__, exc)})
        return
    if doc.get("problems"):
        notify.send("error", "Backtest vs reality: %d problem(s)" % len(doc["problems"]),
                    "; ".join(doc["problems"][:5]), cfg)


def _summary_time(cfg: dict) -> tuple:
    raw = str((cfg.get("notify") or {}).get("daily_summary_et") or "16:10")
    try:
        hh, mm = raw.split(":", 1)
        return int(hh), int(mm)
    except ValueError:
        return 16, 10


def daily_summary(cfg: dict, st: dict, learned: dict, now) -> None:
    """Once per New York day, after daily_summary_et: what it did, what it earned, what it learned."""
    et = market_clock.to_et(now)
    if (et.hour, et.minute) < _summary_time(cfg):
        return
    day = et.date().isoformat()
    if st.get("summary_sent") == day:
        return
    utc_day = _today(now)
    trades = [t for t in (state.read_json("journal.json", {}) or {}).get("trades") or []
              if t.get("source") == "autopilot" and t.get("status") == "closed"
              and ((t.get("exit") or {}).get("time") or "")[:10] == utc_day]
    looked = [d for d in state.read_jsonl(DECISIONS) if (d.get("at") or "")[:10] == utc_day]
    why = {}
    for d in looked:
        if d.get("action") == "skipped" and d.get("reasons"):
            head = d["reasons"][0].split(":", 1)[0][:60]
            why[head] = why.get(head, 0) + 1
    eq = st.get("equity") or {}
    pnl = sum(float(t.get("pnl_usd") or 0) for t in trades)
    lines = ["%d trade(s) closed · P&L %s · equity %s (%s)" % (len(trades), fmt.money(pnl), fmt.money(eq.get("equity")),
                                                               st.get("mode") or "?")]
    for t in trades[:8]:
        lines.append("  %s %s %s · %s" % (t.get("display") or t.get("symbol"), t.get("setup") or "",
                                          fmt.r(t.get("r_multiple")), fmt.money(t.get("pnl_usd"))))
    lines.append("%d setups looked at: %d taken, %d skipped" % (
        len(looked), sum(1 for d in looked if d.get("action") == "taken"),
        sum(1 for d in looked if d.get("action") == "skipped")))
    for head, n in sorted(why.items(), key=lambda kv: -kv[1])[:4]:
        lines.append("  %d× %s" % (n, head))
    if (learned or {}).get("risk_mult", 1) < 1:
        lines.append("risk × %g — %s" % (learned["risk_mult"], learned.get("risk_reason") or ""))
    paused = [k for k, v in ((learned or {}).get("setups") or {}).items() if v.get("status") == "paused"]
    if paused:
        lines.append("paused setups: " + ", ".join(paused))
    notify.send("daily_summary", "Trader %s: %s" % (day, fmt.money(pnl)), "\n".join(lines), cfg)
    _state(summary_sent=day)


def compact_equity(keep_days: int = 7) -> int:
    """equity.jsonl gets a line a minute around the clock: keep a week in full, one line per hour before that."""
    rows = state.read_jsonl("broker/equity.jsonl")
    cutoff = market_clock.now_utc().timestamp() - keep_days * 86400
    recent, hourly = [], {}
    for r in rows:
        try:
            t = market_clock.ts(r["at"])
        except (KeyError, TypeError, ValueError):
            continue
        if t >= cutoff:
            recent.append(r)
        else:
            hourly[t // 3600] = r
    out = [hourly[k] for k in sorted(hourly)] + recent
    removed = len(rows) - len(out)
    if removed > 0:
        p = state.path("broker", "equity.jsonl")
        tmp = p.with_suffix(".jsonl.tmp")
        tmp.write_text("".join(json.dumps(r) + "\n" for r in out), encoding="utf-8")
        os.replace(str(tmp), str(p))
    return removed


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
    # the equity snapshot first, so the drawdown check sees this cycle's equity
    line = _write_broker_files(broker, acct, positions, orders, book, _realized_today(now))
    learned = learn(cfg, control, now, actions)
    if learned.get("drawdown_pause") and not control["paused"] and not control["kill"]:
        control = write_control(by="autopilot", paused=True, run_once=False)
        why = "equity %s is %.1f%% below its peak %s (limit %s%%)" % (
            fmt.money(learned.get("equity")), learned.get("drawdown_pct") or 0, fmt.money(learned.get("equity_peak")),
            ((ap.get("adapt") or {}).get("max_drawdown_pct")))
        actions.append("PAUSED by the drawdown limit: " + why)
        notify.send("paused", "Autopilot paused — drawdown limit", why + ". Exits keep running; resume to trade again "
                    "(resuming resets the peak).", cfg, priority="high")
    hdoc = check_health(cfg, control, now, actions)
    if hdoc.get("pause") and not control["paused"] and not control["kill"]:
        control = write_control(by="autopilot", paused=True, run_once=False)

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
        notify.send("kill", "KILL — %s" % kill_reason, "Open orders cancelled%s. The autopilot stays stopped until "
                    "you resume it." % (", positions closed" if ap.get("flatten_on_kill", True) else ""), cfg,
                    priority="high")
        acct, positions, orders = sync()
        actions += reconcile(broker, book, positions, orders, cfg, limits)
        write_control(by="autopilot", kill=False, paused=True, run_once=False)
        state.write_json(BOOK, book)
        line = _write_broker_files(broker, acct, positions, orders, book, _realized_today(now))
        msg = "KILLED — %s. Orders cancelled%s. Resume to trade again." % (
            kill_reason, ", positions closed" if ap.get("flatten_on_kill", True) else "")
        _state(status="killed", message=msg, today=_today_summary(book, now, kill_reason), equity=line, **common)
        return {"status": "killed", "message": msg, "actions": actions, "errors": errors}

    exits = manage_exits(broker, book, positions, orders, cfg)
    if exits:
        actions += exits
        acct, positions, orders = sync()
        actions += reconcile(broker, book, positions, orders, cfg, limits)

    status = "paused" if control["paused"] and not control["run_once"] else "running"
    if prev.get("status") == "killed" and control["paused"]:
        status = "killed"
    decisions = []
    uni, uni_notes = watched(cfg, broker, now) if status == "running" else (_universe_counts_only(cfg), [])
    try:
        pbs = playbook_state(cfg, now)
    except Exception as exc:  # a broken playbook file must not stop exits — crypto just stays gated
        pbs = {"required": True, "playbook": None, "problem": "playbook unreadable: %s" % exc, "by_coin": {}}
    if status == "running":
        extra = add_playbook_coins(uni, pbs, cfg, limits, broker)
        if extra:
            uni_notes.append("also watching %s — validated by the backtest lab" % ", ".join(extra))
    if status == "running":
        memo = {}
        try:
            cands, notes = find_triggers(cfg, book, memo, uni, pbs)
        except Exception as exc:  # a bad symbol must not stop exits from being managed next cycle
            cands, notes = [], []
            errors.append("trigger scan: %s: %s" % (type(exc).__name__, exc))
        try:
            more, more_notes = etf_candidates(cfg, book, memo, now)
            cands += more
            notes += more_notes
        except Exception as exc:
            errors.append("ETF scan: %s: %s" % (type(exc).__name__, exc))
        handled = book["handled"].setdefault(_today(now), {})
        use_learned = learned if learned.get("enabled", True) else None
        # when several fire at once and the caps allow only some, the most certain go first
        cands.sort(key=lambda c: -float((((c.get("playbook") or {}).get("test") or {}).get("profit_chance")) or 0))
        for c in cands:
            try:
                d = judge(c, cfg, limits, broker, book, approved, acct, use_learned)
            except Exception as exc:  # one broken candidate is recorded and skipped; the next cycle must not retry it
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
    if decisions or exits:
        acct, positions, orders = sync()
        line = _write_broker_files(broker, acct, positions, orders, book, _realized_today(now))
    open_n = sum(1 for it in book["items"].values() if it["status"] == "open")
    pend_n = sum(1 for it in book["items"].values() if it["status"] == "pending")
    n_st, n_cr = len(uni.get("stock") or []), len(uni.get("crypto") or [])
    msg = "%s · watching %d stocks + %d coins · %d open, %d pending%s" % (
        status, n_st, n_cr, open_n, pend_n, "" if approved else " · DRY RUN (not enabled)")
    taken = [d for d in decisions if d["action"] == "taken"]
    if taken:
        msg += " · placed " + ", ".join("%s %s" % (d["symbol"], d["setup"]) for d in taken)
    last_errors = (prev.get("last_errors") or [])
    last_errors = (last_errors + [{"at": now_iso, "error": e} for e in errors])[-10:]
    today = _today_summary(book, now)
    pb = pbs.get("playbook") or {}
    playbook = {"required": pbs["required"], "problem": pbs.get("problem"), "generated_at": pb.get("generated_at"),
                "valid_until": pb.get("valid_until"), "entries": len(pb.get("entries") or {}),
                "coins": sorted(pbs.get("by_coin") or {})}
    st = _state(status=status, message=msg, today=today, equity=line, last_errors=last_errors,
                universe={"stock": n_st, "crypto": n_cr}, notes=(uni_notes + (notes if status == "running" else []))[-20:],
                playbook=playbook, **common)
    daily_summary(cfg, st, learned, now)
    actions += ["%s %s %s" % (d["action"], d["symbol"], d["setup"]) for d in decisions]
    return {"status": status, "message": msg, "actions": actions, "errors": errors,
            "decisions": [{"id": d["id"], "action": d["action"], "reasons": d["reasons"]} for d in decisions]}


def _sessions(now) -> dict:
    ms = market_clock.market_status(now)
    stock = ms["state"] if ms["trading_day"] else ("holiday" if ms.get("holiday") else "weekend")
    return {"crypto": "open 24/7", "stock": stock}


def heartbeat(runner: str, status: str) -> dict:
    """Proof of life for the dashboard: written after every cycle, whoever runs it."""
    st = state.read_json(STATE, {}) or {}
    scan = state.read_json(SCAN, {}) or {}
    now = market_clock.now_utc()
    hb = {"at": market_clock.iso(now), "pid": os.getpid(), "host": socket.gethostname(), "runner": runner,
          "started_at": _PROCESS["started_at"] or market_clock.iso(now), "cycle": st.get("cycles"), "status": status,
          "interval_sec": st.get("interval_sec"), "next_cycle": st.get("next_cycle"),
          "universe": st.get("universe") or {},
          "scan": {a: "%d/%d" % (len(v.get("done") or []), v.get("total") or 0) for a, v in sorted(scan.items())
                   if isinstance(v, dict)},
          "sessions": _sessions(now)}
    state.write_json(HEARTBEAT, hb)
    return hb


def run_cycle(now=None, approved=None, runner: str = "cli") -> dict:
    """One autopilot cycle. Thread-safe to call from the dashboard; never raises.

    now: optional ISO time to pin the clock for this cycle (replays). approved: True/False overrides
    config autopilot.enabled for this cycle (the dashboard's --autopilot flag passes True).
    runner: who is driving it (daemon / dashboard / cli / replay) — goes into heartbeat.json.
    """
    saved = os.environ.get("TRADER_NOW")
    res = None
    try:
        if now:
            os.environ["TRADER_NOW"] = market_clock.iso(market_clock.parse_iso(now))
        config.ensure_home()
        _PROCESS["started_at"] = _PROCESS["started_at"] or market_clock.iso(market_clock.now_utc())
        res = _cycle(approved)
        return res
    except Exception as exc:  # never let the dashboard thread die
        err = "%s: %s" % (type(exc).__name__, exc)
        try:
            prev = state.read_json(STATE, {}) or {}
            _state(status="error", message=err, last_cycle=market_clock.iso(market_clock.now_utc()),
                   last_errors=(prev.get("last_errors") or [])[-9:] + [
                       {"at": market_clock.iso(market_clock.now_utc()), "error": err}])
        except Exception:
            pass
        res = {"status": "error", "message": err, "actions": [], "errors": [err]}
        return res
    finally:
        try:
            heartbeat(runner, (res or {}).get("status") or "error")
        except Exception:
            pass
        if now:
            if saved is None:
                os.environ.pop("TRADER_NOW", None)
            else:
                os.environ["TRADER_NOW"] = saved


# --- the 24/7 daemon ------------------------------------------------------------------------------------

def _pid_alive(pid) -> bool:
    if os.name != "posix":  # os.kill(pid, 0) would terminate the process on Windows — rely on the heartbeat
        return True
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError):
        return False
    return True


def lock_holder():
    """The live daemon holding trader/autopilot/daemon.lock, or None if the lock is free or stale."""
    doc = state.read_json(LOCK)
    if not doc:
        return None
    hb = state.read_json(HEARTBEAT, {}) or {}
    fresh = False
    if hb.get("pid") == doc.get("pid") and hb.get("at"):
        fresh = time.time() - market_clock.ts(hb["at"]) <= STALE_LOCK_SEC
    elif doc.get("started_at"):
        fresh = time.time() - market_clock.ts(doc["started_at"]) <= STALE_LOCK_SEC
    same_host = doc.get("host") == socket.gethostname()
    if fresh and (not same_host or _pid_alive(doc.get("pid"))):
        return doc
    return None


def running_daemon():
    """Another live daemon on this trader/ folder (so the CLI hands work to it instead of racing it)."""
    holder = lock_holder()
    return holder if holder and holder.get("pid") != os.getpid() else None


def acquire_lock() -> dict:
    holder = lock_holder()
    if holder and holder.get("pid") != os.getpid():
        cli.fail("another autopilot daemon is already running for this trader/ folder (pid %s on %s, since %s) "
                 "— stop it first" % (holder.get("pid"), holder.get("host"), holder.get("started_at")))
    doc = {"pid": os.getpid(), "host": socket.gethostname(), "started_at": market_clock.iso(market_clock.now_utc())}
    state.write_json(LOCK, doc)
    return doc


def release_lock() -> None:
    doc = state.read_json(LOCK) or {}
    if doc.get("pid") == os.getpid() and doc.get("host") == socket.gethostname():
        try:
            state.path(LOCK).unlink()
        except OSError:
            pass


def _refresh_watchlist_news(cfg: dict) -> None:
    """Background: keep the dashboard's feed fresh for the watchlists (trade candidates are refreshed just in time)."""
    try:
        _mod("trader-news", "news").refresh_feed(assets=("stock", "crypto"))
    except Exception as exc:
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": market_clock.iso(market_clock.now_utc()),
                                                            "task": "news", "error": "%s: %s" % (type(exc).__name__, exc)})


def _refresh_lab(cfg: dict) -> None:
    """Background: re-run the backtest lab so the crypto playbook follows the market (weekly by default)."""
    pb_cfg = (cfg.get("autopilot") or {}).get("playbook") or {}
    lab = _mod("trader-backtest", "lab")
    started = market_clock.iso(market_clock.now_utc())
    try:
        argv = ["--top", str(int(pb_cfg.get("top") or 25)), "--no-html"]
        if float(pb_cfg.get("min_target_r") or 0) > 0:  # e.g. 2 = only exits that aim for 2:1 or better
            argv += ["--min-target-r", str(pb_cfg["min_target_r"])]
        if pb_cfg.get("setups"):
            argv += ["--setups", ",".join(pb_cfg["setups"])]
        if pb_cfg.get("timeframes"):
            argv += ["--timeframes", ",".join(pb_cfg["timeframes"])]
        args = lab.build_parser().parse_args(argv)
        ctx = cli.Context(args=args, cfg=config.load_config(), limits=config.load_limits(), home=config.trader_home())
        doc = lab.run(args, ctx)["doc"]
        s = doc["summary"]
        names = ["%s %s (%s)" % (r["display"], r["setup"], r["timeframe"]) for r in doc["validated"][:6]]
        text = ("Backtest lab re-ran on %d coins: %d validated combination(s)%s. Crypto is traded only from these." % (
            doc["coins"], s["coins_validated"], (": " + ", ".join(names)) if names else
            " — nothing kept an edge after costs on unseen data, so no crypto trades for now"))
        notify.send("learned", "Backtest lab: %d validated" % s["coins_validated"], text, cfg)
        if ((cfg.get("autopilot") or {}).get("etf_trend") or {}).get("enabled"):
            eargs = lab.build_parser().parse_args(["--etf", "--no-html"])
            edoc = lab.run(eargs, cli.Context(args=eargs, cfg=config.load_config(), limits=config.load_limits(),
                                              home=config.trader_home()))["doc"]
            notify.send("learned", "ETF lab: %d validated" % edoc["summary"]["coins_validated"],
                        "ETF trend lab re-ran on %d ETFs: %s." % (edoc["coins"], ", ".join(
                            r["display"] for r in edoc["validated"]) or "none validated"), cfg)
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": started, "task": "lab", "validated": s["coins_validated"],
                                                            "seconds": s["seconds"]})
    except Exception as exc:
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": started, "task": "lab",
                                                            "error": "%s: %s" % (type(exc).__name__, exc)})


class Housekeeping:
    """Work between cycles that must never delay exits: news refresh and the weekly backtest lab (background
    threads), daily compaction."""

    def __init__(self):
        self.news_thread = None
        self.lab_thread = None
        self.last_compact = None
        self.lab_tried = None
        self.shadow_thread = None
        self.shadow_tried = None

    def tick(self, cfg: dict) -> None:
        now = market_clock.now_utc()
        poll = float(((cfg.get("news") or {}).get("x") or {}).get("poll_minutes") or 15)
        feed = state.read_json("news_feed.json", {}) or {}
        age = now.timestamp() - market_clock.ts(feed["updated_at"]) if feed.get("updated_at") else None
        busy = self.news_thread is not None and self.news_thread.is_alive()
        if poll > 0 and not busy and (age is None or age >= poll * 60) and not config.is_offline():
            self.news_thread = threading.Thread(target=_refresh_watchlist_news, args=(cfg,), daemon=True,
                                                name="trader-news-refresh")
            self.news_thread.start()
        pb_cfg = (cfg.get("autopilot") or {}).get("playbook") or {}
        every = float(pb_cfg.get("auto_refresh_days") or 0)
        lab_busy = self.lab_thread is not None and self.lab_thread.is_alive()
        if every > 0 and pb_cfg.get("required_for_crypto", True) and not lab_busy and not config.is_offline() \
                and "crypto" in ((cfg.get("autopilot") or {}).get("assets") or ["stock", "crypto"]):
            pb = state.read_json("backtests/playbook.json", {}) or {}
            age = now.timestamp() - market_clock.ts(pb["generated_at"]) if pb.get("generated_at") else None
            retry_ok = self.lab_tried is None or now.timestamp() - self.lab_tried >= 6 * 3600
            if (age is None or age >= every * 86400) and retry_ok:
                self.lab_tried = now.timestamp()
                self.lab_thread = threading.Thread(target=_refresh_lab, args=(cfg,), daemon=True,
                                                   name="trader-backtest-lab")
                self.lab_thread.start()
        sh = state.read_json(shadow.FILE, {}) or {}
        shadow_busy = self.shadow_thread is not None and self.shadow_thread.is_alive()
        if not shadow_busy and not config.is_offline() and now.hour >= 1 and \
                (sh.get("updated_at") or "")[:10] != now.strftime("%Y-%m-%d") and self.shadow_tried != now.strftime("%Y-%m-%d"):
            self.shadow_tried = now.strftime("%Y-%m-%d")
            self.shadow_thread = threading.Thread(target=_daily_shadow, args=(cfg,), daemon=True, name="trader-shadow")
            self.shadow_thread.start()
        day = _today(now)
        if self.last_compact != day:
            self.last_compact = day
            try:
                compact_equity()
            except OSError:
                pass


def daemon(args, cfg) -> int:
    """Run forever: one cycle every interval_sec, crypto around the clock, stocks in the session."""
    if os.environ.get("TRADER_NOW") and not args.max_cycles:
        cli.fail("the daemon runs on the real clock — with a pinned clock (--now/--offline) use replay, or pass "
                 "--max-cycles for a bounded test run")
    acquire_lock()
    stop = {"signal": None}

    def _stop(signum, frame):
        stop["signal"] = signum
    previous = {}
    for sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None)):
        if sig is not None:
            try:
                previous[sig] = signal.signal(sig, _stop)
            except (ValueError, OSError):  # not the main thread — the flag still works
                pass
    approved = True if args.approve else None
    ap = cfg.get("autopilot") or {}
    mode = brokers.mode_of(cfg)
    notify.send("started", "Autopilot started (%s)" % mode.upper(),
                "Broker %s · %s · crypto 24/7, US stocks 9:30–15:30 ET. pid %d on %s." % (
                    ap.get("broker") or "simulator",
                    "standing approval" if (approved or ap.get("enabled")) else "DRY RUN (not enabled)",
                    os.getpid(), socket.gethostname()), cfg)
    house = Housekeeping()
    errors_in_row, n = 0, 0
    try:
        while stop["signal"] is None:
            res = run_cycle(approved=approved, runner="daemon")
            n += 1
            errors_in_row = errors_in_row + 1 if res.get("status") == "error" else 0
            if errors_in_row == ERROR_ALERT_AFTER:
                notify.send("error", "Autopilot failing: %d cycles in a row" % errors_in_row, res.get("message") or "",
                            config.load_config(), priority="high")
            if not args.json:
                print("%s  %s" % (market_clock.iso(market_clock.now_utc()), res.get("message")))
                for a in res.get("actions") or []:
                    print("    " + a)
                sys.stdout.flush()
            if args.max_cycles and n >= args.max_cycles:
                break
            cfg = config.load_config()
            try:
                house.tick(cfg)
            except Exception as exc:
                print("    housekeeping: %s: %s" % (type(exc).__name__, exc))
            interval = int(args.interval or (cfg.get("autopilot") or {}).get("interval_sec") or 60)
            if errors_in_row:
                interval = min(MAX_BACKOFF_SEC, interval * (2 ** min(errors_in_row - 1, 4)))
            waited = 0
            while waited < interval and stop["signal"] is None:
                time.sleep(1)
                waited += 1
                if read_control()["run_once"]:
                    break
    finally:
        why = "signal %s" % stop["signal"] if stop["signal"] is not None else "stopped after %d cycle(s)" % n
        try:
            st = state.read_json(STATE, {}) or {}
            _state(status="stopped", message="daemon stopped (%s)" % why)
            heartbeat("daemon", "stopped")
            notify.send("stopped", "Autopilot stopped", "%s. Last status: %s" % (why, st.get("message") or "?"),
                        config.load_config())
        finally:
            release_lock()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return 0


# --- CLI ----------------------------------------------------------------------------------------------------

def build_parser():
    p = cli.parser("autopilot.py", __doc__)
    p.add_argument("action", choices=("status", "run", "loop", "daemon", "pause", "resume", "kill", "replay",
                                      "check-live", "universe", "learned", "notify-test", "profile", "check"))
    p.add_argument("--once", action="store_true", help="run: a single cycle (default)")
    p.add_argument("--refresh", action="store_true", help="universe: rebuild it now instead of showing the cached one")
    p.add_argument("--approve", action="store_true",
                   help="standing approval for this run (otherwise config autopilot.enabled decides; else dry run)")
    p.add_argument("--interval", type=int,
                   help="loop/daemon: seconds between cycles (default config autopilot.interval_sec)")
    p.add_argument("--max-cycles", type=int, help="loop/daemon: stop after N cycles")
    p.add_argument("--confirm", help='kill: must be "KILL"')
    p.add_argument("--from", dest="start", help="replay: start time (ISO)")
    p.add_argument("--to", dest="end", help="replay: end time (ISO)")
    p.add_argument("--step", default="5m", help="replay: clock step (default 5m)")
    p.add_argument("--risk", type=float, default=2.0, help="profile: %% of equity at risk per trade (default 2)")
    p.add_argument("--leverage", type=float, default=1.0, help="profile: crypto leverage, 1–2 (default 1 = none)")
    p.add_argument("--stock-leverage", type=float, default=1.0, help="profile: stock margin, 1–2 (default 1 = none)")
    p.add_argument("--capital", type=float, help="profile: account size (default: config account_size)")
    p.add_argument("--write", action="store_true", help="profile: save the changes (default: show them only)")
    p.add_argument("--no-etf", action="store_true",
                   help="profile: no ETF trend while crypto is in a bear market (default: on)")
    p.add_argument("--cash-yield", type=float, default=4.0,
                   help="profile: %% a year idle cash earns in the simulator — today's T-bill yield (default 4)")
    p.add_argument("--no-runner", action="store_true",
                   help="profile: sell the whole trend breakout at its exit (default: let two thirds of a winner ride)")
    return p


# --- profile: the daily-trend setup the €1,000 backtest ran -----------------------------------------------

TREND_SETUPS = ["trend_ema", "trend_breakout"]
MAX_PROFILE_RISK = 5.0


def trend_profile(risk: float, lev: float, stock_lev: float, capital: float, runner: bool = True,
                  etf: bool = True, cash_yield: float = 4.0) -> tuple:
    """(config changes, limits changes) for daily trend following on the biggest coins.

    Every number is what the portfolio backtest used. The learning rules are loosened to fit a strategy that
    wins 30–40 % of trades: three losses in a row happen in a quarter of all stretches there, so they are no
    warning; seven (≈ 5 %) are. The drawdown pause sits above the worst drop of the backtest (−30 %), so it
    fires only when reality is worse than eight years of history.
    """
    if not 0 < risk <= MAX_PROFILE_RISK:
        raise ValueError("--risk must be above 0 and at most %g%% per trade" % MAX_PROFILE_RISK)
    for name, x in (("--leverage", lev), ("--stock-leverage", stock_lev)):
        if not 1.0 <= x <= config.LEVERAGE_HARD_CAP:
            raise ValueError("%s must be between 1 and %g" % (name, config.LEVERAGE_HARD_CAP))
    backstop = lambda pct: round(capital * pct / 100.0 * 4)  # dollar limits bind only after the account grew 4×
    cfg = {"risk_per_trade_pct": risk, "account_size": capital, "cash_yield_pct": float(cash_yield),
           "leverage": {"crypto": lev, "stock": stock_lev},
           "autopilot": {"sim_starting_cash": capital, "runner": {"enabled": bool(runner)},
                         "etf_trend": {"enabled": bool(etf), "when": "crypto_bear"},
                         "playbook": {"top": 10, "setups": TREND_SETUPS, "timeframes": ["1d"], "max_risk_pct": risk},
                         "universe": {"crypto": {"top_n": 10}},
                         "adapt": {"loss_streak": 7, "symbol_loss_streak": 5, "min_trades": 20,
                                   "max_drawdown_pct": 35}}}
    day = 5 * risk  # five full losses in one day, then no new entries until tomorrow
    lim = {"global": {"max_daily_loss_pct": day, "max_daily_loss_usd": backstop(day)},
           "crypto": {"max_open_positions": 5, "max_position_pct": 25, "max_total_exposure_pct": 100,
                      "allow_leverage": lev > 1, "max_leverage": lev, "max_risk_per_trade_pct": risk,
                      "max_risk_per_trade_usd": backstop(risk), "max_daily_loss_pct": day,
                      "max_daily_loss_usd": backstop(day)},
           "stock": {"allow_margin": stock_lev > 1, "max_leverage": stock_lev, "max_risk_per_trade_pct": risk,
                     "max_risk_per_trade_usd": backstop(risk), "max_daily_loss_pct": day,
                     "max_daily_loss_usd": backstop(day)}}
    return cfg, lim


def _flat(d: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out.update(_flat(v, prefix + k + "."))
        else:
            out[prefix + k] = v
    return out


def _get(d: dict, dotted: str):
    for part in dotted.split("."):
        if not isinstance(d, dict):
            return None
        d = d.get(part)
    return d


def profile_text(cfg: dict, limits: dict, changes: tuple, written: bool) -> str:
    c_cfg, c_lim = changes
    lines = ["PROFILE · daily trend following on the 10 biggest coins · %g%% risk · crypto %g× · stocks %g×%s" % (
        c_cfg["risk_per_trade_pct"], c_cfg["leverage"]["crypto"], c_cfg["leverage"]["stock"],
        " · winners ride" if c_cfg["autopilot"]["runner"]["enabled"] else "")]
    if c_cfg["autopilot"]["etf_trend"]["enabled"]:
        lines.append("Bear markets: while Bitcoin is below its 200-day average (no crypto trend to follow), the bot "
                     "trades the same trend rule on ETFs that move unlike crypto — gold, the dollar, commodities, "
                     "bonds, energy, the indexes — held for days, only those the ETF lab validated; idle cash counts "
                     "%g%% a year in the simulator (T-bills)." % c_cfg["cash_yield_pct"])
    if c_cfg["autopilot"]["runner"]["enabled"]:
        lines.append("Let winners ride: when a trend breakout's exit comes in profit while the coin is above its "
                     "200-day average, the bot sells a third and lets two thirds ride until a daily close below the "
                     "50-day EMA, with the stop moved to the buy price — only while this week's lab run says it pays.")
    for name, cur, ch in (("config.json", cfg, c_cfg), ("limits.json", limits, c_lim)):
        lines.append(name + ":")
        for key, new in _flat(ch).items():
            old = _get(cur, key)
            lines.append("  %-44s %s%s" % (key, json.dumps(new), "" if old == new else "   (was %s)" % json.dumps(old)))
    if (cfg.get("autopilot") or {}).get("broker") == "alpaca" and c_cfg["leverage"]["crypto"] > 1:
        lines.append("Note: Alpaca has no crypto margin — crypto stays at 1× there; leverage works in the simulator.")
    sim = state.read_json("broker/sim.json") or {}
    if sim and float(sim.get("starting_cash") or 0) != float(c_cfg["account_size"]):
        lines.append("The simulator keeps its current book (started at %s); delete trader/broker/sim.json to restart "
                     "it at %s." % (fmt.money(sim.get("starting_cash")), fmt.money(c_cfg["account_size"])))
    lines.append("Not touched: broker, mode, paper, live_confirmation, keys, autopilot.enabled.")
    lines.append("Saved. The weekly lab run rebuilds the playbooks; run them now with:\n"
                 "  python3 trader-backtest/lab.py --top 10 --timeframes 1d --setups %s%s" % (
                     ",".join(TREND_SETUPS), "\n  python3 trader-backtest/lab.py --etf"
                     if c_cfg["autopilot"]["etf_trend"]["enabled"] else "")
                 if written else "Dry run — add --write to save.")
    return "\n".join(lines)


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
    hb = state.read_json(HEARTBEAT, {}) or {}
    if hb.get("at"):
        age = market_clock.now_utc().timestamp() - market_clock.ts(hb["at"])
        alive = age <= max(180, 3 * int(hb.get("interval_sec") or 60)) and hb.get("status") != "stopped"
        lines.append("Heartbeat: %s — %s, pid %s on %s, %d s ago" % (
            "ALIVE" if alive else ("stopped" if hb.get("status") == "stopped" else "STALE"), hb.get("runner"),
            hb.get("pid"), hb.get("host"), age))
        sess = hb.get("sessions") or {}
        lines.append("Sessions: crypto %s · US stocks %s" % (sess.get("crypto"), sess.get("stock")))
    uni = st.get("universe") or {}
    if uni:
        lines.append("Watching %s stocks + %s coins (autopilot.py universe)" % (uni.get("stock", 0), uni.get("crypto", 0)))
    pb = st.get("playbook") or {}
    if pb:
        if not pb.get("required"):
            lines.append("Crypto playbook: off — crypto trades on the daily per-symbol backtest only")
        elif pb.get("problem"):
            lines.append("Crypto playbook: %s — no crypto trades until then" % pb["problem"])
        else:
            lines.append("Crypto playbook: %d validated combination(s)%s · built %s" % (
                pb.get("entries") or 0, (" on " + ", ".join(pb.get("coins") or [])) if pb.get("coins") else "",
                pb.get("generated_at")))
    learned = state.read_json("autopilot/adapt.json", {}) or {}
    if learned:
        paused = [k for k, v in (learned.get("setups") or {}).items() if v.get("status") == "paused"]
        cooling = [k for k, v in (learned.get("symbols") or {}).items() if v.get("status") == "cooldown"]
        lines.append("Learned: risk × %s%s%s · drawdown %.1f%%" % (
            learned.get("risk_mult", 1), " · paused " + ", ".join(paused) if paused else "",
            " · cooling " + ", ".join(cooling) if cooling else "", learned.get("drawdown_pct") or 0))
    hd = state.read_json(health.FILE, {}) or {}
    if hd:
        lines.append("Health: %s — %s" % (str(hd.get("status")).upper(), hd.get("text")))
    sd = state.read_json(shadow.FILE, {}) or {}
    if sd:
        lines.append("Backtest vs reality: %s — %s" % (str(sd.get("verdict")).upper(), sd.get("text")))
    book = state.read_json(BOOK, {}) or {}
    held = [it for it in (book.get("items") or {}).values() if it.get("status") == "open"]
    if held:
        lines.append("Holding:")
        lines += ["  " + position_story(it) for it in held]
    t = st.get("today") or {}
    if t:
        lines.append("Today %s: %d opened · %d skipped · realized %s" % (
            t.get("date"), t.get("trades_opened", 0), t.get("skipped", 0), fmt.money(t.get("realized_pnl"))))
    for p in state.read_json("broker/positions.json", []) or []:
        lines.append("  %s %s @ %s · last %s · %s" % (fmt.qty(p["qty"]), p["symbol"], fmt.price(p["avg_entry"]),
                                                    fmt.price(p.get("last")), fmt.money(p.get("unrealized_pl"))))
    lines.append("Live trading: %s" % ("READY (all opt-in steps done)" if ok_live else "off"))
    return "\n".join(lines)


def universe_text(doc: dict) -> str:
    lines = ["UNIVERSE · mode %s · built %s" % (doc.get("mode"), doc.get("generated_at"))]
    for asset in ("stock", "crypto"):
        sec = doc.get(asset) or {}
        syms = sec.get("symbols") or []
        if not sec:
            continue
        lines.append("%s: %d symbols · %s · refreshed %s" % (asset, len(syms), sec.get("source"), sec.get("refreshed_at")))
        reasons = sec.get("reasons") or {}
        for sym in syms:
            lines.append("  %-10s %s" % (sym, reasons.get(sym, "")))
    ex = doc.get("excluded") or {}
    if ex:
        lines.append("excluded: " + ", ".join("%s (%s)" % kv for kv in sorted(ex.items())[:20]))
    for w in doc.get("warnings") or []:
        lines.append("warning: " + w)
    return "\n".join(lines)


def learned_text(doc: dict) -> str:
    lines = ["WHAT THE AUTOPILOT LEARNED FROM ITS OWN TRADES · %s" % ("on" if doc.get("enabled", True) else "off")]
    lines.append("Risk × %s%s · equity %s · peak %s · drawdown %.1f%%%s" % (
        doc.get("risk_mult", 1), " (%s)" % doc["risk_reason"] if doc.get("risk_reason") else "",
        fmt.money(doc.get("equity")), fmt.money(doc.get("equity_peak")), doc.get("drawdown_pct") or 0,
        " — PAUSED" if doc.get("drawdown_pause") else ""))
    for k, v in sorted((doc.get("setups") or {}).items()):
        lines.append("  setup %-22s %2d trades · %d wins · %s · %s%s" % (
            k, v.get("trades") or 0, v.get("wins") or 0, fmt.r(v.get("expectancy_r")), v.get("status"),
            " until %s" % v["until"] if v.get("until") and v.get("status") == "paused" else ""))
    for k, v in sorted((doc.get("symbols") or {}).items()):
        if v.get("status") != "active" or v.get("loss_streak"):
            lines.append("  symbol %-10s loss streak %d · %s%s" % (k, v.get("loss_streak") or 0, v.get("status"),
                                                                  " until %s" % v["until"] if v.get("until") else ""))
    for ev in (doc.get("events") or [])[-8:]:
        lines.append("  %s  %s" % (ev.get("at"), ev.get("text")))
    if len(lines) == 2 and not doc.get("setups"):
        lines.append("  no closed autopilot trades yet — nothing to learn from")
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
        res = run_cycle(market_clock.iso(t), approved, runner="replay")
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
    if args.action == "check":
        res = run_checks(cfg)
        cli.emit(args, health.text(res["health"]) + "\n\n" + shadow.text(res["shadow"]), res)
        return 0
    if args.action == "profile":
        capital = float(args.capital or cfg.get("account_size") or 0)
        if capital <= 0:
            raise ValueError("--capital must be positive")
        changes = trend_profile(args.risk, args.leverage, args.stock_leverage, capital, not args.no_runner,
                                not args.no_etf, args.cash_yield)
        if args.write:
            config.update_file("config.json", changes[0])
            config.update_file("limits.json", changes[1])
        cli.emit(args, profile_text(cfg, ctx.limits, changes, args.write),
                 {"config": changes[0], "limits": changes[1], "written": bool(args.write)})
        return 0
    if args.action == "pause":
        write_control(paused=True)
        cli.emit(args, "Paused — no new entries; exits and time stops keep running.", read_control())
        return 0
    if args.action == "resume":
        write_control(paused=False, kill=False, dd_reset_at=market_clock.iso(market_clock.now_utc()))
        cli.emit(args, "Resumed — new entries allowed on the next cycle (the drawdown peak starts again from now).",
                 read_control())
        return 0
    if args.action == "universe":
        broker = None
        if args.refresh:
            try:
                broker = brokers.get(cfg)
            except BrokerError:
                broker = None
            universe.build(cfg, broker=broker)
        doc = state.read_json("autopilot/universe.json", {}) or {}
        if not doc:
            universe.current(cfg)
            doc = state.read_json("autopilot/universe.json", {}) or {}
        cli.emit(args, universe_text(doc), doc)
        return 0
    if args.action == "learned":
        doc = adapt.evaluate(cfg)
        cli.emit(args, learned_text(doc), doc)
        return 0
    if args.action == "notify-test":
        res = notify.test(cfg)
        ch = res.get("channels") or {}
        text = "Test notification: " + (", ".join("%s %s" % kv for kv in sorted(ch.items())) or "no channel configured")
        if not (cfg.get("notify") or {}).get("enabled"):
            text += "\n  notify.enabled is false in trader/config.json — nothing is sent until you turn it on"
        cli.emit(args, text, res)
        return 0
    if args.action == "daemon":
        return daemon(args, cfg)
    if args.action == "kill":
        if args.confirm != "KILL":
            cli.fail('kill needs --confirm KILL (it cancels every order and closes every position)')
        holder = running_daemon()
        if holder:  # two cycles at once would race on the book — let the daemon do it, now
            write_control(kill=True, run_once=True)
            cli.emit(args, "KILL sent to the running daemon (pid %s on %s) — it cancels every order and closes every "
                           "position within a few seconds. Check with: autopilot.py status" % (
                               holder.get("pid"), holder.get("host")), read_control())
            return 0
        write_control(kill=True)
        res = run_cycle(approved=False)
        cli.emit(args, "\n".join([res["message"]] + ["  " + a for a in res["actions"]]), res)
        return 0
    if args.action == "status":
        cli.emit(args, status_text(cfg), {"state": state.read_json(STATE, {}), "control": read_control(),
                                         "live_ready": brokers.live_readiness(cfg)[0]})
        return 0
    approved = True if args.approve else None
    holder = running_daemon() if args.action in ("run", "loop") else None
    if holder and args.action == "run":
        write_control(run_once=True)
        cli.emit(args, "A daemon is running (pid %s on %s) — asked it to run a cycle now instead of starting a second "
                       "one. Check with: autopilot.py status" % (holder.get("pid"), holder.get("host")), read_control())
        return 0
    if holder and args.action == "loop":
        cli.fail("a daemon is already trading this trader/ folder (pid %s on %s) — stop it before starting a loop"
                 % (holder.get("pid"), holder.get("host")))
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
        res = run_cycle(approved=approved, runner="cli")
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
