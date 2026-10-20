"""trader-scanner: the expected setups on the stock, crypto and meme fixtures."""
import os
import unittest

from tests.helpers import DEMOS, TOKENS, TraderTestCase

SKILL, TOOL = "trader-scanner", "scan"


def by(hits, symbol, setup=None):
    return [h for h in hits if h["symbol"] == symbol and (setup is None or h["setup"] == setup)]


class ScannerStockTest(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def test_help(self):
        code, out, _ = self.run_tool(SKILL, TOOL, ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--max-symbols", out)

    def test_stock_scan(self):
        r = self.run_json(SKILL, TOOL, ["--asset", "stock"])
        hits = r["setups"]
        self.assertEqual(r["universe"]["total"], 30)
        self.assertEqual(r["universe"]["scanned"], 6)
        tsla = by(hits, "TSLA", "orb15")
        self.assertEqual(len(tsla), 1)
        t = tsla[0]
        self.assertEqual(t["status"], "triggered")
        self.assertEqual(t["levels"]["range_high"], 362.18)
        self.assertEqual(t["levels"]["range_low"], 358.32)
        self.assertEqual(t["trigger"]["price"], 364.18)
        self.assertEqual(t["trigger"]["time"], "2026-10-20T14:10:00Z")
        self.assertIn("high_relvol", t["flags"])
        self.assertEqual(t["id"], "TSLA-20261020-orb15")
        self.assertEqual(t["entry_setup"], "orb15")
        self.assertEqual(hits[0]["id"], "TSLA-20261020-orb15")  # best-ranked
        self.assertEqual(by(hits, "NVDA", "gap_and_go")[0]["status"], "triggered")
        self.assertEqual(by(hits, "AMD", "vwap_reclaim")[0]["status"], "triggered")
        self.assertEqual(by(hits, "PLTR", "bull_flag")[0]["status"], "triggered")
        # ORB-30 fired on the same TSLA candle at the same level → shown once
        self.assertEqual(by(hits, "TSLA", "orb30"), [])
        saved = self.read_state("setups.json")
        self.assertEqual(saved["asset"], "stock")
        self.assertEqual(len(saved["setups"]), len(hits))
        self.assertTrue(self.read_state("setups-stock.json"))
        self.assertTrue((self.home / hits[0]["chart"]).exists())

    def test_text_header_and_filters(self):
        code, out, err = self.run_tool(SKILL, TOOL, ["--asset", "stock", "--symbols", "TSLA,AAPL", "--setups",
                                                     "orb15", "--no-html"])
        self.assertEqual(code, 0, err)
        self.assertIn("2 of 2 symbols scanned", out)
        self.assertIn("TSLA", out)
        self.assertIn("Educational tool", out)
        code, _, err = self.run_tool(SKILL, TOOL, ["--asset", "stock", "--setups", "nonsense"])
        self.assertEqual(code, 2)

    def test_time_budget_and_prefilter(self):
        r = self.run_json(SKILL, TOOL, ["--asset", "stock", "--max-symbols", "3", "--no-html"])
        self.assertLessEqual(r["universe"]["scanned"] + r["universe"]["skipped"], 3)
        self.assertEqual(r["universe"]["candidates"], 3)


class ScannerCryptoTest(TraderTestCase):
    NOW = DEMOS["btc"]["now"]

    def test_crypto_scan(self):
        r = self.run_json(SKILL, TOOL, ["--asset", "crypto"])
        hits = r["setups"]
        btc = by(hits, "BTCUSDT", "asia_range")[0]
        self.assertEqual(btc["status"], "triggered")
        self.assertEqual(btc["levels"]["range_high"], 67420.0)
        self.assertEqual(btc["trigger"]["time"], "2026-10-20T14:35:00Z")
        self.assertIn("rising_oi", btc["flags"])
        self.assertGreater(btc["metrics"]["oi_change_pct"], 2)
        self.assertEqual(hits[0]["id"], btc["id"])
        eth = by(hits, "ETHUSDT")
        self.assertTrue(eth)
        self.assertIn("funding_extreme", eth[0]["flags"])
        self.assertEqual(eth[0]["setup"], "funding_extreme")
        self.assertEqual(eth[0]["entry_setup"], "momentum")
        self.assertEqual(r["universe"]["scanned"], 4)  # BTC, ETH, SOL, XRP have candles offline


class ScannerMemeTest(TraderTestCase):
    NOW = DEMOS["meme"]["now"]

    def test_meme_scan_gates_on_rugcheck(self):
        r = self.run_json(SKILL, TOOL, ["--asset", "meme"])
        hits = r["setups"]
        pup = "solana:" + TOKENS["PUPKIN"]["address"]
        newt = "base:" + TOKENS["NEWT"]["address"]
        p = by(hits, pup)
        self.assertEqual(len(p), 1)
        self.assertEqual(p[0]["setup"], "momentum")
        self.assertEqual(p[0]["status"], "triggered")
        self.assertEqual(p[0]["rugcheck"]["verdict"], "SAFE")
        n = by(hits, newt)
        self.assertEqual(n[0]["setup"], "new_launch")
        self.assertIn("rugcheck_risky", n[0]["flags"])
        self.assertFalse(by(hits, "solana:" + TOKENS["MLAMBO"]["address"]))
        hidden = r["hidden"]
        self.assertEqual(len(hidden), 1)
        self.assertIn("DANGER", hidden[0]["reason"])
        self.assertIn("40.0%", hidden[0]["reason"])
        self.assertFalse(any(TOKENS["OLDFROG"]["address"] in h["symbol"] for h in hits))  # ethereum not configured
        self.assertTrue((self.home / "rugcheck" / ("solana-%s.json" % TOKENS["MLAMBO"]["address"])).exists())
        self.assertIn("meme", r["disclaimer"].lower())

    def test_rugcheck_failure_hides_hits(self):
        os.environ["TRADER_OFFLINE_FAIL"] = "api.rugcheck.xyz,api.honeypot.is"
        r = self.run_json(SKILL, TOOL, ["--asset", "meme", "--no-html"])
        # with the safety sources down nothing can be SAFE; DANGER ones are still hidden
        for h in r["setups"]:
            self.assertNotEqual(h["rugcheck"]["verdict"], "SAFE")
        self.assertGreaterEqual(len(r["hidden"]), 1)


if __name__ == "__main__":
    unittest.main()
