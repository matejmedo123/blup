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
watching yet, so they cannot have been missed. Neither is a signal that came while the bot was paused or killed
(``autopilot/control_log.jsonl``), nor one on a coin the playbook did not hold that day — the weekly lab run changes
the list, and ``backtests/playbook-history.jsonl`` remembers each version. An ETF signal can only be missed after
the next US session's first entry time (9:45 ET); a crypto one after its bar closed. A daily trade bought while the
playbook did not hold it is a problem (OUTSIDE).

The verdict is "ok" when nothing was missed or extra, no decision ended in an error, and the average entry
slippage is within twice the costs the backtests assume. State lives in ``autopilot/shadow.json``.
"""
from __future__ import annotations

from . import data, market_clock, setups, state

FILE = "autopilot/shadow.json"
PLAYBOOKS = (("crypto", "backtests/playbook.json"), ("stock", "backtests/playbook-etf.json"))
HISTORY = "backtests/playbook-history.jsonl"
CONTROL_LOG = "autopilot/control_log.jsonl"
DECISIONS = "autopilot/decisions.jsonl"
BOOK = "autopilot/book.json"
BAR = 86400
ETF_LOOK = (9, 45)   # ET — the autopilot judges yesterday's ETF bar from here on (autopilot.ETF_FIRST_ENTRY)
GRACE = 3600         # a signal is "missed" only after the bot had an hour to look at it


def note_playbook(path: str, pb: dict) -> None:
    """Called by the lab on every playbook it writes: which coin + setup combinations were tradable from when."""
    state.append_jsonl(HISTORY, {"generated_at": pb.get("generated_at"), "path": path, "entries": {
        k: {"symbol": e.get("symbol"), "setup": e.get("setup"), "interval": e.get("interval")}
        for k, e in (pb.get("entries") or {}).items()}})


def note_control(c: dict) -> None:
    """Called whenever control.json is written: a line each time the bot is paused, killed or resumed."""
    rows = state.read_jsonl(CONTROL_LOG)
    last = rows[-1] if rows else {}
    now = (bool(c.get("paused")), bool(c.get("kill")))
    if (bool(last.get("paused")), bool(last.get("kill"))) != now:
        state.append_jsonl(CONTROL_LOG, {"at": c.get("updated_at") or market_clock.iso(market_clock.now_utc()),
                                         "paused": now[0], "kill": now[1], "by": c.get("by")})


def _stopped_at(log: list, ts: float) -> bool:
    st = False
    for r in log:
        if r.get("at") and market_clock.ts(r["at"]) <= ts:
            st = bool(r.get("paused") or r.get("kill"))
    return st


def _look_ts(asset: str, bar_t: int) -> int:
    """When the bot first looks at the signal of the daily bar that opened at bar_t."""
    if asset == "stock":
        day = market_clock.next_trading_day(market_clock.et_date(market_clock.from_ts(bar_t)))
        return int(market_clock.ts(market_clock.et_to_utc(day, *ETF_LOOK)))
    return bar_t + BAR


def _versions(path: str, pb: dict, hist: list) -> list:
    """[(from_ts, {key: {symbol, setup, interval}})] — every playbook the bot traded from, oldest first."""
    out = {}
    for h in hist:
        if h.get("path") == path and h.get("generated_at"):
            out[int(market_clock.ts(h["generated_at"]))] = h.get("entries") or {}
    if pb.get("generated_at"):
        out.setdefault(int(market_clock.ts(pb["generated_at"])), {
            k: {"symbol": e.get("symbol"), "setup": e.get("setup"), "interval": e.get("interval")}
            for k, e in (pb.get("entries") or {}).items()})
    return sorted(out.items())


def _held(versions: list, key: str, ts: float):
    """True / False — was this combination in the playbook at ts? None when no version from then is known."""
    cur = None
    for t, entries in versions:
        if t <= ts:
            cur = entries
    return None if cur is None else key in cur


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
    hist = state.read_jsonl(HISTORY)
    log = state.read_jsonl(CONTROL_LOG)
    rows, notes, seen = [], [], set()
    for asset, path in PLAYBOOKS:
        pb = state.read_json(path, {}) or {}
        versions = _versions(path, pb, hist)
        # every combination the bot could have traded in the window, plus whatever it actually holds
        combos = {}
        for i, (t, entries) in enumerate(versions):
            until = versions[i + 1][0] if i + 1 < len(versions) else now_ts
            if until >= start:
                combos.update(entries)
        for it in book.values():
            if it.get("interval") == "1d" and it.get("asset") == asset and it.get("data_key") and it.get("setup"):
                combos.setdefault("%s:%s@1d" % (it["data_key"], it["setup"]),
                                  {"symbol": it["data_key"], "setup": it["setup"], "interval": "1d"})
        for pkey, e in sorted(combos.items()):
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
                look = _look_ts(asset, trig["t"])
                held = _held(versions, pkey, look)
                if expected and held is not True:
                    expected, why_not = False, ("not in the playbook that day" if held is False else
                                                "no record of the playbook from that day")
                if expected and _stopped_at(log, look):
                    expected, why_not = False, "the bot was paused"
                row = {"id": sid, "symbol": sym.display, "asset": asset, "setup": setup,
                       "signal_at": market_clock.iso(trig["t"] + BAR), "signal_price": trig["price"]}
                d, it = decisions.get(sid), book.get(sid)
                if (it or (d and d.get("action") == "taken")) and held is False:
                    notes.append("OUTSIDE %s %s: bought while the playbook did not hold it" % (sym.display, setup))
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
                elif look > now_ts - GRACE:
                    row.update(outcome="pending", reason="the bot has not had its turn yet" if look > now_ts
                               else "the signal is less than an hour old")
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
    problems = [n for n in notes if n.startswith("OUTSIDE ")]
    notes = [n for n in notes if not n.startswith("OUTSIDE ")]
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
