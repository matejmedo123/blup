#!/usr/bin/env python3
"""Price Alerts — rings once when a level, stop, target, % move or the opening bell is hit.

Built to run on a schedule (/loop or a scheduled task): `check` evaluates every
active alert once and rings each at most once. Stock alerts are only checked
while the NYSE regular session is open; crypto and meme-coin alerts run 24/7.

Examples:
  python3 alerts.py add TSLA --above 365
  python3 alerts.py add BTCUSDT --cross 67700
  python3 alerts.py add TSLA --pct-move 5
  python3 alerts.py add --opening-bell
  python3 alerts.py add --from-plan                 # stop + target (+ liquidity exit) of the latest plan
  python3 alerts.py add SOL:<mint> --liquidity-drop 30
  python3 alerts.py add SOL:<mint> --dev-selling 25 --note "creator wallet"
  python3 alerts.py list
  python3 alerts.py check
  python3 alerts.py rearm al-0002
  python3 alerts.py remove al-0003
"""
from __future__ import annotations

import os
import re
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, market_clock, skills, state, symbols  # noqa: E402

FILE = "alerts.json"
LOG = "alerts_log.jsonl"
COMMANDS = ("add", "list", "check", "remove", "rearm")
PRICE_TYPES = ("above", "below", "cross", "stop", "target", "pct_move")
MEME_TYPES = ("liquidity_drop", "dev_selling", "holder_jump")
_MEME_KEY = re.compile(r"^(solana|base|ethereum|bsc)-(.+?)-\d{8}-")


def build_parser():
    p = cli.parser("alerts.py", __doc__)
    p.add_argument("command", choices=COMMANDS, help="add | list | check | remove | rearm")
    p.add_argument("target", nargs="?", help="symbol for `add`, alert id for `remove` / `rearm`")
    kind = p.add_argument_group("alert type for `add` (pick one)")
    kind.add_argument("--above", type=float, metavar="PRICE", help="ring when the price is at or above PRICE")
    kind.add_argument("--below", type=float, metavar="PRICE", help="ring when the price is at or below PRICE")
    kind.add_argument("--cross", type=float, metavar="PRICE", help="ring when the price crosses PRICE either way")
    kind.add_argument("--pct-move", type=float, metavar="PCT",
                      help="ring on a ±PCT%% move (stocks: vs previous close; crypto/meme: vs 24 h ago)")
    kind.add_argument("--opening-bell", action="store_true", help="ring once per trading day at the NYSE open")
    kind.add_argument("--liquidity-drop", type=float, metavar="PCT", help="meme: ring if pool liquidity falls PCT%%")
    kind.add_argument("--dev-selling", type=float, metavar="PCT",
                      help="meme: ring if the creator wallet's share falls by PCT%% (relative)")
    kind.add_argument("--holder-jump", type=float, metavar="PTS",
                      help="meme: ring if the top-10 holder share rises by PTS percentage points")
    kind.add_argument("--from-plan", nargs="?", const="latest", metavar="PLAN_ID",
                      help="stop + target alerts from trader/plan.json (meme: + liquidity exit)")
    p.add_argument("--note", default="", help="free text shown when the alert rings")
    p.add_argument("--anytime", action="store_true", help="check stock alerts even when the market is closed")
    return p


# --- state ---------------------------------------------------------------------------------

def load() -> dict:
    doc = state.read_json(FILE) or {}
    doc.setdefault("alerts", [])
    doc.setdefault("next_id", len(doc["alerts"]) + 1)
    return doc


def save(doc: dict) -> None:
    state.write_json(FILE, doc)


def _new_id(doc: dict) -> str:
    n = int(doc.get("next_id") or 1)
    doc["next_id"] = n + 1
    return "al-%04d" % n


def _find(doc: dict, alert_id: str) -> dict:
    for a in doc["alerts"]:
        if a["id"] == alert_id:
            return a
    raise ValueError("no alert %r (see `alerts.py list`)" % alert_id)


# --- symbols & observations ---------------------------------------------------------------------

def resolve(raw: str, asset: str = None) -> symbols.Symbol:
    sym = data.as_symbol(raw, asset)
    if sym.asset == "meme" and not (sym.chain and sym.address and sym.name):
        sym = data.resolve_meme(sym)[0]  # fills chain and the token's ticker for readable alerts
    return sym


def _store_symbol(sym: symbols.Symbol) -> str:
    return "%s:%s" % (sym.chain, sym.address) if sym.asset == "meme" else (sym.raw or sym.display)


