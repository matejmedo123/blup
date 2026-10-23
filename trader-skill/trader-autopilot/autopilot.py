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

import copy
import json
import math
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from datetime import timedelta

try:
    import fcntl
except ImportError:  # Windows: the lock file and the heartbeat are all there is
    fcntl = None

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import adapt, brokers, cli, config, data, fmt, market_clock, notify, setups, skills, state  # noqa: E402
from shared import health, http, indicators, shadow, symbols, universe  # noqa: E402
from shared.brokers import BrokerError, broker_symbol  # noqa: E402
from shared.brokers.base import OPEN_STATUSES  # noqa: E402
from shared.cache import FileCache  # noqa: E402

STATE = "autopilot/state.json"
CONTROL = "autopilot/control.json"
DECISIONS = "autopilot/decisions.jsonl"
BOOK = "autopilot/book.json"
SCAN = "autopilot/scan.json"
DAY = "autopilot/day.json"   # equity when the UTC day began — the daily-loss limit measures from there
HEARTBEAT = "autopilot/heartbeat.json"
LOCK = "autopilot/daemon.lock"
FLOCK = "autopilot/daemon.flock"  # held by the live daemon's process for as long as it runs (the OS frees it)
INTERVAL = "5m"
STALE_ENTRY_BARS = 3          # an entry that has not filled 15 min after the trigger is cancelled
DAILY_ENTRY_WAIT_SEC = 3600   # a daily signal's entry keeps working for an hour (the lab buys every one at the close)
DAILY_ENTRY_SLACK_PCT = (0.5, 2.0)  # …and may pay a quarter ATR above the close: at least 0.5 %, at most 2 %
NO_NEW_STOCK_ENTRIES = 30   # minutes before the close (3:30 p.m. ET, 12:30 on early-close days): too little
                            # session left for a 2R move before the time stop five minutes before the bell
TM_SEED = 7
APPROVAL_TEXT = "autopilot standing approval (config autopilot.enabled)"
STALE_LOCK_SEC = 600
ERROR_ALERT_AFTER = 5         # consecutive failed cycles before an "error" notification
MAX_BACKOFF_SEC = 900
HOLDING_BACKOFF_SEC = 120     # the longest wait between failing cycles while positions or entries are open
NEWS_REFRESH_BUDGET_SEC = 45  # the most a cycle waits for headlines right before a trade
CYCLE_LOCK_WAIT_SEC = 600    # the longest one cycle waits for another process's cycle to finish
CYCLE_BUDGET_SEC = 240        # past this, the cycle judges no more ideas (the next cycle does) and checks exits again
_MODS = {}
_PROCESS = {"started_at": None}


def _mod(skill: str, module: str):
    key = skill + "/" + module
    if key not in _MODS:
        _MODS[key] = skills.load(skill, module)
    return _MODS[key]


# --- small state helpers -------------------------------------------------------------------------

def read_control() -> dict:
    try:
        c = state.read_json(CONTROL, {}) or {}
    except ValueError as exc:  # unreadable: take no new trades, but keep managing the open ones
        note = "%s — paused until it is fixed or deleted (exits keep running)" % exc
        if note not in state.recovered:
            state.recovered.append(note)
        c = {"paused": True}
    return {"paused": bool(c.get("paused")), "kill": bool(c.get("kill")), "run_once": bool(c.get("run_once")),
            "updated_at": c.get("updated_at"), "by": c.get("by"), "dd_reset_at": c.get("dd_reset_at"),
            "kill_tries": int(c.get("kill_tries") or 0)}


def cap_first(s: str) -> str:
    return s[:1].upper() + s[1:]


def _consume_run_once(seen_at) -> None:
    """A "run once" asked for before this cycle began is used up — whatever the cycle did. One that arrived during
    the cycle (a KILL from the dashboard) is left for the next, which then starts at once."""
    with state.locked(CONTROL):
        c = read_control()
        if c["run_once"] and c.get("updated_at") == seen_at:
            write_control(by="autopilot", run_once=False)


def write_control(by: str = "cli", **changes) -> dict:
    with state.locked(CONTROL):  # the dashboard writes it too — neither may lose the other's KILL
        c = read_control()
        c.update(changes)
        c.update(updated_at=market_clock.iso(market_clock.now_utc()), by=by)
        state.write_json(CONTROL, c)
    shadow.note_control(c)
    return c


def _book() -> dict:
    b = state.read_json(BOOK, {}) or {}
    b.setdefault("items", {})
    b.setdefault("handled", {})
    return b


def _today(now) -> str:
    return market_clock.parse_iso(now).date().isoformat()


HANDLED_DAYS = 7


def _recent_handled(book: dict, now) -> dict:
    """Signals judged today or in the days before — a daily signal is judged once, never again the next day."""
    out = {}
    for day in sorted(book["handled"])[-HANDLED_DAYS:]:
        out.update(book["handled"][day])
    out.update(book["handled"].setdefault(_today(now), {}))
    return out


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
        return approved is True
    return (cfg.get("autopilot") or {}).get("enabled") is True  # "false" in quotes is not a yes


# --- broker sync & bookkeeping ----------------------------------------------------------------------

def _write_broker_files(broker, acct, positions, orders, book, realized_today):
    by_symbol = {it["symbol"]: pid for pid, it in book["items"].items() if it["status"] in LIVE_ITEM}
    for p in positions:
        p["plan_id"] = by_symbol.get(p["symbol"])
        if p["plan_id"]:
            it = book["items"][p["plan_id"]]
            p["story"] = position_story(it)
            p["riding"] = (it.get("runner") or {}).get("status") == "riding"
            for k in ("stop", "target"):  # the dashboard draws the position between them
                if p.get(k) is None and it.get(k) is not None:
                    p[k] = it[k]
            p["rule_exit"] = bool(it.get("exit_rule"))
    state.write_json("broker/positions.json", positions)
    recent = sorted(orders, key=lambda o: o.get("submitted_at") or "", reverse=True)
    keep = [o for o in recent if o.get("status") in OPEN_ORDER]
    keep += [o for o in recent if o.get("status") not in OPEN_ORDER][:max(0, 200 - len(keep))]
    state.write_json("broker/orders.json", keep)  # the newest 200 (and every open one), not the oldest
    unreal = sum(float(p.get("unrealized_pl") or 0) for p in positions)
    line = {"at": market_clock.iso(market_clock.now_utc()), "equity": acct.get("equity"), "cash": acct.get("cash"),
            "unrealized": round(unreal, 2), "realized_today": round(realized_today, 2), "mode": broker.mode,
            "account": account_key(broker, acct)}
    for k in ("borrowed", "interest_paid", "interest_earned"):  # only when leverage or cash interest is in play
        if acct.get(k):
            line[k] = acct[k]
    state.append_jsonl("broker/equity.jsonl", line)
    return line


def usd_limits_binding(cfg: dict, limits: dict, equity) -> list:
    """Dollar limits that now cut below their percentage twins: written for a smaller account (the profile's 4×
    backstop), they hold the bot back as it grows — the user decides whether to raise them."""
    try:
        eq = float(equity)
    except (TypeError, ValueError):
        return []
    out = []
    risk = float(cfg.get("risk_per_trade_pct") or 0)
    pairs = [("global", "max_daily_loss_usd", "max_daily_loss_pct")]
    pairs += [(a, "max_risk_per_trade_usd", "max_risk_per_trade_pct") for a in ("crypto", "stock")]
    for sec, usd_key, pct_key in pairs:
        lim = limits.get(sec) or {}
        usd, pct = lim.get(usd_key), lim.get(pct_key)
        if pct is None and usd_key == "max_risk_per_trade_usd":
            pct = risk or None
        if usd is None or pct is None or eq <= 0:
            continue
        if eq * float(pct) / 100.0 > float(usd) * 1.05:
            out.append("%s.%s %s is below %g%% of equity %s (%s) — it now caps the bot; raise it in limits.json "
                       "(or re-run `autopilot.py profile` with your own options and --capital %d)" % (
                           sec, usd_key, fmt.money(usd), float(pct), fmt.money(eq),
                           fmt.money(eq * float(pct) / 100.0), int(eq)))
    for sec in ("crypto", "stock"):
        for name, one in sorted(((limits.get(sec) or {}).get("symbols") or {}).items()):
            if not isinstance(one, dict) or one.get("max_risk_per_trade_usd") is None or eq <= 0:
                continue
            pct = one.get("max_risk_per_trade_pct")
            pct = float(pct) if pct is not None else config.risk_pct_for(cfg, name)
            if eq * pct / 100.0 > float(one["max_risk_per_trade_usd"]) * 1.05:
                out.append("%s.symbols.%s.max_risk_per_trade_usd %s is below %g%% of equity %s — it now caps %s; "
                           "raise it in limits.json (or re-run `autopilot.py profile` with --capital %d)" % (
                               sec, name, fmt.money(one["max_risk_per_trade_usd"]), pct, fmt.money(eq), name, int(eq)))
    return out


def account_key(broker, acct: dict) -> str:
    """Which account an equity figure belongs to: another broker, mode or a fresh simulator starts a new record."""
    return "%s/%s/%s" % (broker.name, broker.mode, (acct or {}).get("account_id") or "-")


def _day_loss(now, equity, yours: float = 0.0, account: str = None) -> tuple:
    """(loss today in $, equity at the start of the UTC day). Positions are held for days, so their whole unrealized
    P&L is not today's: the loss is how far equity fell since the day began (closed trades included) less what your
    own holdings lost today (``yours``, from ``yours_today``), and never less than what closed at a loss today.
    After a switch of account (``account``: paper → live, a fresh simulator) the day starts again at its equity."""
    doc = state.read_json(DAY, {}) or {}
    day = _today(now)
    if equity is not None:
        if account and doc.get("account") and doc["account"] != account:
            # not a loss: another account — nor are the old one's holdings or the trades it closed today
            doc = {"day": day, "start_equity": float(equity), "account": account,
                   "account_since": market_clock.iso(now)}
            yours = 0.0
        doc.setdefault("account", account)
        if doc.get("day") != day:
            yesterday = (market_clock.parse_iso(now).date() - timedelta(days=1)).isoformat()
            # after downtime the last equity seen is days old — those days' losses are not today's
            start = doc.get("last_equity", equity) if doc.get("day") == yesterday else equity
            doc = dict({k: doc[k] for k in ("yours", "yours_day", "account", "account_since") if k in doc},
                       day=day, start_equity=start)
        doc["last_equity"] = float(equity)
        state.write_json(DAY, doc)
    start = doc.get("start_equity") if doc.get("day") == day else None
    drop = float(start) - float(equity) + float(yours or 0) if start is not None and equity is not None else 0.0
    return max(drop, -_realized_today(now, account, doc.get("account_since")), 0.0), start


def _killed_today(now, mark: bool = False) -> bool:
    """The daily-loss kill fires once a day — after it the bot still manages exits on the following cycles."""
    doc = state.read_json(DAY, {}) or {}
    if mark:
        doc["killed"] = _today(now)
        state.write_json(DAY, doc)
    return doc.get("killed") == _today(now)


def _realized_today(now, account: str = None, since: str = None) -> float:
    """P&L of the trades closed today — with ``account``, only those of that broker and mode; with ``since``
    (the switch to this account, a fresh simulator), only those closed after it."""
    day = _today(now)
    total = 0.0
    name, mode = (account.split("/")[:2] + [None])[:2] if account else (None, None)
    for t in (state.read_json("journal.json", {}) or {}).get("trades") or []:
        if t.get("status") == "closed" and ((t.get("exit") or {}).get("time") or "")[:10] == day:
            if name and t.get("broker") and (t["broker"] != name or ("paper" in t and (t["paper"] is False)
                                                                      != (mode == "live"))):
                continue
            if since and ((t.get("exit") or {}).get("time") or "") < since:
                continue
            total += float(t.get("pnl_usd") or 0)
    return total


LIVE_ITEM = ("submitting", "pending", "open")  # book items the bot still owns something for
UNSURE_ORDER = "may or may not have been placed"  # the broker adapters' words for "look it up before anything else"
OPEN_ORDER = tuple(s for s in OPEN_STATUSES if s != "pending_cancel")  # still working (a cancel on its way isn't)
PDT_EQUITY = 25000.0         # FINRA pattern-day-trader threshold (margin accounts, Alpaca paper included)
CRYPTO_FEE_IN_COIN = 0.0025  # Alpaca takes its crypto fee (≤ 0.25 %) out of the coins bought
STOP_LIMIT_ROOM = 0.005  # Alpaca crypto stops are stop-limits 0.5 % under the stop: below that they can't fill


def _live_stop(it: dict, orders: list):
    """This trade's own working protective stop at the broker, or None — a stop you placed yourself on the same
    symbol is not the bot's (it is neither cancelled by its exits nor trusted to protect its position)."""
    sid = it.get("stop_order_id")
    for o in orders:
        if o.get("symbol") != it["symbol"] or o.get("side") != "sell" or o.get("status") not in OPEN_ORDER:
            continue
        if not _mine(o, it):
            continue
        if o.get("id") == sid or o.get("leg") == "stop" or str(o.get("type") or "").startswith("stop"):
            return o
    placed = it.get("stop_retry_at")
    fresh = bool(placed) and market_clock.now_utc().timestamp() - market_clock.ts(placed) < 600
    if sid and fresh and not any(o.get("id") == sid for o in orders):
        # placed after this order list was read (a fill in this very cycle): there until the next list says — an
        # older id the broker doesn't know (a save that failed, a lookup that didn't answer) is no stop at all
        return {"id": sid, "status": "new", "symbol": it["symbol"], "side": "sell",
                "type": "stop_limit" if it["asset"] == "crypto" else "stop"}
    return None


def _mine(o: dict, it: dict) -> bool:
    """Is this order one of this trade's own (its bracket legs, its stop, its exits) — not the partial sale of a
    runner and not anything else on the same symbol (your own shares or coins)?"""
    ride = it.get("runner") or {}
    if o.get("id") and o.get("id") == ride.get("sell_order_id"):
        return False
    cid = str(o.get("client_order_id") or "")
    return bool((o.get("id") and o.get("id") in (it.get("exit_order_id"), it.get("stop_order_id")))
                or (o.get("id") and o.get("id") in (it.get("leg_ids") or ()))
                or (it.get("broker_order_id") and o.get("parent_id") == it.get("broker_order_id"))
                or (it.get("order_id") and cid.startswith(it["order_id"]) and not cid.endswith("-part")))


SPLITS = (2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50)


def _split_check(it: dict, p: dict, cfg: dict = None) -> str:
    """A stock split or reverse split on a held stock: the broker scales its quantity and average price, the book
    must too — or the stop, the size and the P&L are all off by the split ratio. '' when nothing changed."""
    if it["asset"] != "stock":
        return ""
    try:
        avg, held = float(p.get("avg_entry") or 0), float(p.get("qty") or 0)
    except (TypeError, ValueError):
        return ""
    if avg <= 0 or held <= 0:
        return ""
    # judged on what the broker reported LAST cycle, not on the bot's fill price: shares you hold yourself blend
    # into the broker's average price, and a blend is no split. A split moves both the quantity and the average
    # by the same ratio from one cycle to the next; the bot's own sales change only the quantity
    prev_q, prev_a = it.get("broker_qty"), it.get("broker_avg")
    it["broker_qty"], it["broker_avg"] = held, avg
    if not prev_q or not prev_a:
        return ""
    for n in SPLITS:
        for k, word in ((n, "%d-for-1 split" % n), (1.0 / n, "1-for-%d reverse split" % n)):
            if abs(held / float(prev_q) / k - 1) < 0.02 and abs(float(prev_a) / avg / k - 1) < 0.02:
                break
        else:
            continue
        it["qty"] = round(float(it["qty"]) * k, 6)
        for f in ("stop", "target", "entry_fill", "entry_plan"):
            if it.get(f) is not None:
                it[f] = float(it[f]) / k
        try:
            journal = _mod("trader-journal", "journal")
            t = journal.get_trade(it.get("trade_id"))
            if t:
                t["qty"] = it["qty"]
                t["entry"]["price"] = float(t["entry"]["price"]) / k
                t["stop"] = float(t["stop"]) / k if t.get("stop") is not None else None
                t["risk_per_unit"] = float(t["risk_per_unit"]) / k
                t["notes"] = (t.get("notes") or "") + " · adjusted for a %s" % word
                journal.save_trade(t)
        except Exception:  # noqa: BLE001 — the book is right; the journal note is a nicety
            pass
        notify.send("error", "%s: %s" % (it["symbol"], word),
                    "The broker shows a %s on %s; the bot rescaled its quantity, stop and target to match." % (
                        word, it["symbol"]), cfg)
        return "%s: %s — quantity, stop and target rescaled to match the broker" % (it["symbol"], word)
    return ""


