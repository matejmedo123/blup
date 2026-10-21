"""Risk manager: every limit, PASS/BLOCK, meme rugcheck gate, order hash."""
from __future__ import annotations

import unittest
from datetime import timedelta

from shared import market_clock
from tests.helpers import DEMOS, MEME_FAIL, TOKENS, TraderTestCase, load
from tests.test_sizer import BTC_ID, MEME_ID, TSLA_ID, rugcheck_doc, write_plans


def check_names(risk: dict, ok: bool) -> set:
    return {c["name"] for c in risk["checks"] if c["ok"] is ok}


class RiskTest(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def setUp(self):
        super().setUp()
        write_plans(self)

    def size(self, plan_id=TSLA_ID, *extra):
        return self.run_json("trader-sizer", "size", ["--id", plan_id] + list(extra))["order"]

    def risk(self, *argv):
        return self.run_json("trader-risk", "risk", list(argv))

    def test_help(self):
        code, out, _ = self.run_tool("trader-risk", "risk", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--order", out)

    def test_tsla_pass_saved_and_logged(self):
        order = self.size()
        res = self.risk()
        self.assertEqual(res["order_id"], order["id"])
        self.assertEqual(res["risk"]["result"], "PASS", res["risk"]["reasons"])
        saved = self.read_state("orders.json")["orders"][0]
        self.assertEqual(saved["status"], "risk_pass")
        self.assertEqual(saved["risk"]["order_hash"], load("trader-risk", "risk").order_hash(saved))
        log = (self.home / "risk_log.jsonl").read_text().strip().splitlines()
        self.assertEqual(len(log), 1)
        self.assertIn('"PASS"', log[0])

    def test_text_output(self):
        self.size()
        code, out, _ = self.run_tool("trader-risk", "risk", [])
        self.assertEqual(code, 0)
        self.assertIn("PASS ✓", out)
        self.assertIn("max_risk_per_trade", out)

    def test_block_is_exit_zero_and_adhoc_not_saved(self):
        self.size()
        code, out, _ = self.run_tool("trader-risk", "risk", ["--symbol", "TSLA", "--qty", "60", "--entry", "364.18",
                                                              "--stop", "358.32"])
        self.assertEqual(code, 0)
        self.assertIn("BLOCK ✗", out)
        res = self.risk("--symbol", "TSLA", "--qty", "60", "--entry", "364.18", "--stop", "358.32")
        self.assertEqual(res["risk"]["result"], "BLOCK")
        self.assertIn("max_risk_per_trade", check_names(res["risk"], False))
        self.assertIn("max_position_pct", check_names(res["risk"], False))
        self.assertEqual(self.read_state("orders.json")["orders"][0]["status"], "proposed")

    def test_blocked_symbol(self):
        limits = self.read_state("limits.json") or (self.size() and self.read_state("limits.json"))
        limits["blocked_symbols"] = ["tsla"]
        self.write_state("limits.json", limits)
        res = self.risk("--symbol", "TSLA", "--qty", "1", "--entry", "364.18", "--stop", "358.32")
        self.assertIn("blocked_symbols", check_names(res["risk"], False))

    def test_shorts_leverage_options_and_missing_stop(self):
        r = self.risk("--symbol", "TSLA", "--qty", "1", "--entry", "364.18", "--stop", "370", "--side", "sell")
        self.assertIn("no_shorts", check_names(r["risk"], False))
        r = self.risk("--symbol", "BTCUSDT", "--qty", "0.01", "--entry", "67448.6", "--stop", "67310",
                      "--leverage", "3")
        self.assertIn("no_leverage", check_names(r["risk"], False))
        r = self.risk("--symbol", "TSLA261023C00370000", "--qty", "1", "--entry", "5.20", "--stop", "2.10")
        self.assertIn("no_options", check_names(r["risk"], False))
        r = self.risk("--symbol", "TSLA", "--qty", "1", "--entry", "364.18")
        self.assertIn("stop_defined", check_names(r["risk"], False))

    def test_daily_loss(self):
        self.size()
        trade = {"id": "trd-x", "asset": "stock", "symbol": "NVDA", "status": "closed", "qty": 10,
                 "entry": {"time": "2026-10-20T13:40:00Z", "price": 193.45},
                 "exit": {"time": "2026-10-20T14:00:00Z", "price": 145.45, "reason": "stop"}, "pnl_usd": -480.0}
        self.write_state("journal.json", {"trades": [trade]})
        res = self.risk()
        self.assertEqual(res["risk"]["result"], "BLOCK")
        self.assertIn("max_daily_loss", check_names(res["risk"], False))
        trade["pnl_usd"] = -520.0
        self.write_state("journal.json", {"trades": [trade]})
        res = self.risk("--order", res["order_id"])
        self.assertTrue(any("done for the day" in r for r in res["risk"]["reasons"]))
        # yesterday's loss does not count today
        trade["exit"]["time"] = "2026-10-19T19:00:00Z"
        self.write_state("journal.json", {"trades": [trade]})
        res = self.risk("--order", res["order_id"])
        self.assertEqual(res["risk"]["result"], "PASS", res["risk"]["reasons"])

    def test_max_open_positions(self):
        self.size()
        trades = [{"id": "trd-%d" % i, "asset": "stock", "symbol": s, "status": "open", "qty": 1,
                   "entry": {"time": "2026-10-20T13:45:00Z", "price": 100.0}} for i, s in enumerate("ABCDE")]
        self.write_state("journal.json", {"trades": trades})
        res = self.risk()
        self.assertIn("max_open_positions", check_names(res["risk"], False))

    def test_the_autopilots_waiting_entries_count_as_open(self):
        self.set_now(DEMOS["btc"]["now"])
        self.size(BTC_ID)
        items = {"p%d" % i: {"status": "pending", "asset": "crypto", "data_key": s, "order_id": "ord-%d" % i,
                             "qty": 2.0, "entry_plan": 2400.0} for i, s in enumerate(("ETHUSDT", "SOLUSDT"))}
        self.write_state("autopilot/book.json", {"items": items, "handled": {}})
        res = self.risk()
        self.assertIn("max_total_exposure", check_names(res["risk"], False))  # $9,600 waiting at the broker

    def test_max_daily_trades(self):
        self.size()
        rows = "".join('{"ts": "2026-10-20T13:5%d:00Z", "ticket_id": "t%d", "approved": true, "asset": "stock"}\n'
                       % (i, i) for i in range(6))
        (self.home / "approvals.jsonl").write_text(rows)
        res = self.risk()
        self.assertIn("max_daily_trades", check_names(res["risk"], False))

    def test_crypto_pass_and_exposure_cap(self):
        self.set_now(DEMOS["btc"]["now"])
        self.size(BTC_ID)
        res = self.risk()
        self.assertEqual(res["risk"]["result"], "PASS", res["risk"]["reasons"])
        open_trade = {"id": "trd-eth", "asset": "crypto", "symbol": "ETHUSDT", "status": "open", "qty": 5.0,
                      "entry": {"time": "2026-10-20T10:00:00Z", "price": 2400.0}}
        self.write_state("journal.json", {"trades": [open_trade]})
        res = self.risk("--order", res["order_id"])
        self.assertIn("max_total_exposure", check_names(res["risk"], False))

    def test_meme_without_rugcheck_always_blocked(self):
        self.set_now(DEMOS["meme"]["now"])
        self.size(MEME_ID)
        res = self.risk()
        self.assertEqual(res["risk"]["result"], "BLOCK")
        self.assertTrue(any("run /trader-rugcheck" in r for r in res["risk"]["reasons"]))

    def test_meme_with_fresh_safe_rugcheck_passes(self):
        now = DEMOS["meme"]["now"]
        self.set_now(now)
        addr = TOKENS["PUPKIN"]["address"]
        self.write_state("rugcheck/solana-%s.json" % addr, rugcheck_doc("SAFE", now, addr))
        self.size(MEME_ID)
        res = self.risk()
        self.assertEqual(res["risk"]["result"], "PASS", res["risk"]["reasons"])
        self.assertTrue({"rugcheck_passed", "min_liquidity", "max_slippage", "max_pct_of_pool"}
                        <= check_names(res["risk"], True))

    def test_meme_stale_rugcheck_blocked(self):
        now = market_clock.parse_iso(DEMOS["meme"]["now"])
        self.set_now(DEMOS["meme"]["now"])
        addr = TOKENS["PUPKIN"]["address"]
        old = market_clock.iso(now - timedelta(hours=2))
        self.write_state("rugcheck/solana-%s.json" % addr, rugcheck_doc("SAFE", old, addr))
        self.size(MEME_ID)
        res = self.risk()
        self.assertIn("rugcheck_passed", check_names(res["risk"], False))

    def test_meme_danger_blocked_with_reasons(self):
        now = DEMOS["meme"]["now"]
        self.set_now(now)
        addr = TOKENS["MLAMBO"]["address"]
        reasons = ["LP not locked or burned (0% locked)", "Top holder owns 40.0% of supply"]
        self.write_state("rugcheck/solana-%s.json" % addr, rugcheck_doc("DANGER", now, addr, reasons))
        code, out, _ = self.run_tool("trader-risk", "risk", ["--symbol", MEME_FAIL, "--notional", "100",
                                                              "--entry", "0.000918", "--stop", "0.0008"])
        self.assertEqual(code, 0)
        self.assertIn("BLOCK", out)
        self.assertIn("rugcheck DANGER", out)
        self.assertIn("LP not locked or burned (0% locked)", out)
        self.assertIn("Top holder owns 40.0% of supply", out)
        self.assertIn("Meme coins", out)

    def test_order_hash_changes_with_size(self):
        risk = load("trader-risk", "risk")
        o = self.size()
        h1 = risk.order_hash(o)
        o2 = dict(o, qty=18)
        self.assertNotEqual(h1, risk.order_hash(o2))
        self.assertEqual(h1, risk.order_hash(dict(o, status="ticketed", risk={"x": 1})))

    def test_no_order_is_input_error(self):
        code, _, err = self.run_tool("trader-risk", "risk", [])
        self.assertEqual(code, 2)
        self.assertIn("trader-sizer", err)


if __name__ == "__main__":
    unittest.main()