def _price_fmt(x) -> str:
    return fmt.price(x)


def _safety_metrics(sym: symbols.Symbol):
    """Creator share and top-10 concentration — fresh from /trader-rugcheck if installed, else its last file."""
    try:
        rc = skills.load("trader-rugcheck", "rugcheck")
        res = rc.check(sym)
        if isinstance(res, dict) and res.get("metrics"):
            return res["metrics"]
    except Exception:  # rugcheck is optional here; fall back to what is on disk
        pass
    saved = state.read_json("rugcheck/%s-%s.json" % (sym.chain, sym.address)) or {}
    return saved.get("metrics")


def observe(sym: symbols.Symbol, needs_safety: bool = False) -> dict:
    """One snapshot per symbol per check: price, % change, liquidity (meme), safety metrics (meme)."""
    if sym.asset == "meme":
        p = data.get_pair(sym)
        obs = {"price": p.get("price_usd"), "change_pct": (p.get("price_change") or {}).get("h24"),
               "liquidity_usd": p.get("liquidity_usd"), "name": (p.get("base") or {}).get("symbol") or sym.short}
        if needs_safety:
            obs["safety"] = _safety_metrics(sym)
        return obs
    q = data.get_quote(sym)
    return {"price": q.get("price"), "change_pct": q.get("change_pct"), "prev_close": q.get("prev_close"),
            "name": sym.display}


# --- add ----------------------------------------------------------------------------------------

def _alert(doc, sym, kind, level=None, pct=None, baseline=None, plan_id=None, note="", now_iso=None):
    return {"id": _new_id(doc), "symbol": _store_symbol(sym) if sym else "NYSE",
            "display": sym.display if sym else "NYSE opening bell", "key": sym.key if sym else "NYSE",
            "asset": sym.asset if sym else "stock", "type": kind, "level": level, "pct": pct,
            "baseline": baseline or {}, "plan_id": plan_id, "status": "active", "created_at": now_iso,
            "fired_at": None, "fired_value": None, "message": None, "last_value": None, "last_checked": None,
            "note": note or "", "recurring": kind == "opening_bell", "last_rung": None}


def _plan_symbol(plan: dict) -> symbols.Symbol:
    sym = _plan_symbol_raw(plan)
    if sym.asset == "meme" and not sym.name:
        # the exit planner already resolved the token's ticker ("PUPKIN (solana)") — reuse it for display
        shown = (plan.get("symbol_display") or "").rsplit(" (", 1)[0].strip()
        if shown and "…" not in shown:
            sym.name = shown
    return sym


def _plan_symbol_raw(plan: dict) -> symbols.Symbol:
    if plan.get("asset") == "meme":
        if plan.get("chain") and plan.get("address"):
            return symbols.meme_symbol(plan["chain"], plan["address"], plan.get("name") or "")
        for cand in (plan.get("symbol_raw"), plan.get("symbol")):
            try:
                s = symbols.parse(cand, asset="meme")
            except (symbols.SymbolError, TypeError):
                continue
            if s.address:
                return resolve(cand, "meme") if not s.chain else s
        m = _MEME_KEY.match(plan.get("id") or "")
        if m:
            return symbols.meme_symbol(m.group(1), m.group(2))
        raise ValueError("plan %s has no token address" % plan.get("id"))
    return data.as_symbol(plan.get("symbol_raw") or plan["symbol"], plan.get("asset"))


def add_from_plan(doc, plan_ref: str, note: str, now_iso: str) -> list:
    plans = state.read_json("plan.json") or {}
    pid = plans.get("latest") if plan_ref == "latest" else plan_ref
    plan = (plans.get("plans") or {}).get(pid)
    if not plan:
        raise ValueError("no plan %r in trader/plan.json — run /trader-exit first" % plan_ref)
    sym = _plan_symbol(plan)
    stop = (plan.get("stop") or {}).get("price")
    target = (plan.get("target") or {}).get("price")
    out = []
    if stop:
        out.append(_alert(doc, sym, "stop", float(stop), plan_id=pid, note=note or "stop from plan", now_iso=now_iso))
    if target:
        out.append(_alert(doc, sym, "target", float(target), plan_id=pid, note=note or "target from plan",
                          now_iso=now_iso))
    liq = plan.get("liquidity_exit") or {}
    if sym.asset == "meme" and liq.get("drop_pct"):
        out.append(_alert(doc, sym, "liquidity_drop", pct=float(liq["drop_pct"]), plan_id=pid,
                          baseline={"liquidity_usd": liq.get("liquidity_at_entry_usd")},
                          note=note or "liquidity exit from plan", now_iso=now_iso))
    if not out:
        raise ValueError("plan %s has no stop or target to alert on" % pid)
    return out


