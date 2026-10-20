"""Entry Timer: watches a setup candle by candle and says exactly when to get in."""
from __future__ import annotations

import unittest

from tests.helpers import DEMOS, MEME_PASS, TraderTestCase


class EntryTimerTests(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def test_help(self):
        code, out, _ = self.run_tool("trader-entry", "entry", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--setup", out)
        self.assertIn("--follow", out)

    def test_tsla_watching_then_triggered(self):
        self.set_now("2026-10-20T14:05:00Z")
        first = self.run_json("trader-entry", "entry", ["TSLA", "--setup", "orb15"])["entry"]
        self.assertEqual(first["status"], "watching")
        self.assertEqual(first["levels"]["range_high"], 362.18)
        self.assertIsNone(first["entry_price"])

        self.set_now(DEMOS["tsla"]["now"])
        code, out, err = self.run_tool("trader-entry", "entry", ["TSLA", "--setup", "orb15"])
        self.assertEqual(code, 0, err)
        self.assertIn("Opening range high $362.18 (9:30–9:45 ET). Rule: 5-min close above.", out)
        self.assertIn("Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. "
                      "Get in $364.18.", out)
        self.assertIn("not financial advice", out)

        doc = self.read_state("entries.json")
        rec = doc["entries"]["TSLA-20261020-orb15"]
        self.assertEqual(doc["latest"], "TSLA-20261020-orb15")
        self.assertEqual(rec["status"], "triggered")
        self.assertEqual(rec["previous_status"], "watching")
        self.assertEqual(rec["entry_price"], 364.18)
        self.assertEqual(rec["trigger"]["time"], "2026-10-20T14:10:00Z")
        self.assertEqual(rec["trigger"]["close_time"], "2026-10-20T14:15:00Z")
        self.assertEqual([h["status"] for h in rec["history"]], ["watching", "triggered"])
        self.assertEqual(rec["range"], {"start": "2026-10-20T13:30:00Z", "end": "2026-10-20T13:45:00Z"})
        self.assertTrue((self.home / rec["chart"]).exists())

    def test_btc_asia_range(self):
        self.set_now(DEMOS["btc"]["now"])
        code, out, err = self.run_tool("trader-entry", "entry", ["BTC-USD", "--setup", "asia_range", "--no-html"])
        self.assertEqual(code, 0, err)
        self.assertIn("BTC Asia range high $67,420.00 — 5-min close above at 14:35 UTC", out)
        rec = self.read_state("entries.json")["entries"]["BTCUSD-20261020-asia_range"]
        self.assertEqual(rec["status"], "triggered")
        self.assertEqual(rec["entry_price"], 67448.60)
        self.assertEqual(rec["symbol"], "BTC/USD")

    def test_meme_momentum_liquidity_ok(self):
        self.set_now(DEMOS["meme"]["now"])
        out = self.run_json("trader-entry", "entry", [MEME_PASS, "--setup", "momentum", "--no-html"])
        rec = out["entry"]
        self.assertEqual(rec["status"], "triggered")
        self.assertEqual(rec["entry_price"], 0.004712)
        self.assertTrue(rec["liquidity_check"]["ok"])
        self.assertGreater(rec["liquidity_check"]["liquidity_usd"], 400000)
        self.assertTrue(any("rugcheck" in w for w in rec["warnings"]))
        self.assertIn("Meme coins", out["disclaimer"])

    def test_meme_blocked_when_slippage_too_high(self):
        self.set_now(DEMOS["meme"]["now"])
        rec = self.run_json("trader-entry", "entry", [MEME_PASS, "--setup", "momentum", "--size-usd", "100000",
                                                      "--no-html"])["entry"]
        self.assertEqual(rec["status"], "blocked")
        self.assertFalse(rec["liquidity_check"]["ok"])
        self.assertGreater(rec["liquidity_check"]["est_slippage_pct"], 3.0)
        self.assertIn("slippage", rec["notes"][0])

    def test_stale_momentum_trigger_not_reported(self):
        # watching starts at 16:00 UTC: the 14:35 momentum bar is history, not a fresh signal
        self.set_now("2026-10-20T16:00:00Z")
        rec = self.run_json("trader-entry", "entry", ["BTCUSDT", "--setup", "momentum", "--no-html"])["entry"]
        if rec["trigger"]:
            self.assertGreaterEqual(rec["trigger"]["time"], "2026-10-20T15:55:00Z")
        self.assertEqual(rec["watch_started"], "2026-10-20T16:00:00Z")

    def test_id_from_scanner_flag_hit_uses_entry_setup(self):
        self.set_now(DEMOS["btc"]["now"])
        sid = "BTCUSDT-20261020-rising_oi"
        self.write_state("setups.json", {"setups": [{"id": sid, "symbol": "BTCUSDT", "asset": "crypto",
                                                     "setup": "rising_oi", "status": "flag",
                                                     "entry_setup": "asia_range", "score": 80}]})
        rec = self.run_json("trader-entry", "entry", ["--id", sid, "--no-html"])["entry"]
        self.assertEqual(rec["id"], sid)
        self.assertEqual(rec["setup"], "asia_range")
        self.assertEqual(rec["status"], "triggered")
        self.assertEqual(rec["scanner"]["setup"], "rising_oi")

    def test_unknown_id(self):
        code, _, err = self.run_tool("trader-entry", "entry", ["--id", "NOPE-20261020-orb15", "--no-html"])
        self.assertEqual(code, 2)
        self.assertIn("no setup", err)

    def test_wrong_setup_for_asset(self):
        code, _, err = self.run_tool("trader-entry", "entry", ["TSLA", "--setup", "asia_range", "--no-html"])
        self.assertEqual(code, 2)
        self.assertIn("not defined for stock", err)

    def test_premarket_waits_for_open(self):
        self.set_now("2026-10-20T12:00:00Z")
        code, out, err = self.run_tool("trader-entry", "entry", ["TSLA", "--no-html"])
        self.assertEqual(code, 0, err)
        self.assertIn("FORMING — waiting for the 9:30 ET open", out)
        self.assertIn("Market pre-market", out)

    def test_follow_with_pinned_clock_is_single_check(self):
        code, out, err = self.run_tool("trader-entry", "entry", ["TSLA", "--follow", "--no-html"])
        self.assertEqual(code, 0, err)
        self.assertIn("single check", out)


if __name__ == "__main__":
    unittest.main()
