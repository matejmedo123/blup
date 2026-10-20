"""Exit Planner: stop / target / time stop, meme scale-outs and the liquidity exit."""
from __future__ import annotations

import unittest

from tests.helpers import DEMOS, MEME_PASS, TOKENS, TraderTestCase, load

from shared.indicators import Candle

TSLA_ID = "TSLA-20261020-orb15"
TSLA_ENTRY = {
    "id": TSLA_ID, "symbol": "TSLA", "asset": "stock", "setup": "orb15",
    "label": "Opening-range breakout (15 min)", "direction": "long", "status": "triggered",
    "entry_price": 364.18,
    "levels": {"range_high": 362.18, "range_low": 358.32, "trigger_level": 362.18, "stop_ref": 358.32},
    "trigger": {"time": "2026-10-20T14:10:00Z", "close_time": "2026-10-20T14:15:00Z", "price": 364.18},
    "checked_at": "2026-10-20T14:15:00Z",
}


def flat_candles(n=40, px=100.0, rng=1.0, start=1792500000):
    return [Candle(start + 300 * i, px, px + rng / 2, px - rng / 2, px, 1000.0) for i in range(n)]


class ExitPlanTests(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def test_help(self):
        code, out, _ = self.run_tool("trader-exit", "exit", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--target-r", out)
        self.assertIn("--offline", out)

    def test_plan_from_tsla_entry(self):
        self.write_state("entries.json", {"entries": {TSLA_ID: TSLA_ENTRY}, "latest": TSLA_ID})
        out = self.run_json("trader-exit", "exit", [])
        plan = out["plan"]
        self.assertEqual(plan["id"], TSLA_ID)
        self.assertEqual(plan["stop"]["price"], 358.32)
        self.assertEqual(plan["stop"]["method"], "range_low")
        self.assertEqual(plan["target"]["price"], 375.90)
        self.assertEqual(plan["target"]["r_multiple"], 2.0)
        self.assertAlmostEqual(plan["risk_per_unit"], 5.86, places=6)
        self.assertEqual(plan["time_stop"]["at"], "2026-10-20T19:55:00Z")
        self.assertEqual(plan["time_stop"]["rule"], "flat by 3:55 p.m. ET")
        self.assertEqual(plan["horizon"]["end"], "2026-10-20T20:00:00Z")
        self.assertIn("disclaimer", out)
        doc = self.read_state("plan.json")
        self.assertEqual(doc["latest"], TSLA_ID)
        self.assertIn(TSLA_ID, doc["plans"])
        self.assertTrue((self.home / plan["chart"]).exists())

    def test_text_output(self):
        self.write_state("entries.json", {"entries": {TSLA_ID: TSLA_ENTRY}, "latest": TSLA_ID})
        code, out, err = self.run_tool("trader-exit", "exit", ["--id", TSLA_ID, "--no-html"])
        self.assertEqual(code, 0, err)
        self.assertIn("Get in $364.18 · Stop $358.32 · Target $375.90 (2R) · Time stop 3:55 p.m. ET", out)
        self.assertIn("below the opening range low", out)
        self.assertIn("not financial advice", out)

    def test_untriggered_entry_is_refused(self):
        rec = dict(TSLA_ENTRY, status="watching")
        self.write_state("entries.json", {"entries": {TSLA_ID: rec}, "latest": TSLA_ID})
        code, _, err = self.run_tool("trader-exit", "exit", ["--no-html"])
        self.assertEqual(code, 2)
        self.assertIn("no triggered entry", err)

    def test_btc_stop_below_breakout_level(self):
        self.set_now(DEMOS["btc"]["now"])
        out = self.run_json("trader-exit", "exit", [
            "BTC-USD", "--entry", "67448.60", "--entry-time", DEMOS["btc"]["now"], "--stop-ref", "66612.40",
            "--trigger-level", "67420", "--setup", "asia_range", "--no-html"])
        plan = out["plan"]
        self.assertEqual(plan["asset"], "crypto")
        self.assertEqual(plan["stop"]["method"], "below_level")
        self.assertTrue(66612.40 < plan["stop"]["price"] < 67420.0)
        self.assertEqual(plan["time_stop"]["at"], "2026-10-20T18:40:00Z")
        self.assertIn("4h horizon", plan["time_stop"]["rule"])
        self.assertAlmostEqual(plan["target"]["price"] - 67448.60, 2 * plan["risk_per_unit"], delta=0.02)

    def test_meme_scale_out_and_liquidity_exit(self):
        self.set_now(DEMOS["meme"]["now"])
        out = self.run_json("trader-exit", "exit", [
            MEME_PASS, "--entry", "0.004712", "--entry-time", DEMOS["meme"]["now"], "--stop-ref", "0.00429",
            "--trigger-level", "0.004424", "--setup", "momentum", "--no-html"])
        plan = out["plan"]
        self.assertEqual(plan["asset"], "meme")
        self.assertEqual(plan["target"]["r_multiple"], 3.0)
        self.assertEqual(plan["symbol"], "solana:" + TOKENS["PUPKIN"]["address"])
        so = plan["scale_out"][0]
        self.assertEqual((so["fraction"], so["at_multiple"]), (0.5, 2.0))
        self.assertAlmostEqual(so["price"], 0.009424, places=9)
        self.assertIn("recovers the initial stake", so["note"])
        le = plan["liquidity_exit"]
        self.assertEqual(le["drop_pct"], 30.0)
        self.assertAlmostEqual(le["liquidity_at_entry_usd"], 412350.0)
        self.assertAlmostEqual(le["exit_below_usd"], 288645.0)
        self.assertEqual(plan["time_stop"]["at"], "2026-10-20T19:55:00Z")
        self.assertIn("Meme coins", out["disclaimer"])

    def test_trailing_and_bad_input(self):
        self.write_state("entries.json", {"entries": {TSLA_ID: TSLA_ENTRY}, "latest": TSLA_ID})
        out = self.run_json("trader-exit", "exit", ["--trail", "breakeven:1", "--no-html"])
        self.assertEqual(out["plan"]["trailing"], {"type": "breakeven_at_r", "value": 1.0})
        code, _, err = self.run_tool("trader-exit", "exit", ["--stop", "wherever", "--no-html"])
        self.assertEqual(code, 2)
        self.assertIn("--stop", err)
        code, _, err = self.run_tool("trader-exit", "exit", ["--stop", "370", "--no-html"])
        self.assertEqual(code, 2)
        self.assertIn("below entry", err)


class PlanLevelsTests(TraderTestCase):
    def setUp(self):
        super().setUp()
        self.ex = load("trader-exit", "exit")

    def test_auto_prefers_structure_when_close(self):
        c = flat_candles(rng=1.0)  # ATR = 1.0
        lv = self.ex.plan_levels(100.0, c[-1].t + 300, "crypto", c, stop_ref=97.0, trigger_level=99.0, tick=0.01)
        self.assertEqual(lv["stop"]["method"], "range_low")
        self.assertEqual(lv["stop"]["price"], 97.0)
        self.assertEqual(lv["target"]["price"], 106.0)

    def test_auto_uses_breakout_level_when_structure_far(self):
        c = flat_candles(rng=1.0)
        lv = self.ex.plan_levels(100.0, c[-1].t + 300, "crypto", c, stop_ref=90.0, trigger_level=99.5, tick=0.01)
        self.assertEqual(lv["stop"]["method"], "below_level")
        self.assertEqual(lv["stop"]["price"], 98.5)

    def test_atr_fallback_and_rounding(self):
        c = flat_candles(rng=1.0)
        lv = self.ex.plan_levels(100.0, c[-1].t + 300, "crypto", c, tick=0.01)
        self.assertEqual(lv["stop"]["method"], "atr")
        self.assertEqual(lv["stop"]["price"], 98.5)
        self.assertEqual(self.ex.round_price(98.567, "stock", 0.01, "down"), 98.56)
        self.assertEqual(self.ex.round_price(98.565, "stock", 0.01, "nearest"), 98.57)
        self.assertEqual(self.ex.round_price(0.004348979, "meme", None, "down"), 0.00434897)
        self.assertEqual(self.ex.round_price(0.004348979, "meme", None, "nearest"), 0.00434898)

    def test_early_close_time_stop(self):
        # Nov 27 2026 closes at 1:00 p.m. ET (EST, UTC-5) → flat by 12:55 p.m. = 17:55Z
        lv = self.ex.plan_levels(100.0, 1795795200, "stock", [], stop_ref=98.0)
        self.assertEqual(lv["time_stop"]["at"], "2026-11-27T17:55:00Z")
        self.assertEqual(lv["time_stop"]["rule"], "flat by 12:55 p.m. ET")

    def test_stop_must_be_below_entry(self):
        with self.assertRaises(ValueError):
            self.ex.plan_levels(100.0, 1792500000, "crypto", flat_candles(), stop="101", tick=0.01)

    def test_parsers(self):
        self.assertIsNone(self.ex.parse_trail("none"))
        self.assertEqual(self.ex.parse_trail("atr:2"), {"type": "atr", "value": 2.0})
        self.assertEqual(self.ex.parse_trail("pct:5")["type"], "pct")
        with self.assertRaises(ValueError):
            self.ex.parse_trail("moon:3")
        so = self.ex.parse_scale("0.25@4,0.5@2", 1.0, "meme")
        self.assertEqual([s["at_multiple"] for s in so], [2.0, 4.0])
        with self.assertRaises(ValueError):
            self.ex.parse_scale("0.8@2,0.5@3", 1.0, "meme")


if __name__ == "__main__":
    unittest.main()
