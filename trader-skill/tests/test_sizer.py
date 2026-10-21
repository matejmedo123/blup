"""Position sizer: risk-based size, caps, rounding, orders.json."""
from __future__ import annotations

import json
import unittest

from tests.helpers import DEMOS, MEME_PASS, TOKENS, TraderTestCase

TSLA_ID = "TSLA-20261020-orb15"
BTC_ID = "BTCUSD-20261020-asia_range"
MEME_ID = "solana-%s-20261020-momentum" % TOKENS["PUPKIN"]["address"]


def plans() -> dict:
    """The three demo plans in trader/plan.json format (what /trader-exit writes)."""
    meme_entry, meme_stop = 0.004712, 0.00429
    btc_entry, btc_stop = 67448.60, 67310.00
    return {
        TSLA_ID: {
            "id": TSLA_ID, "symbol": "TSLA", "asset": "stock", "setup": "orb15", "direction": "long",
            "entry": {"price": 364.18, "time": "2026-10-20T14:15:00Z"},
            "stop": {"price": 358.32, "method": "range_low", "note": "below the opening-range low"},
            "target": {"price": 375.90, "r_multiple": 2.0}, "risk_per_unit": 5.86,
            "time_stop": {"at": "2026-10-20T19:55:00Z", "rule": "flat by 3:55 p.m. ET"},
            "horizon": {"end": "2026-10-20T20:00:00Z", "label": "rest of the session"},
            "trailing": None, "scale_out": [], "liquidity_exit": None, "atr": 1.74, "interval": "5m"},
        BTC_ID: {
            "id": BTC_ID, "symbol": "BTC-USD", "asset": "crypto", "setup": "asia_range", "direction": "long",
            "entry": {"price": btc_entry, "time": "2026-10-20T14:40:00Z"},
            "stop": {"price": btc_stop, "method": "level", "note": "below the breakout level"},
            "target": {"price": round(btc_entry + 2 * (btc_entry - btc_stop), 2), "r_multiple": 2.0},
            "risk_per_unit": round(btc_entry - btc_stop, 2),
            "time_stop": {"at": "2026-10-20T18:40:00Z", "rule": "4h horizon"},
            "horizon": {"end": "2026-10-20T18:40:00Z", "label": "4h"},
            "trailing": None, "scale_out": [], "liquidity_exit": None, "atr": 110.0, "interval": "5m"},
        MEME_ID: {
            "id": MEME_ID, "symbol": MEME_PASS, "asset": "meme", "setup": "momentum", "direction": "long",
            "entry": {"price": meme_entry, "time": "2026-10-20T15:55:00Z"},
            "stop": {"price": meme_stop, "method": "range_low", "note": "below the 6-bar low"},
            "target": {"price": round(meme_entry + 3 * (meme_entry - meme_stop), 9), "r_multiple": 3.0},
            "risk_per_unit": round(meme_entry - meme_stop, 9),
            "time_stop": {"at": "2026-10-20T19:55:00Z", "rule": "4h horizon"},
            "horizon": {"end": "2026-10-20T19:55:00Z", "label": "4h"}, "trailing": None,
            "scale_out": [{"fraction": 0.5, "at_multiple": 2.0, "price": meme_entry * 2,
                           "note": "sell half at 2x — recovers the initial stake"}],
            "liquidity_exit": {"drop_pct": 30, "liquidity_at_entry_usd": 412350.0, "exit_below_usd": 288645.0},
            "atr": 0.00006, "interval": "5m"},
    }


def write_plans(case, latest: str = TSLA_ID) -> None:
    case.write_state("plan.json", {"plans": plans(), "latest": latest})


def rugcheck_doc(verdict: str, checked_at: str, address: str, reasons=None, score=None) -> dict:
    return {"chain": "solana", "address": address, "symbol": "X", "name": "X", "pair_address": "pool",
            "dex": "raydium", "checked_at": checked_at, "score": score if score is not None else (88 if verdict == "SAFE" else 12),
            "verdict": verdict, "headline": "", "checks": [], "reasons": reasons or [], "metrics": {},
            "sources": {}, "warnings": []}


