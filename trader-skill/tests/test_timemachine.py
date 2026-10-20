"""Time Machine: block-bootstrap replays of a planned trade (offline fixtures)."""
from __future__ import annotations

import unittest

from tests.helpers import DEMOS, MEME_PASS, TOKENS, TraderTestCase

SKILL = "trader-timemachine"

TSLA_PLAN = {
    "id": "TSLA-20261020-orb15", "symbol": "TSLA", "asset": "stock", "setup": "orb15", "direction": "long",
    "entry": {"price": 364.18, "time": "2026-10-20T14:15:00Z"},
    "stop": {"price": 358.32, "method": "range_low", "note": "below the opening-range low"},
    "target": {"price": 375.90, "r_multiple": 2.0}, "risk_per_unit": 5.86,
    "time_stop": {"at": "2026-10-20T19:55:00Z", "rule": "flat by 3:55 p.m. ET"},
    "horizon": {"end": "2026-10-20T20:00:00Z", "label": "rest of the session"},
    "trailing": None, "scale_out": [], "liquidity_exit": None, "atr": 1.74, "interval": "5m",
}
BTC_PLAN = {
    "id": "BTCUSD-20261020-asia_range", "symbol": "BTC-USD", "asset": "crypto", "setup": "asia_range",
    "direction": "long", "entry": {"price": 67448.60, "time": "2026-10-20T14:40:00Z"},
    "stop": {"price": 67310.00, "method": "level"}, "target": {"price": 67725.80, "r_multiple": 2.0},
    "time_stop": {"at": "2026-10-20T18:40:00Z", "rule": "4h horizon"},
    "horizon": {"end": "2026-10-20T18:40:00Z", "label": "next 4 hours"},
    "trailing": None, "scale_out": [], "liquidity_exit": None, "atr": 110.0, "interval": "5m",
}
MEME_ID = "solana-%s-20261020-momentum" % TOKENS["PUPKIN"]["address"]
MEME_PLAN = {
    "id": MEME_ID, "symbol": MEME_PASS, "asset": "meme", "setup": "momentum", "direction": "long",
    "entry": {"price": 0.004712, "time": "2026-10-20T15:55:00Z"},
    "stop": {"price": 0.00429, "method": "range"}, "target": {"price": 0.005978, "r_multiple": 3.0},
    "time_stop": {"at": "2026-10-20T19:55:00Z", "rule": "4h horizon"},
    "horizon": {"end": "2026-10-20T19:55:00Z", "label": "next 4 hours"},
    "trailing": None, "scale_out": [{"fraction": 0.5, "at_multiple": 2.0, "price": 0.009424}],
    "liquidity_exit": {"drop_pct": 30, "liquidity_at_entry_usd": 412350.0, "exit_below_usd": 288645.0},
    "interval": "5m",
}