WASH_LIMIT = 0.99  # after a wash-trade refusal: sell with a limit 1 % under the last price, a stop-limit 3 % under
WASH_STOP_LIMIT = 0.97


def _wash(exc) -> bool:
    """Alpaca's wash-trade guard: your own open buy order on the symbol could trade with the bot's market sell."""
    return "wash" in str(exc).lower()


def _sell_own(broker, it: dict, held: float = None, limit_price: float = None) -> dict:
    """Sell this trade's quantity at market (or, with limit_price, with a marketable limit). The whole position is
    closed only when all of it is this trade's — shares or coins you hold yourself on the same symbol are never
    sold."""
    room = CRYPTO_FEE_IN_COIN + 1e-4 if it["asset"] == "crypto" else 1e-6  # the fee left out of its quantity
    step = broker.qty_step(it["symbol"], it["asset"]) if hasattr(broker, "qty_step") else 0.0
    if limit_price is not None:
        qty = float(it["qty"]) if held is None else min(float(it["qty"]), float(held))
        o = broker.place_exit(it["symbol"], qty, "limit", limit_price=limit_price, asset=it["asset"],
                              client_order_id="%s-x%d" % (it["order_id"], int(time.time() * 1000)))
        it.update(exit_limit=float(limit_price), exit_limit_at=market_clock.iso(market_clock.now_utc()))
    elif held is not None and (float(held) <= float(it["qty"]) * (1 + room)
                               or (step and float(held) - float(it["qty"]) < step - 1e-12)):
        o = broker.close_position(it["symbol"])  # all ours — also clears crypto fee dust a sized sell would leave
        it.pop("exit_limit", None), it.pop("exit_limit_at", None)
    else:
        qty = float(it["qty"]) if held is None else min(float(it["qty"]), float(held))
        o = broker.place_exit(it["symbol"], qty, "market", asset=it["asset"],
                              client_order_id="%s-x%d" % (it["order_id"], int(time.time() * 1000)))
        it.pop("exit_limit", None), it.pop("exit_limit_at", None)
    it["exit_order_id"] = o.get("id")
    return o


def _queued_exit(broker, it: dict, orders: list):
    """This trade's exit order — also one sent earlier in this same cycle (the reconcile's sale of a runner whose
    part sale failed), which the order list read at the start of the cycle can't hold: looked up at the broker,
    so the exits and the KILL never sell it a second time out of coins you hold yourself."""
    oid = it.get("exit_order_id")
    if not oid:
        return None
    o = _find(orders, oid)
    if o is None:
        try:
            o = next((x for x in broker.lookup(oid) if x.get("id") == oid), None)
        except BrokerError:
            o = None
    return o


def _stale_exit(queued: dict, it: dict, last, now) -> bool:
    """A limit sale (sent because a market one was refused) that the price has fallen below, or that has waited
    EXIT_RETRY_SEC: it is cancelled and sent again at today's price — never left resting while the position has
    no stop. A queued market sale (a stock after hours) is left to wait for the open."""
    if queued.get("type") != "limit" and (queued.get("type") or not it.get("exit_limit_at")):
        return False
    try:
        limit = float(queued.get("limit_price") or it.get("exit_limit") or 0)
        last = float(last) if last is not None else None
    except (TypeError, ValueError):
        limit, last = 0.0, None
    if last is not None and limit > 0 and last < limit:
        return True
    at = it.get("exit_limit_at")
    return bool(at) and now.timestamp() - market_clock.ts(at) >= EXIT_RETRY_SEC


CANCEL_WAIT_SEC = 6     # how long an exit waits for the broker to confirm a cancelled stop
EXIT_RETRY_SEC = 900    # after the broker refuses a sale: the stop goes back, the sale is tried again this much later


def _cancel_own_sells(broker, it: dict, orders: list, live=None) -> str:
    """Cancel this trade's working sell orders (its stop, bracket legs, exits) and wait until the broker says they
    are cancelled. '' when the way is clear for a sale; otherwise why it must wait: at Alpaca a cancel is pending
    for a moment and still holds the quantity (the sale would be refused), and a stop that filled in between has
    already sold — a second sale would come out of shares you hold yourself."""
    own = [o for o in orders if o.get("status") in OPEN_STATUSES and o.get("side") == "sell"
           and (o is live or _mine(o, it))]
    ids = [o["id"] for o in own]  # a cancel already pending (asked last cycle) is waited for, not asked again
    for o in own:
        if o.get("status") not in OPEN_ORDER:
            continue
        try:
            broker.cancel(o["id"])
        except BrokerError:
            pass  # "not cancelable" — perhaps it just filled: the look below tells
    deadline = time.monotonic() + CANCEL_WAIT_SEC
    while ids:
        status, part = {}, set()
        for oid in ids:
            found = [o for o in broker.lookup(oid) if o.get("id") == oid]
            status[oid] = found[0].get("status") if found else None
            try:
                if found and float(found[0].get("filled_qty") or 0) > 0:
                    part.add(oid)  # partly filled, then cancelled: some of it is already sold
            except (TypeError, ValueError):
                part.add(oid)
        sold = [oid for oid, st in status.items() if st in ("filled", "partially_filled") or oid in part]
        if sold:
            return "its sell order %s filled meanwhile — the next sync books it" % sold[0]
        waiting = [oid for oid, st in status.items() if st not in ("canceled", "expired", "rejected", "replaced")]
        if not waiting:
            break
        if time.monotonic() >= deadline:
            return "the cancel of %s is not confirmed yet — the sale waits for the next cycle" % waiting[0]
        time.sleep(1.0)
    return ""


def _restore_stop(broker, it: dict, held, now) -> list:
    """Put the protective stop back (after a refused sale, or when the broker lost it)."""
    it["stop_retry_at"] = market_clock.iso(now)
    qty = min(float(it["qty"]), float(held or it["qty"]))
    cid = "%s-s%d" % (it["order_id"], int(now.timestamp()))
    try:
        try:
            so = broker.place_stop(it["symbol"], qty, it["stop"], client_order_id=cid, asset=it["asset"])
        except BrokerError as exc:
            if not _wash(exc):
                raise
            # your own buy order on the symbol: a stop-limit under it can't trade with it — Alpaca takes that
            so = broker.place_stop(it["symbol"], qty, it["stop"], client_order_id=cid + "l", asset=it["asset"],
                                   limit_price=float(it["stop"]) * WASH_STOP_LIMIT)
        it["stop_order_id"] = so.get("id")
        return ["protective stop %s for %s put back" % (fmt.price(it["stop"]), it["symbol"])]
    except BrokerError as exc:  # the old id stays: its own fill must still close the trade as a stop
        return ["no stop order for %s (%s) — the bot watches the stop" % (it["symbol"], exc)]


