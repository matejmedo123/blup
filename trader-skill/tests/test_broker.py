"""Order executor: tickets, the explicit-yes protocol, verbatim approvals, never any network."""
from __future__ import annotations

import json
import re
import unittest

from tests.helpers import DEMOS, ROOT, TOKENS, TraderTestCase
from tests.test_sizer import BTC_ID, MEME_ID, TSLA_ID, rugcheck_doc, write_plans


class BrokerTest(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def setUp(self):
        super().setUp()
        write_plans(self)

    def passed_order(self, plan_id=TSLA_ID):
        self.run_json("trader-sizer", "size", ["--id", plan_id])
        res = self.run_json("trader-risk", "risk", [])
        self.assertEqual(res["risk"]["result"], "PASS", res["risk"]["reasons"])
        return res["order_id"]

    def ticket(self, *argv):
        return self.run_json("trader-broker", "ticket", list(argv))

    def approvals(self) -> list:
        p = self.home / "approvals.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def test_help(self):
        code, out, _ = self.run_tool("trader-broker", "ticket", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("approve", out)

    def test_no_network_code_paths(self):
        src = (ROOT / "trader-broker" / "ticket.py").read_text()
        self.assertNotIn("urllib", src)
        self.assertNotIn("http.", src)
        imports = re.search(r"from shared import ([^\n#]+)", src).group(1)
        self.assertNotIn("data", imports.split(", "))
        self.assertNotIn("http", imports.split(", "))

    def test_prepare_requires_risk_pass(self):
        self.run_json("trader-sizer", "size", ["--id", TSLA_ID])
        code, _, err = self.run_tool("trader-broker", "ticket", ["prepare", "--order", "ord-TSLA-20261020-141500"])
        self.assertEqual(code, 2)
        self.assertIn("risk", err)

    def test_stock_ticket_text_and_payload(self):
        oid = self.passed_order()
        t = self.ticket("prepare")["ticket"]
        self.assertEqual(t["text"], "BUY 17 TSLA, limit $364.20, stop $358.32, day — PAPER")
        self.assertIn("take-profit $375.90 · bracket order", t["details"])
        self.assertEqual(t["status"], "awaiting_approval")
        self.assertEqual(t["order_id"], oid)
        p = t["payload"]
        self.assertEqual((p["connector"], p["tool"]), ("alpaca", "place_stock_order"))
        a = p["arguments"]
        self.assertEqual(a["quantity"], 17)
        self.assertEqual(a["order_class"], "bracket")
        self.assertEqual(a["time_in_force"], "day")
        self.assertAlmostEqual(a["limit_price"], 364.20)
        self.assertAlmostEqual(a["stop_loss_stop_price"], 358.32)
        self.assertAlmostEqual(a["take_profit_limit_price"], 375.90)
        self.assertEqual(a["client_order_id"], t["id"])
        self.assertEqual(self.read_state("orders.json")["orders"][0]["status"], "ticketed")
        code, out, _ = self.run_tool("trader-broker", "ticket", ["list"])
        self.assertIn("awaiting_approval", out)

    def test_prepare_text_asks_for_yes(self):
        self.passed_order()
        code, out, _ = self.run_tool("trader-broker", "ticket", ["prepare"])
        self.assertEqual(code, 0)
        self.assertIn("Reply yes to send this exact ticket to the PAPER account.", out)
        self.assertIn("Nothing has been sent", out)

    def test_yes_approves_once_and_is_recorded_verbatim(self):
        oid = self.passed_order()
        tid = self.ticket("prepare")["ticket"]["id"]
        res = self.ticket("approve", "--ticket", tid, "--reply", "yes")
        self.assertTrue(res["approved"])
        self.assertEqual(res["payload"]["tool"], "place_stock_order")
        rows = self.approvals()
        self.assertEqual(rows[-1]["user_reply"], "yes")
        self.assertTrue(rows[-1]["approved"])
        self.assertEqual(rows[-1]["ticket_text"], "BUY 17 TSLA, limit $364.20, stop $358.32, day — PAPER")
        self.assertEqual(self.read_state("orders.json")["orders"][0]["status"], "approved")
        self.assertEqual(self.read_state("tickets.json")["tickets"][0]["status"], "approved")
        again = self.ticket("approve", "--ticket", tid, "--reply", "yes")
        self.assertFalse(again["approved"])
        self.assertIn("single-use", again["reason"])
        code, _, err = self.run_tool("trader-broker", "ticket", ["prepare", "--order", oid])
        self.assertEqual(code, 2)
        self.assertIn("already approved", err)

    def test_anything_but_yes_does_not_approve(self):
        self.passed_order()
        tid = self.ticket("prepare")["ticket"]["id"]
        for reply in ("y", "sure", "yes please", "ok", "Yes, but smaller", ""):
            res = self.ticket("approve", "--ticket", tid, "--reply", reply)
            self.assertFalse(res["approved"], reply)
        rows = self.approvals()
        self.assertEqual([r["user_reply"] for r in rows], ["y", "sure", "yes please", "ok", "Yes, but smaller", ""])
        self.assertFalse(any(r["approved"] for r in rows))
        self.assertEqual(self.read_state("tickets.json")["tickets"][0]["status"], "awaiting_approval")
        self.assertTrue(self.ticket("approve", "--ticket", tid, "--reply", " Yes. ")["approved"])
        self.assertEqual(self.approvals()[-1]["user_reply"], " Yes. ")

    def test_expired_ticket_refused(self):
        self.passed_order()
        tid = self.ticket("prepare")["ticket"]["id"]
        self.set_now("2026-10-20T14:31:00Z")
        res = self.ticket("approve", "--ticket", tid, "--reply", "yes")
        self.assertFalse(res["approved"])
        self.assertIn("expired", res["reason"])
        self.assertFalse(self.approvals()[-1]["approved"])

    def test_stale_risk_check_refused(self):
        self.passed_order()
        self.set_now("2026-10-20T14:50:00Z")
        code, _, err = self.run_tool("trader-broker", "ticket", ["prepare"])
        self.assertEqual(code, 2)
        self.assertIn("re-run /trader-risk", err)

    def test_modified_order_refused(self):
        self.passed_order()
        tid = self.ticket("prepare")["ticket"]["id"]
        doc = self.read_state("orders.json")
        doc["orders"][0]["qty"] = 40
        self.write_state("orders.json", doc)
        res = self.ticket("approve", "--ticket", tid, "--reply", "yes")
        self.assertFalse(res["approved"])
        self.assertIn("changed", res["reason"])

    def test_live_refused_while_paper(self):
        self.passed_order()
        code, _, err = self.run_tool("trader-broker", "ticket", ["prepare", "--live"])
        self.assertEqual(code, 2)
        self.assertIn("paper", err)

    def test_live_needs_paper_false_and_yes(self):
        self.passed_order()
        cfg = self.read_state("config.json")
        cfg["paper"] = False
        self.write_state("config.json", cfg)
        t = self.ticket("prepare", "--live")["ticket"]
        self.assertTrue(t["text"].endswith("— LIVE (real money)"))
        self.assertEqual(t["payload"]["account"], "live")
        cfg["paper"] = True  # flipped back before the yes → refused
        self.write_state("config.json", cfg)
        self.assertFalse(self.ticket("approve", "--ticket", t["id"], "--reply", "yes")["approved"])
        cfg["paper"] = False
        self.write_state("config.json", cfg)
        self.assertTrue(self.ticket("approve", "--ticket", t["id"], "--reply", "yes")["approved"])

    def test_crypto_ticket(self):
        self.set_now(DEMOS["btc"]["now"])
        self.passed_order(BTC_ID)
        t = self.ticket("prepare")["ticket"]
        self.assertEqual(t["text"], "BUY 0.05559 BTC/USD, limit $67,462.09, gtc — PAPER")
        self.assertTrue(any("separate stop order" in d for d in t["details"]))
        self.assertEqual(t["payload"]["tool"], "place_crypto_order")
        self.assertEqual(t["payload"]["arguments"]["symbol"], "BTC/USD")
        self.assertEqual(t["payload"]["arguments"]["time_in_force"], "gtc")
        self.assertAlmostEqual(t["payload"]["arguments"]["qty"], 0.05559)

    def test_decline(self):
        self.passed_order()
        tid = self.ticket("prepare")["ticket"]["id"]
        res = self.ticket("decline", "--ticket", tid, "--reply", "no, skip it")
        self.assertFalse(res["approved"])
        self.assertEqual(self.read_state("tickets.json")["tickets"][0]["status"], "declined")
        self.assertEqual(self.approvals()[-1]["user_reply"], "no, skip it")
        self.assertFalse(self.ticket("approve", "--ticket", tid, "--reply", "yes")["approved"])

    def test_meme_manual_checklist_only(self):
        now = DEMOS["meme"]["now"]
        self.set_now(now)
        addr = TOKENS["PUPKIN"]["address"]
        self.write_state("rugcheck/solana-%s.json" % addr, rugcheck_doc("SAFE", now, addr))
        self.passed_order(MEME_ID)
        code, out, _ = self.run_tool("trader-broker", "ticket", ["prepare"])
        self.assertEqual(code, 0)
        self.assertIn("MANUAL SWAP", out)
        self.assertIn(addr, out)
        self.assertIn("rugcheck.xyz/tokens/%s" % addr, out)
        self.assertIn("solscan.io/token/%s" % addr, out)
        self.assertIn("Meme coins", out)
        t = self.read_state("tickets.json")["tickets"][0]
        self.assertEqual(t["status"], "manual_checklist")
        self.assertIsNone(t["payload"])
        res = self.ticket("approve", "--ticket", t["id"], "--reply", "yes")
        self.assertFalse(res["approved"])
        self.assertIn("manual checklist", res["reason"])


if __name__ == "__main__":
    unittest.main()