class TimeMachineCase(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def write_plans(self, latest="TSLA-20261020-orb15"):
        self.write_state("plan.json", {"plans": {TSLA_PLAN["id"]: TSLA_PLAN, BTC_PLAN["id"]: BTC_PLAN,
                                                 MEME_ID: MEME_PLAN}, "latest": latest})

    def replay(self, *argv):
        return self.run_json(SKILL, "replay", list(argv))


class TestReplay(TimeMachineCase):
    def test_help(self):
        for module in ("replay", "report"):
            code, out, _ = self.run_tool(SKILL, module, ["--help"])
            self.assertEqual(code, 0)
            self.assertIn("--offline", out)

    def test_no_plan_is_a_clear_error(self):
        code, _, err = self.run_tool(SKILL, "replay", ["--no-html"])
        self.assertEqual(code, 2)
        self.assertIn("/trader-exit", err)

    def test_tsla_replay_probabilities_and_files(self):
        self.write_plans()
        res = self.replay("--paths", "2000")
        p = res["probabilities"]
        self.assertAlmostEqual(sum(p.values()), 1.0, places=3)
        self.assertEqual(p["rug"], 0.0)
        self.assertGreater(p["target"], 0.05)
        self.assertGreater(p["stop"], 0.05)
        self.assertEqual(res["steps"], 69)  # 10:15 → 16:00 ET in 5-minute bars
        c = res["close"]
        self.assertLessEqual(c["p5"], c["median"])
        self.assertLessEqual(c["median"], c["p95"])
        self.assertEqual(res["history"]["sessions"], 60)
        self.assertFalse(res["history"]["thin_sample"])
        self.assertEqual(res["expected_value"]["qty"], 17)  # 0.5 % risk, capped by the 25 % position limit
        self.assertIn("I replayed the rest of today 2,000 times from TSLA", res["summary"])
        self.assertIn("not a prediction", res["summary"])
        saved = self.read_state("timemachine/TSLA-20261020.json")
        self.assertEqual(saved["probabilities"], p)
        self.assertEqual(len(saved["histogram"]["counts"]), 40)
        self.assertEqual(sum(saved["histogram"]["counts"]), 2000)
        self.assertTrue(0 < len(saved["sample_paths"]) <= 200)
        self.assertEqual(len(saved["sample_paths"][0]["prices"]), 70)
        html_file = self.home / "reports" / "timemachine-TSLA-20261020.html"
        text = html_file.read_text(encoding="utf-8")
        self.assertIn("simulated sessions", text)
        self.assertIn("Target $375.90", text)
        self.assertIn("not a prediction", text)

    def test_same_seed_same_result(self):
        self.write_plans()
        a = self.replay("--paths", "1500", "--seed", "11", "--no-html")
        b = self.replay("--paths", "1500", "--seed", "11", "--no-html")
        c = self.replay("--paths", "1500", "--seed", "12", "--no-html")
        self.assertEqual(a["probabilities"], b["probabilities"])
        self.assertEqual(a["close"], b["close"])
        self.assertNotEqual(a["close"], c["close"])

    def test_no_lookahead(self):
        """Replays use only bars that closed by the entry, whatever the clock says."""
        self.write_plans()
        self.set_now(DEMOS["tsla"]["after_close"])
        res = self.replay("--paths", "500", "--no-html")
        self.assertEqual(res["history"]["last"], "2026-10-20T14:10:00Z")

    def test_order_sets_position(self):
        self.write_plans()
        self.write_state("orders.json", {"orders": [{"id": "ord-1", "plan_id": TSLA_PLAN["id"], "qty": 10,
                                                     "qty_unit": "shares", "status": "proposed"}]})
        res = self.replay("--paths", "500", "--no-html")
        ev = res["expected_value"]
        self.assertEqual(ev["qty"], 10)
        self.assertAlmostEqual(ev["risk_usd"], 58.6, places=2)
        self.assertAlmostEqual(ev["usd"], ev["r"] * 58.6, delta=0.02)

    def test_backtest_comparison_read_from_file(self):
        self.write_plans()
        self.write_state("backtests/TSLA-orb15.json", {
            "symbol": "TSLA", "setup": "orb15", "windows": 59, "triggers": 33, "target": 13, "stop": 15,
            "neither": 5, "p_target": 0.394, "p_stop": 0.45, "p_neither": 0.152, "avg_r": 0.12,
            "summary": "Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop, 5 neither."})
        res = self.replay("--paths", "500")
        self.assertEqual(res["backtest"]["triggers"], 33)
        self.assertIn("Backtest of this setup: 39% target / 45% stop over 33 triggers", res["summary"])
        html_text = (self.home / "reports" / "timemachine-TSLA-20261020.html").read_text(encoding="utf-8")
        self.assertIn("Last 59 sessions", html_text)

    def test_text_output(self):
        self.write_plans()
        code, out, err = self.run_tool(SKILL, "replay", ["--paths", "500", "--no-html"])
        self.assertEqual(code, 0, err)
        self.assertIn("Target first", out)
        self.assertIn("9 in 10 close between", out)
        self.assertIn("not financial advice", out)


class TestCryptoReplay(TimeMachineCase):
    NOW = DEMOS["btc"]["now"]

    def test_btc_four_hour_window(self):
        self.write_plans(BTC_PLAN["id"])
        res = self.replay("--paths", "1500", "--no-html")
        self.assertEqual(res["steps"], 48)
        self.assertEqual(res["asset"], "crypto")
        self.assertIn("next 4 hours", res["summary"])
        self.assertAlmostEqual(sum(res["probabilities"].values()), 1.0, places=3)
        self.assertIn("asia", res["method"]["buckets"])
        self.assertTrue(self.read_state("timemachine/BTCUSD-20261020.json"))

    def test_horizon_override(self):
        self.write_plans(BTC_PLAN["id"])
        res = self.replay("--paths", "500", "--no-html", "--horizon", "1h")
        self.assertEqual(res["steps"], 12)
        self.assertEqual(res["horizon_end"], "2026-10-20T15:40:00Z")


class TestMemeReplay(TimeMachineCase):
    NOW = DEMOS["meme"]["now"]

    def test_thin_sample_and_rug_scenario(self):
        self.write_plans(MEME_ID)
        res = self.replay("--paths", "3000")
        self.assertTrue(res["history"]["thin_sample"])
        self.assertTrue(any("thin sample" in w for w in res["warnings"]))
        self.assertIn("sample is thin", res["summary"])
        self.assertGreater(res["method"]["rug_share"], 0)
        self.assertGreater(res["probabilities"]["rug"], 0)
        self.assertGreater(res["method"]["exit_slippage_pct"], 0)
        self.assertEqual(res["expected_value"]["qty_unit"], "usd")
        self.assertIn("Meme coins", res["disclaimer"])
        name = "timemachine-solana-%s-20261020.html" % TOKENS["PUPKIN"]["address"]
        self.assertIn("rug pull", (self.home / "reports" / name).read_text(encoding="utf-8"))

    def test_rugcheck_score_sets_rug_share(self):
        self.write_plans(MEME_ID)
        self.write_state("rugcheck/solana-%s.json" % TOKENS["PUPKIN"]["address"],
                         {"score": 86, "verdict": "SAFE", "checked_at": DEMOS["meme"]["now"]})
        res = self.replay("--paths", "500", "--no-html")
        self.assertAlmostEqual(res["method"]["rug_share"], max(0.01, 0.03 * 4 / 24.0), places=4)
        self.assertIn("rugcheck score 86", res["method"]["rug_basis"])

    def test_no_rug(self):
        self.write_plans(MEME_ID)
        res = self.replay("--paths", "1000", "--no-rug", "--no-html")
        self.assertEqual(res["probabilities"]["rug"], 0.0)
        self.assertEqual(res["method"]["rug_share"], 0.0)

    def test_rug_share_override(self):
        self.write_plans(MEME_ID)
        res = self.replay("--paths", "2000", "--rug-share", "0.5", "--no-html")
        self.assertGreater(res["probabilities"]["rug"], 0.2)


class TestSimulationCore(TimeMachineCase):
    def test_rug_path_exits_at_collapsed_price(self):
        rp = __import__("tests.helpers", fromlist=["load"]).load(SKILL, "replay")
        recs = [(1000 + 300 * i, 0.0, 0.001, -0.001, "us", 1) for i in range(50)]
        lv = {"entry": 1.0, "stop": 0.9, "target": 1.3, "risk": 0.1}
        scales = {"_global": {"scale": 1.0, "mean": 0.0}, "us": {"scale": 1.0, "mean": 0.0}}
        sim = rp.simulate(recs, lv, 100000 * 300, 100000 * 300 + 12 * 300, 100000 * 300 + 12 * 300, 300, "meme",
                          scales, 6, 200, 3, rug_share=1.0, keep=5)
        self.assertEqual(sim["counts"]["rug"], 200)
        self.assertTrue(all(abs(r + 9.0) < 1e-6 for r in sim["r"]))  # 1.0 → 0.1 with a 0.1 risk = −9R

    def test_flat_history_never_hits_far_levels(self):
        rp = __import__("tests.helpers", fromlist=["load"]).load(SKILL, "replay")
        recs = [(1000 + 300 * i, 0.0, 0.0005, -0.0005, "us", 1) for i in range(50)]
        lv = {"entry": 100.0, "stop": 90.0, "target": 120.0, "risk": 10.0}
        scales = {"_global": {"scale": 1.0, "mean": 0.0}}
        start = 100000 * 300
        sim = rp.simulate(recs, lv, start, start + 24 * 300, start + 24 * 300, 300, "crypto", scales, 6, 300, 1)
        self.assertEqual(sim["counts"]["neither"], 300)
        self.assertTrue(all(abs(c - 100.0) < 1e-9 for c in sim["closes"]))


if __name__ == "__main__":
    unittest.main()