def add(doc, args, now_iso: str) -> list:
    if args.from_plan:
        return add_from_plan(doc, args.from_plan, args.note, now_iso)
    chosen = [k for k in ("above", "below", "cross", "pct_move", "liquidity_drop", "dev_selling", "holder_jump")
              if getattr(args, k) is not None] + (["opening_bell"] if args.opening_bell else [])
    if len(chosen) != 1:
        raise ValueError("`add` needs exactly one alert type: --above / --below / --cross / --pct-move / "
                         "--opening-bell / --liquidity-drop / --dev-selling / --holder-jump / --from-plan")
    kind = chosen[0]
    if kind == "opening_bell":
        return [_alert(doc, None, "opening_bell", note=args.note, now_iso=now_iso)]
    if not args.target:
        raise ValueError("`add` needs a symbol, e.g. `alerts.py add TSLA --above 365`")
    sym = resolve(args.target, args.asset)
    value = getattr(args, kind)
    if kind in MEME_TYPES and sym.asset != "meme":
        raise ValueError("--%s is for meme coins (got %s, a %s)" % (kind.replace("_", "-"), sym.display, sym.asset))
    if kind in ("pct_move", "liquidity_drop", "dev_selling", "holder_jump") and value <= 0:
        raise ValueError("--%s must be a positive number" % kind.replace("_", "-"))
    if kind in ("above", "below", "cross") and value <= 0:
        raise ValueError("price level must be positive")
    alert = _alert(doc, sym, kind, level=value if kind in ("above", "below", "cross") else None,
                   pct=value if kind not in ("above", "below", "cross") else None, note=args.note, now_iso=now_iso)
    try:
        obs = observe(sym, needs_safety=kind in ("dev_selling", "holder_jump"))
    except data.DataUnavailable as exc:
        obs = {}
        alert["note"] = (alert["note"] + " " if alert["note"] else "") + "(no data at creation: %s)" % exc
    if obs.get("price") is not None:
        alert["last_value"] = obs["price"]
    if kind == "liquidity_drop":
        alert["baseline"] = {"liquidity_usd": obs.get("liquidity_usd")}
    elif kind in ("dev_selling", "holder_jump"):
        field = "creator_pct" if kind == "dev_selling" else "top10_pct"
        metrics = obs.get("safety") or {}
        alert["baseline"] = {field: metrics.get(field)}
        if metrics.get(field) is None:
            alert["baseline"]["why"] = ("no %s available yet (run /trader-rugcheck) — the first successful check "
                                        "will set the baseline" % field.replace("_", " "))
        elif kind == "dev_selling" and not metrics.get(field):
            alert["baseline"]["why"] = "the creator wallet holds 0% — nothing left to sell; this alert cannot ring"
    return [alert]


# --- check ----------------------------------------------------------------------------------------

def _ring(alert, value, message, now_iso):
    alert["message"] = message
    alert["fired_value"] = value
    alert["fired_at"] = now_iso
    if not alert.get("recurring"):
        alert["status"] = "fired"
    state.append_jsonl(LOG, {"ts": now_iso, "id": alert["id"], "symbol": alert["display"], "type": alert["type"],
                             "value": value, "message": message, "note": alert.get("note") or ""})
    return message


