#!/usr/bin/env python3
"""Run the three README walkthroughs end to end on the offline fixtures (no network, no keys).

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


def tsla():
    d = MAN["demos"]["tsla"]
    banner("1 · TSLA opening-range breakout — scanner → news → entry → exit → timemachine → sizer → risk → broker → journal")
    run("trader-scanner", "scan.py", ["--asset", "stock", "--top", "6"], d["now"])
    run("trader-news", "news.py", ["--symbols", "TSLA"], d["now"])
    run("trader-entry", "entry.py", ["--id", "TSLA-20261020-orb15"], "2026-10-20T14:05:00Z")
    run("trader-entry", "entry.py", ["--id", "TSLA-20261020-orb15"], d["now"])
    run("trader-exit", "exit.py", ["--id", "TSLA-20261020-orb15"], d["now"])
    run("trader-backtest", "backtest.py", ["TSLA", "--setup", "orb15"], d["now"])
    run("trader-timemachine", "replay.py", ["--id", "TSLA-20261020-orb15", "--seed", "7"], d["now"])
    run("trader-sizer", "size.py", ["--id", "TSLA-20261020-orb15"], d["now"])
    run("trader-risk", "risk.py", [], d["now"])
    t = ticket_id(run("trader-broker", "ticket.py", ["prepare"], d["now"]))
    print("\n  [demo] simulating the user typing: yes")
    run("trader-broker", "ticket.py", ["approve", "--ticket", t, "--reply", "yes"], d["now"])
    run("trader-alerts", "alerts.py", ["add", "--from-plan", "TSLA-20261020-orb15"], d["now"])
    run("trader-journal", "journal.py", ["add", "--plan", "TSLA-20261020-orb15", "--auto"], d["after_close"])


def btc():
    d = MAN["demos"]["btc"]
    idea = "BTCUSD-20261020-asia_range"
    banner("2 · BTC/USD Asia-range breakout at the US open with rising open interest — 4h horizon, Alpaca crypto paper ticket")
    run("trader-scanner", "scan.py", ["--asset", "crypto", "--top", "5"], d["now"])
    run("trader-news", "news.py", ["--asset", "crypto", "--symbols", "BTC"], d["now"])
    run("trader-entry", "entry.py", ["BTC-USD", "--setup", "asia_range"], d["now"])
    run("trader-exit", "exit.py", ["--id", idea, "--horizon", "4h"], d["now"])
    run("trader-backtest", "backtest.py", ["BTC-USD", "--setup", "asia_range", "--horizon", "4h"], d["now"])
    run("trader-timemachine", "replay.py", ["--id", idea, "--seed", "7"], d["now"])
    run("trader-sizer", "size.py", ["--id", idea], d["now"])
    run("trader-risk", "risk.py", [], d["now"])
    t = ticket_id(run("trader-broker", "ticket.py", ["prepare"], d["now"]))
    print("\n  [demo] simulating the user typing: yes")
    run("trader-broker", "ticket.py", ["approve", "--ticket", t, "--reply", "yes"], d["now"])
    run("trader-journal", "journal.py", ["add", "--plan", idea, "--auto"], d["later"])


def meme():
    d = MAN["demos"]["meme"]
    banner("3 · Solana meme coin from DexScreener — scanner → rugcheck (pass + BLOCK) → entry → exit → timemachine → sizer → risk → manual checklist → journal")
    run("trader-scanner", "scan.py", ["--asset", "meme"], d["now"])
    run("trader-rugcheck", "rugcheck.py", [PUP], d["now"])
    run("trader-rugcheck", "rugcheck.py", [LAMBO], d["now"])
    run("trader-risk", "risk.py", ["--symbol", LAMBO, "--notional", "100", "--entry", "0.000918", "--stop", "0.00078"],
        d["now"])
    run("trader-news", "news.py", ["--asset", "meme", "--symbols", PUP], d["now"])
    run("trader-entry", "entry.py", [PUP, "--setup", "momentum"], d["now"])
    run("trader-exit", "exit.py", [], d["now"])
    run("trader-timemachine", "replay.py", ["--seed", "7"], d["now"])
    run("trader-sizer", "size.py", [], d["now"])
    run("trader-risk", "risk.py", [], d["now"])
    run("trader-broker", "ticket.py", ["prepare"], d["now"])
    run("trader-alerts", "alerts.py", ["add", "--from-plan"], d["now"])
    run("trader-journal", "journal.py", ["add", "--auto"], d["later"])
    run("trader-journal", "journal.py", ["stats"], d["later"], quiet_disclaimer=False)


def addons():
    banner("Add-ons · arbitrage gap monitor (read-only) and the four-role trading desk")
    run("trader-arb", "arb.py", [PUP, "BTCUSDT"], MAN["demos"]["meme"]["now"])
    now = MAN["demos"]["tsla"]["now"]
    idea = "TSLA-20261020-orb15"
    run("trader-desk", "desk.py", ["brief", "TSLA"], now)
    print("\n  [demo] canned memos — in real use the trader-researcher / trader-skeptic / trader-lead subagents write them")
    memos = {
        "researcher": "## Thesis\nOpening-range breakout on 2.8x relative volume with a merger headline before the open.\n"
                      "## Evidence\n- setups.json: orb15 triggered on the 10:10 candle at $364.18 (score 85)\n"
                      "- news.json: 'Tesla–SpaceX merger mania strikes Wall Street ahead of earnings' 9:05 ET\n"
                      "## What would make this wrong\nA close back inside the opening range; earnings tomorrow.",
        "skeptic": "O1 [critical] Earnings land tomorrow after the close and the plan holds until 3:55 p.m. — evidence: news.json "
                   "'Tesla Q3 earnings preview'\nO2 [major] This rule lost money on TSLA: backtest expectancy is negative "
                   "after costs — evidence: backtests/TSLA-orb15.json\nO3 [major] Time Machine: stop first is about twice as "
                   "likely as target — evidence: timemachine/TSLA-20261020.json\n## Verdict\nI would pass: the edge is not there.",
        "lead": "O1: mitigated — the plan is flat by 3:55 p.m. today, before the report; size stays at 0.4% risk\n"
                "O2: accepted — 33 triggers, negative expectancy; the rule has not earned trust on TSLA\n"
                "O3: accepted — P(stop) 56% vs P(target) 24% with EV close to zero\n"
                "DECISION: NO-GO\nThe catalyst is real but the numbers do not pay for the risk. Revisit only with a "
                "tighter stop that the Time Machine likes.",
    }
    for role, text in memos.items():
        run("trader-desk", "desk.py", ["record", "--id", idea, "--role", role, "--text", text], now)
    run("trader-desk", "desk.py", ["verify", "--id", idea], now)


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
    ap.add_argument("--only", choices=("tsla", "btc", "meme", "addons"), help="run one walkthrough")
    args = ap.parse_args()
    if HOME.exists():
        shutil.rmtree(str(HOME))
    for name, fn in (("tsla", tsla), ("btc", btc), ("meme", meme), ("addons", addons)):
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
