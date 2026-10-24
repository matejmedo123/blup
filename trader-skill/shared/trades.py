"""One position the bot split is one trade for every judgement.

A stop that filled in part, or the third sold before a runner rides on, leaves two (or more) journal entries for one
position. Counted apart they make a loss look like two losses (a losing streak that isn't one) and a runner look
like a sure win (its sold part is always in profit). ``merge`` puts them back together: the whole position's P&L,
its R over the whole position's risk, closed only once every piece is.
"""
from __future__ import annotations

import copy


def root_of(t: dict) -> str:
    """The id of the trade a piece was split from (its own id when it never was)."""
    sp = t.get("split") or {}
    if sp.get("root"):
        return sp["root"]
    run = t.get("runner") or {}
    if run.get("part") == "ride" and run.get("from"):  # runner pieces recorded before splits were tagged
        return run["from"]
    return t.get("id")


def _f(x, default=0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def merge(trades: list) -> list:
    """The journal's trades with every split position as one trade, in the order its first piece appears."""
    groups, order = {}, []
    for t in trades:
        k = root_of(t)
        if k not in groups:
            groups[k] = []
            order.append(k)
        groups[k].append(t)
    out = []
    for k in order:
        pieces = groups[k]
        if len(pieces) == 1:
            out.append(pieces[0])
            continue
        root = next((p for p in pieces if p.get("id") == k), pieces[0])
        whole = copy.deepcopy(root)
        of_qty = _f((root.get("split") or {}).get("of_qty")) or _f((root.get("runner") or {}).get("of_qty")) or \
            sum(_f(p.get("qty")) for p in pieces)
        whole.update(qty=of_qty, pieces=[p.get("id") for p in pieces])
        whole.pop("runner", None)
        if any(p.get("status") != "closed" for p in pieces):
            whole.update(status="open", exit=None, pnl_usd=None, r_multiple=None, r_net=None)
            out.append(whole)
            continue
        rpu = _f(root.get("risk_per_unit"))
        pnl = sum(_f(p.get("pnl_usd")) for p in pieces)
        exits = [(p.get("exit") or {}) for p in pieces]
        sold = sum(_f(p.get("qty")) for p in pieces) or of_qty
        price = sum(_f(p.get("qty")) * _f(e.get("price")) for p, e in zip(pieces, exits)) / sold if sold else None
        last = max(exits, key=lambda e: e.get("time") or "")
        risk = of_qty * rpu
        whole.update(status="closed", exit=dict(last, price=price), pnl_usd=round(pnl, 2),
                     fees_usd=round(sum(_f(p.get("fees_usd")) for p in pieces), 2),
                     slippage_usd=round(sum(_f(p.get("slippage_usd")) for p in pieces), 2),
                     r_multiple=round(sum(_f(p.get("qty")) * _f(p.get("r_multiple")) for p in pieces) / sold, 3)
                     if sold else None,
                     r_net=round(pnl / risk, 3) if risk > 0 else None)
        out.append(whole)
    return out