def evaluate(alert: dict, obs: dict, now_iso: str):
    """→ message if the alert rings now, else None. Updates last_value."""
    kind = alert["type"]
    name = alert["display"] if alert["asset"] != "meme" else (obs.get("name") or alert["display"])
    price = obs.get("price")
    prev = alert.get("last_value")
    msg = None
    if kind in ("above", "target") and price is not None and price >= alert["level"]:
        verb = "reached the target" if kind == "target" else (
            "crossed above" if prev is not None and prev < alert["level"] else "is above")
        msg = "ALERT %s %s %s (now %s)" % (name, verb, _price_fmt(alert["level"]), _price_fmt(price))
    elif kind in ("below", "stop") and price is not None and price <= alert["level"]:
        verb = "hit the stop" if kind == "stop" else (
            "crossed below" if prev is not None and prev > alert["level"] else "is below")
        msg = "ALERT %s %s %s (now %s)" % (name, verb, _price_fmt(alert["level"]), _price_fmt(price))
        if kind == "stop":
            msg += " — the plan says exit"
    elif kind == "cross" and price is not None and prev is not None:
        lvl = alert["level"]
        if prev < lvl <= price or prev > lvl >= price:
            msg = "ALERT %s crossed %s %s (now %s)" % (name, "above" if price >= lvl else "below", _price_fmt(lvl),
                                                     _price_fmt(price))
    elif kind == "pct_move" and obs.get("change_pct") is not None:
        ch = float(obs["change_pct"])
        if abs(ch) >= alert["pct"]:
            ref = "the previous close" if alert["asset"] == "stock" else "24 h ago"
            msg = "ALERT %s moved %s vs %s (now %s)" % (name, fmt.pct(ch, 1, True), ref, _price_fmt(price))
    elif kind == "liquidity_drop":
        base = (alert.get("baseline") or {}).get("liquidity_usd")
        liq = obs.get("liquidity_usd")
        if base and liq is not None and liq <= base * (1 - alert["pct"] / 100.0):
            msg = "ALERT %s pool liquidity fell %s (%s → %s) — liquidity exit" % (
                name, fmt.pct((1 - liq / base) * 100, 0), fmt.compact_usd(base), fmt.compact_usd(liq))
        elif not base and liq is not None:
            alert["baseline"] = {"liquidity_usd": liq}
    elif kind in ("dev_selling", "holder_jump"):
        field = "creator_pct" if kind == "dev_selling" else "top10_pct"
        cur = (obs.get("safety") or {}).get(field)
        base = (alert.get("baseline") or {}).get(field)
        if base is None and cur is not None:
            alert["baseline"] = {field: cur}
        elif base is not None and cur is not None:
            if kind == "dev_selling" and base > 0 and (base - cur) / base * 100 >= alert["pct"]:
                msg = "ALERT %s dev wallet share fell from %.1f%% to %.1f%% (%s) — the creator is selling" % (
                    name, base, cur, fmt.pct(-(base - cur) / base * 100, 0, True))
            elif kind == "holder_jump" and cur - base >= alert["pct"]:
                msg = "ALERT %s top-10 holders now %.1f%% (+%.1f pts since the alert was set)" % (name, cur, cur - base)
        alert["last_value"] = cur
    if kind in PRICE_TYPES and price is not None:
        alert["last_value"] = price
    elif kind == "liquidity_drop":
        alert["last_value"] = obs.get("liquidity_usd")
    alert["last_checked"] = now_iso
    if msg and alert.get("note"):
        msg += " · " + alert["note"]
    return msg


def check(doc, args, now_iso: str) -> dict:
    status = market_clock.market_status(market_clock.parse_iso(now_iso))
    fired, skipped, errors = [], [], []
    cache = {}
    for alert in doc["alerts"]:
        if alert["status"] != "active":
            continue
        if alert["type"] == "opening_bell":
            if status["state"] == "open" and alert.get("last_rung") != status["session_date"]:
                alert["last_rung"] = status["session_date"]
                closes = market_clock.fmt_et_ampm(status["closes_at"])
                msg = "ALERT NYSE opening bell — regular session open until %s ET%s" % (
                    closes, " (early close)" if status["early_close"] else "")
                fired.append(_ring(alert, None, msg + (" · " + alert["note"] if alert.get("note") else ""), now_iso))
            alert["last_checked"] = now_iso
            continue
        if alert["asset"] == "stock" and status["state"] != "open" and not args.anytime:
            skipped.append(alert["id"])
            continue
        needs_safety = alert["type"] in ("dev_selling", "holder_jump")
        ck = (alert["symbol"], alert["asset"], needs_safety)
        if ck not in cache:
            try:
                cache[ck] = observe(resolve(alert["symbol"], alert["asset"]), needs_safety)
            except (data.DataUnavailable, symbols.SymbolError, ValueError) as exc:
                cache[ck] = {"error": str(exc)}
        obs = cache[ck]
        if obs.get("error"):
            errors.append("%s %s: %s" % (alert["id"], alert["display"], obs["error"]))
            continue
        msg = evaluate(alert, obs, now_iso)
        if msg:
            fired.append(_ring(alert, obs.get("price") if alert["type"] in PRICE_TYPES else alert.get("last_value"),
                               msg, now_iso))
    return {"fired": fired, "skipped": skipped, "errors": errors, "market": status}


# --- text ---------------------------------------------------------------------------------------------

