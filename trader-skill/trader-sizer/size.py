#!/usr/bin/env python3
"""Position Sizer — turn an exit plan into an order proposal sized by risk.

Size = (account × risk %) ÷ (entry − stop), then capped by the limits in
trader/limits.json. Leverage (only when limits.json allows it) lifts the
position cap, never the risk: the stop still decides how much is at stake. Stocks round to whole shares (fractional if enabled),
crypto to the exchange's lot step, meme coins become a USD amount capped by
pool liquidity so the trade cannot move the price too much.

Examples:
  python3 size.py                                  # latest plan in trader/plan.json
  python3 size.py --id TSLA-20261020-orb15
  python3 size.py --id BTCUSD-20261020-asia_range --risk-pct 0.25
  python3 size.py --account 10000 --size-usd 300   # meme: force a smaller USD amount
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

from shared import cli, config, data, fmt, market_clock, state, symbols, trade_sim  # noqa: E402


def build_parser():
    p = cli.parser("size.py", __doc__)
    p.add_argument("--id", dest="plan_id", help="plan id from trader/plan.json (default: the latest plan)")
    p.add_argument("--account", type=float, help="account size in USD (default: config account_size)")
    p.add_argument("--risk-pct", type=float, help="risk per trade in %% of account (default: config risk_per_trade_pct)")
    p.add_argument("--size-usd", type=float, help="meme coins: use this USD amount if it is below every cap")
    return p


# --- helpers shared with risk/broker/journal (kept local so each skill stands alone) ---------------

def symbol_of(obj: dict) -> symbols.Symbol:
    """Symbol for a plan/order dict; meme coins prefer the explicit chain + address."""
    if obj.get("asset") == "meme" and obj.get("chain") and obj.get("address"):
        return symbols.meme_symbol(obj["chain"], obj["address"], obj.get("name", ""))
    return data.as_symbol(obj["symbol"], obj.get("asset"))


def load_plan(plan_id: str = None) -> dict:
    doc = state.read_json("plan.json", {}) or {}
    plans = doc.get("plans") or {}
    pid = plan_id or doc.get("latest")
    if not plans:
        raise ValueError("no plans in trader/plan.json — run /trader-exit first")
    if not pid or pid not in plans:
        raise ValueError("plan %r not found in trader/plan.json (have: %s)" % (pid, ", ".join(sorted(plans))))
    return plans[pid]


def _decimals(step: float) -> int:
    s = ("%.12f" % float(step or 0)).rstrip("0")
    return len(s.split(".", 1)[1]) if "." in s else 0


MIN_STOP_FRACTION = 0.001  # 0.1 % — tighter than that is noise, not a stop


def floor_to(x: float, step: float):
    if not step:
        return x
    n = math.floor(x / step + 1e-9)
    dp = _decimals(step)
    return int(round(n * step)) if dp == 0 else round(n * step, dp)


def ceil_to(x: float, step: float) -> float:
    if not step:
        return x
    n = math.ceil(x / step - 1e-9)
    return round(n * step, _decimals(step))


def rugcheck_info(sym: symbols.Symbol):
    if sym.asset != "meme" or not sym.address:
        return None
    name = "rugcheck/%s-%s.json" % (sym.chain, sym.address)
    rc = state.read_json(name)
    if not rc:
        return None
    return {"verdict": rc.get("verdict"), "score": rc.get("score"), "checked_at": rc.get("checked_at"),
            "file": name, "reasons": rc.get("reasons") or []}


# --- sizing --------------------------------------------------------------------------------------

def size_order(plan: dict, cfg: dict, limits: dict, account: float = None, risk_pct: float = None,
               size_usd: float = None, leverage: float = None) -> dict:
    sym = symbol_of(plan)
    asset = plan.get("asset") or sym.asset
    lim = limits.get(asset) or {}
    entry = float(plan["entry"]["price"])
    stop = float(plan["stop"]["price"])
    target = float((plan.get("target") or {}).get("price") or 0) or None
    if not (math.isfinite(entry) and math.isfinite(stop)) or entry <= 0 or stop < 0:
        raise ValueError("entry %s / stop %s are not usable prices — skipped" % (entry, stop))
    rpu = entry - stop
    if rpu <= 0:
        raise ValueError("stop %s is not below entry %s — this pack only sizes long trades" % (stop, entry))
    if rpu < entry * MIN_STOP_FRACTION:  # a stop a tick away "risks" nothing on paper and slips straight through
        raise ValueError("the stop is only %.3f%% below the entry — under %.1f%%, slippage alone is a full loss"
                         % (100.0 * rpu / entry, 100.0 * MIN_STOP_FRACTION))
    account = float(account if account is not None else (cfg.get("account_size") or 0))
    if account <= 0:
        raise ValueError("account size must be positive (set account_size in trader/config.json)")
    risk_pct = float(risk_pct if risk_pct is not None else cfg.get("risk_per_trade_pct", 0.5))
    caps = []
    budget_cfg = account * risk_pct / 100.0
    budget = budget_cfg
    max_risk = lim.get("max_risk_per_trade_usd")
    if max_risk is not None and budget > float(max_risk):
        budget = float(max_risk)
        caps.append("max_risk_per_trade_usd %s → risk budget %s" % (fmt.money(max_risk), fmt.money(budget)))
    max_risk_pct = lim.get("max_risk_per_trade_pct")
    if max_risk_pct is not None and budget > account * float(max_risk_pct) / 100.0 + 1e-9:
        budget = account * float(max_risk_pct) / 100.0
        caps.append("max_risk_per_trade_pct %s%% → risk budget %s" % (_num(max_risk_pct), fmt.money(budget)))
    if asset == "meme":
        lev = 1.0
    else:
        lev = float(leverage) if leverage is not None else config.leverage(cfg, limits, asset)[0]
        lev = max(1.0, min(lev, config.LEVERAGE_HARD_CAP))
    max_notional = account * float(lim.get("max_position_pct", 100)) / 100.0 * lev
    order = {
        "id": "ord-%s-%s" % (sym.key, market_clock.now_utc().strftime("%Y%m%d-%H%M%S")),
        "plan_id": plan.get("id"),
        "symbol": plan.get("symbol") or sym.raw,
        "symbol_key": sym.key,
        "display": plan.get("symbol_display") or sym.display,
        "asset": asset,
        "setup": plan.get("setup"),
        "side": "buy",
        "direction": "long",
        "entry_price": entry,
        "stop_price": stop,
        "target_price": target,
        "liquidity_usd": None,
        "est_slippage_pct": None,
        "pool_pct": None,
        "status": "proposed",
        "risk": None,
        "paper": bool(cfg.get("paper", True)),
        "leverage": lev,
        "created_at": market_clock.iso(market_clock.now_utc()),
    }
    sizing = {"account_size": account, "risk_pct": risk_pct, "risk_budget_usd": round(budget, 2),
              "caps": caps, "leverage": lev}

    if asset == "meme":
        pair = data.get_pair(sym)
        liq = float(pair.get("liquidity_usd") or 0)
        stop_frac = rpu / entry
        risk_amount = budget / stop_frac
        sizing["raw_usd"] = round(risk_amount, 2)
        pool_cap = liq * float(lim.get("max_pct_of_pool", 1.0)) / 100.0
        slip_cap = trade_sim.max_size_for_slippage(liq, float(lim.get("max_slippage_pct", 3.0)))
        candidates = [
            (risk_amount, "risk budget %s at a %s stop" % (fmt.money(budget), fmt.pct(stop_frac * 100))),
            (max_notional, "max_position_pct %s%% of account" % _num(lim.get("max_position_pct"))),
            (pool_cap, "max_pct_of_pool %s%% of %s liquidity" % (_num(lim.get("max_pct_of_pool", 1.0)),
                                                                 fmt.compact_usd(liq))),
            (slip_cap, "max_slippage_pct %s%% (pool impact)" % _num(lim.get("max_slippage_pct", 3.0))),
        ]
        if size_usd:
            candidates.append((float(size_usd), "--size-usd %s" % fmt.money(size_usd)))
        amount, why = min(candidates, key=lambda c: c[0])
        amount = math.floor(amount * 100) / 100.0
        if amount < 1:
            raise ValueError("position rounds to under $1 (liquidity %s) — too small to trade" % fmt.compact_usd(liq))
        if why != candidates[0][1]:
            caps.append("%s → %s" % (why, fmt.money(amount)))
        order.update(qty=amount, qty_unit="usd", notional_usd=amount, limit_price=None,
                     risk_usd=round(amount * stop_frac, 2), liquidity_usd=liq,
                     est_slippage_pct=round(trade_sim.estimate_slippage_pct(amount, liq) or 0, 4),
                     pool_pct=round(100.0 * amount / liq, 4) if liq else None,
                     chain=sym.chain, address=sym.address, name=pair.get("base", {}).get("symbol") or sym.name,
                     pair_address=pair.get("pair_address"), dex=pair.get("dex"), pair_url=pair.get("url"),
                     price_usd=pair.get("price_usd"), rugcheck=rugcheck_info(sym),
                     max_slippage_pct=float(lim.get("max_slippage_pct", 3.0)))
        sizing["rounding"] = "USD amount, rounded down to the cent"
    else:
        lot = data.lot_info(sym)
        step = lot.get("step") or (1.0 if asset == "stock" else 0.000001)
        # a daily signal's entry may pay up to entry_slack_pct above the close (the strongest moves leave at once —
        # an order at the close would miss exactly them); the risk is sized at that worst price, never above budget
        slack = max(0.0, float(plan.get("entry_slack_pct") or 0)) / 100.0
        worst = entry * (1 + slack)
        if slack:
            rpu = worst - stop
            sizing["entry_slack_pct"] = round(100 * slack, 3)
        raw = budget / rpu
        sizing["raw_qty"] = round(raw, 8)
        qty = raw
        capped_by_position = qty * worst > max_notional
        if capped_by_position:
            qty = max_notional / worst
        qty = floor_to(qty, step)
        unit = "shares" if asset == "stock" else "coins"
        if capped_by_position:
            caps.append("max_position_pct %s%%%s → %s %s" % (_num(lim.get("max_position_pct")),
                                                           " × %g leverage" % lev if lev > 1 else "", fmt.qty(qty), unit))
        if qty <= 0 or (lot.get("min_qty") and qty < float(lot["min_qty"]) - 1e-12):
            raise ValueError("position rounds to %s %s — below the minimum (%s); widen the risk budget or skip"
                             % (fmt.qty(qty), unit, fmt.qty(lot.get("min_qty") or step)))
        if lot.get("min_notional") and qty * entry < float(lot["min_notional"]):
            raise ValueError("order value %s is below the exchange minimum %s" % (
                fmt.money(qty * entry), fmt.money(lot["min_notional"])))
        if asset == "stock":
            tick = 0.01 if entry >= 1 else 0.0001
            limit = round(math.floor(worst / tick + 1e-9) * tick if slack else
                          entry + max(tick, entry * 0.00005) + 1e-9, 2 if tick == 0.01 else 4)
            sizing["rounding"] = "fractional shares (4 dp)" if step < 1 else "whole shares"
        else:
            tick = lot.get("tick") or 0.01
            if tick > entry * 0.01:  # a cent tick on a $0.0004 coin would put the limit 25× above the price
                tick = 10.0 ** (math.floor(math.log10(entry)) - 4)
            limit = math.floor(worst / tick + 1e-9) * tick if slack else ceil_to(entry * 1.0002, tick)
            sizing["rounding"] = "lot step %s, tick %s (%s)" % (fmt.qty(step), fmt.qty(tick), lot.get("source"))
        order.update(qty=qty, qty_unit=unit, notional_usd=round(qty * worst, 2), limit_price=limit,
                     risk_usd=round(qty * rpu, 2), lot=lot)
    order["risk_pct"] = round(100.0 * order["risk_usd"] / account, 3)
    order["position_pct"] = round(100.0 * order["notional_usd"] / account, 3)
    order["sizing"] = sizing
    return order


def _num(x) -> str:
    x = float(x or 0)
    return ("%d" % x) if x == int(x) else ("%g" % x)


def save_order(order: dict) -> None:
    def add(doc):
        orders = [o for o in (doc or {}).get("orders") or []
                  if not (o.get("plan_id") == order.get("plan_id") and o.get("status") == "proposed")]
        return {"orders": orders + [order]}
    state.update_json("orders.json", add, {})


def describe(order: dict) -> str:
    caps = order["sizing"]["caps"]
    if order["asset"] == "meme":
        head = "BUY %s of %s ≈ %s at %s" % (fmt.money(order["qty"]), order.get("name") or order["display"],
                                            fmt.qty(order["qty"] / order["entry_price"], "tokens"),
                                            fmt.price(order["entry_price"]))
        extra = " · est. slippage %s · %s of pool" % (fmt.pct(order["est_slippage_pct"], 2),
                                                      fmt.pct(order["pool_pct"], 2))
    else:
        sym = order["display"] if order["asset"] == "crypto" else order["symbol"]
        head = "BUY %s %s ≈ %s" % (fmt.qty(order["qty"]), sym, fmt.money(order["notional_usd"], decimals=0))
        extra = " · limit %s" % fmt.price(order["limit_price"])
    line = "%s · risk %s (%s of account)%s" % (head, fmt.money(order["risk_usd"]), fmt.pct(order["risk_pct"], 2),
                                               extra)
    if caps:
        line += " · capped by " + "; ".join(_cap_label(c.split(" → ")[0]) for c in caps)
    return line


_CAP_LABELS = (("max_position_pct", "max position"), ("max_risk_per_trade_usd", "max risk per trade"),
               ("max_pct_of_pool", "max share of pool"), ("max_slippage_pct", "max slippage"))


def _cap_label(text: str) -> str:
    for key, label in _CAP_LABELS:
        text = text.replace(key, label)
    return text.split(" at a ")[0]


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    plan = load_plan(args.plan_id)
    order = size_order(plan, ctx.cfg, ctx.limits, args.account, args.risk_pct, args.size_usd)
    save_order(order)
    lines = ["POSITION SIZE — %s (%s)" % (order["display"], plan.get("id")),
             describe(order),
             "Entry %s · stop %s · target %s · risk per unit %s" % (
                 fmt.price(order["entry_price"]), fmt.price(order["stop_price"]), fmt.price(order["target_price"]),
                 fmt.price(order["entry_price"] - order["stop_price"])),
             "Sizing: %s × %s%% = %s risk budget → raw %s" % (
                 fmt.money(order["sizing"]["account_size"], decimals=0), _num(order["sizing"]["risk_pct"]),
                 fmt.money(order["sizing"]["risk_budget_usd"]),
                 fmt.money(order["sizing"]["raw_usd"]) if order["asset"] == "meme"
                 else fmt.qty(order["sizing"]["raw_qty"], order["qty_unit"]))]
    for c in order["sizing"]["caps"]:
        lines.append("  cap: " + c)
    if order["asset"] == "meme" and not order.get("rugcheck"):
        lines.append("  ! no rugcheck on file — /trader-risk will BLOCK this until /trader-rugcheck passes")
    lines.append("Saved %s as PROPOSED in trader/orders.json (%s). Next: /trader-risk." % (
        order["id"], "PAPER" if order["paper"] else "LIVE account configured"))
    cli.emit(args, "\n".join(lines), {"order": order}, order["asset"])
    return 0


if __name__ == "__main__":
    cli.run(main)
