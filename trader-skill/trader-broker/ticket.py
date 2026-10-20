#!/usr/bin/env python3
"""Order Executor — turn a risk-PASSED order into a plain ticket plus connector JSON.

This tool never places anything and makes no network calls. It prepares a
ticket, waits for the user's explicit "yes" for that exact ticket, records the
reply verbatim in trader/approvals.jsonl, and only then prints the payload for
a brokerage MCP connector (e.g. Alpaca's official MCP server, paper account by
default). Meme coins only ever get a manual wallet checklist.

Examples:
  python3 ticket.py prepare                              # newest risk-passed order
  python3 ticket.py prepare --order ord-TSLA-20261020-141500
  python3 ticket.py approve --ticket tkt-ord-TSLA-20261020-141500 --reply "yes"
  python3 ticket.py decline --ticket tkt-ord-TSLA-20261020-141500 --reply "no, skip it"
  python3 ticket.py list
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import timedelta

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, fmt, market_clock, skills, state, symbols  # noqa: E402

TICKET_TTL_MIN = 15
RISK_MAX_AGE_MIN = 30
CONNECTOR_NOTES = ["paper account by default", "check argument names against your connector's tool schema before calling"]


def build_parser():
    p = cli.parser("ticket.py", __doc__)
    p.add_argument("action", nargs="?", default="prepare", choices=("prepare", "approve", "decline", "list"),
                   help="prepare a ticket, approve/decline it with the user's reply, or list tickets")
    p.add_argument("--order", help="order id (prepare; default: newest risk-passed order)")
    p.add_argument("--ticket", help="ticket id (approve / decline; default: newest ticket awaiting approval)")
    p.add_argument("--reply", help="the user's reply, copied word for word (approve / decline)")
    p.add_argument("--live", action="store_true",
                   help="prepare a LIVE ticket — only possible when trader/config.json has \"paper\": false")
    return p


def _risk_mod():
    return skills.load("trader-risk", "risk")


def order_hash(order: dict) -> str:
    return _risk_mod().order_hash(order)


def _orders_doc() -> dict:
    return state.read_json("orders.json", {}) or {"orders": []}


def _tickets_doc() -> dict:
    return state.read_json("tickets.json", {}) or {"tickets": []}


def _find(items, key, value):
    for x in items:
        if x.get(key) == value:
            return x
    return None


def _symbol(order: dict) -> symbols.Symbol:
    if order.get("asset") == "meme" and order.get("chain") and order.get("address"):
        return symbols.meme_symbol(order["chain"], order["address"], order.get("name", ""))
    return symbols.parse(order["symbol"], asset=order.get("asset"))


def ticket_hash(text: str, payload) -> str:
    blob = text + "\n" + json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# --- ticket building (pure — the same order always yields the same ticket) -------------------------------

def build_ticket(order: dict, mode: str) -> dict:
    tid = "tkt-" + order["id"]
    tag = "PAPER" if mode == "paper" else "LIVE (real money)"
    sym = _symbol(order)
    if order["asset"] == "meme":
        return _meme_ticket(order, sym, tid)
    side = (order.get("side") or "buy").upper()
    qty = order["qty"]
    if order["asset"] == "stock":
        text = "%s %s %s, limit %s, stop %s, day — %s" % (side, fmt.qty(qty), sym.base, fmt.price(order["limit_price"]),
                                                          fmt.price(order["stop_price"]), tag)
        details = []
        if order.get("target_price"):
            details.append("take-profit %s · bracket order" % fmt.price(order["target_price"]))
        args = {"symbol": sym.base, "side": order.get("side", "buy"), "quantity": qty, "order_type": "limit",
                "limit_price": order["limit_price"], "time_in_force": "day", "order_class": "bracket",
                "take_profit_limit_price": order.get("target_price"), "stop_loss_stop_price": order["stop_price"],
                "client_order_id": tid}
        tool = "place_stock_order"
    else:
        pair = sym.alpaca
        text = "%s %s %s, limit %s, gtc — %s" % (side, fmt.qty(qty), pair, fmt.price(order["limit_price"]), tag)
        details = ["stop %s — place it as a separate stop order after the fill (crypto has no bracket orders on Alpaca)"
                   % fmt.price(order["stop_price"])]
        if order.get("target_price"):
            details.append("target %s — a separate limit sell once filled" % fmt.price(order["target_price"]))
        args = {"symbol": pair, "side": order.get("side", "buy"), "qty": qty, "order_type": "limit",
                "limit_price": order["limit_price"], "time_in_force": "gtc", "client_order_id": tid}
        tool = "place_crypto_order"
    payload = {"connector": "alpaca", "tool": tool, "account": mode, "arguments": args, "notes": list(CONNECTOR_NOTES)}
    return {"id": tid, "order_id": order["id"], "asset": order["asset"], "symbol": order.get("symbol"),
            "mode": mode, "text": text, "details": details, "payload": payload,
            "hash": ticket_hash(text, payload), "order_hash": order_hash(order), "status": "awaiting_approval"}


def _meme_ticket(order: dict, sym: symbols.Symbol, tid: str) -> dict:
    name = order.get("name") or sym.name or sym.display
    addr = sym.address
    if sym.chain == "solana":
        safety = "https://rugcheck.xyz/tokens/%s" % addr
    else:
        safety = "https://honeypot.is/?address=%s" % addr
    dexscreener = order.get("pair_url") or "https://dexscreener.com/%s/%s" % (sym.chain, addr)
    max_slip = order.get("max_slippage_pct") or 3.0
    text = "MANUAL SWAP — BUY %s of %s on %s (you execute it in your own wallet)" % (
        fmt.money(order["qty"]), name, sym.chain)
    checklist = [
        "Token contract address: %s" % addr,
        "Chain: %s" % sym.chain,
        "Pair / pool: %s on %s" % (order.get("pair_address") or "see DexScreener", order.get("dex") or "the DEX"),
        "Amount: %s (≈ %s at %s)" % (fmt.money(order["qty"]), fmt.qty(order["qty"] / order["entry_price"], "tokens"),
                                     fmt.price(order["entry_price"])),
        "Max slippage: %s (estimated impact %s)" % (fmt.pct(max_slip, 1), fmt.pct(order.get("est_slippage_pct"), 2)),
        "Verify the address on DexScreener: %s" % dexscreener,
        "Verify the address on the explorer: %s" % (sym.explorer_url or "n/a"),
        "Re-check safety right before swapping: %s" % safety,
        "Compare the address character by character from two independent sources — copycat tokens share names.",
        "Use a wallet that holds only this trade's amount; never connect your main wallet.",
        "Set max slippage in the swap UI to %s or less; never sign an unlimited token approval." % fmt.pct(max_slip, 1),
        "A DEX has no stop orders: set /trader-alerts for the stop %s, the target %s and a liquidity drop."
        % (fmt.price(order["stop_price"]), fmt.price(order.get("target_price"))),
        "Never paste your seed phrase or private key anywhere — this pack never asks for them.",
    ]
    return {"id": tid, "order_id": order["id"], "asset": "meme", "symbol": order.get("symbol"), "mode": "manual",
            "text": text, "details": [], "checklist": checklist, "payload": None,
            "hash": ticket_hash(text, checklist), "order_hash": order_hash(order), "status": "manual_checklist"}


# --- actions ---------------------------------------------------------------------------------------------

def _pick_order(order_id: str = None) -> dict:
    orders = _orders_doc().get("orders") or []
    if order_id:
        o = _find(orders, "id", order_id)
        if not o:
            raise ValueError("order %r not found in trader/orders.json" % order_id)
        return o
    passed = [o for o in orders if o.get("status") == "risk_pass"]
    if not passed:
        raise ValueError("no risk-passed order — run /trader-sizer and /trader-risk first")
    return passed[-1]


def _risk_problem(order: dict, now) -> str:
    risk = order.get("risk") or {}
    if risk.get("result") != "PASS":
        return "order %s has no risk PASS (%s) — run /trader-risk first" % (
            order["id"], risk.get("result") or "never checked")
    if order_hash(order) != risk.get("order_hash"):
        return "order changed since the risk check — re-run /trader-risk"
    age = (now - market_clock.parse_iso(risk["checked_at"])).total_seconds() / 60.0
    if age > RISK_MAX_AGE_MIN:
        return "the risk check is %.0f min old (max %d) — re-run /trader-risk" % (age, RISK_MAX_AGE_MIN)
    return ""


def _save_ticket(ticket: dict) -> None:
    doc = _tickets_doc()
    tickets = [t for t in doc.get("tickets") or [] if t.get("id") != ticket["id"]]
    tickets.append(ticket)
    state.write_json("tickets.json", {"tickets": tickets})


def _set_order_status(order_id: str, status: str) -> None:
    doc = _orders_doc()
    for o in doc.get("orders") or []:
        if o.get("id") == order_id:
            o["status"] = status
    state.write_json("orders.json", doc)


def prepare(args, ctx) -> tuple:
    now = market_clock.now_utc()
    order = _pick_order(args.order)
    problem = _risk_problem(order, now)
    if problem:
        raise ValueError(problem)
    existing = _find(_tickets_doc().get("tickets") or [], "id", "tkt-" + order["id"])
    if existing and existing.get("status") == "approved":
        raise ValueError("ticket %s was already approved — approvals are single-use; size a new order" % existing["id"])
    if args.live and ctx.cfg.get("paper", True):
        raise ValueError("live tickets are disabled: trader/config.json has \"paper\": true")
    mode = "live" if args.live else "paper"
    ticket = build_ticket(order, mode)
    ticket["created_at"] = market_clock.iso(now)
    if ticket["status"] == "awaiting_approval":
        ticket["expires_at"] = market_clock.iso(now + timedelta(minutes=TICKET_TTL_MIN))
    _save_ticket(ticket)
    _set_order_status(order["id"], "ticketed")
    lines = ["TICKET %s" % ticket["id"], "", "  " + ticket["text"]]
    lines += ["  " + d for d in ticket["details"]]
    if ticket["status"] == "manual_checklist":
        lines += ["", "Manual execution checklist (nothing is sent anywhere):"]
        lines += ["  [ ] " + c for c in ticket["checklist"]]
    else:
        lines += ["", "hash %s · expires %s" % (ticket["hash"][:16], ticket["expires_at"]),
                  "Reply yes to send this exact ticket to the %s account." % ("PAPER" if mode == "paper" else "LIVE"),
                  "(Nothing has been sent. Approval is recorded with: ticket.py approve --ticket %s --reply \"<your exact words>\")"
                  % ticket["id"]]
    return "\n".join(lines), {"ticket": ticket}, order["asset"]


def _pick_ticket(ticket_id: str = None) -> dict:
    tickets = _tickets_doc().get("tickets") or []
    if ticket_id:
        t = _find(tickets, "id", ticket_id)
        if not t:
            raise ValueError("ticket %r not found in trader/tickets.json" % ticket_id)
        return t
    waiting = [t for t in tickets if t.get("status") == "awaiting_approval"]
    if not waiting:
        raise ValueError("no ticket is awaiting approval — run ticket.py prepare first")
    return waiting[-1]


def is_explicit_yes(reply: str) -> bool:
    return (reply or "").strip().lower().rstrip(".!").strip() == "yes"


def _approval_problem(ticket: dict, order, ctx, now) -> str:
    if ticket.get("status") == "manual_checklist":
        return "meme-coin tickets are a manual checklist — there is nothing to send to a connector"
    if ticket.get("status") != "awaiting_approval":
        return "ticket is %s — approvals are single-use; prepare a new ticket" % ticket.get("status")
    if now > market_clock.parse_iso(ticket["expires_at"]):
        return "ticket expired at %s — prepare it again" % ticket["expires_at"]
    if ticket_hash(ticket["text"], ticket["payload"]) != ticket["hash"]:
        return "ticket contents changed after it was shown — prepare it again"
    if not order:
        return "the order behind this ticket no longer exists"
    risk = order.get("risk") or {}
    if risk.get("result") != "PASS" or order_hash(order) != risk.get("order_hash"):
        return "the order changed or lost its risk PASS since the ticket was shown — re-run risk and prepare again"
    if build_ticket(order, ticket["mode"])["hash"] != ticket["hash"]:
        return "the order no longer matches the ticket that was shown — prepare it again"
    if ticket["mode"] == "live" and ctx.cfg.get("paper", True):
        return "live ticket refused: trader/config.json has \"paper\": true"
    return ""


def approve(args, ctx, decline: bool = False) -> tuple:
    if args.reply is None:
        raise ValueError("pass the user's reply word for word with --reply")
    now = market_clock.now_utc()
    ticket = _pick_ticket(args.ticket)
    order = _find(_orders_doc().get("orders") or [], "id", ticket.get("order_id"))
    problem = "" if decline else _approval_problem(ticket, order, ctx, now)
    yes = is_explicit_yes(args.reply) and not decline
    approved = yes and not problem
    reason = ("declined by the user" if decline else problem if problem else
              "" if yes else "reply was not an explicit yes")
    state.append_jsonl("approvals.jsonl", {
        "ts": market_clock.iso(now), "ticket_id": ticket["id"], "order_id": ticket.get("order_id"),
        "ticket_hash": ticket["hash"], "ticket_text": ticket["text"], "mode": ticket.get("mode"),
        "user_reply": args.reply, "approved": approved, "reason": reason,
        "asset": ticket.get("asset"), "symbol": ticket.get("symbol")})
    if approved:
        ticket["status"] = "approved"
        ticket["approved_at"] = market_clock.iso(now)
        _save_ticket(ticket)
        _set_order_status(ticket["order_id"], "approved")
        payload = ticket["payload"]
        text = "\n".join([
            "APPROVED — hand this payload unchanged to the %s MCP tool %s:" % (payload["connector"], payload["tool"]),
            json.dumps(payload["arguments"], indent=2),
            "Ticket: %s" % ticket["text"],
            "Recorded the reply %r in trader/approvals.jsonl. This approval covers this one ticket only." % args.reply])
        return text, {"approved": True, "ticket": ticket, "payload": payload}, ticket.get("asset")
    if decline:
        if ticket.get("status") in ("awaiting_approval", "manual_checklist"):
            ticket["status"] = "declined"
            _save_ticket(ticket)
            if order:
                _set_order_status(order["id"], "declined")
        text = "DECLINED — ticket %s is closed; nothing was sent. Reply recorded verbatim: %r" % (
            ticket["id"], args.reply)
    elif problem:
        text = "NOT APPROVED — %s. Nothing was sent. Reply recorded verbatim: %r" % (problem, args.reply)
    else:
        text = ("NOT APPROVED — the reply %r is not an explicit \"yes\". Nothing was sent; the ticket is still "
                "waiting. Only a plain \"yes\" for this exact ticket approves it." % args.reply)
    return text, {"approved": False, "reason": reason, "ticket": ticket}, ticket.get("asset")


def list_tickets(args, ctx) -> tuple:
    tickets = _tickets_doc().get("tickets") or []
    lines = ["TICKETS (%d)" % len(tickets)]
    for t in tickets[-20:]:
        lines.append("  %-18s %-40s %s" % (t.get("status"), t.get("id"), t.get("text")))
    if not tickets:
        lines.append("  none yet — /trader-broker prepare turns a risk-passed order into a ticket")
    assets = sorted({t.get("asset") for t in tickets if t.get("asset")})
    return "\n".join(lines), {"tickets": tickets}, assets or None


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    if args.action == "prepare":
        text, payload, asset = prepare(args, ctx)
    elif args.action == "approve":
        text, payload, asset = approve(args, ctx)
    elif args.action == "decline":
        text, payload, asset = approve(args, ctx, decline=True)
    else:
        text, payload, asset = list_tickets(args, ctx)
    cli.emit(args, text, payload, asset)
    return 0


if __name__ == "__main__":
    cli.run(main)
