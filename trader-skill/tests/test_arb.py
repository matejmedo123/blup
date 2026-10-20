"""Arbitrage gap monitor: routes net of costs, stale/thin legs, USDT conversion, never trades."""
from __future__ import annotations

import json

from tests.helpers import DEMOS, MEME_PASS, ROOT, TraderTestCase, load


class ArbMeme(TraderTestCase):
    NOW = DEMOS["meme"]["now"]

    def test_help(self):
        code, out, _ = self.run_tool("trader-arb", "arb", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("never trades", out.lower())

    def test_two_pools_no_edge_after_costs(self):
        res = self.run_json("trader-arb", "arb", [MEME_PASS, "--size-usd", "500"])["results"][0]
        self.assertEqual(len(res["venues"]), 2)
        best = res["best"]
        self.assertGreater(best["gross_pct"], 0)
        self.assertAlmostEqual(best["net_pct"], best["gross_pct"] - best["costs_pct"])
        self.assertLess(best["net_pct"], 0)
        self.assertEqual(res["verdict"], "no edge after costs")
        self.assertTrue((self.home / "arb" / ("%s.json" % res["key"])).exists())
        self.assertTrue((self.home / "arb_log.jsonl").exists())

    def test_thin_pool_excluded_from_routes(self):
        res = self.run_json("trader-arb", "arb", [MEME_PASS, "--size-usd", "20000"])["results"][0]
        thin = [v for v in res["venues"] if v["too_thin"]]
        self.assertEqual(len(thin), 1)
        self.assertEqual(res["routes"], [])
        self.assertEqual(res["verdict"], "no tradeable gap")

    def test_stale_leg_flagged(self):
        arb = load("trader-arb", "arb")
        v = [arb._venue("a", 1.0, 0.0, 0.0, stale=True), arb._venue("b", 1.10, 0.0, 0.0)]
        best = arb.routes(v)[0]
        self.assertTrue(best["stale_leg"])
        self.assertEqual(arb.verdict(best, 2, "meme")[0], "paper gap on a stale quote")
        fresh = arb.routes([arb._venue("a", 1.0, 0.1, 0.1), arb._venue("b", 1.10, 0.1, 0.1)])[0]
        label, sentence = arb.verdict(fresh, 2, "crypto")
        self.assertEqual(label, "gap above estimated costs")
        self.assertIn("gone before", sentence)
        self.assertNotIn("opportunit", sentence.lower())

    def test_text_has_reality_check_and_meme_disclaimer(self):
        code, out, _ = self.run_tool("trader-arb", "arb", [MEME_PASS, "--no-html"])
        self.assertEqual(code, 0)
        self.assertIn("MEV", out)
        self.assertIn("never trades", out)
        self.assertIn("most go to zero", out)

    def test_html_report(self):
        res = self.run_json("trader-arb", "arb", [MEME_PASS])
        self.assertTrue((self.home / res["report"]).exists())


class ArbCrypto(TraderTestCase):
    NOW = DEMOS["btc"]["now"]

    def test_three_venues_usdt_converted(self):
        res = self.run_json("trader-arb", "arb", ["BTCUSDT", "--size-usd", "2000"])["results"][0]
        names = sorted(v["venue"] for v in res["venues"])
        self.assertEqual(names, ["Binance", "Coinbase", "Kraken"])
        self.assertTrue(any("0.9997" in v["note"] for v in res["venues"]))
        self.assertEqual(res["verdict"], "no edge after costs")
        self.assertEqual(len(res["routes"]), 3)  # 3 venues → 3 cheaper→richer routes

    def test_stock_refused_and_nothing_given(self):
        code, _, err = self.run_tool("trader-arb", "arb", ["TSLA"])
        self.assertEqual(code, 3)
        self.assertIn("stock", err)
        code, _, err = self.run_tool("trader-arb", "arb", [])
        self.assertEqual(code, 2)

    def test_from_setups(self):
        self.write_state("setups.json", {"setups": [{"symbol": "BTCUSDT", "asset": "crypto"},
                                                    {"symbol": "TSLA", "asset": "stock"}]})
        res = self.run_json("trader-arb", "arb", ["--from-setups"])
        self.assertEqual([r["key"] for r in res["results"]], ["BTCUSDT"])

    def test_tool_never_touches_trading_code(self):
        src = (ROOT / "trader-arb" / "arb.py").read_text(encoding="utf-8")
        for banned in ("trader-broker", "ticket", "place_stock_order", "place_crypto_order", "orders.json",
                       "urllib", "skills.load"):
            self.assertNotIn(banned, src)
        self.assertIn("never trades", json.dumps(src).lower())
