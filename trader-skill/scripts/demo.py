#!/usr/bin/env python3
"""Run the README walkthroughs end to end on the offline fixtures (no network, no keys).

The desk (rule-based mode) runs before every Trader step: only a GO leads to sizing, a risk check
and a ticket. Anything else and the walkthrough stops there — no money moves.

    python3 scripts/demo.py            # writes demo/trader/ and demo/trader/reports/index.html
    python3 scripts/demo.py --open     # … and opens the report index in your browser

Every "yes" below is typed by the demo on your behalf, for PAPER tickets, offline — nothing is sent
anywhere. In real use the broker skill waits for *you* to type it.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = Path(os.environ.get("TRADER_DEMO_HOME") or (ROOT / "demo" / "trader")).resolve()
MAN = json.loads((ROOT / "tests" / "fixtures" / "manifest.json").read_text(encoding="utf-8"))
PUP = "SOL:" + MAN["tokens"]["PUPKIN"]["address"]
LAMBO = "SOL:" + MAN["tokens"]["MLAMBO"]["address"]
DISCLAIMER = re.compile(r"^⚠ ")


def run(skill, tool, args, now, quiet_disclaimer=True):
    cmd = [sys.executable, str(ROOT / skill / tool)] + list(args) + ["--offline", "--home", str(HOME), "--now", now]
    shown = " ".join(a if " " not in a else '"%s"' % a for a in [skill + "/" + tool] + list(args))
    print("\n$ python3 %s   [now %s]" % (shown.replace(PUP, "SOL:<PUPKIN>").replace(LAMBO, "SOL:<MLAMBO>"), now))
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    out = res.stdout.rstrip()
    lines = [l for l in out.splitlines() if not (quiet_disclaimer and DISCLAIMER.match(l))]
    print("\n".join("  " + l for l in lines if l.strip() or l == ""))
    if res.returncode != 0:
        print("  [exit %d] %s" % (res.returncode, res.stderr.strip()))
    return out


def ticket_id(text):
    m = re.search(r"TICKET (tkt-\S+)", text)
    return m.group(1) if m else None


def banner(title):
    print("\n" + "=" * 100 + "\n" + title + "\n" + "=" * 100)


def desk(symbol, now):
    """The desk runs before every Trader step; anything but GO stops the walkthrough there."""
    out = run("trader-desk", "desk.py", ["auto", symbol], now)
    m = re.search(r"^Status: (\S+)", out, re.M)
    status = m.group(1) if m else "INCOMPLETE"
    if status != "GO":
        print("\n  [desk] %s → the Trader stands down: no sizing, no ticket, no money moves." % status)
    return status == "GO"


def nvda():
    now, close = "2026-10-20T13:50:00Z", MAN["demos"]["tsla"]["after_close"]
    idea = "NVDA-20261020-orb15"
    banner("1 · NVDA opening-range breakout — the desk says GO "
           "(scanner → news → entry → exit → backtest → timemachine → DESK → sizer → risk → broker → journal)")
    run("trader-scanner", "scan.py", ["--asset", "stock", "--top", "6"], now)
    run("trader-news", "news.py", ["--symbols", "NVDA"], now)
    run("trader-entry", "entry.py", ["NVDA", "--setup", "orb15"], now)
    run("trader-exit", "exit.py", ["--id", idea], now)
    run("trader-backtest", "backtest.py", ["NVDA", "--setup", "orb15"], now)
    run("trader-timemachine", "replay.py", ["--id", idea, "--seed", "7"], now)
    if not desk("NVDA", now):
        return
    run("trader-sizer", "size.py", ["--id", idea], now)
    run("trader-risk", "risk.py", [], now)
    t = ticket_id(run("trader-broker", "ticket.py", ["prepare"], now))
    print("\n  [demo] simulating the user typing: yes")
    run("trader-broker", "ticket.py", ["approve", "--ticket", t, "--reply", "yes"], now)
    run("trader-alerts", "alerts.py", ["add", "--from-plan", idea], now)
    run("trader-journal", "journal.py", ["add", "--plan", idea, "--auto"], close)


def tsla():
    d = MAN["demos"]["tsla"]
    idea = "TSLA-20261020-orb15"
    banner("2 · TSLA opening-range breakout — a real catalyst, but the desk says NO-GO")
    run("trader-news", "news.py", ["--symbols", "TSLA"], d["now"])
    run("trader-entry", "entry.py", ["--id", idea], "2026-10-20T14:05:00Z")
    run("trader-entry", "entry.py", ["--id", idea], d["now"])
    run("trader-exit", "exit.py", ["--id", idea], d["now"])
    run("trader-backtest", "backtest.py", ["TSLA", "--setup", "orb15"], d["now"])
    run("trader-timemachine", "replay.py", ["--id", idea, "--seed", "7"], d["now"])
    if not desk("TSLA", d["now"]):
        return
    run("trader-sizer", "size.py", ["--id", idea], d["now"])


def btc():
    d = MAN["demos"]["btc"]
    idea = "BTCUSD-20261020-asia_range"
    banner("3 · BTC/USD breakout of the Asia range at the US open with rising open interest — 4h horizon")
    run("trader-scanner", "scan.py", ["--asset", "crypto", "--top", "5"], d["now"])
    run("trader-news", "news.py", ["--asset", "crypto", "--symbols", "BTC"], d["now"])
    run("trader-entry", "entry.py", ["BTC-USD", "--setup", "asia_range"], d["now"])
    run("trader-exit", "exit.py", ["--id", idea, "--horizon", "4h"], d["now"])
    run("trader-backtest", "backtest.py", ["BTC-USD", "--setup", "asia_range", "--horizon", "4h"], d["now"])
    run("trader-timemachine", "replay.py", ["--id", idea, "--seed", "7"], d["now"])
    if not desk("BTC-USD", d["now"]):
        return
    run("trader-sizer", "size.py", ["--id", idea], d["now"])
    run("trader-risk", "risk.py", [], d["now"])
    run("trader-broker", "ticket.py", ["prepare"], d["now"])


def meme():
    d = MAN["demos"]["meme"]
    banner("4 · Solana meme coin from DexScreener — rugcheck passes one and BLOCKS the other, then the desk decides")
    run("trader-scanner", "scan.py", ["--asset", "meme"], d["now"])
    run("trader-rugcheck", "rugcheck.py", [PUP], d["now"])
    run("trader-rugcheck", "rugcheck.py", [LAMBO], d["now"])
    run("trader-risk", "risk.py", ["--symbol", LAMBO, "--notional", "100", "--entry", "0.000918", "--stop", "0.00078"],
        d["now"])
    run("trader-news", "news.py", ["--asset", "meme", "--symbols", PUP], d["now"])
    run("trader-entry", "entry.py", [PUP, "--setup", "momentum"], d["now"])
    run("trader-exit", "exit.py", [], d["now"])
    run("trader-timemachine", "replay.py", ["--seed", "7"], d["now"])
    if not desk(PUP, d["now"]):
        return
    run("trader-sizer", "size.py", [], d["now"])
    run("trader-risk", "risk.py", [], d["now"])
    run("trader-broker", "ticket.py", ["prepare"], d["now"])


def addons():
    banner("Add-on · arbitrage gap monitor (read-only) · and the journal after the day")
    run("trader-arb", "arb.py", [PUP, "BTCUSDT"], MAN["demos"]["meme"]["now"])
    run("trader-journal", "journal.py", ["stats"], MAN["demos"]["tsla"]["after_close"], quiet_disclaimer=False)


def index():
    reports = sorted((HOME / "reports").glob("*.html"))
    items = "".join("<li><a href='%s'>%s</a></li>" % (html.escape(p.name), html.escape(p.stem)) for p in reports
                    if p.name != "index.html")
    (HOME / "reports" / "index.html").write_text(
        "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Trader demo reports</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:24px auto;"
        "padding:0 16px;background:#f6f7f9;color:#1f2328}a{color:#0969da}code{font-family:ui-monospace,monospace}</style>"
        "<h1>Trader demo reports</h1><p>Offline walkthroughs on synthetic fixtures. Educational tool, not financial "
        "advice.</p><ul>%s</ul>" % items, encoding="utf-8")
    return HOME / "reports" / "index.html"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--open", action="store_true", help="open the report index when done")
    ap.add_argument("--only", choices=("nvda", "tsla", "btc", "meme", "addons"), help="run one walkthrough")
    args = ap.parse_args()
    if HOME.exists():
        shutil.rmtree(str(HOME))
    for name, fn in (("nvda", nvda), ("tsla", tsla), ("btc", btc), ("meme", meme), ("addons", addons)):
        if not args.only or args.only == name:
            fn()
    idx = index()
    banner("Reports")
    for p in sorted((HOME / "reports").glob("*.html")):
        print("  " + str(p))
    print("\nOpen %s to browse them all." % idx)
    print("⚠ Educational tool, not financial advice. Fixture data is synthetic. Meme coins: most go to zero.")
    if args.open:
        webbrowser.open(idx.resolve().as_uri())


if __name__ == "__main__":
    main()
