"""Is this normal? — the autopilot's own closed trades held against what the backtest lab saw on unseen data.

A losing streak, a bad month or a drawdown is only a warning if the strategy rarely produced one that bad. So the
lab's out-of-sample trades (``test_trades`` in ``backtests/lab-*.json``, all setups the bot trades, in time order)
are cut into blocks of ``block`` consecutive trades and stitched together thousands of times into histories as long
as the bot's — blocks, not single trades, because trades cluster: the coins move together and a crash stops out
several positions in the same days; drawing trades one by one would make every real losing streak look rare. Each
check says how often a history at least that bad happened:

* the longest losing streak of the last ``window`` trades,
* the sum of the last ``window`` trades in R,
* the deepest drawdown in R since the bot started (or since you last resumed it).

Below ``watch_pct`` % of histories → "watch"; below ``alarm_pct`` % → "alarm": the results are worse than what
the strategy did in 9 of 10 histories, so its edge may be gone — the autopilot pauses new entries
(``pause_on_alarm``) until you resume it. Wins count up to ``cap_r`` (a rare +100R trade would make every
ordinary stretch look poor). Calibrated on the bot's own simulated trade sequences 2018–2026 (5 positions, 10
signal orders): false alarms 0.2–0.7 % of the time; a strategy that loses (20 % winners) is caught after ~16
trades; one with no edge left is only caught about a third of the time within 40 trades — results alone are
slow to prove anything, which is why the lab's eight years of walk-forward tests come first. A trade split by the runner (sold part + the part that rode on) counts
once, as the backtest counts it. Only trades of setups the lab tested are judged — the others (an intraday stock
setup, say) are listed as not judged. State lives in ``autopilot/health.json``.
"""
from __future__ import annotations

import copy
import hashlib
import json
import random

from . import market_clock, state, trades as tradesmod

FILE = "autopilot/health.json"
LAB_FILES = ("backtests/lab-crypto.json", "backtests/lab-etf.json")
DEFAULTS = {"enabled": True, "min_trades": 10, "window": 30, "alarm_pct": 10.0, "watch_pct": 25.0,
            "pause_on_alarm": True, "paths": 2000, "block": 20, "cap_r": 3.0,
            "alarm_checks": ["losing streak", "recent result", "drawdown"]}
LEVELS = {"early": 0, "normal": 1, "unknown": 1, "watch": 2, "alarm": 3}


def settings(cfg: dict) -> dict:
    out = dict(DEFAULTS)
    out.update(((cfg or {}).get("autopilot") or {}).get("health") or {})
    return out


def reference(cfg: dict = None, setups: set = None) -> list:
    """R of every out-of-sample lab trade of the setups the bot trades, in time order — with the runner's results
    where the bot lets winners ride. Families the lab did not validate are left out: the bot doesn't trade them.
    ``setups`` (a set) is filled with the setups the reference covers."""
    riding = bool((((cfg or {}).get("autopilot") or {}).get("runner") or {}).get("enabled"))
    rows = []
    for name in LAB_FILES:
        doc = state.read_json(name, {}) or {}
        for fam in doc.get("families") or []:
            if fam.get("validated") is False:
                continue
            ride = fam.get("runner") or {}
            got = ride.get("test_trades") if riding and ride.get("helps") and ride.get("test_trades") else \
                fam.get("test_trades")
            rows += [(int(t), float(r)) for t, r in got or []]
            if setups is not None and got:
                setups.add(fam.get("setup"))
    return [r for _, r in sorted(rows)]


def _r(t: dict):
    v = t.get("r_net")
    if v is None:
        v = t.get("r_multiple")
    return float(v) if v is not None else None


def live_trades(since: str = None) -> list:
    """The autopilot's closed trades, oldest first: [{"setup", "r", "at", "id"}] — a runner split counts once."""
    trades = [t for t in (state.read_json("journal.json", {}) or {}).get("trades") or [] if t.get("source") == "autopilot"]
    out = []
    for t in tradesmod.merge(trades):  # a split position counts once — judged once every piece is sold
        if t.get("status") != "closed":
            continue
        at = (t.get("exit") or {}).get("time") or ""
        r = _r(t)
        if r is None or (since and at < since):
            continue
        out.append({"id": t["id"], "setup": t.get("setup") or "manual", "r": float(r), "at": at})
    return sorted(out, key=lambda x: x["at"])


def _longest_losing_streak(rs) -> int:
    best = run = 0
    for r in rs:
        run = run + 1 if r <= 0 else 0
        best = max(best, run)
    return best


def _drawdown(rs) -> float:
    peak = total = dd = 0.0
    for r in rs:
        total += r
        peak = max(peak, total)
        dd = max(dd, peak - total)
    return dd


def _verdict(p: float, s: dict) -> str:
    return "alarm" if 100 * p < float(s["alarm_pct"]) else ("watch" if 100 * p < float(s["watch_pct"]) else "normal")


def _how_often(p: float) -> str:
    if p >= 0.995:
        return "almost every"
    if p < 0.005:
        return "almost no"
    return "%.0f%% of" % (100 * p)


def _stitch(ref: list, n: int, block: int, rng) -> list:
    """A history of n trades made of random blocks of consecutive reference trades."""
    out = []
    block = max(1, min(block, len(ref)))
    while len(out) < n:
        start = int(rng.random() * (len(ref) - block + 1))
        out += ref[start:start + block]
    return out[:n]


_MEMO = {}