def _sale_refused(broker, it: dict, p: dict, exc, now, cfg: dict = None) -> list:
    """The broker said no to the bot's sale (a wash-trade guard against your own open buy order, the
    pattern-day-trader rule, an asset no longer tradable): the position must not sit there without its stop."""
    if UNSURE_ORDER in str(exc):  # it may have gone through: a stop now could sell a second time
        return ["could not tell whether the sale of %s went through (%s) — the next sync shows" % (it["symbol"], exc)]
    first = not it.get("exit_refused_at")
    it["exit_refused_at"], it["exit_refused"] = market_clock.iso(now), str(exc)
    out = ["the broker refused the sale of %s: %s — the stop goes back, the sale is tried again in %d min" % (
        it["symbol"], exc, EXIT_RETRY_SEC // 60)]
    out += _restore_stop(broker, it, p.get("qty") if p else None, now)
    if first:
        hint = (" Cancel your own open buy order on %s — Alpaca refuses the bot's sale while it could trade with "
                "yours." % it["symbol"]) if _wash(exc) else (" The day-trade rule refuses same-day sales under "
                "$25,000 — the stop holds it until tomorrow." if "day trad" in str(exc).lower() else "")
        notify.send("error", "%s: the broker refused the bot's sale" % it["symbol"],
                    "%s. The protective stop is back in place and the sale is retried every %d minutes.%s" % (
                        exc, EXIT_RETRY_SEC // 60, hint), cfg, priority="high")
    return out


def _orphans(book: dict, orders: list, cfg: dict) -> None:
    """An open order at the broker that carries the bot's client id but no book item of the bot's: a crash at
    the worst moment, a book restored from an old copy. Nobody manages it — say so once, with its id."""
    mine = [it.get("order_id") for it in book["items"].values() if it.get("order_id")]
    manual = {o.get("id") for o in (state.read_json("orders.json", {}) or {}).get("orders") or []
              if o.get("origin") != "autopilot"}
    seen = (state.read_json(STATE, {}) or {}).get("orphans_told") or []
    new = []
    for o in orders:
        cid = str(o.get("client_order_id") or "")
        if o.get("status") not in OPEN_ORDER or not cid.startswith("ord-") or cid in manual:
            continue
        if any(cid == m or cid.startswith(m + "-") for m in mine) or o.get("id") in seen:
            continue
        new.append(o)
    if new:
        notify.send("error", "Order(s) the bot does not manage", "Open at the broker under the bot's client ids, but "
                    "not in its book: %s. Cancel them at the broker, or check what happened before a restart." % (
                        ", ".join("%s %s %s (%s)" % (o.get("side"), o.get("symbol"), o.get("client_order_id"),
                                                     o.get("id")) for o in new[:5])), cfg, priority="high")
        _state(orphans_told=(seen + [o.get("id") for o in new])[-50:])


def _here(it: dict, broker) -> bool:
    """Was this trade opened at the broker and account this cycle talks to? A simulator or paper trade left in
    the book must never be sold — or given a stop — out of the live account, where the same coin may be yours;
    a live trade must never be "closed" by the simulator while the real one stays open."""
    b, m = it.get("broker"), it.get("mode")
    return (b is None or b == broker.name) and (m is None or m == broker.mode)


def foreign_open(book: dict, broker=None) -> list:
    """Open or waiting trades that belong to another broker or account than ``broker`` (or than each other)."""
    live = [it for it in book["items"].values() if it.get("status") in LIVE_ITEM]
    if broker is not None:
        return [it for it in live if not _here(it, broker)]
    return live


def forget_foreign(cfg: dict) -> dict:
    """Mark the book's open trades of another broker or account than the configured one as "left": after a switch
    (simulator → paper → live) they are never managed from here, and they would hold up new entries forever."""
    name = (cfg.get("autopilot") or {}).get("broker") or "simulator"
    mode = brokers.mode_of(cfg)
    gone = []
    with state.locked("autopilot/cycle", timeout=CYCLE_LOCK_WAIT_SEC):
        book = _book()
        for key, it in book["items"].items():
            if it.get("status") in LIVE_ITEM and (it.get("broker") or name, it.get("mode") or mode) != (name, mode):
                it.update(status="left", left_at=market_clock.iso(market_clock.now_utc()),
                          left_note="opened at %s/%s; the bot now trades at %s/%s" % (
                              it.get("broker"), it.get("mode"), name, mode))
                gone.append("%s (%s/%s)" % (it.get("symbol"), it.get("broker"), it.get("mode")))
        if gone:
            state.write_json(BOOK, book)
    return {"forgotten": gone, "message": ("Forgot %d trade(s) of another broker or account: %s. Close them there "
                                           "if they are still open." % (len(gone), ", ".join(gone))) if gone else
            "Nothing to forget — every open trade in the book belongs to %s/%s." % (name, mode)}


def _bot_qty(book: dict, orders: list, broker=None) -> dict:
    """symbol → how much of it the bot holds: its open trades, and what of a pending entry already filled."""
    out = {}
    for it in book["items"].values():
        if it.get("status") not in LIVE_ITEM or (broker is not None and not _here(it, broker)):
            continue
        qty = float(it.get("qty") or 0)
        if it["status"] != "open":
            o = _find(orders, it.get("broker_order_id")) or _find(orders, cid=it.get("order_id")) or {}
            try:
                qty = float(o.get("filled_qty") or 0)
            except (TypeError, ValueError):
                qty = 0.0
        out[it["symbol"]] = out.get(it["symbol"], 0.0) + qty
    return out


def yours_today(now, positions: list, book: dict, orders: list, broker=None) -> float:
    """How much the coins and shares you hold yourself at this broker made (+) or lost (−) since the UTC day began,
    from their price moves alone: your own BTC falling is not the bot's daily loss. Buying or selling them yourself
    moves nothing (cash ↔ coins); what they moved before you sold stays counted for the day."""
    doc = state.read_json(DAY, {}) or {}
    day = _today(now)
    yesterday = (market_clock.parse_iso(now).date() - timedelta(days=1)).isoformat()
    if doc.get("yours_day") == day:
        mine = doc.get("yours") or {}
    elif doc.get("yours_day") == yesterday:  # the day's start equity is yesterday's last — so is this baseline
        mine = {sym: dict(v, move=0.0) for sym, v in (doc.get("yours") or {}).items() if float(v.get("qty") or 0)}
    else:
        mine = None
    fresh = mine is None  # after days away (or the first cycle since the upgrade): counting starts now
    mine = mine or {}
    bot = _bot_qty(book, orders, broker)
    seen = set()
    for p in positions or []:
        sym = p.get("symbol")
        try:
            whole = float(p.get("qty") or 0)
            qty = max(0.0, whole - bot.get(sym, 0.0))
            last = float(p.get("last") or 0)
        except (TypeError, ValueError):
            continue
        if not last > 0:
            continue
        seen.add(sym)
        was = mine.get(sym) or {}
        move = float(was.get("move") or 0)
        q0, p0 = float(was.get("qty") or 0), float(was.get("last") or 0)
        w0 = float(was.get("whole") or q0)
        if not fresh and q0 > 0 and p0 > 0:
            # a split scales the whole position's quantity and price together (the bot's share is rescaled later
            # this cycle): no gain, no loss
            split = whole > 0 and w0 > 0 and abs(last / p0 - 1) > 0.3 and abs(whole * last / (w0 * p0) - 1) < 0.02
            if not split:
                move += q0 * (last - p0)
        mine[sym] = {"qty": round(qty, 10), "whole": round(whole, 10), "last": last, "move": round(move, 2)}
    for sym, was in mine.items():
        if sym not in seen:  # sold (or gone): what it moved today stays, nothing more
            was["qty"] = 0.0
    doc.update(yours_day=day, yours=mine)
    state.write_json(DAY, doc)
    return round(sum(float(v.get("move") or 0) for v in mine.values()), 2)


def _tracked(broker, book: dict, orders: list) -> list:
    """The bot's own orders missing from the broker's recent-orders list (a swing bracket placed weeks ago)."""
    seen = {o.get("id") for o in orders}
    extra = []
    for it in book["items"].values():
        if it["status"] not in LIVE_ITEM or not _here(it, broker):
            continue
        for oid in (it.get("broker_order_id"), it.get("stop_order_id"), it.get("exit_order_id"),
                    (it.get("runner") or {}).get("sell_order_id")):
            if not oid or oid in seen:
                continue
            try:
                found = broker.lookup(oid) or []
            except BrokerError:
                continue
            for o in found:
                if o.get("id") not in seen:
                    seen.add(o.get("id"))
                    extra.append(o)
    return extra


def _find(orders, oid=None, cid=None):
    for o in orders:
        if (oid and o.get("id") == oid) or (cid and o.get("client_order_id") == cid):
            return o
    return None


def _open_trade(item: dict, fill: dict, cfg: dict, limits: dict) -> dict:
    journal = _mod("trader-journal", "journal")
    plan = (state.read_json("plan.json", {}) or {}).get("plans", {}).get(item["plan_id"])
    if not plan:  # plan.json lost it (a manual run overwrote the file) — the book item has what the trade needs
        entry = float(item.get("entry_plan") or fill["filled_avg_price"])
        plan = {"id": item["plan_id"], "symbol": item.get("data_key") or item["symbol"], "asset": item["asset"],
                "setup": item.get("setup"), "entry": {"price": entry, "time": item["placed_at"]},
                "stop": {"price": float(item["stop"])}, "target": {"price": item.get("target")},
                "risk_per_unit": max(entry - float(item["stop"]), 1e-12)}
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
    def change(doc):
        for o in doc.get("orders") or []:
            if o.get("id") == oid:
                o.update(fields)
    state.update_json("orders.json", change, {})


def reconcile(broker, book: dict, positions: list, orders: list, cfg: dict, limits: dict) -> list:
    """Turn broker fills into journal entries: entries open trades, exits close them. One position that can't be
    reconciled (a missing plan, a journal that won't save) never stops the others."""
    actions = []
    now = market_clock.now_utc()
    step = market_clock.interval_seconds(INTERVAL)
    pos_by = {p["symbol"]: p for p in positions}
    for it in book["items"].values():
        if not _here(it, broker):  # another broker's or account's trade: its fills are not in these lists
            continue
        try:
            actions += _reconcile_one(broker, it, pos_by, orders, cfg, limits, now, step)
        except Exception as exc:  # noqa: BLE001 — logged on the item and in the cycle's actions
            it["error"] = "%s: %s" % (type(exc).__name__, exc)
            actions.append("could not reconcile %s: %s" % (it.get("symbol"), it["error"]))
    return actions


def _reconcile_one(broker, it: dict, pos_by: dict, orders: list, cfg: dict, limits: dict, now, step: int) -> list:
    actions = []
    if it["status"] == "submitting":  # sent, but the answer never reached the book (or never came)
        o = _find(orders, cid=it.get("order_id"))
        if o is None and now.timestamp() - market_clock.ts(it["placed_at"]) > 2 * step:
            o = broker.find_client(it["order_id"])
        if o is not None:
            it.update(status="pending", broker_order_id=o.get("id"))
            actions.append("found the entry for %s at the broker (sent before a restart)" % it["symbol"])
        elif now.timestamp() - market_clock.ts(it["placed_at"]) > 6 * step:
            it["status"] = "canceled"
            _update_order(it["order_id"], status="canceled")
            actions.append("entry for %s never reached the broker" % it["symbol"])
            return actions
        else:
            return actions
    if it["status"] == "pending":
        o = _find(orders, it.get("broker_order_id"), it.get("order_id"))
        part = o and o.get("status") in ("canceled", "expired") and float(o.get("filled_qty") or 0) > 0 \
            and o.get("filled_avg_price")
        if o and (o.get("status") == "filled" or part):  # a partly filled entry is a position all the same
            qty = float(o.get("filled_qty") or it["qty"])
            p = pos_by.get(it["symbol"])
            if it["asset"] == "crypto" and p and 0 < float(p.get("qty") or 0) < qty:
                qty = float(p["qty"])  # a fee taken in the coin leaves less than was bought
            elif it["asset"] == "crypto" and broker.name == "alpaca":
                # Alpaca takes the fee out of the coins later in the day (or you hold the coin too, so the position
                # can't show it): the stop and the exits never count the fee as the bot's to sell
                qty = round(qty * (1 - CRYPTO_FEE_IN_COIN), 9)
            step = broker.qty_step(it["symbol"], it["asset"]) if hasattr(broker, "qty_step") else 0.0
            if step and qty > step:  # the stop, the journal and the sales all count what the broker can sell
                qty = round(math.floor(qty / step + 1e-9) * step, 12)
            o = dict(o, filled_qty=qty)
            trade = _open_trade(it, o, cfg, limits)
            it.update(status="open", filled_at=o.get("filled_at"), entry_fill=o.get("filled_avg_price"),
                      trade_id=trade["id"], qty=qty, partial=bool(part),
                      # its bracket legs, remembered: weeks later the broker may list them without their parent
                      leg_ids=[x.get("id") for x in orders if it.get("broker_order_id")
                               and x.get("parent_id") == it.get("broker_order_id")])
            _update_order(it["order_id"], status="filled", filled_avg_price=o.get("filled_avg_price"))
            actions.append("filled %s %s @ %s" % (fmt.qty(it["qty"]), it["symbol"], fmt.price(o["filled_avg_price"])))
            if it["asset"] == "crypto" or part:  # a partly filled bracket never activates its legs
                try:
                    so = broker.place_stop(it["symbol"], it["qty"], it["stop"], client_order_id=it["order_id"] + "-stop",
                                           asset=it["asset"])
                    it["stop_order_id"] = so.get("id")
                    it["stop_retry_at"] = market_clock.iso(now)
                    actions.append("protective stop %s for %s" % (fmt.price(it["stop"]), it["symbol"]))
                except BrokerError as exc:
                    it["stop_error"] = str(exc)
                    actions.append("could not place the protective stop for %s: %s" % (it["symbol"], exc))
        elif o and o.get("status") in ("canceled", "expired", "rejected"):
            it["status"] = "canceled"
            _update_order(it["order_id"], status=o["status"])
            actions.append("entry for %s %s" % (it["symbol"], o["status"]))
        elif now.timestamp() - market_clock.ts(it["placed_at"]) > (
                DAILY_ENTRY_WAIT_SEC if it.get("interval") == "1d" else STALE_ENTRY_BARS * step):
            if not it.get("cancel_asked_at"):
                # the next sync says how it ended: cancelled, partly filled or filled in between
                try:
                    broker.cancel(it.get("broker_order_id"))
                except BrokerError:
                    pass
                it["cancel_asked_at"] = market_clock.iso(now)
                actions.append("entry for %s not filled within %d min — cancelling it so a late fill can't "
                               "happen" % (it["symbol"], (DAILY_ENTRY_WAIT_SEC if it.get("interval") == "1d"
                                                          else STALE_ENTRY_BARS * step) // 60))
            elif now.timestamp() - market_clock.ts(it["cancel_asked_at"]) > 6 * step:
                if not o:
                    it["status"] = "canceled"
                    _update_order(it["order_id"], status="canceled")
                    actions.append("entry for %s cancelled (no longer seen at the broker)" % it["symbol"])
                elif o.get("status") in OPEN_ORDER:  # the cancel did not take (a network error) — ask again
                    try:
                        broker.cancel(o["id"])
                    except BrokerError:
                        pass
                    it["cancel_asked_at"] = market_clock.iso(now)
    elif it["status"] == "open":
        ride = it.get("runner") or {}
        if ride.get("status") == "selling":
            o = _find(orders, ride.get("sell_order_id"))
            if o and o.get("status") == "filled":
                actions += start_ride(broker, it, o, cfg)
            elif (o and o.get("status") in ("canceled", "expired", "rejected")) or (
                    (not o or o.get("status") in OPEN_ORDER)
                    and now.timestamp() - market_clock.ts(ride.get("asked_at") or it["placed_at"]) > 6 * step):
                if o and o.get("status") in OPEN_STATUSES:  # cancelled and confirmed first: what of it sold is
                    wait = _cancel_own_sells(broker, it, orders, live=o)  # booked next cycle, never sold twice
                    if wait:
                        actions.append("partial sale of %s: %s" % (it["symbol"], wait))
                        return actions
                    o = dict(o, status="canceled")
                # its protective stop is already cancelled, so sell everything now rather than wait
                ride["status"] = "failed"
                if o and _part_sold(o, it):  # what of the part did sell is sold: only the rest goes now
                    actions += _book_part_sale(it, o, cfg)
                what = o["status"] if o else "not seen at the broker after %d min" % (6 * step // 60)
                it["exit_note"] = (it.get("exit_note") or "exit rule") + " · the partial sale was %s" % what
                it["exit_reason"], it["stop_order_id"] = "rule", None
                try:
                    p = pos_by.get(it["symbol"]) or {}
                    _sell_own(broker, it, p.get("qty"))
                    actions.append("partial sale of %s %s — sold everything instead" % (it["symbol"], what))
                except BrokerError as exc:
                    actions.append("partial sale of %s %s and closing failed (%s) — the bot watches the stop"
                                   % (it["symbol"], what, exc))
            return actions
        p = pos_by.get(it["symbol"])
        for o in orders:
            if _part_sold(o, it) and _mine(o, it) and float(o["filled_qty"]) < float(it["qty"]) * (1 - 1e-9):
                actions += _book_part_sale(it, o, cfg)
        since = ride.get("sold_at") or it.get("filled_at") or ""
        sells = [o for o in orders if o.get("symbol") == it["symbol"] and o.get("side") == "sell"
                 and o.get("status") == "filled" and (o.get("filled_at") or "") >= since
                 and o.get("id") != ride.get("sell_order_id")]
        own = [o for o in sells if _mine(o, it)] + [
            o for o in orders if _part_sold(o, it) and _mine(o, it) and float(o["filled_qty"]) >= float(it["qty"]) *
            (1 - 1e-9)]
        if own:  # its own stop, leg or exit filled — whatever else of the symbol you still hold
            ex = sorted(own, key=lambda o: o.get("filled_at") or "")[-1]
        elif p and float(p.get("qty") or 0) > 1e-9:
            return actions
        elif sells:  # the position is gone and something else sold it (by hand at the broker)
            ex = sorted(sells, key=lambda o: o.get("filled_at") or "")[-1]
        else:
            return actions
        leg = ex.get("leg")
        if leg in ("stop", "target"):
            reason = leg
        elif ex.get("id") == it.get("stop_order_id"):
            reason = "stop"
        else:
            reason = it.get("exit_reason") or "manual"
        trade = _close_trade(it, ex, reason, cfg)
        it.update(status="closed", closed_at=ex.get("filled_at") or ex.get("updated_at") or market_clock.iso(now),
                  exit_price=ex.get("filled_avg_price"),
                  exit_reason=reason, pnl_usd=(trade or {}).get("pnl_usd"))
        for o in orders:  # a stop of its own still working (put back after a sale that did go through) must go
            if o is not ex and o.get("side") == "sell" and o.get("status") in OPEN_ORDER and _mine(o, it):
                try:
                    broker.cancel(o["id"])
                    actions.append("cancelled %s's leftover %s order" % (it["symbol"], o.get("type") or "sell"))
                except BrokerError:
                    pass
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
    except Exception as exc:  # noqa: BLE001 — no prices this cycle: the stop (and putting it back) still run
        it["rule_check"] = "no %s prices this cycle (%s) — the exit rule waits; the stop still protects it" % (
            interval, type(exc).__name__)
        return ""
    since = (it.get("runner") or {}).get("since") or it.get("filled_at") or it["placed_at"]
    least = 2 * n if rule["type"] == "close_below_ema" else n + 1
    if len(bars) < least:  # e.g. a fallback source with 30 days for a 50-day EMA: say so instead of never exiting
        it["rule_check"] = "only %d %s bars available — the exit rule needs %d; the stop still protects it" % (
            len(bars), interval, least)
        return ""
    it.pop("rule_check", None)
    closes = [b.c for b in bars]
    # every bar that closed after the fill, not just the newest — a bot that was down a day still exits
    fired = [j for j in range(n, len(bars)) if bars[j].t + step > market_clock.ts(since)
             and setups.rule_says_exit(rule, closes, j)]
    if not fired:
        return ""
    if fired[0] != len(bars) - 1:
        return "the %s close of %s %s met the exit rule (%s) — the bot missed that bar" % (
            setups.bar_label(interval), market_clock.iso(bars[fired[0]].t)[:10], fmt.price(closes[fired[0]]),
            rule.get("text") or rule["type"])
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
    held = min(float(it["qty"]), float(p.get("qty") or it["qty"]))  # never more than the broker holds
    sell = floor_to(held * (1 - float(ride["keep"])), step)
    keep = round(held - sell, 10)
    if sell <= 0 or keep <= 0:
        return False, "the position is too small to split (%s)" % fmt.qty(it["qty"])
    ride.update(sell_qty=sell, keep_qty=keep)
    return True, None


def sell_part(broker, it: dict, orders: list, cfg: dict = None) -> list:
    """Sell the part that leaves now; the rest rides on with its stop at the buy price."""
    ride = it["runner"]
    # its protective stop covers the whole position — a new one comes for the part that stays; never your own
    # orders on the same coin
    wait = _cancel_own_sells(broker, it, orders)
    if wait:  # the runner stays planned: the next cycle sells the part
        return ["%s: %s" % (it["symbol"], wait)]
    it["stop_order_id"] = None  # cancelled: until the new one is in, the bot itself watches the stop
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


def _book_part_sale(it: dict, o: dict, cfg: dict = None) -> list:
    """A sell order of this trade that filled in part and then was cancelled or expired: that part is sold. It is
    booked as its own closed trade and the rest stays open with the smaller quantity — the next sale, sized on the
    whole, would otherwise come out of coins or shares you hold yourself."""
    sold = float(o.get("filled_qty") or 0)
    left = round(float(it["qty"]) - sold, 10)
    it.setdefault("parts_booked", []).append(o.get("id"))
    price = float(o.get("filled_avg_price") or 0) or float(it["stop"])
    at = o.get("filled_at") or o.get("updated_at") or o.get("canceled_at") or market_clock.iso(market_clock.now_utc())
    reason = "stop" if (o.get("leg") == "stop" or o.get("id") == it.get("stop_order_id")) else (
        it.get("exit_reason") or "manual")
    journal = _mod("trader-journal", "journal")
    first = journal.get_trade(it.get("trade_id"))
    if first:
        rest = copy.deepcopy(first)
        first["qty"] = sold
        journal.finalize(first, cfg or config.load_config(), price, at, reason)
        first["exit"]["broker_order_id"] = o.get("id")
        rest.update(id="%s-%d" % (first["id"], len(it["parts_booked"])), qty=left)
        first["notes"] = (first.get("notes") or "") + " · its %s order filled %s of %s, then was %s; the rest " \
            "stays open as %s" % (o.get("type") or "sell", fmt.qty(sold), fmt.qty(it["qty"]), o.get("status"),
                                  rest["id"])
        journal.save_trade(first)
        journal.save_trade(rest)
        it["trade_id"] = rest["id"]
    it["qty"] = left
    return ["%s: %s of its %s order filled before it was %s — booked, %s left" % (
        it["symbol"], fmt.qty(sold), o.get("type") or "sell", o.get("status"), fmt.qty(left))]


def _part_sold(o: dict, it: dict) -> bool:
    """A sell order of this trade that ended (cancelled, expired) with part of it filled, not booked yet."""
    try:
        filled = float(o.get("filled_qty") or 0)
    except (TypeError, ValueError):
        return False
    return (o.get("side") == "sell" and o.get("status") in ("canceled", "expired", "rejected")  # done_for_day
            and filled > 1e-12 and o.get("id") not in (it.get("parts_booked") or ()))  # may still trade tomorrow


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
        journal.finalize(first, cfg, price, at, "time" if (it.get("exit_note") or "").startswith("time stop")
                         else "rule")
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
            it["stop_retry_at"] = market_clock.iso(market_clock.now_utc())
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


def manage_exits(broker, book: dict, positions: list, orders: list, cfg: dict = None, persist: bool = False) -> list:
    """Time stops, exit rules, crypto targets (Alpaca has no crypto brackets) — and the stop itself whenever no
    working stop order protects the position (cancelled, failed, or a stop-limit the price fell through)."""
    actions = []
    now = market_clock.now_utc()
    now_ts = now.timestamp()
    stocks_open = market_clock.market_status(now)["state"] == "open"
    pos_by = {p["symbol"]: p for p in positions}
    for it in book["items"].values():
        if not _here(it, broker):  # never sell or protect another account's trade out of this one
            continue
        try:
            actions += _exit_one(broker, it, pos_by, orders, cfg, now, now_ts, stocks_open,
                                 (lambda: state.write_json(BOOK, book)) if persist else None)
        except Exception as exc:  # noqa: BLE001 — the next position's stop must still be checked
            it["error"] = "%s: %s" % (type(exc).__name__, exc)
            actions.append("could not check the exits of %s: %s" % (it.get("symbol"), it["error"]))
    return actions


def _exit_one(broker, it: dict, pos_by: dict, orders: list, cfg: dict, now, now_ts: float, stocks_open: bool,
              persist=None) -> list:
    actions = []
    if it["status"] != "open" or (it.get("runner") or {}).get("status") == "selling":
        return actions
    p = pos_by.get(it["symbol"])
    if not p:
        return actions
    split = _split_check(it, p, cfg)
    if split:
        actions.append(split)
    # outside the session stock orders don't fill: no exits then — but a position must never sit without a stop
    # (an intraday bracket's legs expire at the close: one the bot couldn't sell in time gets a GTC stop)
    closed = it["asset"] == "stock" and not stocks_open
    reason = None
    try:
        last = float(p["last"]) if p.get("last") is not None else None
    except (TypeError, ValueError):
        last = None
    if last is not None and not last > 0:  # 0, negative or NaN is a broken quote, not a price to sell at
        last = None
    live = _live_stop(it, orders)
    if closed:
        pass
    elif now_ts >= market_clock.ts(it["time_stop"]):
        reason = "time"
    elif last is not None:
        # crypto has no bracket at Alpaca, and a partly filled stock bracket never activated its take-profit leg
        if (it["asset"] == "crypto" or it.get("partial")) and last >= float(it["target"]):
            reason = "target"
        elif last <= float(it["stop"]) and (live is None or (
                live.get("type") == "stop_limit" and last < float(it["stop"]) * (1 - STOP_LIMIT_ROOM))):
            reason = "stop"
    if not reason and not closed and it.get("exit_rule"):
        why = rule_exit_due(it)
        if why:
            reason = "rule"
            it["exit_note"] = "exit rule: " + why
    refused = it.get("exit_refused_at")
    # after a refused sale the stop is back and the sale waits — but a price through the stop sells at once
    backing_off = bool(refused) and now_ts - market_clock.ts(refused) < EXIT_RETRY_SEC and reason != "stop"
    if refused and not reason and not backing_off:
        it.pop("exit_refused_at", None)  # the next refusal is news again
        it.pop("exit_refused", None)
    if not reason or backing_off:
        # its stop is gone (Alpaca cancels GTC orders after 90 days, a fee left less to sell, a refused sale…):
        # put it back — an intraday stock's bracket legs are the stop, unless a refused sale cancelled them
        if live is None and (it["asset"] == "crypto" or it.get("swing") or closed or refused) and \
                now_ts - market_clock.ts(it.get("stop_retry_at") or "1970-01-01T00:00:00Z") > \
                (60 if refused else 3600):
            actions += _restore_stop(broker, it, p.get("qty"), now)
        return actions
    # the lab lets two thirds ride after its time stop as after its exit rule — so does the bot
    if reason in ("rule", "time") and (it.get("runner") or {}).get("status") == "planned":
        ok, why_not = ride_check(it, p, cfg)
        if ok:
            if reason == "time":
                it["exit_note"] = "time stop"
            actions += sell_part(broker, it, orders, cfg)
            if (it.get("runner") or {}).get("status") != "failed":
                return actions
        else:
            it["runner"]["status"] = "skipped"
            it["exit_note"] = it.get("exit_note", "") + " · sold everything: " + why_not
    queued = _queued_exit(broker, it, orders)
    if queued and queued.get("status") in OPEN_ORDER and not _stale_exit(queued, it, last, now):
        return actions  # its sale is on its way (sent earlier, or a stock's waiting for the open)
    if queued and queued.get("status") in ("filled", "partially_filled"):
        return actions  # sold (or selling) already: the next sync books it
    wait = _cancel_own_sells(broker, it, orders, live)
    if wait:
        actions.append("%s exit for %s waits: %s" % (reason, it["symbol"], wait))
        return actions
    it["stop_order_id"] = None  # cancelled — if the close fails, the stop goes back at once
    it["exit_reason"] = reason
    if persist is not None:  # a crash right after the sale must still journal it as time / stop / rule, not "manual"
        try:
            persist()
        except OSError:
            pass
    try:
        try:
            _sell_own(broker, it, p.get("qty"))
        except BrokerError as exc:
            if not (_wash(exc) and last):
                raise
            # a market sale could trade with your own buy order: a limit 1 % under the price can't — it still fills
            _sell_own(broker, it, p.get("qty"), limit_price=last * WASH_LIMIT)
        actions.append("%s exit for %s" % (reason, it["symbol"]))
        it.pop("exit_refused_at", None)
    except BrokerError as exc:
        actions += _sale_refused(broker, it, p, exc, now, cfg)
    return actions


def kill(broker, book: dict, cfg: dict, reason: str, orders: list = None, positions: list = None) -> list:
    """Cancel the bot's entries and — with flatten_on_kill — sell what it holds. Only the bot's own orders and
    quantities: your own holdings and orders at the same broker are never touched."""
    actions = ["KILL: %s" % reason]
    flatten = bool((cfg.get("autopilot") or {}).get("flatten_on_kill", True))
    orders = orders if orders is not None else broker.orders()
    pos_by = {p["symbol"]: p for p in (positions if positions is not None else broker.positions())}
    problems = []
    away = foreign_open(book, broker)
    if away:  # not reachable from here — said out loud, never "closed" by selling this account's holdings
        actions.append("KILL cannot reach %d trade(s) opened at another broker or account: %s — close them there" % (
            len(away), ", ".join("%s (%s/%s)" % (it.get("symbol"), it.get("broker"), it.get("mode")) for it in away)))
    for it in book["items"].values():
        if not _here(it, broker):
            continue
        try:  # one broken item must not keep the others from being flattened
            problems += _kill_one(broker, it, reason, orders, pos_by, flatten)
        except Exception as exc:  # noqa: BLE001
            problems.append("%s: %s: %s" % (it.get("symbol"), type(exc).__name__, exc))
    actions.append("cancelled the bot's open entries" + ("; selling what it holds" if flatten else
                                                          "; positions keep their stops"))
    if problems:
        actions.append("kill incomplete: %s" % "; ".join(problems))
    return actions


def _kill_one(broker, it: dict, reason: str, orders: list, pos_by: dict, flatten: bool) -> list:
    problems = []
    if it["status"] in ("pending", "submitting"):
        oid = it.get("broker_order_id") or (_find(orders, cid=it.get("order_id")) or {}).get("id")
        if oid:
            try:
                broker.cancel(oid)
            except BrokerError as exc:
                problems.append(str(exc))
        # a fill that raced the cancel still turns into a trade on the next sync — and the KILL then sells it; the
        # first ask is kept (re-stamped every retry, the "no answer for 30 min → cancelled" rule would never fire)
        it.setdefault("cancel_asked_at", market_clock.iso(market_clock.now_utc()))
    elif it["status"] == "open" and flatten:
        it["exit_reason"], it["exit_note"] = "manual", "kill switch: %s" % reason
        p = pos_by.get(it["symbol"])
        queued = _queued_exit(broker, it, orders)
        if queued and queued.get("status") in OPEN_ORDER and not _stale_exit(
                queued, it, (p or {}).get("last"), market_clock.now_utc()):
            problems.append("%s: its sale is queued at the broker" % it["symbol"])  # a stock after hours: the open
            return problems
        if queued and queued.get("status") in ("filled", "partially_filled"):
            return problems  # sold already — the next sync books it
        live = _live_stop(it, orders)
        ride = it.get("runner") or {}
        part = _find(orders, ride.get("sell_order_id")) if ride.get("status") == "selling" else None
        if part and part.get("status") in OPEN_STATUSES:
            live = part  # the part sale on its way: cancelled and confirmed before the whole goes
        wait = _cancel_own_sells(broker, it, orders, live)
        if not wait and ride.get("status") == "selling":
            ride["status"] = "failed"  # the reconcile must not sell everything a second time
            it["exit_note"] = (it.get("exit_note") or "") + " · the partial sale was cancelled by the kill switch"
        if wait:  # the KILL stays on and the next cycle sells — never a sale out of your own shares
            problems.append("%s: %s" % (it["symbol"], wait))
        elif p and float(p.get("qty") or 0) > 1e-9:
            it["stop_order_id"] = None
            try:
                try:
                    _sell_own(broker, it, p.get("qty"))
                except BrokerError as exc:
                    last = float(p.get("last") or 0)
                    if not (_wash(exc) and last > 0):
                        raise
                    _sell_own(broker, it, p.get("qty"), limit_price=last * WASH_LIMIT)  # can't trade with yours
            except BrokerError as exc:  # refused: the stop goes back and the next cycle tries again
                now = market_clock.now_utc()
                problems.append("%s: %s" % (it["symbol"], exc))
                if UNSURE_ORDER not in str(exc):
                    _restore_stop(broker, it, p.get("qty"), now)
    return problems


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


# ~1,000 closed bars for the hourly timeframes: an EMA-200 seeded on fewer still carries its starting value, and the
# lab's indicators run on years — 300 days for the daily ones (the 200-day average plus room)
SERIES_HISTORY_DAYS = {"1h": 42, "4h": 167, "1d": 300}
# Rule-exit plans still carry a target (brackets need one) but the lab's rule trades have none: the stop and the
# exit rule decide. A 10R cap halved the average trade on 2018–2026 data (+1.78R → +0.90R): the few huge trends
# (ZEC +133R, BNB +100R, BTC +48R) are what pays for all the small losses. So the target is out of reach.
RULE_TARGET_CAP_R = 1000.0
RIDE_TARGET_R = 1000.0     # the part that rides on has no real target either — the trend decides


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
    banned = list(((cfg.get("autopilot") or {}).get("universe") or {}).get("exclude") or []) + \
        list(limits.get("blocked_symbols") or [])
    try:
        tradable = broker.tradable("crypto") if broker is not None else None
    except Exception:
        tradable = None
    added = []
    for key, entries in sorted(pbs["by_coin"].items()):
        if key in have:
            continue
        sym = data.as_symbol(key, "crypto")
        # a meme coin comes in only through the universe, which checks its market-cap rank today
        if symbols.blocked_hits((key, sym.base, sym.display), banned) or symbols.is_meme_base(sym.base) or \
                (tradable is not None and sym.base not in tradable):
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
    handled = _recent_handled(book, now)
    found, notes = [], []
    holding = {it["data_key"] for it in book["items"].values() if it["status"] in LIVE_ITEM}
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
            if (st.get("minutes_to_close") or 0) <= NO_NEW_STOCK_ENTRIES:
                notes.append("the last %d minutes of the session%s — no new stock entries" % (
                    NO_NEW_STOCK_ENTRIES, " (early close today)" if st.get("early_close") else ""))
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
            except (symbols.SymbolError, ValueError) as exc:
                notes.append("%s: %s" % (raw, exc))
                continue
            entries = pbs["by_coin"].get(sym.key) if asset == "crypto" and pbs["required"] else None
            for e in [e for e in entries or [] if e["interval"] != INTERVAL]:
                # only the newest closed bar, as in the backtest: a day-old signal would buy at yesterday's close
                found += _series_candidates(sym, e, memo, handled, holding, now_ts, 0, notes)
            if entries is not None and not any(e["interval"] == INTERVAL for e in entries):
                continue  # daily / swing rules only: no 5-minute bars to download every cycle
            try:
                key = (sym.key, asset)
                if key not in memo:
                    memo[key] = data.get_candles(sym, INTERVAL, days=3 if asset == "stock" else 2)
                series = memo[key]
            except (data.DataUnavailable, symbols.SymbolError, ValueError) as exc:
                notes.append("%s: %s" % (raw, exc))
                continue
            if not series.candles:
                continue
            # crypto: the window of the newest CLOSED bar — just after 00:00 UTC that is yesterday's, and its last
            # bar (23:55) is judged like any other; stocks: only while the session runs
            probe = bar if asset == "crypto" else now_ts - 1
            w = setups.window_at(series.candles, asset, INTERVAL, probe)
            if not w or not (w.start <= probe < w.end):
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
    st = market_clock.market_status(now)
    if st["state"] != "open":
        return [], []
    et = market_clock.to_et(now)
    if (et.hour, et.minute) < ETF_FIRST_ENTRY or (st.get("minutes_to_close") or 0) <= NO_NEW_STOCK_ENTRIES:
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
    holding = {it["data_key"] for it in book["items"].values() if it["status"] in LIVE_ITEM}
    handled = _recent_handled(book, now)
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
        if asset == "stock" and interval == "1d":  # the lab counts bars = sessions; a calendar day count is ~30 % short
            d = market_clock.et_date(market_clock.from_ts(trig["t"]))
            for _ in range(int(rule.get("max_bars") or 10)):
                d = market_clock.next_trading_day(d)
            horizon_s = int(market_clock.flat_by(d).timestamp()) - entry_ts  # 12:55 on an early-close day
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
    if interval == "1d" and lv.get("atr") and float(trig["price"]) > 0:
        lo, hi = DAILY_ENTRY_SLACK_PCT
        plan["entry_slack_pct"] = round(min(hi, max(lo, 25.0 * float(lv["atr"]) / float(trig["price"]))), 3)
    plan["runner"], plan["runner_note"] = runner_plan(c, cfg)
    def save(doc):
        doc.setdefault("plans", {})[plan["id"]] = plan
        doc.setdefault("latest", plan["id"])
    state.update_json("plan.json", save, {})  # /trader-exit writes plans too — neither may lose the other's
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
    box = {}

    def fetch():
        try:
            box["res"] = _mod("trader-news", "news").refresh_feed(symbols=[plan["symbol"]], now=market_clock.iso(now))
        except Exception as exc:  # noqa: BLE001 — a news outage is noted by the desk ("no feed data")
            box["exc"] = exc
    t = threading.Thread(target=fetch, name="news-before-trade", daemon=True)
    t.start()
    t.join(NEWS_REFRESH_BUDGET_SEC)  # a rate-limited news site must not hold up the positions' exits
    if t.is_alive():
        return "news refresh failed: still fetching after %d s — the desk read the feed as it was" % \
            NEWS_REFRESH_BUDGET_SEC
    if "exc" in box:
        return "news refresh failed: %s: %s" % (type(box["exc"]).__name__, box["exc"])
    res = box.get("res") or {}
    bad = ["%s %s" % (k, v) for k, v in sorted((res.get("sources") or {}).items()) if str(v).startswith("error")]
    return "news refreshed for %s (%d new)%s" % (scope, res.get("new") or 0,
                                                 " · " + "; ".join(bad)[:200] if bad else "")


def _scaled(cfg: dict, limits: dict, asset: str, mult: float) -> tuple:
    """Risk per trade times ``mult``. Smaller also shrinks the per-trade cap; larger never lifts limits.json."""
    if abs(mult - 1) < 1e-9:
        return cfg, limits
    cfg2, lim2 = copy.deepcopy(cfg), copy.deepcopy(limits)
    cfg2["risk_per_trade_pct"] = float(cfg.get("risk_per_trade_pct", 0.5)) * mult
    # a coin's own risk (risk_by_symbol) scales the same way — a losing streak halves BTC's 3 % too
    cfg2["risk_by_symbol"] = {k: float(v) * mult for k, v in (cfg.get("risk_by_symbol") or {}).items()}
    lim = lim2.get(asset) or {}
    if mult < 1:
        for one in [lim] + [e for e in (lim.get("symbols") or {}).values() if isinstance(e, dict)]:
            if one.get("max_risk_per_trade_usd") is not None:
                one["max_risk_per_trade_usd"] = float(one["max_risk_per_trade_usd"]) * mult
    return cfg2, lim2


DEFAULT_RISK_TIERS = ((0.9, 2.0), (0.8, 1.5), (0.7, 1.0), (0.0, 0.5))


def confidence_mult(entry: dict, cfg: dict, symbol=None) -> tuple:
    """(multiplier, reason): size by how sure the backtest lab is — its profit chance on trades it never saw.

    Bigger only with enough unseen trades behind it, never above max_risk_mult, never past limits.json.
    ``symbol``: the coin, for its own risk per trade (risk_by_symbol) — playbook.max_risk_pct stops a boost past
    it, never cuts the coin below the risk you set for it.
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
    base = config.risk_pct_for(cfg, symbol) if symbol is not None else float(cfg.get("risk_per_trade_pct", 0.5))
    top = pb_cfg.get("max_risk_pct")
    if top is not None:
        top = max(float(top), base)
    if top is not None and base > 0 and base * mult > top + 1e-9:
        mult, why = top / base, why + " — capped at %g%% per trade (playbook.max_risk_pct)" % top
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
    if status == "error":  # a refusal, a reply cut short or unreadable, a failed call: with the AI desk on, a no
        return (["AI desk could not review it (%s) — no trade while the AI desk is on" % why[:200]],
                {"name": "AI desk", "ok": False, "detail": "error: %s" % why[:200]}, info)
    if ai_cfg.get("on_unavailable") == "skip":
        return (["AI desk unavailable (%s) — ai_desk.on_unavailable is \"skip\"" % why],
                {"name": "AI desk", "ok": False, "detail": "unavailable: %s" % why}, info)
    return None, {"name": "AI desk", "ok": True, "detail": "unavailable (%s) — rule-based decision used" % why}, info


def meme_refusal(c: dict, cfg: dict) -> str:
    """'' when an exchange-listed meme coin may be traded: switched on, validated by the lab (which only counts it
    while it was among the biggest coins), and a year of daily history behind it. Else why not."""
    pol = symbols.memes_policy(cfg)
    disp = c["sym"].display
    if pol is None:
        return "%s is a meme coin — off unless you switch it on (autopilot.memes.enabled)" % disp
    if not c.get("playbook"):
        return "%s is a meme coin — traded only when the backtest lab validated it" % disp
    try:  # its whole daily history: listed long enough to have lived through more than one hype
        bars = data.get_candles(c["sym"], "1d", days=pol["min_listed_days"] + 10, asset="crypto").candles
    except Exception as exc:  # noqa: BLE001
        return "%s is a meme coin and its daily history is unavailable (%s)" % (disp, type(exc).__name__)
    age = (bars[-1].t - bars[0].t) / 86400.0 if bars else 0.0
    if age < pol["min_listed_days"] - 2:
        return "%s is a meme coin with %d days on the exchange — under %d" % (disp, age, pol["min_listed_days"])
    return ""


def judge(c: dict, cfg: dict, limits: dict, broker, book: dict, approved: bool, acct: dict,
          learned: dict = None) -> dict:
    """Everything between "a rule fired" and "an order is at the broker". Returns the decision record."""
    sym, asset = c["sym"], c["asset"]
    base = {"id": c["id"], "symbol": sym.display, "asset": asset, "setup": c["setup"]}
    if c.get("skip"):
        return _decision(reasons=[c["skip"]], **base)
    if asset == "meme":  # a DEX token: never through a broker, never on its own
        return _decision(reasons=["%s is a DEX meme token — never auto-traded" % sym.display], **base)
    meme = asset == "crypto" and symbols.is_meme_base(sym.base)  # DOGE, 1000PEPE… (not WEN stock)
    if meme:
        why_not = meme_refusal(c, cfg)
        if why_not:
            return _decision(reasons=[why_not], **base)
    if c["id"] in book["items"]:  # one signal, one trade — its record in the book is never overwritten
        return _decision(reasons=["this signal was already traded (%s)" % book["items"][c["id"]].get("status")],
                         **base)
    # one position per symbol: two setups firing on the same coin in one cycle must not both buy it — the broker
    # holds one position, and the first exit rule would close the other trade too
    # (by the broker's name too: BTCUSDT and BTC-USD are two data keys but one BTC/USD position at Alpaca)
    try:
        bname = broker_symbol(sym, asset)
    except (BrokerError, symbols.SymbolError, ValueError):
        bname = None
    held = [it for it in book["items"].values() if it["status"] in LIVE_ITEM
            and (it.get("data_key") == sym.key or (bname and it.get("symbol") == bname))]
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
        try:
            run_timemachine(plan, cfg, limits)
        except data.DataUnavailable as exc:  # a coin listed last week: too little history to replay — a skip
            return _decision(reasons=["Time Machine: %s" % exc], **base)
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
    if asset == "crypto" and acct.get("crypto_ok") is False:
        return _decision(reasons=["the broker account is not enabled for crypto"], desk=desk_info, gates=gates, **base)
    pdt_eq = acct.get("last_equity") if acct.get("last_equity") is not None else acct.get("equity")
    if asset == "stock" and not plan.get("swing") and broker.name == "alpaca" and \
            float(pdt_eq or 0) < PDT_EQUITY and int(acct.get("daytrade_count") or 0) >= 3:
        # under $25,000 a 4th day trade in 5 days is refused — and then the 3:55 p.m. sale would be too
        return _decision(reasons=["pattern day trader rule: %d day trades in the last 5 days and equity under $25,000 "
                                  "— a same-day stock trade would be refused" % int(acct.get("daytrade_count") or 0)],
                         desk=desk_info, gates=gates, **base)
    if _count_today(book, now) >= max_new:
        return _decision(reasons=["daily cap reached: %d new trades today (autopilot.max_new_trades_per_day)" % max_new],
                         desk=desk_info, gates=gates, **base)
    lim = limits.get(asset) or {}
    busy = [it for it in book["items"].values() if it["status"] in LIVE_ITEM]
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
    conf, conf_why = confidence_mult(c.get("playbook"), cfg, sym)
    own = (cfg.get("risk_by_symbol") or {}).get(str(sym.base).upper())
    if own is not None:
        gates.append({"name": "risk for %s" % sym.base, "ok": True,
                      "detail": "%g%% per trade (config risk_by_symbol; the other coins %g%%)" % (
                          config.risk_pct_for(cfg, sym), float(cfg.get("risk_per_trade_pct", 0.5)))})
    if conf_why:
        gates.append({"name": "confidence sizing", "ok": True,
                      "detail": "risk × %g — %s%s" % (conf, conf_why, " (limits.json still caps it)" if conf > 1
                                                       else "")})
    mult *= conf
    if asset == "crypto" and symbols.is_meme_base(sym.base):
        m = symbols.memes_policy(cfg)["risk_mult"]
        mult *= m
        gates.append({"name": "meme coin", "ok": True, "detail": "risk × %g — an established meme coin "
                      "(autopilot.memes.risk_mult)" % m})
    if plan.get("runner_note"):
        gates.append({"name": "let winners ride", "ok": True, "detail": plan["runner_note"]})
    lev, lev_why = config.leverage(cfg, limits, asset, broker.name, sym)
    if lev_why:
        gates.append({"name": "leverage", "ok": True, "detail": lev_why})
    s_cfg, s_limits = _scaled(cfg, limits, asset, mult)
    try:
        # the broker's equity when it reports one — even 0 (then nothing is sized), never the configured size instead
        eq = acct.get("equity")
        order = sizer.size_order(plan, s_cfg, s_limits, account=eq if eq is not None else None, leverage=lev)
    except ValueError as exc:
        return _decision(reasons=["sizer: %s" % exc], desk=desk_info, gates=gates, **base)
    order["origin"] = "autopilot"
    # the signal names the order: sent twice (a crash between the broker and the book), the broker refuses the
    # second as a duplicate and the first is found again, instead of buying twice
    order["id"] = "ord-" + plan["id"]
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
    bp = acct.get("buying_power")
    cash = float(bp if bp is not None else (acct.get("cash") or 0))
    if acct.get("cash") is not None and float(acct.get("equity") or 0) > 0:
        # never more borrowed money than the leverage you allowed, whatever the broker would lend — and entries
        # that have not filled yet already hold their share of it
        waiting = sum(float(x.get("qty") or 0) * float(x.get("entry_plan") or 0)
                      for x in book["items"].values() if x.get("status") in ("pending", "submitting"))
        cash = min(cash, float(acct["cash"]) + (lev - 1) * float(acct["equity"]) - waiting)
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
    # in the book BEFORE the order goes out: if the process dies while the broker answers (a kill, an OOM, a
    # power cut), the next start finds the order by its client id and manages it — never a position nobody owns
    item = book["items"][plan["id"]] = {
        "plan_id": plan["id"], "order_id": order["id"], "broker_order_id": None, "broker": broker.name,
        "mode": broker.mode, "symbol": bsym, "data_key": sym.key, "asset": asset, "qty": order["qty"],
        "qty_unit": order.get("qty_unit"), "stop": order["stop_price"], "target": order["target_price"],
        "time_stop": plan["time_stop"]["at"], "status": "submitting", "placed_at": market_clock.iso(now),
        "exit_rule": plan.get("exit_rule"), "interval": plan.get("interval"), "leverage": lev,
        "runner": plan.get("runner"), "setup": c["setup"], "entry_plan": plan["entry"]["price"],
        "swing": bool(plan.get("swing"))}
    state.write_json(BOOK, book)
    try:
        bo = broker.place_entry({"client_order_id": order["id"], "symbol": bsym, "asset": asset, "qty": order["qty"],
                                 "limit_price": order["limit_price"], "stop_price": order["stop_price"],
                                 "target_price": order["target_price"], "leverage": lev,
                                 "swing": bool(plan.get("swing"))})
    except BrokerError as exc:
        if UNSURE_ORDER in str(exc):  # it may have landed: the next cycles look it up by its client id
            item["submit_error"] = str(exc)
        else:  # refused for sure: nothing at the broker, nothing in the book
            del book["items"][plan["id"]]
        state.write_json(BOOK, book)
        unsure = UNSURE_ORDER in str(exc)
        _update_order(order["id"], status="unsure" if unsure else "error", error=str(exc))
        return _decision(action="error", reasons=[("the order may have reached the broker — it is looked up next "
                                                   "cycle (%s)" if unsure else "broker refused: %s") % exc],
                         desk=desk_info, gates=gates, ai=ai_info, **base)
    item.update(status="pending", broker_order_id=bo.get("id"))
    state.write_json(BOOK, book)  # on disk before anything else can fail — a lost book means a second order
    state.append_jsonl("approvals.jsonl", {
        "ts": market_clock.iso(now), "ticket_id": None, "order_id": order["id"], "ticket_hash": res["order_hash"],
        "ticket_text": text, "mode": broker.mode, "user_reply": APPROVAL_TEXT, "approved": True, "asset": asset,
        "symbol": order["symbol"], "source": "autopilot"})
    _update_order(order["id"], status="submitted", broker=broker.name, broker_order_id=bo.get("id"))
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
    try:
        state.write_json(STATE, st)
    except OSError as exc:  # a full disk: the cycle's exits are done — the status file is the least of it
        _PROCESS["state_error"] = "%s: %s" % (type(exc).__name__, exc)
    return st


def _today_summary(book: dict, now, kill_reason=None) -> dict:
    day = _today(now)
    taken = skipped = 0
    # today's lines only, read from the end: the file holds years of decisions, the cycle needs today
    for d in state.tail_jsonl(DECISIONS, stop=lambda d: bool(d.get("at")) and d["at"][:10] < day):
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
    # learning is a brake: when it can't run (a bad setting, an unreadable record) the cycle's best_effort turns
    # that into "no new entries" — the brakes are never silently off while trading goes on
    doc = adapt.evaluate(cfg, now=market_clock.iso(now))
    for ev in doc.get("new_events") or []:
        actions.append("learned: %s" % ev.get("text"))
        if ev.get("kind") != "drawdown_pause":  # that one gets its own "paused" notification
            notify.send("learned", (ev.get("text") or "")[:110], ev.get("text") or "", cfg)
    return doc


def check_health(cfg: dict, control: dict, now, actions: list) -> dict:
    """Is the bot's record still what the backtest promised? A new alarm pauses new entries (exits keep running)."""
    doc = health.update(cfg, now, control)  # failing → best_effort: exits run, no new entries
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
    # everything since the last summary went out (the first one: the last 24 hours) — a crypto exit at 00:00 UTC,
    # after one summary and before the next New York day, belongs to the next summary, never to none
    try:
        start = market_clock.ts(st.get("summary_sent_at")) if st.get("summary_sent_at") else now.timestamp() - 86400
    except (TypeError, ValueError):
        start = now.timestamp() - 86400
    since = market_clock.iso(start)

    def today(at) -> bool:
        try:
            return bool(at) and market_clock.ts(at) >= start
        except (TypeError, ValueError):
            return False
    trades = [t for t in (state.read_json("journal.json", {}) or {}).get("trades") or []
              if t.get("source") == "autopilot" and t.get("status") == "closed" and today((t.get("exit") or {}).get("time"))]
    looked = [d for d in state.tail_jsonl(DECISIONS, stop=lambda d: bool(d.get("at")) and d["at"] < since)]
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
    _state(summary_sent=day, summary_sent_at=market_clock.iso(now))


def compact_equity(keep_days: int = 7) -> int:
    """equity.jsonl gets a line a minute around the clock: keep a week in full; before that each hour's highest
    line and its last — the drawdown limit measures from the peak, which must survive the compaction."""
    rows = state.read_jsonl("broker/equity.jsonl")
    cutoff = market_clock.now_utc().timestamp() - keep_days * 86400
    recent, hourly = [], {}
    for r in rows:
        try:
            t = market_clock.ts(r["at"])
            value = float(r["equity"])
        except (KeyError, TypeError, ValueError):
            continue
        if t >= cutoff:
            recent.append(r)
            continue
        top, _ = hourly.get(t // 3600, (None, None))
        if top is None or value > float(top["equity"]):
            top = r
        hourly[t // 3600] = (top, r)
    out = []
    for k in sorted(hourly):
        top, last = hourly[k]
        out += [top] if top is last else sorted((top, last), key=lambda r: market_clock.ts(r["at"]))
    out += recent
    removed = len(rows) - len(out)
    if removed > 0:
        config.atomic_write(state.path("broker", "equity.jsonl"), "".join(json.dumps(r) + "\n" for r in out))
    return removed


_LAST_GOOD = {}   # this process's last readable config.json + limits.json


def _settings() -> tuple:
    """(cfg, limits, problem). A config.json you are halfway through editing must not stop the exits: the last
    good one is used and the problem stops new entries until it is fixed."""
    try:
        cfg, limits = config.load_config(), config.load_limits()
    except ValueError as exc:
        good = _LAST_GOOD.get(str(config.trader_home()))
        if not good:
            raise
        return good[0], good[1], "%s — using the last good settings" % exc
    _LAST_GOOD[str(config.trader_home())] = (cfg, limits)
    return cfg, limits, None


def _cycle(approved=None) -> dict:
    t0 = time.monotonic()
    del http.warnings[:]  # data warnings are about this cycle's reads, not last week's
    cfg, limits, settings_problem = _settings()
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
    actions, errors = [], [settings_problem] if settings_problem else []

    def sync():
        broker.sync()
        if getattr(broker, "save_error", None) and not any("not saved" in e for e in errors):
            errors.append("the simulator's book was not saved (%s) — exits go on, nothing new opens" % broker.save_error)
        for sym_, why in sorted((getattr(broker, "sync_errors", None) or {}).items()):
            note = "no prices for %s this cycle — its orders wait, nothing new opens: %s" % (sym_, why)
            if note not in errors:
                errors.append(note)
        acct, pos, ords = broker.account(), broker.positions(), broker.orders()
        return acct, pos, ords + _tracked(broker, book, ords)

    def best_effort(what, fn, fallback=None):
        """Bookkeeping (files, learning, health) that fails stops new entries — never the exits."""
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            errors.append("%s: %s: %s" % (what, type(exc).__name__, exc))
            return fallback

    free = _free_mb()
    if free is not None and free < MIN_FREE_MB:
        errors.append("disk almost full: %d MB free (under %d MB) — exits go on, nothing new opens" % (free, MIN_FREE_MB))
    acct, positions, orders = sync()
    if acct.get("blocked"):
        errors.append("broker account: %s — nothing new opens" % acct["blocked"])
    away = foreign_open(book, broker)
    if away:
        errors.append("%d open trade(s) in the book belong to another broker or account (%s) — the bot does not "
                      "manage them from %s/%s and opens nothing new: switch back and close them, or run "
                      "`autopilot.py forget --confirm FORGET` once they are closed there" % (
                          len(away), ", ".join(sorted({"%s %s/%s" % (it.get("symbol"), it.get("broker"), it.get("mode"))
                                                      for it in away})), broker.name, broker.mode))
    actions += reconcile(broker, book, positions, orders, cfg, limits)
    best_effort("saving the book", lambda: state.write_json(BOOK, book))  # what reached the broker, on disk first
    best_effort("orphan orders", lambda: _orphans(book, orders, cfg))
    # the equity snapshot first, so the drawdown check sees this cycle's equity
    line = best_effort("broker files", lambda: _write_broker_files(broker, acct, positions, orders, book,
                                                                     _realized_today(now)))
    learned = best_effort("learning", lambda: learn(cfg, control, now, actions)) or {"enabled": False}
    if learned.get("drawdown_pause") and not control["paused"] and not control["kill"]:
        control = write_control(by="autopilot", paused=True, run_once=False)
        why = "equity %s is %.1f%% below its peak %s (limit %s%%)" % (
            fmt.money(learned.get("equity")), learned.get("drawdown_pct") or 0, fmt.money(learned.get("equity_peak")),
            ((ap.get("adapt") or {}).get("max_drawdown_pct")))
        actions.append("PAUSED by the drawdown limit: " + why)
        notify.send("paused", "Autopilot paused — drawdown limit", why + ". Exits keep running; resume to trade again "
                    "(resuming resets the peak).", cfg, priority="high")
    hdoc = best_effort("health check", lambda: check_health(cfg, control, now, actions)) or {}
    if hdoc.get("pause") and not control["paused"] and not control["kill"]:
        control = write_control(by="autopilot", paused=True, run_once=False)

    kill_reason = None
    if control["kill"]:
        kill_reason = "kill switch (%s)" % (control.get("by") or "control")
    else:
        yours = best_effort("your own holdings", lambda: yours_today(now, positions, book, orders, broker)) or 0.0
        loss, start = best_effort("daily loss", lambda: _day_loss(now, acct.get("equity"), yours,
                                                                 account_key(broker, acct))) or (0.0, None)
        glob = limits.get("global") or {}
        caps = [float(glob["max_daily_loss_usd"])] if glob.get("max_daily_loss_usd") is not None else []
        if glob.get("max_daily_loss_pct") is not None and start:
            caps.append(float(start) * float(glob["max_daily_loss_pct"]) / 100.0)
        killed_today = best_effort("daily loss", lambda: _killed_today(now), True)
        if caps and loss >= min(caps) and not killed_today:
            why = "daily loss %s reached the %s limit" % (fmt.money(-loss), fmt.money(min(caps)))
            best_effort("daily loss", lambda: _killed_today(now, mark=True))
            if ap.get("daily_loss_action") == "stop_entries":  # a strategy that holds for weeks: no fire sale
                actions.append("DAILY LIMIT: %s — no new entries until tomorrow (UTC); positions keep their stops"
                               % why)
                errors.append("%s — no new entries until tomorrow (UTC)" % why)
                notify.send("paused", "Daily loss limit — no new entries today", why + ". Positions keep their "
                            "stops and exits; new entries resume tomorrow (UTC).", cfg, priority="high")
            else:
                kill_reason = why
        elif killed_today and ap.get("daily_loss_action") == "stop_entries":  # a bounce doesn't lift it
            errors.append("the daily loss limit was reached today — no new entries until tomorrow (UTC)")
        elif caps and loss >= min(caps):  # resumed after today's kill: still no new trades until tomorrow
            errors.append("daily loss %s is past the %s limit — no new entries until tomorrow (UTC)" % (
                fmt.money(-loss), fmt.money(min(caps))))
    if kill_reason:
        flatten = bool(ap.get("flatten_on_kill", True))
        tries = control.get("kill_tries", 0) if control["kill"] else 0
        actions += kill(broker, book, cfg, kill_reason, orders, positions)
        acct, positions, orders = sync()
        actions += reconcile(broker, book, positions, orders, cfg, limits)
        held = {p["symbol"] for p in positions if float(p.get("qty") or 0) > 1e-9}
        left = [it for it in book["items"].values() if _here(it, broker) and (it["status"] in ("pending", "submitting")
                or (flatten and it["status"] == "open" and it["symbol"] in held))]
        done = not left and not any(a.startswith("kill incomplete") for a in actions)
        # not done (the broker still holds cancelled legs, an entry filled in the race): the KILL stays on and the
        # next cycle tries again — it is never quietly dropped
        if not flatten:  # the positions keep their stops — and their targets, time stops and exit rules
            actions += manage_exits(broker, book, positions, orders, cfg, persist=True)
        write_control(by="autopilot", kill=not done, kill_tries=0 if done else tries + 1, paused=True, run_once=False)
        best_effort("saving the book", lambda: state.write_json(BOOK, book))
        line = best_effort("broker files", lambda: _write_broker_files(broker, acct, positions, orders, book,
                                                                         _realized_today(now)))
        what = "orders cancelled" + (", positions closed" if flatten else ", positions keep their stops")
        if done:
            msg = "KILLED — %s. %s. Resume to trade again." % (kill_reason, cap_first(what))
            notify.send("kill", "KILL — %s" % kill_reason, "%s. The autopilot stays stopped until you resume it."
                        % cap_first(what), cfg, priority="high")
        else:
            msg = "KILL in progress — %s. Still open: %s — retrying every cycle." % (
                kill_reason, ", ".join(sorted({it["symbol"] for it in left})) or "see the errors")
            if tries == 0:
                notify.send("kill", "KILL started — %s" % kill_reason, msg, cfg, priority="high")
        _state(status="killed", message=msg, today=_today_summary(book, now, kill_reason), equity=line, **common)
        return {"status": "killed", "message": msg, "actions": actions, "errors": errors}

    exits = manage_exits(broker, book, positions, orders, cfg, persist=True)
    if exits:
        actions += exits
        best_effort("saving the book", lambda: state.write_json(BOOK, book))  # a partial sale is not asked twice
        acct, positions, orders = sync()
        actions += reconcile(broker, book, positions, orders, cfg, limits)

    status = "paused" if control["paused"] and not control["run_once"] else "running"
    if prev.get("status") == "killed" and control["paused"]:
        status = "killed"
    while state.recovered:  # a broken file was read from its last good copy — say so (it stops new entries)
        errors.append(state.recovered.pop(0))
    blocked = list(errors)  # bookkeeping that failed: the cycle can't vouch for its limits, so no new entries
    errors += [a for a in actions if a.startswith(("could not reconcile", "could not check the exits"))]
    decisions, notes = [], []
    uni, uni_notes = watched(cfg, broker, now) if status == "running" else (_universe_counts_only(cfg), [])
    if blocked and status == "running":
        uni_notes.append("no new entries this cycle — %s" % blocked[0])
    try:
        pbs = playbook_state(cfg, now)
    except Exception as exc:  # a broken playbook file must not stop exits — crypto just stays gated
        pbs = {"required": True, "playbook": None, "problem": "playbook unreadable: %s" % exc, "by_coin": {}}
    if status == "running":
        extra = add_playbook_coins(uni, pbs, cfg, limits, broker)
        if extra:
            uni_notes.append("also watching %s — validated by the backtest lab" % ", ".join(extra))
    if status == "running" and not blocked:
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
        for day in sorted(book["handled"])[:-HANDLED_DAYS - 1]:
            del book["handled"][day]
        use_learned = learned if learned.get("enabled", True) else None
        # when several fire at once and the caps allow only some, the most certain go first
        cands.sort(key=lambda c: -float((((c.get("playbook") or {}).get("test") or {}).get("profit_chance")) or 0))
        for i, c in enumerate(cands):
            if time.monotonic() - t0 > CYCLE_BUDGET_SEC:  # slow sources: the rest waits, the exits don't
                notes.append("cycle time budget (%d s) reached — %d idea(s) left for the next cycle" % (
                    CYCLE_BUDGET_SEC, len(cands) - i))
                break
            if _PROCESS.get("stopping"):  # systemd / Docker kill after 2 min — a stop must not wait on new trades
                notes.append("stopping — %d idea(s) left for the next start" % (len(cands) - i))
                break
            try:
                d = judge(c, cfg, limits, broker, book, approved, acct, use_learned)
            except Exception as exc:  # one broken candidate is recorded and skipped; the next cycle must not retry it
                d = _decision(action="error", id=c["id"], symbol=c["sym"].display, asset=c["asset"], setup=c["setup"],
                              reasons=["%s: %s" % (type(exc).__name__, exc)])
                errors.append("%s: %s" % (c["id"], exc))
            handled[c["id"]] = d["action"]
            decisions.append(d)
            if d["action"] == "taken":
                try:
                    acct = broker.account()
                except BrokerError as exc:  # the order is booked; the next candidates wait for the next cycle
                    errors.append("account after an order: %s" % exc)
                    break
    best_effort("saving the book", lambda: state.write_json(BOOK, book))
    slow = time.monotonic() - t0 > max(60, interval)
    if decisions or exits or slow:
        acct, positions, orders = sync()
        if slow:  # judging took long: a stop, target or time stop may have come due meanwhile
            now = market_clock.now_utc()
            late = manage_exits(broker, book, positions, orders, cfg, persist=True)
            if late:
                actions += late
                best_effort("saving the book", lambda: state.write_json(BOOK, book))
                acct, positions, orders = sync()
                actions += reconcile(broker, book, positions, orders, cfg, limits)
        line = best_effort("broker files", lambda: _write_broker_files(broker, acct, positions, orders, book,
                                                                         _realized_today(now)), line)
    open_n = sum(1 for it in book["items"].values() if it["status"] == "open")
    pend_n = sum(1 for it in book["items"].values() if it["status"] in ("pending", "submitting"))
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
    binding = usd_limits_binding(cfg, limits, acct.get("equity")) if acct else []
    uni_notes = list(uni_notes) + binding
    told = "|".join(b.split(" is below")[0] for b in binding)
    if told and told != prev.get("usd_limits_told"):  # once per set of limits — equity hovering at the line
        notify.send("learned", "A dollar limit now holds the bot back", "; ".join(binding), cfg)
    common["usd_limits_told"] = told or prev.get("usd_limits_told") or ""  # doesn't send it again and again
    st = _state(status=status, message=msg, today=today, equity=line, last_errors=last_errors,
                universe={"stock": n_st, "crypto": n_cr}, notes=(uni_notes + (notes if status == "running" else []))[-20:],
                playbook=playbook, **common)
    best_effort("daily summary", lambda: daily_summary(cfg, st, learned, now))
    actions += ["%s %s %s" % (d["action"], d["symbol"], d["setup"]) for d in decisions]
    return {"status": status, "message": msg, "actions": actions, "errors": errors,
            "decisions": [{"id": d["id"], "action": d["action"], "reasons": d["reasons"]} for d in decisions]}


def _sessions(now) -> dict:
    ms = market_clock.market_status(now)
    stock = ms["state"] if ms["trading_day"] else ("holiday" if ms.get("holiday") else "weekend")
    return {"crypto": "open 24/7", "stock": stock}


def heartbeat(runner: str, status: str, wait_sec: int = None) -> dict:
    """Proof of life for the dashboard: written when a cycle starts ("cycling"), after it, and while the daemon waits
    longer than usual after errors (``wait_sec``) — so a slow cycle or a back-off never looks like a dead bot."""
    st = state.read_json(STATE, {}) or {}
    scan = state.read_json(SCAN, {}) or {}
    now = market_clock.now_utc()
    prev = state.read_json(HEARTBEAT, {}) or {}
    ok = status in ("running", "paused", "killed", "dry_run")
    hb = {"at": market_clock.iso(now), "pid": os.getpid(), "host": socket.gethostname(), "runner": runner,
          # the last cycle that worked: a bot that beats but fails every cycle is not "alive" for long
          "last_ok_at": market_clock.iso(now) if ok else prev.get("last_ok_at"),
          "started_at": _PROCESS["started_at"] or market_clock.iso(now), "cycle": st.get("cycles"), "status": status,
          "interval_sec": wait_sec or st.get("interval_sec"),
          "next_cycle": market_clock.iso(now.timestamp() + wait_sec) if wait_sec else st.get("next_cycle"),
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
        if runner != "replay":
            try:
                heartbeat(runner, "cycling")
            except Exception:
                pass
        with state.locked("autopilot/cycle", timeout=CYCLE_LOCK_WAIT_SEC, stop=lambda: _PROCESS.get("stopping")):
            # the daemon, the dashboard and a CLI run never cycle at once — and never wait for each other forever;
            # the watchdog times the cycle, not the wait for another process's cycle
            _PROCESS["cycle_t0"] = time.monotonic()
            asked = read_control()
            try:
                res = _cycle(approved)
            finally:
                if asked["run_once"]:  # used up whatever the cycle did — never a loop that cycles every second
                    _consume_run_once(asked.get("updated_at"))
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
        _PROCESS["cycle_t0"] = None
        try:
            if runner != "replay":  # a replay's clock is in the past — its beat would make the daemon look dead
                heartbeat(runner, (res or {}).get("status") or "error")
        except Exception:
            pass
        if now:
            if saved is None:
                os.environ.pop("TRADER_NOW", None)
            else:
                os.environ["TRADER_NOW"] = saved


# --- the 24/7 daemon ------------------------------------------------------------------------------------

def _holding() -> bool:
    try:
        return any(it.get("status") in LIVE_ITEM for it in (_book().get("items") or {}).values())
    except Exception:  # can't tell — assume it does
        return True


def _pid_alive(pid) -> bool:
    if os.name != "posix":  # os.kill(pid, 0) would terminate the process on Windows — rely on the heartbeat
        return True
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError):
        return False
    return True


def _flock_held():
    """True: a live process on this machine holds the daemon's OS lock · False: none does · None: can't tell."""
    if fcntl is None:
        return None
    if _PROCESS.get("lock_fh") is not None:
        return True
    try:
        fh = open(str(state.path(FLOCK)), "a")
    except OSError:
        return None
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        return True if exc.errno in state._HELD else None  # no locks on this filesystem: can't tell
    else:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        fh.close()


def lock_holder():
    """The live daemon holding trader/autopilot/daemon.lock, or None if the lock is free or stale.

    A daemon holds an OS lock for its whole life, so a long back-off or a slow cycle never makes it look dead,
    and a crashed one never looks alive (not even from a new Docker container with another hostname)."""
    try:
        doc = state.read_json(LOCK)
    except ValueError:
        doc = None
    held = _flock_held()
    if held:
        return doc or {"pid": None, "host": socket.gethostname(), "started_at": None, "flock": True}
    if doc and doc.get("flock") and held is False:
        return None
    return _legacy_holder(doc)


def _legacy_holder(doc):
    """A lock file without an OS lock behind it (Windows, or a daemon of an older version): pid + heartbeat."""
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
    def refuse(holder):
        cli.fail("another autopilot daemon is already running for this trader/ folder (pid %s on %s, since %s) "
                 "— stop it first" % (holder.get("pid"), holder.get("host"), holder.get("started_at")))
    try:
        doc = state.read_json(LOCK)
    except ValueError:
        doc = None
    if fcntl is not None and _PROCESS.get("lock_fh") is None:
        fh = open(str(state.path(FLOCK)), "a")
        try:  # check and take in one step: two daemons started at once can't both get it
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            fh.close()
            if exc.errno not in state._HELD:
                cli.fail("cannot lock %s (%s) — the trader/ folder must be on a local disk with file locks (not "
                         "NFS without lockd, CIFS or a FUSE mount)" % (state.path(FLOCK), exc))
            refuse(doc or {})
        _PROCESS["lock_fh"] = fh
    if doc and not doc.get("flock"):
        holder = _legacy_holder(doc)
        if holder and holder.get("pid") != os.getpid():
            release_lock()
            refuse(holder)
    doc = {"pid": os.getpid(), "host": socket.gethostname(), "started_at": market_clock.iso(market_clock.now_utc()),
           "flock": _PROCESS.get("lock_fh") is not None}
    state.write_json(LOCK, doc)
    return doc


def release_lock() -> None:
    try:
        doc = state.read_json(LOCK) or {}
    except ValueError:
        doc = {}
    if doc.get("pid") == os.getpid() and doc.get("host") == socket.gethostname():
        try:
            state.path(LOCK).unlink()
        except OSError:
            pass
    fh = _PROCESS.pop("lock_fh", None)
    if fh is not None:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            fh.close()


def _refresh_watchlist_news(cfg: dict) -> None:
    """Background: keep the dashboard's feed fresh for the watchlists (trade candidates are refreshed just in time)."""
    try:
        _mod("trader-news", "news").refresh_feed(assets=("stock", "crypto"))
    except Exception as exc:
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": market_clock.iso(market_clock.now_utc()),
                                                            "task": "news", "error": "%s: %s" % (type(exc).__name__, exc)})


LAB_TIMEOUT_SEC = 4 * 3600
HK_STATE = "autopilot/housekeeping_state.json"


def _run_lab(argv: list, out_file: str) -> dict:
    """The lab in a process of its own, at low priority: its hundreds of MB of candles are freed when it ends,
    and its CPU never competes with a cycle that has a stop to manage."""
    import shutil
    # `nice` as a command, not a preexec_fn: running Python code between fork and exec is unsafe in a process
    # with threads (the watchdog, the news refresh)
    nice = [shutil.which("nice"), "-n", "10"] if os.name == "posix" and shutil.which("nice") else []
    r = subprocess.run(nice + [sys.executable, os.path.join(_ROOT, "trader-backtest", "lab.py")] + argv,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                       timeout=LAB_TIMEOUT_SEC, env=dict(os.environ))
    if r.returncode != 0:
        raise RuntimeError("the lab exited with %d: %s" % (r.returncode, (r.stderr or r.stdout or "")[-300:].strip()))
    doc = state.read_json(out_file)
    if not doc:
        raise RuntimeError("the lab finished but wrote no %s" % out_file)
    return doc


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
        lab.build_parser().parse_args(argv)  # a bad playbook setting fails here, in words, not in the child
        doc = _run_lab(argv, lab.LAB_FILE)
        s = doc["summary"]
        names = ["%s %s (%s)" % (r["display"], r["setup"], r["timeframe"]) for r in doc["validated"][:6]]
        text = ("Backtest lab re-ran on %d coins: %d validated combination(s)%s. Crypto is traded only from these." % (
            doc["coins"], s["coins_validated"], (": " + ", ".join(names)) if names else
            " — nothing kept an edge after costs on unseen data, so no crypto trades for now"))
        notify.send("learned", "Backtest lab: %d validated" % s["coins_validated"], text, cfg)
        if ((cfg.get("autopilot") or {}).get("etf_trend") or {}).get("enabled"):
            edoc = _run_lab(["--etf", "--no-html"], lab.LAB_FILE_ETF)
            notify.send("learned", "ETF lab: %d validated" % edoc["summary"]["coins_validated"],
                        "ETF trend lab re-ran on %d ETFs: %s." % (edoc["coins"], ", ".join(
                            r["display"] for r in edoc["validated"]) or "none validated"), cfg)
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": started, "task": "lab", "validated": s["coins_validated"],
                                                            "seconds": s["seconds"]})
    except Exception as exc:
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": started, "task": "lab",
                                                            "error": "%s: %s" % (type(exc).__name__, exc)})


def _note_housekeeping(task: str, exc: BaseException) -> None:
    try:
        state.append_jsonl("autopilot/housekeeping.jsonl", {"at": market_clock.iso(market_clock.now_utc()),
                                                            "task": task, "error": "%s: %s" % (type(exc).__name__, exc)})
    except Exception:
        pass


def _guarded(task: str, fn, cfg: dict) -> None:
    """A background job that fails is written down — it never dies silently, not even on SystemExit."""
    try:
        fn(cfg)
    except BaseException as exc:  # noqa: BLE001 — argparse in the lab raises SystemExit on a bad setting
        _note_housekeeping(task, exc)


KEEP_DAYS = 45        # finished records older than this move to trader/archive/ (the journal and equity stay whole)
PRUNE_EVERY_SEC = 6 * 3600
MIN_FREE_MB = 200     # below this nothing new opens (exits go on): every entry writes a dozen files
LOW_DISK_MB = 1024    # below this housekeeping empties the download cache and tells you (every 6 h at most)
# logs nobody reads in full: past MAX bytes the oldest part goes to archive/<name>-<date>.jsonl.gz
ROTATE = (("autopilot/decisions.jsonl", 64, 24), ("broker/log.jsonl", 32, 4), ("notifications.jsonl", 16, 2),
          ("risk_log.jsonl", 32, 4), ("autopilot/housekeeping.jsonl", 4, 1), ("autopilot/control_log.jsonl", 8, 2),
          ("broker/sim-archive.jsonl", 8, 0), ("arb_log.jsonl", 32, 4), ("archive/book.jsonl", 8, 0),
          ("archive/plan.jsonl", 8, 0), ("archive/entries.jsonl", 8, 0), ("archive/orders.jsonl", 8, 0))


def _free_mb():
    try:
        import shutil
        return shutil.disk_usage(str(config.ensure_home())).free // (1024 * 1024)
    except (OSError, AttributeError):
        return None


def _older(at, cut: str) -> bool:
    return bool(at) and str(at) < cut  # ISO times compare as text; no time → kept


def rotate_log(name: str, max_mb: float, keep_mb: float, now=None) -> int:
    """Move all but the newest ``keep_mb`` of a JSONL log into archive/<name>-<date>.jsonl.gz once it passes
    ``max_mb``. Returns the bytes moved."""
    day = market_clock.iso(now or market_clock.now_utc())[:10].replace("-", "")
    dest = state.path("archive", "%s-%s.jsonl.gz" % (name.replace("/", "-")[:-6], day))
    return state.rotate_jsonl(name, int(max_mb * 1024 * 1024), int(keep_mb * 1024 * 1024), dest)


def _newest_mtime(f) -> float:
    if not f.is_dir():
        return f.stat().st_mtime
    return max([f.stat().st_mtime] + [g.stat().st_mtime for g in f.iterdir()])


def _archive_doc(name: str, coll: str, when: tuple, cut: str, keep) -> int:
    """Move finished records of plan.json / entries.json / orders.json older than ``cut`` to archive/<name>l —
    appended under the file's lock before they leave it, so a full disk loses nothing."""
    moved = []

    def stale(key, v) -> bool:
        return isinstance(v, dict) and not keep(key) and _older(next((v.get(w) for w in when if v.get(w)), None), cut)

    def change(doc):
        items = doc.get(coll)
        if isinstance(items, dict):
            gone = [k for k, v in items.items() if k != doc.get("latest") and stale(k, v)]
            if gone:
                state.append_jsonl_rows("archive/%sl" % name, [dict(items[k], id=items[k].get("id") or k)
                                                               for k in gone])
            for k in gone:
                del items[k]
            moved.extend(gone)
        elif isinstance(items, list):
            gone = [v for v in items if stale(v.get("id") if isinstance(v, dict) else None, v)]
            if gone:
                state.append_jsonl_rows("archive/%sl" % name, gone)
            out = {id(v) for v in gone}
            doc[coll] = [v for v in items if id(v) not in out]
            moved.extend(v.get("id") for v in gone)
    if (state.home() / name).exists():
        state.update_json(name, change, {})
    return len(moved)


def prune_state(now=None, keep_days: int = KEEP_DAYS, cache_age: float = None, cache: bool = True) -> dict:
    """Keep the folder the size of a few weeks, not of every day the bot ever ran: old downloads are deleted;
    finished book items, plans, entries and orders move to trader/archive/*.jsonl; desk reviews, Time Machine
    replays and per-symbol backtests nobody needs any more are deleted; big logs are rotated. Anything an open
    position, a waiting entry or an alert still points to is kept."""
    import shutil
    now = market_clock.parse_iso(now) if now else market_clock.now_utc()
    cut_ts = now.timestamp() - keep_days * 86400
    cut = market_clock.iso(cut_ts)
    out = {"cache": FileCache().prune(http.STALE_MAX_AGE if cache_age is None else cache_age) if cache else None}
    with state.locked("autopilot/cycle", timeout=60):  # the cycle reads the book at its start, writes it at its end
        book = _book()
        live = {k: it for k, it in book["items"].items() if it.get("status") in LIVE_ITEM}
        ids = set(live) | {it.get("plan_id") for it in live.values()} | {it.get("order_id") for it in live.values()}
        old = [k for k, it in book["items"].items() if k not in live
               and _older(it.get("closed_at") or it.get("canceled_at") or it.get("placed_at"), cut)]
        if old:
            state.append_jsonl_rows("archive/book.jsonl", [dict(book["items"][k], id=k) for k in old])
            for k in old:
                del book["items"][k]
            state.write_json(BOOK, book)
        out["book"] = len(old)
        for rel, max_mb, keep_mb in ROTATE:
            out[rel] = rotate_log(rel, max_mb, keep_mb, now=now)
    try:
        alerts_text = (state.home() / "alerts.json").read_text(encoding="utf-8")
    except OSError:
        alerts_text = ""

    def keep(key) -> bool:
        return bool(key) and (key in ids or key in alerts_text)

    out["plans"] = _archive_doc("plan.json", "plans", ("created_at",), cut, keep)
    out["entries"] = _archive_doc("entries.json", "entries", ("checked_at", "watch_started"), cut, keep)
    out["orders"] = _archive_doc("orders.json", "orders", ("created_at",), cut, keep)
    gone = 0
    for folder, pattern in (("desk", "*"), ("timemachine", "*"), ("backtests", "*-*.json*")):
        d = state.home() / folder
        for f in (d.glob(pattern) if d.exists() else []):
            if f.name.split(".json")[0] in ids or f.name.startswith(("lab", "playbook")):
                continue
            try:
                if _newest_mtime(f) >= cut_ts:
                    continue
                shutil.rmtree(str(f)) if f.is_dir() else f.unlink()
                gone += 1
            except OSError:
                continue
    out["files"] = gone
    return out


class Housekeeping:
    """Work between cycles that must never delay exits: news refresh and the weekly backtest lab (background
    threads), daily compaction, pruning old records and watching the free disk space."""

    def __init__(self):
        self.news_thread = None
        self.lab_thread = None
        self.last_compact = None
        self.lab_tried = None
        self.shadow_thread = None
        self.shadow_tried = None
        self.last_prune = None
        self.disk_warned = None
        self.cache_thread = None

    def tick(self, cfg: dict) -> None:
        self._run(cfg, (self._news, self._lab, self._shadow, self._compact, self._prune, self._disk))

    def upkeep(self, cfg: dict) -> None:
        """Only what keeps the folder small (the CLI loop and the dashboard's own loop): no news, lab or checks."""
        self._run(cfg, (self._compact, self._prune, self._disk))

    def _run(self, cfg: dict, jobs) -> None:
        # each job on its own: a broken news file must not also stop the lab, the checks and the compaction
        for job in jobs:
            try:
                job(cfg, market_clock.now_utc())
            except Exception as exc:  # noqa: BLE001
                _note_housekeeping(job.__name__.strip("_"), exc)

    def _news(self, cfg: dict, now) -> None:
        poll = float(((cfg.get("news") or {}).get("x") or {}).get("poll_minutes") or 15)
        feed = state.read_json("news_feed.json", {}) or {}
        age = now.timestamp() - market_clock.ts(feed["updated_at"]) if feed.get("updated_at") else None
        busy = self.news_thread is not None and self.news_thread.is_alive()
        if poll > 0 and not busy and (age is None or age >= poll * 60) and not config.is_offline():
            self.news_thread = threading.Thread(target=_guarded, args=("news", _refresh_watchlist_news, cfg),
                                                daemon=True, name="trader-news-refresh")
            self.news_thread.start()

    def _lab(self, cfg: dict, now) -> None:
        pb_cfg = (cfg.get("autopilot") or {}).get("playbook") or {}
        every = float(pb_cfg.get("auto_refresh_days") or 0)
        lab_busy = self.lab_thread is not None and self.lab_thread.is_alive()
        if every > 0 and pb_cfg.get("required_for_crypto", True) and not lab_busy and not config.is_offline() \
                and "crypto" in ((cfg.get("autopilot") or {}).get("assets") or ["stock", "crypto"]):
            pb = state.read_json("backtests/playbook.json", {}) or {}
            age = now.timestamp() - market_clock.ts(pb["generated_at"]) if pb.get("generated_at") else None
            if self.lab_tried is None:  # remembered on disk: a restart (or a crash in the lab) is no reason to retry
                self.lab_tried = float((state.read_json(HK_STATE, {}) or {}).get("lab_tried") or 0) or None
            retry_ok = self.lab_tried is None or now.timestamp() - self.lab_tried >= 6 * 3600
            if (age is None or age >= every * 86400) and retry_ok:
                self.lab_tried = now.timestamp()
                state.update_json(HK_STATE, lambda d: d.update(lab_tried=self.lab_tried), {})
                self.lab_thread = threading.Thread(target=_guarded, args=("lab", _refresh_lab, cfg), daemon=True,
                                                   name="trader-backtest-lab")
                self.lab_thread.start()

    def _shadow(self, cfg: dict, now) -> None:
        sh = state.read_json(shadow.FILE, {}) or {}
        shadow_busy = self.shadow_thread is not None and self.shadow_thread.is_alive()
        if not shadow_busy and not config.is_offline() and now.hour >= 1 and \
                (sh.get("updated_at") or "")[:10] != now.strftime("%Y-%m-%d") and self.shadow_tried != now.strftime("%Y-%m-%d"):
            self.shadow_tried = now.strftime("%Y-%m-%d")
            self.shadow_thread = threading.Thread(target=_guarded, args=("shadow", _daily_shadow, cfg), daemon=True,
                                                  name="trader-shadow")
            self.shadow_thread.start()

    def _compact(self, cfg: dict, now) -> None:
        day = _today(now)
        if self.last_compact != day:
            self.last_compact = day
            with state.locked("autopilot/cycle", timeout=60):
                compact_equity()

    def _prune_cache(self, max_age: float) -> None:
        # in the background: an old install holds millions of cache files, and deleting them must not hold up exits
        if self.cache_thread is None or not self.cache_thread.is_alive():
            self.cache_thread = threading.Thread(target=_guarded, args=("cache", FileCache().prune, max_age),
                                                 daemon=True, name="trader-cache-prune")
            self.cache_thread.start()

    def _prune(self, cfg: dict, now) -> None:
        if self.last_prune is None or time.monotonic() - self.last_prune >= PRUNE_EVERY_SEC:
            self.last_prune = time.monotonic()
            self._prune_cache(http.STALE_MAX_AGE)
            prune_state(now, cache=False)

    def _disk(self, cfg: dict, now) -> None:
        free = _free_mb()
        if free is None or free >= LOW_DISK_MB:
            return
        self._prune_cache(3600)  # downloads are fetched again; the last hour stays as the copy for an outage
        if self.disk_warned is None or time.monotonic() - self.disk_warned >= 6 * 3600:
            self.disk_warned = time.monotonic()
            notify.send("error", "Disk almost full", "%d MB free on the trader's disk — the download cache is being "
                        "emptied down to its last hour. Under %d MB the bot opens nothing new; exits go on." % (
                            free, MIN_FREE_MB), cfg, priority="high")


WATCHDOG_SEC = 1200  # a cycle running this long is stuck (a socket that never answers): restart the process


def _say(line: str) -> None:
    """Print for whoever watches the daemon — a closed terminal or a broken pipe is no reason to stop trading."""
    try:
        print(line)
        sys.stdout.flush()
    except (OSError, ValueError):
        pass


def _watchdog() -> None:
    """The daemon's own guard: when one cycle has run for WATCHDOG_SEC, say so and exit — systemd / Docker restart
    the process, the OS lock is freed with it, and the next cycle picks up the book where it was saved."""
    while True:
        time.sleep(15)
        t0 = _PROCESS.get("cycle_t0")
        if t0 is None or time.monotonic() - t0 < WATCHDOG_SEC:
            continue
        why = "a cycle has been running for %d min — restarting the autopilot" % ((time.monotonic() - t0) // 60)
        try:
            heartbeat("daemon", "hung")
        except Exception:
            pass
        t = threading.Thread(target=notify.send, args=("error", "Autopilot stuck — restarting", why),
                             kwargs={"priority": "high"}, daemon=True)
        t.start()
        t.join(20)
        _say("    watchdog: " + why)
        os._exit(70)


def daemon(args, cfg) -> int:
    """Run forever: one cycle every interval_sec, crypto around the clock, stocks in the session."""
    if os.environ.get("TRADER_NOW") and not args.max_cycles:
        cli.fail("the daemon runs on the real clock — with a pinned clock (--now/--offline) use replay, or pass "
                 "--max-cycles for a bounded test run")
    acquire_lock()
    _PROCESS["stopping"] = False
    stop = {"signal": None}

    def _stop(signum, frame):
        stop["signal"] = signum
        _PROCESS["stopping"] = True  # a cycle waiting for a lock gives up instead of holding up the stop
    previous = {}
    for sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None), getattr(signal, "SIGHUP", None)):
        if sig is not None:
            if sig == getattr(signal, "SIGHUP", None) and signal.getsignal(sig) == signal.SIG_IGN:
                continue  # started with nohup: a closed terminal is meant to leave it running
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
    from shared import secrets
    if secrets.file_warning():  # your keys, readable by every account on the machine
        _say("WARNING: " + secrets.file_warning())
        notify.send("error", "secrets.env is readable by other users", secrets.file_warning(), cfg, priority="high")
    house = Housekeeping()
    errors_in_row, n = 0, 0
    threading.Thread(target=_watchdog, name="trader-watchdog", daemon=True).start()
    try:
        while stop["signal"] is None:
            res = run_cycle(approved=approved, runner="daemon")
            n += 1
            errors_in_row = errors_in_row + 1 if res.get("status") == "error" else 0
            try:
                cfg = config.load_config()
            except ValueError as exc:  # a typo while you edit config.json: keep going on the last good one
                _say("    config: %s — still using the last good config" % exc)
            if errors_in_row == ERROR_ALERT_AFTER:
                notify.send("error", "Autopilot failing: %d cycles in a row" % errors_in_row, res.get("message") or "",
                            cfg, priority="high")
            if not args.json:
                _say("%s  %s" % (market_clock.iso(market_clock.now_utc()), res.get("message")))
                for a in res.get("actions") or []:
                    _say("    " + a)
            if args.max_cycles and n >= args.max_cycles:
                break
            try:
                house.tick(cfg)
            except Exception as exc:
                _say("    housekeeping: %s: %s" % (type(exc).__name__, exc))
            interval = max(config.MIN_INTERVAL_SEC,
                           int(args.interval or (cfg.get("autopilot") or {}).get("interval_sec") or 60))
            if errors_in_row:
                # back off from a failing broker — but not past a stop or a 3:55 p.m. time stop while it holds positions
                cap = MAX_BACKOFF_SEC if not _holding() else HOLDING_BACKOFF_SEC
                interval = max(interval, min(cap, interval * (2 ** min(errors_in_row - 1, 4))))
                try:  # waiting longer than usual is not being dead — say how long
                    heartbeat("daemon", "error", wait_sec=interval)
                except Exception:
                    pass
            waited = 0
            while waited < interval and stop["signal"] is None:
                time.sleep(1)
                waited += 1
                try:
                    if read_control()["run_once"]:
                        break
                except ValueError:
                    pass
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
                                      "check-live", "universe", "learned", "notify-test", "profile", "check",
                                      "forget"))
    p.add_argument("--once", action="store_true", help="run: a single cycle (default)")
    p.add_argument("--refresh", action="store_true", help="universe: rebuild it now instead of showing the cached one")
    p.add_argument("--approve", action="store_true",
                   help="standing approval for this run (otherwise config autopilot.enabled decides; else dry run)")
    p.add_argument("--interval", type=int,
                   help="loop/daemon: seconds between cycles (default config autopilot.interval_sec)")
    p.add_argument("--max-cycles", type=int, help="loop/daemon: stop after N cycles")
    p.add_argument("--confirm", help='kill: must be "KILL"; forget: must be "FORGET"')
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
    p.add_argument("--memes", action="store_true",
                   help="profile: also trade established meme coins on the exchange (top 40 by market cap, a year "
                        "listed, validated by the lab, half the risk) — never DEX tokens")
    p.add_argument("--no-runner", action="store_true",
                   help="profile: sell the whole trend breakout at its exit (default: let two thirds of a winner ride)")
    p.add_argument("--core-risk", type=float,
                   help="profile: %% risk per trade for the core coins (default: the same as --risk); 3 = the "
                        "backtested split, BTC and ETH at 3 %% with a position up to 50 %% of the account")
    p.add_argument("--core-coins", default="BTC,ETH",
                   help="profile: the core coins --core-risk applies to (default BTC,ETH)")
    p.add_argument("--fixed-risk", action="store_true",
                   help="profile: always the risk you set — no halving when the lab is less than 70 %% sure "
                        "(the losing-streak and drawdown rules still cut it)")
    return p