class SizerTest(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def setUp(self):
        super().setUp()
        write_plans(self)

    def test_help(self):
        code, out, _ = self.run_tool("trader-sizer", "size", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("usage", out.lower())
        self.assertIn("--risk-pct", out)

    def test_tsla_capped_by_max_position(self):
        res = self.run_json("trader-sizer", "size", ["--id", TSLA_ID])
        o = res["order"]
        self.assertEqual(o["qty"], 17)
        self.assertIsInstance(o["qty"], int)
        self.assertEqual(o["qty_unit"], "shares")
        self.assertAlmostEqual(o["sizing"]["raw_qty"], 125 / 5.86, places=2)
        self.assertAlmostEqual(o["limit_price"], 364.20, places=2)
        self.assertAlmostEqual(o["risk_usd"], 99.62, places=2)
        self.assertAlmostEqual(o["notional_usd"], 6191.06, places=2)
        self.assertTrue(any(c.startswith("max_position_pct 25%") for c in o["sizing"]["caps"]))
        self.assertEqual(o["status"], "proposed")
        self.assertTrue(o["paper"])
        saved = self.read_state("orders.json")["orders"]
        self.assertEqual([x["id"] for x in saved], [o["id"]])
        self.assertEqual(o["id"], "ord-TSLA-20261020-141500")

    def test_text_line(self):
        code, out, _ = self.run_tool("trader-sizer", "size", [])
        self.assertEqual(code, 0)
        self.assertIn("BUY 17 TSLA ≈ $6,191 · risk $99.62 (0.40% of account)", out)
        self.assertIn("capped by max position 25%", out)
        self.assertIn("not financial advice", out)

    def test_rerun_replaces_proposed_order(self):
        self.run_json("trader-sizer", "size", ["--id", TSLA_ID])
        self.set_now("2026-10-20T14:16:00Z")
        self.run_json("trader-sizer", "size", ["--id", TSLA_ID])
        orders = self.read_state("orders.json")["orders"]
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0]["id"], "ord-TSLA-20261020-141600")

    def test_small_risk_no_cap(self):
        o = self.run_json("trader-sizer", "size", ["--id", TSLA_ID, "--risk-pct", "0.1"])["order"]
        self.assertEqual(o["qty"], 4)
        self.assertEqual(o["sizing"]["caps"], [])

    def test_fractional_shares(self):
        cfg = self.read_state("config.json") or {}
        if not cfg:
            self.run_json("trader-sizer", "size", ["--id", TSLA_ID])
            cfg = self.read_state("config.json")
        cfg["fractional_shares"] = True
        self.write_state("config.json", cfg)
        o = self.run_json("trader-sizer", "size", ["--id", TSLA_ID])["order"]
        self.assertAlmostEqual(o["qty"], 17.1618, places=4)
        self.assertLessEqual(o["notional_usd"], 6250.0)

    def test_crypto_lot_step_and_tick(self):
        self.set_now(DEMOS["btc"]["now"])
        o = self.run_json("trader-sizer", "size", ["--id", BTC_ID])["order"]
        self.assertEqual(o["qty_unit"], "coins")
        self.assertAlmostEqual(o["qty"], 0.05559, places=8)
        steps = o["qty"] / 0.00001
        self.assertAlmostEqual(steps, round(steps), places=6)
        self.assertAlmostEqual(o["limit_price"], 67462.09, places=2)
        self.assertLessEqual(o["position_pct"], 15.0 + 1e-9)

    def test_a_sub_cent_coin_gets_a_limit_near_its_price(self):
        size = __import__("tests.helpers", fromlist=["load"]).load("trader-sizer", "size")
        from shared import config, data
        real = data.lot_info
        data.lot_info = lambda symbol: {"step": 1.0, "tick": 0.01, "min_qty": 1.0, "min_notional": 1.0,
                                        "source": "test"}
        self.addCleanup(setattr, data, "lot_info", real)
        plan = dict(plans()[BTC_ID], symbol="HOTUSDT", entry={"price": 0.00001234, "time": "2026-10-20T14:40:00Z"},
                    stop={"price": 0.0000115}, risk_per_unit=0.00000084)
        o = size.size_order(plan, config.load_config(), config.load_limits(), account=1000)
        self.assertLess(o["limit_price"], 0.00001234 * 1.001)   # not a cent — 800× the price
        self.assertGreaterEqual(o["limit_price"], 0.00001234)

    def test_crypto_below_minimum_refused(self):
        self.set_now(DEMOS["btc"]["now"])
        code, out, err = self.run_tool("trader-sizer", "size", ["--id", BTC_ID, "--account", "20"])
        self.assertEqual(code, 2)
        self.assertIn("minimum", err)

    def test_meme_usd_amount_capped(self):
        self.set_now(DEMOS["meme"]["now"])
        code, out, _ = self.run_tool("trader-sizer", "size", ["--id", MEME_ID])
        self.assertEqual(code, 0, out)
        self.assertIn("Meme coins", out)  # stronger disclaimer
        o = self.read_state("orders.json")["orders"][-1]
        self.assertEqual(o["qty_unit"], "usd")
        self.assertAlmostEqual(o["qty"], 500.0)
        self.assertIsNone(o["limit_price"])
        self.assertAlmostEqual(o["liquidity_usd"], 412350.0)
        self.assertAlmostEqual(o["est_slippage_pct"], 0.2425, places=3)
        self.assertAlmostEqual(o["pool_pct"], 100 * 500 / 412350.0, places=3)
        self.assertEqual(o["chain"], "solana")
        self.assertEqual(o["address"], TOKENS["PUPKIN"]["address"])
        self.assertTrue(any("max_position_pct" in c for c in o["sizing"]["caps"]))
        self.assertIsNone(o["rugcheck"])

    def test_meme_size_usd_override(self):
        self.set_now(DEMOS["meme"]["now"])
        o = self.run_json("trader-sizer", "size", ["--id", MEME_ID, "--size-usd", "120"])["order"]
        self.assertAlmostEqual(o["qty"], 120.0)

    def test_meme_attaches_rugcheck(self):
        self.set_now(DEMOS["meme"]["now"])
        addr = TOKENS["PUPKIN"]["address"]
        self.write_state("rugcheck/solana-%s.json" % addr, rugcheck_doc("SAFE", DEMOS["meme"]["now"], addr))
        o = self.run_json("trader-sizer", "size", ["--id", MEME_ID])["order"]
        self.assertEqual(o["rugcheck"]["verdict"], "SAFE")

    def test_missing_plan(self):
        code, _, err = self.run_tool("trader-sizer", "size", ["--id", "nope"])
        self.assertEqual(code, 2)
        self.assertIn("not found", err)

    def test_json_is_strict(self):
        code, out, _ = self.run_tool("trader-sizer", "size", ["--json"])
        self.assertEqual(code, 0)
        json.loads(out, parse_constant=lambda c: self.fail("non-standard JSON constant %s" % c))


if __name__ == "__main__":
    unittest.main()