def evaluate(trades: list, ref: list, cfg: dict = None, seed: int = 7) -> dict:
    """Pure: the checks for these trades against this time-ordered reference (no files). Thousands of simulated
    histories — remembered until a trade closes or the reference changes, not redone every minute."""
    key = hashlib.sha1(json.dumps([[[t["r"], t["setup"]] for t in trades], ref, settings(cfg), seed],
                                  sort_keys=True, default=str).encode("utf-8")).hexdigest()
    last = _MEMO.get("last")  # one entry, swapped whole: the dashboard and a cycle may ask at the same time
    if last is None or last[0] != key:
        last = (key, _evaluate(trades, ref, cfg, seed))
        _MEMO["last"] = last
    return copy.deepcopy(last[1])


def _evaluate(trades: list, ref: list, cfg: dict = None, seed: int = 7) -> dict:
    s = settings(cfg)
    n = len(trades)
    base = {"trades": n, "min_trades": int(s["min_trades"]), "checks": [], "setups": sorted({t["setup"] for t in trades})}
    if len(ref) < 2 * int(s["min_trades"]):
        return dict(base, status="unknown", text="no lab results to compare with — run trader-backtest/lab.py")
    if n < int(s["min_trades"]):
        return dict(base, status="early", text="%d closed trade(s) — judged from %d on; until then any result is "
                                                 "within chance" % (n, int(s["min_trades"])))
    w = min(n, int(s["window"]))
    # a rare +100R trade would make every ordinary stretch look poor — sums and drawdowns count wins up to cap_r
    cap = float(s.get("cap_r") or 1e9)
    rs = [min(t["r"], cap) for t in trades]
    ref = [min(r, cap) for r in ref]
    recent = rs[-w:]
    live = {"streak": _longest_losing_streak(recent), "sum": sum(recent), "drawdown": _drawdown(rs)}
    worse = {"streak": 0, "sum": 0, "drawdown": 0}
    rng = random.Random(seed)
    paths = int(s["paths"])
    for _ in range(paths):
        sim = _stitch(ref, n, int(s["block"]), rng)
        tail = sim[-w:]
        worse["streak"] += _longest_losing_streak(tail) >= live["streak"]
        worse["sum"] += sum(tail) <= live["sum"]
        worse["drawdown"] += _drawdown(sim) >= live["drawdown"]
    checks = []
    for key, name, shown, unit in (
            ("streak", "losing streak", "%d losses in a row (longest of the last %d trades)" % (live["streak"], w), ""),
            ("sum", "recent result", "%+.1fR over the last %d trades" % (live["sum"], w), "R"),
            ("drawdown", "drawdown", "%.1fR below the best point" % live["drawdown"], "R")):
        p = worse[key] / float(paths)
        v = _verdict(p, s)
        if v == "alarm" and name not in (s.get("alarm_checks") or []):
            v = "watch"  # reported, but not reason enough to stop the bot
        checks.append({"name": name, "value": round(live[key], 2), "p": round(p, 4), "verdict": v,
                       "text": "%s — %s backtest histories of the same %d trades were at least this bad: %s" % (
                           shown, _how_often(p), w if key != "drawdown" else n,
                           {"normal": "normal", "watch": "worth watching",
                            "alarm": "worse than 9 histories in 10 — the edge may be gone"}[v])})
    status = max((c["verdict"] for c in checks), key=lambda v: LEVELS[v])
    worst = max(checks, key=lambda c: LEVELS[c["verdict"]] * 10 - c["p"])
    head = {"normal": "results look like the backtest", "watch": "results are on the weak side of the backtest",
            "alarm": "results are worse than 9 of 10 backtest histories"}[status]
    return dict(base, status=status, checks=checks, window=w, text="%s (%d trades): %s" % (head, n, worst["text"]))


def update(cfg: dict, now=None, control: dict = None) -> dict:
    """Evaluate the bot's trades since the last resume and keep autopilot/health.json; adds ``new_alarm``."""
    s = settings(cfg)
    now_iso = market_clock.iso(now or market_clock.now_utc())
    prev = state.read_json(FILE, {}) or {}
    if not s.get("enabled", True):
        doc = {"updated_at": now_iso, "enabled": False, "status": "off", "text": "the health check is off"}
        state.write_json(FILE, doc)
        return dict(doc, new_alarm=False)
    since = (control or {}).get("dd_reset_at")
    covered = set()
    ref = reference(cfg, covered)
    # only trades of setups the lab tested can be held against its trades — an intraday stock setup is not a trend
    trades = live_trades(since)
    judged = [t for t in trades if t["setup"] in covered]
    other = {}
    for t in trades:
        if t["setup"] not in covered:
            other[t["setup"]] = other.get(t["setup"], 0) + 1
    doc = evaluate(judged, ref, cfg)
    if other:
        doc["not_judged"] = other
        doc["text"] += " · not judged (no lab reference): %s" % ", ".join("%s %d" % kv for kv in sorted(other.items()))
    alarm_since = prev.get("alarm_since") if prev.get("status") == "alarm" else None
    new_alarm = doc["status"] == "alarm" and not alarm_since
    if doc["status"] == "alarm":
        alarm_since = alarm_since or now_iso
    doc.update(updated_at=now_iso, enabled=True, since=since, alarm_since=alarm_since if doc["status"] == "alarm" else None,
               history=((prev.get("history") or []) + ([{"at": now_iso, "status": doc["status"]}]
                                                       if doc["status"] != prev.get("status") else []))[-50:])
    state.write_json(FILE, doc)
    return dict(doc, new_alarm=new_alarm)


def text(doc: dict) -> str:
    if not doc:
        return "HEALTH: not checked yet"
    lines = ["HEALTH · %s · %s" % (str(doc.get("status") or "?").upper(), doc.get("text") or "")]
    for c in doc.get("checks") or []:
        lines.append("  %-7s %s" % ({"normal": "ok", "watch": "watch", "alarm": "ALARM"}[c["verdict"]], c["text"]))
    return "\n".join(lines)