# --- profile: the daily-trend setup the €1,000 backtest ran -----------------------------------------------

TREND_SETUPS = ["trend_ema", "trend_breakout"]
MAX_PROFILE_RISK = 5.0
# the profile owns the per-coin risk: a re-run replaces these mappings whole, so an old split cannot linger
PROFILE_REPLACES = {"config.json": ("risk_by_symbol",), "limits.json": ("crypto.symbols",)}


def trend_profile(risk: float, lev: float, stock_lev: float, capital: float, runner: bool = True,
                  etf: bool = True, cash_yield: float = 4.0, memes: bool = False, core_risk: float = None,
                  core_coins=("BTC", "ETH"), fixed_risk: bool = False) -> tuple:
    """(config changes, limits changes) for daily trend following on the biggest coins.

    Every number is what the portfolio backtest used, and only what it tested trades: the intraday stock setups
    are switched off (the ETF trend still trades stocks, on daily bars). The learning rules are loosened to fit a strategy that
    wins 30–40 % of trades: three losses in a row happen in a quarter of all stretches there, so they are no
    warning; seven (≈ 5 %) are. The drawdown pause sits above the worst drop of the backtest (−30 %), so it
    fires only when reality is worse than eight years of history.

    ``core_risk``: its own risk per trade for ``core_coins`` (the backtested split: BTC and ETH at 3 %, the rest
    at 2 %). Above ``risk`` their position may reach half the account — at 25 % a 3 % trade with a 3×ATR stop
    would be cut back to the 2 % size and the split would do nothing.

    ``fixed_risk``: no confidence sizing. With ``max_risk_pct`` = the risk, the tiers can only cut (×0.5 under a
    70 % profit chance), so this is the risk exactly as set — what the split backtest ran.
    """
    if not 0 < risk <= MAX_PROFILE_RISK:
        raise ValueError("--risk must be above 0 and at most %g%% per trade" % MAX_PROFILE_RISK)
    core_risk = risk if core_risk is None else core_risk
    if not (isinstance(core_risk, (int, float)) and math.isfinite(core_risk) and 0 < core_risk <= MAX_PROFILE_RISK):
        raise ValueError("--core-risk must be above 0 and at most %g%% per trade" % MAX_PROFILE_RISK)
    coins = set()
    for c in (str(c).strip() for c in core_coins):
        if not c:
            continue
        try:  # BTCUSDT, BTC/USD and btc all mean BTC — the key the sizer looks up
            base = symbols.parse(c, asset="crypto", quote="USDT").base.upper()
        except symbols.SymbolError:
            base = ""
        if not base.isalnum():
            raise ValueError("--core-coins takes coin names like BTC,ETH — not %r" % c)
        coins.add(base)
    coins = sorted(coins)
    if core_risk != risk and not coins:
        raise ValueError("--core-coins is empty — name the coins --core-risk is for (e.g. BTC,ETH)")
    if not (isinstance(capital, (int, float)) and math.isfinite(capital) and capital > 0):
        raise ValueError("--capital must be an amount above 0 (e.g. 1000)")
    if not (math.isfinite(float(cash_yield)) and 0 <= float(cash_yield) <= 20):
        raise ValueError("--cash-yield must be between 0 and 20 (% a year)")
    for name, x in (("--leverage", lev), ("--stock-leverage", stock_lev)):
        if not 1.0 <= x <= config.LEVERAGE_HARD_CAP:
            raise ValueError("%s must be between 1 and %g" % (name, config.LEVERAGE_HARD_CAP))
    # dollar limits bind only after the account grew 4× — and never round down to 0 (a limit of 0 is refused)
    backstop = lambda pct: max(1, round(capital * pct / 100.0 * 4))
    cfg = {"risk_per_trade_pct": risk, "account_size": capital, "cash_yield_pct": float(cash_yield),
           "leverage": {"crypto": lev, "stock": stock_lev},
           "autopilot": {"sim_starting_cash": capital, "runner": {"enabled": bool(runner)},
                         "etf_trend": {"enabled": bool(etf), "when": "crypto_bear"},
                         "playbook": {"top": 10, "setups": TREND_SETUPS, "timeframes": ["1d"], "max_risk_pct": risk,
                                      "confidence_sizing": not fixed_risk},
                         "universe": {"crypto": {"top_n": 10}},
                         "setups": {"stock": []}, "daily_loss_action": "stop_entries",
                         "memes": {"enabled": bool(memes)},
                         "adapt": {"loss_streak": 7, "symbol_loss_streak": 5, "min_trades": 20,
                                   "max_drawdown_pct": 35}}}
    day = 5 * max(risk, core_risk)  # five full losses in one day, then no new entries until tomorrow
    lim = {"global": {"max_daily_loss_pct": day, "max_daily_loss_usd": backstop(day)},
           "crypto": {"max_open_positions": 5, "max_position_pct": 25, "max_total_exposure_pct": 100,
                      "allow_leverage": lev > 1, "max_leverage": lev, "max_risk_per_trade_pct": risk,
                      "max_risk_per_trade_usd": backstop(risk), "max_daily_loss_pct": day,
                      "max_daily_loss_usd": backstop(day)},
           "stock": {"allow_margin": stock_lev > 1, "max_leverage": stock_lev, "max_risk_per_trade_pct": risk,
                     "max_risk_per_trade_usd": backstop(risk), "max_daily_loss_pct": day,
                     "max_daily_loss_usd": backstop(day)}}
    # always written, so a re-run with one risk for all clears an old split instead of leaving it behind
    split = core_risk != risk
    cfg["risk_by_symbol"] = {c: core_risk for c in coins} if split else {}
    lim["crypto"]["symbols"] = {c: {"max_risk_per_trade_pct": core_risk, "max_risk_per_trade_usd": backstop(core_risk),
                                    "max_position_pct": 50 if core_risk > risk else 25} for c in coins} if split else {}
    return cfg, lim


