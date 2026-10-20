"""All three README walkthroughs (+ add-ons) end to end, as separate processes, offline."""
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
                "Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. Get in $364.18.",
                "Get in $364.18 · Stop $358.32 · Target $375.90",
                "10,000 replays", "BUY 17 TSLA, limit $364.20, stop $358.32, day — PAPER",
                "APPROVED — hand this payload unchanged", "BTC/USD", "gtc — PAPER",
                "hidden: MLAMBO", "Verdict: DANGER", "BLOCK ✗ — rugcheck DANGER", "MANUAL SWAP",
                "NO EDGE AFTER COSTS", "Status: NO-GO"):
            self.assertIn(expected, out)
        reports = list((self.tmp / "demo" / "reports").glob("*.html"))
        self.assertGreaterEqual(len(reports), 20)
        approvals = (self.tmp / "demo" / "approvals.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(approvals), 2)  # the TSLA and BTC paper tickets — the meme coin is manual only
