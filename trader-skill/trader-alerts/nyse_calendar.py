#!/usr/bin/env python3
"""NYSE calendar — holidays, 1:00 p.m. early closes, market status and the next sessions (all ET).

2026 and 2027 come from the official NYSE calendar; other years use the published
holiday rules and are marked as such. Crypto and meme coins trade 24/7 and ignore this.

Examples:
  python3 nyse_calendar.py                 # status, next 5 sessions, this year's calendar
  python3 nyse_calendar.py --status
  python3 nyse_calendar.py --year 2027
  python3 nyse_calendar.py --next 10 --json
"""
from __future__ import annotations

import os
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, market_clock  # noqa: E402


def build_parser():
    p = cli.parser("nyse_calendar.py", __doc__)
    p.add_argument("--year", type=int, help="show this year's holidays and early closes")
    p.add_argument("--status", action="store_true", help="show whether the market is open right now")
    p.add_argument("--next", type=int, metavar="N", help="list the next N trading sessions")
    return p


def status(now=None) -> dict:
    """Market status right now (or at ``now``) — importable by other skills."""
    return market_clock.market_status(now)


def year_calendar(year: int) -> dict:
    hol = market_clock.holidays(year)
    early = market_clock.early_closes(year)
    return {
        "year": year,
        "source": market_clock.calendar_source(year),
        "holidays": [{"date": d.isoformat(), "weekday": d.strftime("%A"), "name": hol[d]} for d in sorted(hol)],
        "early_closes": [{"date": d.isoformat(), "weekday": d.strftime("%A"), "name": early[d], "close_et": "1:00 p.m."}
                         for d in sorted(early)],
    }


def next_sessions(n: int, now=None) -> list:
    now = market_clock.parse_iso(now) if now else market_clock.now_utc()
    d = market_clock.et_date(now)
    out = []
    b = market_clock.session_bounds(d)
    if not (b and now < b[1]):
        d = market_clock.next_trading_day(d)
    while len(out) < n:
        o, c = market_clock.session_bounds(d)
        out.append({"date": d.isoformat(), "weekday": d.strftime("%a"),
                    "open_et": market_clock.fmt_et_ampm(o), "close_et": market_clock.fmt_et_ampm(c),
                    "open_utc": market_clock.iso(o), "close_utc": market_clock.iso(c),
                    "early_close": market_clock.is_early_close(d)})
        d = market_clock.next_trading_day(d)
    return out


def status_line(s: dict) -> str:
    state = s["state"]
    if state == "open":
        return "NYSE is OPEN — closes %s ET (%d min left)%s" % (
            market_clock.fmt_et_ampm(s["closes_at"]), s["minutes_to_close"] or 0,
            ", early close today" if s["early_close"] else "")
    why = ""
    if s.get("holiday"):
        why = " (%s)" % s["holiday"]
    elif not s["trading_day"]:
        why = " (weekend)"
    nxt = s.get("next_open")
    return "NYSE is %s%s — next open %s ET" % (state.upper(), why, market_clock.fmt_et(nxt, with_date=True)
                                              if nxt else "?")


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    now = ctx.now
    default = not (args.year or args.status or args.next)
    s = status(now)
    payload = {"status": s}
    lines = [status_line(s)]
    if args.next or default:
        sessions = next_sessions(args.next or 5, now)
        payload["next_sessions"] = sessions
        lines += ["", "Next %d sessions (ET):" % len(sessions)]
        for x in sessions:
            lines.append("  %s %s  %s – %s%s" % (x["weekday"], x["date"], x["open_et"], x["close_et"],
                                                "  early close" if x["early_close"] else ""))
    if args.year or default:
        cal = year_calendar(args.year or market_clock.et_date(now).year)
        payload["calendar"] = cal
        lines += ["", "NYSE %d — %s" % (cal["year"], cal["source"]), "Holidays (market closed):"]
        lines += ["  %s %-9s %s" % (h["date"], h["weekday"], h["name"]) for h in cal["holidays"]]
        lines.append("Early closes (1:00 p.m. ET):")
        lines += ["  %s %-9s %s" % (e["date"], e["weekday"], e["name"]) for e in cal["early_closes"]] or ["  none"]
    lines += ["", "Crypto and meme coins trade 24/7 — this calendar only gates stock alerts and sessions."]
    cli.emit(args, "\n".join(lines), payload, "stock")
    return 0


if __name__ == "__main__":
    cli.run(main)