def _flat(d: dict, prefix: str = "", leaves: tuple = ()) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, dict) and prefix + k not in leaves:
            out.update(_flat(v, prefix + k + ".", leaves))
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
    core = c_cfg.get("risk_by_symbol") or {}
    lines = ["PROFILE · daily trend following on the 10 biggest coins · %g%% risk%s · crypto %g× · stocks %g×%s" % (
        c_cfg["risk_per_trade_pct"],
        " (%s %g%%)" % (" + ".join(sorted(core)), list(core.values())[0]) if core else "",
        c_cfg["leverage"]["crypto"], c_cfg["leverage"]["stock"],
        " · winners ride" if c_cfg["autopilot"]["runner"]["enabled"] else "")]
    if core:
        r = list(core.values())[0]
        pos = ((c_lim.get("crypto") or {}).get("symbols") or {}).get(sorted(core)[0], {}).get("max_position_pct")
        lines.append("Core coins: %s risk %g%% per trade (a position up to %g%% of the account), every other coin "
                     "%g%%. The split the backtest ran: more money where the trends are the most reliable." % (
                         " and ".join(sorted(core)), r, pos or 25, c_cfg["risk_per_trade_pct"]))
    if not c_cfg["autopilot"]["playbook"].get("confidence_sizing", True):
        lines.append("Fixed risk: every trade at the risk above — no halving when the lab is less than 70 %% sure; "
                     "7 losses in a row still halve it and a −%g%% drawdown still pauses the bot." % (
                         c_cfg["autopilot"]["adapt"]["max_drawdown_pct"]))
    if c_cfg["autopilot"]["etf_trend"]["enabled"]:
        lines.append("Bear markets: while Bitcoin is below its 200-day average (no crypto trend to follow), the bot "
                     "trades the same trend rule on ETFs that move unlike crypto — gold, the dollar, commodities, "
                     "bonds, energy, the indexes — held for days, only those the ETF lab validated; idle cash counts "
                     "%g%% a year in the simulator (T-bills)." % c_cfg["cash_yield_pct"])
        if not cfg.get("fractional_shares") and float(c_cfg["account_size"]) < 10000:
            cap = float(c_cfg["account_size"]) * float((limits.get("stock") or {}).get("max_position_pct") or 25) / 100
            lines.append("At %s with whole shares an ETF priced above about %s (SPY, QQQ, GLD…) rounds to 0 shares and "
                         "is skipped — the backtest skipped them too; set \"fractional_shares\": true in config.json "
                         "to trade them in the simulator." % (fmt.money(c_cfg["account_size"]), fmt.money(cap)))
    if c_cfg["autopilot"].get("memes", {}).get("enabled"):
        lines.append("Meme coins: established ones on the exchange too (DOGE, SHIB, PEPE…) — only while among the "
                     "top 40 by market cap, a year listed and validated by the lab, at half the risk. Tokens on a DEX "
                     "are never traded.")
    if c_cfg["autopilot"]["runner"]["enabled"]:
        lines.append("Let winners ride: when a trend breakout's exit comes in profit while the coin is above its "
                     "200-day average, the bot sells a third and lets two thirds ride until a daily close below the "
                     "50-day EMA, with the stop moved to the buy price — only while this week's lab run says it pays.")
    for name, cur, ch in (("config.json", cfg, c_cfg), ("limits.json", limits, c_lim)):
        lines.append(name + ":")
        for key, new in _flat(ch, leaves=PROFILE_REPLACES[name]).items():
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
    if brokers.mode_of(cfg) != "simulator":  # a replay of the past must never send a real order
        raise ValueError("replay runs only on the simulator — use a separate trader/ folder (--home) whose config "
                         "has autopilot.broker \"simulator\"")
    holder = running_daemon()
    if holder:
        raise ValueError("a daemon is trading this trader/ folder (pid %s) — replay into a separate folder (--home)"
                         % holder.get("pid"))
    t = market_clock.ts(args.start)
    end = market_clock.ts(args.end)
    step = market_clock.parse_horizon(args.step)
    if step <= 0:
        raise ValueError("--step must be longer than zero (e.g. 5m, 1h, 1d)")
    # a folder that already lived past --from would have its simulator, its day counters and its records sent
    # back in time (a year of interest credited at the next live cycle) — the past belongs in a folder of its own
    seen = [x for x in ((state.read_json("broker/sim.json", {}) or {}).get("last_sync"),
                        (state.read_json(STATE, {}) or {}).get("last_cycle")) if x]
    if seen and max(market_clock.ts(x) for x in seen) > t:
        raise ValueError("this trader/ folder already ran until %s, after --from — replay into a new folder: "
                         "--home /tmp/replay" % max(seen))
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
        capital = float(args.capital if args.capital is not None else (cfg.get("account_size") or 0))
        changes = trend_profile(args.risk, args.leverage, args.stock_leverage, capital, not args.no_runner,
                                not args.no_etf, args.cash_yield, args.memes, args.core_risk,
                                args.core_coins.split(","), args.fixed_risk)
        if args.write:
            config.update_file("config.json", changes[0], replace=PROFILE_REPLACES["config.json"])
            config.update_file("limits.json", changes[1], replace=PROFILE_REPLACES["limits.json"])
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
    if args.action == "forget":
        if args.confirm != "FORGET":
            cli.fail("forget needs --confirm FORGET — it drops the book's open trades of another broker or account "
                     "(close them there first: the bot will never manage them again)")
        res = forget_foreign(cfg)
        cli.emit(args, res["message"], res)
        return 0
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
    interval = max(config.MIN_INTERVAL_SEC,
                   int(args.interval or (cfg.get("autopilot") or {}).get("interval_sec") or 60))
    n = 0
    house = Housekeeping()
    while True:
        res = run_cycle(approved=approved, runner="cli")
        n += 1
        if not os.environ.get("TRADER_NOW"):
            house.upkeep(cfg)  # a loop left running for months compacts and prunes like the daemon
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
