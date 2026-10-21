"""All README walkthroughs (+ add-ons) end to end, as separate processes, offline — the desk gates every trade."""
from __future__ import annotations

import os
import subprocess
import sys

from tests.helpers import ROOT, TraderTestCase


class EndToEnd(TraderTestCase):
    def test_demo_runs_all_walkthroughs(self):
        env = dict(os.environ, TRADER_DEMO_HOME=str(self.tmp / "demo"))
        res = subprocess.run([sys.executable, str(ROOT / "scripts" / "demo.py")], capture_output=True, text=True,
                             encoding="utf-8", env=env, timeout=600)
        out = res.stdout
        self.assertEqual(res.returncode, 0, res.stderr[-2000:])
        self.assertNotIn("[exit ", out, "a tool failed inside the demo")
        for expected in (
                "Status: Watching → TRIGGERED — the 9:45 candle just closed above the opening range. Get in $193.92.",
                "Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. Get in $364.18.",
                "Get in $364.18 · Stop $358.32 · Target $375.90",
                "10,000 replays", "Status: GO", "BUY 32 NVDA, limit $193.93", "APPROVED — hand this payload unchanged",
                "this rule lost money on TSLA", "this rule lost money on BTC/USD",
                "hidden: MLAMBO", "Verdict: DANGER", "BLOCK ✗ — rugcheck DANGER", "NO EDGE AFTER COSTS"):
            self.assertIn(expected, out)
        # the desk is respected: three NO-GOs, and no Trader step after any of them
        self.assertEqual(out.count("[desk] NO-GO → the Trader stands down"), 3)
        self.assertNotIn("BUY 17 TSLA", out)
        self.assertNotIn("MANUAL SWAP", out)
        reports = list((self.tmp / "demo" / "reports").glob("*.html"))
        self.assertGreaterEqual(len(reports), 20)
        approvals = (self.tmp / "demo" / "approvals.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(approvals), 1)  # only NVDA got a GO and a ticket