def describe(a: dict) -> str:
    kind = a["type"]
    if kind in ("above", "below", "cross", "stop", "target"):
        what = "%s %s" % (kind, _price_fmt(a["level"]))
    elif kind == "pct_move":
        what = "move ±%g%%" % a["pct"]
    elif kind == "liquidity_drop":
        base = (a.get("baseline") or {}).get("liquidity_usd")
        what = "liquidity −%g%% (from %s)" % (a["pct"], fmt.compact_usd(base) if base else "first check")
    elif kind == "dev_selling":
        base = (a.get("baseline") or {}).get("creator_pct")
        what = "dev selling −%g%% (creator %s)" % (a["pct"], "%.1f%%" % base if base is not None else "unknown")
    elif kind == "holder_jump":
        base = (a.get("baseline") or {}).get("top10_pct")
        what = "top-10 +%g pts (now %s)" % (a["pct"], "%.1f%%" % base if base is not None else "unknown")
    else:
        what = "opening bell (daily)"
    return what


def list_text(doc) -> str:
    if not doc["alerts"]:
        return "No alerts. Add one: alerts.py add TSLA --above 365"
    lines = ["%-8s %-22s %-34s %-7s %s" % ("ID", "SYMBOL", "ALERT", "STATUS", "LAST")]
    for a in doc["alerts"]:
        last = a.get("last_value")
        last_s = "" if last is None else (_price_fmt(last) if a["type"] in PRICE_TYPES else
                                          fmt.compact_usd(last) if a["type"] == "liquidity_drop" else "%.1f%%" % last)
        if a["type"] == "opening_bell":
            last_s = "rang %s" % a["last_rung"] if a.get("last_rung") else ""
        lines.append("%-8s %-22s %-34s %-7s %s" % (a["id"], a["display"][:22], describe(a)[:34], a["status"], last_s))
    return "\n".join(lines)


def _assets(doc) -> list:
    return sorted({a["asset"] for a in doc["alerts"]}) or [None]


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    now_iso = market_clock.iso(ctx.now)
    doc = load()
    if args.command == "add":
        new = add(doc, args, now_iso)
        doc["alerts"].extend(new)
        save(doc)
        lines = ["Added %s: %s · %s" % (a["id"], a["display"], describe(a)) for a in new]
        for a in new:
            why = (a.get("baseline") or {}).get("why")
            if why:
                lines.append("  note: " + why)
            if a["asset"] == "stock" and a["type"] != "opening_bell":
                lines.append("  stock alerts are checked only while the NYSE session is open (use --anytime to override)")
                break
        lines.append("Run `alerts.py check` on a schedule, e.g. /loop 5m — each alert rings once.")
        cli.emit(args, "\n".join(lines), {"command": "add", "added": new}, [a["asset"] for a in new])
        return 0
    if args.command == "list":
        cli.emit(args, list_text(doc), {"command": "list", "alerts": doc["alerts"]}, _assets(doc))
        return 0
    if args.command in ("remove", "rearm"):
        if not args.target:
            raise ValueError("`%s` needs an alert id, e.g. `alerts.py %s al-0001`" % (args.command, args.command))
        a = _find(doc, args.target)
        if args.command == "remove":
            doc["alerts"] = [x for x in doc["alerts"] if x["id"] != a["id"]]
            text = "Removed %s (%s · %s)" % (a["id"], a["display"], describe(a))
        else:
            a.update(status="active", fired_at=None, fired_value=None, message=None)
            if a["type"] == "cross":
                a["last_value"] = None
            text = "Re-armed %s (%s · %s)" % (a["id"], a["display"], describe(a))
        save(doc)
        cli.emit(args, text, {"command": args.command, "alert": a}, a["asset"])
        return 0
    result = check(doc, args, now_iso)
    save(doc)
    active = sum(1 for a in doc["alerts"] if a["status"] == "active")
    lines = list(result["fired"])
    if not lines:
        lines.append("No alerts rang (%d active, checked %s)." % (active, market_clock.fmt_utc(now_iso)))
    if result["skipped"]:
        nxt = result["market"].get("next_open")
        lines.append("Skipped %d stock alert%s — the NYSE is %s%s." % (
            len(result["skipped"]), "" if len(result["skipped"]) == 1 else "s", result["market"]["state"],
            (", next open %s ET" % market_clock.fmt_et(nxt, with_date=True)) if nxt else ""))
    for e in result["errors"]:
        lines.append("  data problem: " + e)
    payload = {"command": "check", "checked_at": now_iso, "fired": result["fired"], "skipped": result["skipped"],
               "errors": result["errors"], "market": result["market"], "active": active}
    cli.emit(args, "\n".join(lines), payload, _assets(doc))
    return 0


if __name__ == "__main__":
    cli.run(main)
