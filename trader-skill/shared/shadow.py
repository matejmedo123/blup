"""Backtest vs reality: did the bot do what its rules say it should have done?

For the last ``days`` days the daily rules are recomputed from prices for every coin and ETF the lab validated, and
each signal is matched with what the bot recorded under the same id (``autopilot/decisions.jsonl``,
``autopilot/book.json``):

* **taken** — an order went in; for a filled one, how far the fill was from the signal's close (slippage) and,
  for a closed one, whether it left on the day the rule said;
* **skipped** — the bot looked and said no, with its reason (positions full, news, risk limits …) — fine;
* **missed** — the rules fired and the bot has no record of it (it was down, data failed) — a problem;
* **extra** — the bot holds a daily trade the rules do not explain — a problem.

Signals from before the bot's first cycle here (``autopilot/state.json`` ``started_at``) are left out: nobody was
watching yet, so they cannot have been missed.

The verdict is "ok" when nothing was missed or extra, no decision ended in an error, and the average entry
slippage is within twice the costs the backtests assume. State lives in ``autopilot/shadow.json``.
"""
from __future__ import annotations

from . import data, market_clock, setups, state

FILE = "autopilot/shadow.json"
PLAYBOOKS = (("crypto", "backtests/playbook.json"), ("stock", "backtests/playbook-etf.json"))
DECISIONS = "autopilot/decisions.jsonl"
BOOK = "autopilot/book.json"
BAR = 86400


def _closed(series, now_ts: int) -> list:
    return [c for c in series.candles if c.t + BAR <= now_ts]


def _btc_up(memo: dict, days: int, now_ts: int) -> dict:
    key = ("BTCUSDT", "crypto")
    if key not in memo:
        memo[key] = _closed(data.get_candles(data.as_symbol("BTCUSDT", "crypto"), "1d", days=days + 260,
                                             asset="crypto"), now_ts)
    return setups.regime_map(memo[key])


def _decisions() -> dict:
    """One decision per signal id: the first, which says why the signal was not taken while it was fresh (a later
    look only finds it stale) — unless a later one placed or tried to place the order."""
    out = {}
    for d in state.read_jsonl(DECISIONS):
        if not d.get("id"):
            continue
        prev = out.get(d["id"])
        if prev is None or (d.get("action") in ("taken", "error") and prev.get("action") != "taken"):
            out[d["id"]] = d
    return out


