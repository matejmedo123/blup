#!/usr/bin/env python3
"""Two bots side by side — the real one and the paper comparison from deploy/test-bot.sh — in the dashboard's numbers.

    sudo traderctl compare                                  # /var/lib/trader against /var/lib/trader-test
    python3 deploy/compare.py --home trader --home trader-test   # any state folders, two or more

The return that counts is the one since the later bot started: before that only one of them was trading.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _server():
    spec = importlib.util.spec_from_file_location("trader_dashboard_server", str(ROOT / "app" / "server.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def one(srv, home: Path) -> dict:
    """What the dashboard of this state folder shows, plus the equity path for a common start."""
    os.environ["TRADER_HOME"] = str(home)
    cfg = srv.config.load_config()
    stats = srv.trade_stats(srv.journal_trades())
    acct = srv.account_view(cfg, stats, srv.positions_view())
    rows = srv.account_rows(srv.equity_rows())  # an old simulator run is not this one's past
    path = [(str(r["at"]), float(r["equity"])) for r in rows]
    peak, worst = None, 0.0
    for _, eq in path:
        peak = eq if peak is None else max(peak, eq)
        if peak > 0:
            worst = min(worst, eq / peak - 1)
    mode = srv.mode_info(cfg, srv.read_json("autopilot/state.json", {}) or {})
    return {"home": str(home), "setup": srv.setup_info(cfg)["label"], "mode": mode["mode"], "broker": mode["broker"],
            "equity": acct.get("equity"), "pnl_total": acct.get("pnl_total"), "path": path, "worst": worst,
            "closed": stats["closed"], "wins": stats["wins"], "open": stats["open"],
            "interest": acct.get("interest_paid")}


def since(path: list, start: str):
    """Equity change from the last point at or before ``start`` (else the first after it) to the last point."""
    if not path:
        return None
    before = [eq for at, eq in path if at <= start]
    base = before[-1] if before else path[0][1]
    return path[-1][1] / base - 1 if base > 0 else None


def total(b: dict):
    """From the first equity point (a later change of --capital does not rewrite the past), else the journal."""
    if b["path"]:
        return since(b["path"], "")
    eq, pnl = b["equity"], b["pnl_total"]
    return pnl / (eq - pnl) if eq is not None and pnl is not None and eq - pnl > 0 else None


def fmt_pct(x) -> str:
    if x is None:
        return "—"
    return "0.0 %" if abs(x) < 0.0005 else ("%+.1f %%" % (100 * x)).replace("-", "−")


def fmt_money(x) -> str:
    return "—" if x is None else ("$%s" % format(round(x, 2), ",.2f")).replace("$-", "−$")


def table(bots: list) -> str:
    starts = [b["path"][0][0] for b in bots if b["path"]]
    common = max(starts) if len(starts) == len(bots) else None
    rows = [("", [Path(b["home"]).name for b in bots]),
            ("Setup", [b["setup"] for b in bots]),
            ("Mode", [b["mode"] + ("" if b["broker"] == "simulator" else " · " + b["broker"]) for b in bots]),
            ("Running since", [b["path"][0][0][:10] if b["path"] else "no equity yet" for b in bots]),
            ("Return since %s" % (common[:10] if common else "both started"),
             [fmt_pct(since(b["path"], common)) if common else "—" for b in bots]),
            ("Return in total", [fmt_pct(total(b)) for b in bots]),
            ("Worst drop", [fmt_pct(b["worst"]) if b["path"] else "—" for b in bots]),
            ("Equity now", [fmt_money(b["equity"]) for b in bots]),
            ("Closed trades (won)", ["%d (%d)" % (b["closed"], b["wins"]) for b in bots]),
            ("Open positions", [str(b["open"]) for b in bots]),
            ("Margin interest paid", [fmt_money(b["interest"]) for b in bots])]
    w0 = max(len(r[0]) for r in rows)
    ws = [max(len(r[1][i]) for r in rows) for i in range(len(bots))]
    out = ["  ".join([r[0].ljust(w0)] + [v.ljust(w) for v, w in zip(r[1], ws)]).rstrip() for r in rows]
    out.append("")
    out.append("Judge them on the same period (the 'since' row) and only after 20+ closed trades each — before that the "
               "difference is mostly chance.")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--home", action="append", metavar="DIR",
                    help="a state folder (give it twice or more; default /var/lib/trader and /var/lib/trader-test)")
    args = ap.parse_args(argv)
    homes = [Path(h).expanduser().resolve() for h in (args.home or ["/var/lib/trader", "/var/lib/trader-test"])]
    missing = [str(h) for h in homes if not (h / "config.json").is_file()]
    if missing:
        print("no bot in %s — the comparison bot is set up with: sudo bash /opt/trader/deploy/test-bot.sh"
              % ", ".join(missing), file=sys.stderr)
        return 1
    srv = _server()
    print(table([one(srv, h) for h in homes]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
