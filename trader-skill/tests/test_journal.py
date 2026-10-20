"""Trade journal: logging, --auto paper outcomes, P&L, stats, HTML reports."""
from __future__ import annotations

import json
import unittest

from tests.helpers import DEMOS, TraderTestCase
from tests.test_sizer import BTC_ID, MEME_ID, TSLA_ID, write_plans


class JournalTest(TraderTestCase):
    NOW = DEMOS["tsla"]["after_close"]

    def setUp(self):
        super().setUp()
        write_plans(self)

    def journal(self, *argv):
        return self.run_json("trader-journal", "journal", list(argv))

    def test_help(self):
        code, out, _ = self.run_tool("trader-journal", "journal", ["--help"])
        self.assertEqual(code, 0)
        for word in ("add", "close", "stats", "--auto"):
            self.assertIn(word, out)

    def test_auto_tsla_hits_target(self):
        self.set_now(DEMOS["tsla"]["now"])
        self.run_json("trader-sizer", "size", ["--id", TSLA_ID])
        self.set_now(DEMOS["tsla"]["after_close"])
        res = self.journal("add", "--plan", TSLA_ID, "--auto")
        t = res["trade"]
        self.assertEqual(t["status"], "closed")
        self.assertEqual(t["exit"]["reason"], "target")
        self.assertAlmostEqual(t["exit"]["price"], 375.90)
        self.assertAlmostEqual(t["r_multiple"], 2.0, places=2)
        self.assertEqual(t["qty"], 17)
        self.assertEqual(t["order_id"], "ord-TSLA-20261020-141500")
        slip = 17 * (364.18 + 375.90) * 2 / 10000.0
        self.assertAlmostEqual(t["slippage_usd"], round(slip, 2))
        self.assertAlmostEqual(t["pnl_usd"], round(17 * 11.72 - slip, 2), places=2)
        self.assertLess(t["exit"]["time"], "2026-10-20T19:55:00Z")
        self.assertTrue((self.home / "reports" / "journal.html").exists())
        self.assertTrue((self.home / t["chart"]).exists())
        page = (self.home / t["chart"]).read_text()
        self.assertIn("<svg", page)
        self.assertIn("not financial advice", page)

    def test_auto_before_outcome_stays_open(self):
        self.set_now("2026-10-20T15:00:00Z")  # 11:00 ET — neither stop nor target yet
        t = self.journal("add", "--plan", TSLA_ID, "--auto")["trade"]
        self.assertEqual(t["status"], "open")
        self.assertIn("mark", t)
        self.assertEqual(t["qty_source"], "sized like /trader-sizer (no order on file)")
        self.assertEqual(t["qty"], 17)
        self.set_now(DEMOS["tsla"]["after_close"])
        t = self.journal("close", t["id"], "--auto")["trade"]
        self.assertEqual(t["status"], "closed")
        self.assertEqual(len(self.read_state("journal.json")["trades"]), 1)

    def test_manual_exit_and_stats(self):
        self.journal("add", "--plan", TSLA_ID, "--qty", "10", "--exit-price", "375.90", "--reason", "target")
        self.set_now(DEMOS["btc"]["later"])
        self.journal("add", "--plan", BTC_ID, "--qty", "0.05", "--exit-price", "67310", "--reason", "stop",
                     "--exit-time", "2026-10-20T15:10:00Z", "--fees", "3.0")
        stats = self.journal("stats")["stats"]
        o = stats["overall"]
        self.assertEqual(o["trades"], 2)
        self.assertAlmostEqual(o["win_rate"], 0.5)
        self.assertAlmostEqual(o["avg_r"], 0.5, places=2)
        self.assertEqual(set(stats["by_asset"]), {"stock", "crypto"})
        self.assertEqual(stats["best_setup"]["setup"], "orb15")
        self.assertEqual(stats["worst_setup"]["setup"], "asia_range")
        btc = [t for t in self.read_state("journal.json")["trades"] if t["asset"] == "crypto"][0]
        self.assertAlmostEqual(btc["r_multiple"], -1.0, places=2)
        self.assertAlmostEqual(btc["pnl_usd"], round(0.05 * (67310 - 67448.6) - 3.0, 2))
        self.assertGreater(o["profit_factor"], 1)
        crypto_only = self.journal("stats", "--asset", "crypto")["stats"]
        self.assertEqual(crypto_only["overall"]["trades"], 1)

    def test_stats_text_and_strict_json(self):
        self.journal("add", "--plan", TSLA_ID, "--qty", "10", "--exit-price", "375.90", "--reason", "target")
        code, out, _ = self.run_tool("trader-journal", "journal", ["stats", "--json"])
        self.assertEqual(code, 0)
        json.loads(out, parse_constant=lambda c: self.fail("non-standard JSON constant %s" % c))
        code, out, _ = self.run_tool("trader-journal", "journal", ["stats"])
        self.assertIn("win rate 100%", out)
        self.assertIn("profit factor ∞", out)
        self.assertIn("small sample", out)

    def test_meme_pnl_in_usd(self):
        self.set_now(DEMOS["meme"]["later"])
        t = self.journal("add", "--plan", MEME_ID, "--qty", "500", "--exit-price", "0.009424", "--reason", "manual",
                         "--fees", "0", "--no-html")["trade"]
        self.assertEqual(t["qty_unit"], "usd")
        self.assertAlmostEqual(t["pnl_usd"], 500.0, places=2)
        self.assertGreater(t["r_multiple"], 10)
        code, out, _ = self.run_tool("trader-journal", "journal", ["list"])
        self.assertIn("Meme coins", out)

    def test_open_then_close_manually(self):
        t = self.journal("add", "--plan", TSLA_ID, "--qty", "5")["trade"]
        self.assertEqual(t["status"], "open")
        listed = self.journal("list", "--open-only")["trades"]
        self.assertEqual([x["id"] for x in listed], [t["id"]])
        t = self.journal("close", t["id"], "--exit-price", "358.32", "--reason", "stop")["trade"]
        self.assertAlmostEqual(t["r_multiple"], -1.0, places=2)
        code, _, err = self.run_tool("trader-journal", "journal", ["close", t["id"], "--exit-price", "1"])
        self.assertEqual(code, 2)
        self.assertIn("already closed", err)

    def test_journal_report_lists_trades(self):
        self.journal("add", "--plan", TSLA_ID, "--qty", "10", "--exit-price", "375.90", "--reason", "target")
        page = (self.home / "reports" / "journal.html").read_text()
        self.assertIn("Trade Journal", page)
        self.assertIn("orb15", page)
        self.assertIn("Cumulative R", page)


if __name__ == "__main__":
    unittest.main()