def run(cfg: dict, now=None, days: int = 30, memo: dict = None) -> dict:
    now = now or market_clock.now_utc()
    now_ts = int(market_clock.ts(now))
    start = now_ts - days * BAR
    started = (state.read_json("autopilot/state.json", {}) or {}).get("started_at")
    # a signal counts once the bot was there to see its bar close (an hour of slack for the first cycle)
    since = max(start, int(market_clock.ts(started)) - 3600) if started else start
    memo = {} if memo is None else memo
    ap = (cfg or {}).get("autopilot") or {}
    etf_on = bool((ap.get("etf_trend") or {}).get("enabled"))
    decisions = _decisions()
    book = (state.read_json(BOOK, {}) or {}).get("items") or {}
    costs = (cfg or {}).get("costs") or {}
    rows, notes, seen = [], [], set()
    for asset, path in PLAYBOOKS:
        pb = state.read_json(path, {}) or {}
        for e in (pb.get("entries") or {}).values():
            if e.get("interval") != "1d" or not setups.is_series(e.get("setup", "")):
                continue
            setup = e["setup"]
            sym = data.as_symbol(e["symbol"], asset)
            try:
                key = (sym.key, asset)
                if key not in memo:
                    memo[key] = _closed(data.get_candles(sym, "1d", days=days + 260, asset=asset), now_ts)
                bars = memo[key]
                btc = _btc_up(memo, days, now_ts) if (setups.SETUPS[setup].get("needs_btc") or asset == "stock") else None
            except (data.DataUnavailable, ValueError) as exc:
                notes.append("%s: no daily prices (%s)" % (sym.display, exc))
                continue
            context = {"btc_up": btc} if setups.SETUPS[setup].get("needs_btc") else None
            for r in setups.series_signals(setup, bars, "1d", start_ts=start, context=context):
                trig = r["trigger"]
                if trig["t"] + BAR < since:
                    continue
                sid = setups.setup_id(sym.key, r["window"], setup)
                seen.add(sid)
                expected, why_not = True, None
                if asset == "stock":
                    up = (btc or {}).get(max((t for t in (btc or {}) if t <= trig["t"]), default=None))
                    if not etf_on:
                        expected, why_not = False, "the ETF trend is off"
                    elif (ap.get("etf_trend") or {}).get("when", "crypto_bear") == "crypto_bear" and up:
                        expected, why_not = False, "crypto was in a bull market — the ETF trend waits"
                row = {"id": sid, "symbol": sym.display, "asset": asset, "setup": setup,
                       "signal_at": market_clock.iso(trig["t"] + BAR), "signal_price": trig["price"]}
                d, it = decisions.get(sid), book.get(sid)
                if it and it.get("entry_fill"):
                    slip = (float(it["entry_fill"]) / float(trig["price"]) - 1) * 10000.0
                    row.update(outcome="taken", fill=it["entry_fill"], slippage_bps=round(slip, 1),
                               status=it.get("status"), exit_reason=it.get("exit_reason"))
                elif it or (d and d.get("action") == "taken"):
                    row.update(outcome="ordered", status=(it or {}).get("status") or "submitted")
                elif d and d.get("action") == "error":
                    row.update(outcome="error", reason=(d.get("reasons") or ["?"])[0])
                elif d:
                    row.update(outcome="skipped", reason=(d.get("reasons") or ["?"])[0])
                elif not expected:
                    row.update(outcome="not expected", reason=why_not)
                elif trig["t"] + BAR > now_ts - 3600:
                    row.update(outcome="pending", reason="the signal is less than an hour old")
                else:
                    row.update(outcome="missed", reason="no record — the bot never looked at this signal")
                rows.append(row)
    # daily trades the rules do not explain
    for pid, it in book.items():
        if it.get("interval") != "1d" or pid in seen or not it.get("placed_at"):
            continue
        if market_clock.ts(it["placed_at"]) < max(start + BAR, since):
            continue
        rows.append({"id": pid, "symbol": it.get("symbol"), "asset": it.get("asset"), "setup": it.get("setup"),
                     "signal_at": it.get("placed_at"), "outcome": "extra",
                     "reason": "the bot holds a daily trade the rules do not explain"})
    rows.sort(key=lambda r: r.get("signal_at") or "")
    count = {}
    for r in rows:
        count[r["outcome"]] = count.get(r["outcome"], 0) + 1
    slips = [r["slippage_bps"] for r in rows if r.get("slippage_bps") is not None]
    avg_slip = round(sum(slips) / len(slips), 1) if slips else None
    allowed = {a: 2 * float((costs.get(a) or {}).get("slippage_bps") or 0) + 5.0 for a in ("crypto", "stock")}
    problems = []
    for r in rows:
        if r["outcome"] in ("missed", "extra", "error"):
            problems.append("%s %s %s: %s" % (r["outcome"].upper(), r["symbol"], r["setup"], r.get("reason")))
        if r.get("slippage_bps") is not None and r["slippage_bps"] > allowed[r["asset"]]:
            problems.append("SLIPPAGE %s: filled %.0f bps above the signal (backtest assumes ≤ %.0f)" % (
                r["symbol"], r["slippage_bps"], allowed[r["asset"]] / 2 - 2.5))
    verdict = "ok" if not problems else "check"
    span = "%d days" % days if since <= start else "%d days (since the bot started %s)" % (
        days, market_clock.iso(since + 3600)[:10])
    text = ("%d signal(s) in %s: %s" % (len(rows), span, ", ".join("%d %s" % (v, k) for k, v in sorted(count.items())))
            if rows else "no daily signals in the last %s" % span)
    if avg_slip is not None:
        text += " · average entry %+.1f bps from the signal" % avg_slip
    doc = {"updated_at": market_clock.iso(now), "days": days, "since": market_clock.iso(since), "verdict": verdict, "counts": count,
           "avg_slippage_bps": avg_slip, "problems": problems, "rows": rows, "notes": notes,
           "text": text + (" — %d problem(s)" % len(problems) if problems else " — the bot did what the rules say")}
    state.write_json(FILE, doc)
    return doc


def text(doc: dict) -> str:
    if not doc:
        return "BACKTEST vs REALITY: not checked yet"
    lines = ["BACKTEST vs REALITY · %s · %s" % (str(doc.get("verdict") or "?").upper(), doc.get("text") or "")]
    for p in doc.get("problems") or []:
        lines.append("  ! " + p)
    for r in (doc.get("rows") or [])[-12:]:
        extra = (" · fill %+.0f bps" % r["slippage_bps"]) if r.get("slippage_bps") is not None else ""
        lines.append("  %-12s %-10s %-15s %s%s%s" % (r["outcome"], r["symbol"], r["setup"], (r.get("signal_at") or "")[:10],
                                                     extra, (" · " + r["reason"][:80]) if r.get("reason") else ""))
    return "\n".join(lines)
