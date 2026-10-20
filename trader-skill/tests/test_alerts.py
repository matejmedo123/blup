"""Price alerts and the NYSE calendar (offline fixtures)."""
from __future__ import annotations

import unittest
from unittest import mock

from tests.helpers import DEMOS, MEME_PASS, TOKENS, TraderTestCase, load

SKILL = "trader-alerts"

TSLA_PLAN = {
    "id": "TSLA-20261020-orb15", "symbol": "TSLA", "asset": "stock", "setup": "orb15",
    "entry": {"price": 364.18, "time": "2026-10-20T14:15:00Z"}, "stop": {"price": 358.32},
    "target": {"price": 375.90, "r_multiple": 2.0}, "interval": "5m",
}
MEME_ID = "solana-%s-20261020-momentum" % TOKENS["PUPKIN"]["address"]
MEME_PLAN = {
    "id": MEME_ID, "symbol": MEME_PASS, "asset": "meme", "setup": "momentum",
    "entry": {"price": 0.004712, "time": "2026-10-20T15:55:00Z"}, "stop": {"price": 0.00429},
    "target": {"price": 0.005978}, "interval": "5m",
    "liquidity_exit": {"drop_pct": 30, "liquidity_at_entry_usd": 412350.0},
}


class AlertsCase(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def alerts(self, *argv):
        return self.run_json(SKILL, "alerts", list(argv))

    def state_alerts(self):
        return (self.read_state("alerts.json") or {}).get("alerts", [])


class TestAlerts(AlertsCase):
    def test_help(self):
        for module in ("alerts", "nyse_calendar"):
            code, out, _ = self.run_tool(SKILL, module, ["--help"])
            self.assertEqual(code, 0)
            self.assertIn("--offline", out)

    def test_price_alert_rings_once(self):
        self.alerts("add", "TSLA", "--above", "364")
        first = self.alerts("check")
        self.assertEqual(len(first["fired"]), 1)
        self.assertIn("ALERT TSLA", first["fired"][0])
        self.assertIn("$364.00", first["fired"][0])
        second = self.alerts("check")
        self.assertEqual(second["fired"], [])
        a = self.state_alerts()[0]
        self.assertEqual(a["status"], "fired")
        self.assertAlmostEqual(a["fired_value"], 364.18, places=2)
        log = (self.home / "alerts_log.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(log), 1)

    def test_below_not_hit(self):
        self.alerts("add", "TSLA", "--below", "350")
        self.assertEqual(self.alerts("check")["fired"], [])
        self.assertEqual(self.state_alerts()[0]["status"], "active")

    def test_stock_alerts_wait_for_the_open(self):
        self.set_now("2026-10-24T15:00:00Z")  # Saturday
        self.alerts("add", "TSLA", "--above", "1")
        res = self.alerts("check")
        self.assertEqual(res["fired"], [])
        self.assertEqual(len(res["skipped"]), 1)
        self.assertEqual(res["market"]["state"], "closed")
        res = self.alerts("check", "--anytime")
        self.assertEqual(len(res["fired"]), 1)

    def test_opening_bell_once_per_day(self):
        self.set_now("2026-10-20T13:35:00Z")
        self.alerts("add", "--opening-bell")
        self.assertEqual(len(self.alerts("check")["fired"]), 1)
        self.assertEqual(self.alerts("check")["fired"], [])
        self.set_now("2026-10-21T13:00:00Z")  # 9:00 a.m. ET — pre-market
        self.assertEqual(self.alerts("check")["fired"], [])
        self.set_now("2026-10-21T13:31:00Z")
        self.assertEqual(len(self.alerts("check")["fired"]), 1)
        self.assertEqual(self.state_alerts()[0]["status"], "active")  # recurring

    def test_pct_move(self):
        self.alerts("add", "TSLA", "--pct-move", "0.5")
        res = self.alerts("check")
        self.assertEqual(len(res["fired"]), 1)  # 359.40 → 364.18 is +1.3 %
        self.assertIn("previous close", res["fired"][0])

    def test_from_plan(self):
        self.write_state("plan.json", {"plans": {TSLA_PLAN["id"]: TSLA_PLAN}, "latest": TSLA_PLAN["id"]})
        res = self.alerts("add", "--from-plan")
        kinds = sorted(a["type"] for a in res["added"])
        self.assertEqual(kinds, ["stop", "target"])
        self.assertEqual(self.alerts("check")["fired"], [])  # 364.18 is between stop and target
        self.set_now("2026-10-20T19:00:00Z")  # the fixture rallies through the target in the afternoon
        fired = self.alerts("check")["fired"]
        self.assertTrue(any("reached the target $375.90" in f for f in fired), fired)

    def test_remove_and_rearm(self):
        self.alerts("add", "TSLA", "--above", "364")
        self.alerts("check")
        self.alerts("rearm", "al-0001")
        self.assertEqual(self.state_alerts()[0]["status"], "active")
        self.assertEqual(len(self.alerts("check")["fired"]), 1)
        self.alerts("remove", "al-0001")
        self.assertEqual(self.state_alerts(), [])
        code, _, err = self.run_tool(SKILL, "alerts", ["remove", "al-0009"])
        self.assertEqual(code, 2)
        self.assertIn("no alert", err)

    def test_add_needs_exactly_one_type(self):
        code, _, err = self.run_tool(SKILL, "alerts", ["add", "TSLA"])
        self.assertEqual(code, 2)
        code, _, err = self.run_tool(SKILL, "alerts", ["add", "TSLA", "--above", "1", "--below", "2"])
        self.assertEqual(code, 2)
        code, _, err = self.run_tool(SKILL, "alerts", ["add", "TSLA", "--liquidity-drop", "30"])
        self.assertEqual(code, 2)
        self.assertIn("meme", err)


class TestCryptoAlerts(AlertsCase):
    NOW = DEMOS["btc"]["now"]

    def test_cross_between_two_checks(self):
        data = __import__("shared.data", fromlist=["get_quote"])
        p1 = data.get_quote("BTCUSDT")["price"]
        self.set_now("2026-10-20T16:30:00Z")
        p2 = data.get_quote("BTCUSDT")["price"]
        self.assertGreater(abs(p2 - p1), 50)
        level = round((p1 + p2) / 2, 2)
        self.set_now(DEMOS["btc"]["now"])
        self.alerts("add", "BTCUSDT", "--cross", str(level))
        self.assertEqual(self.alerts("check")["fired"], [])
        self.set_now("2026-10-20T16:30:00Z")
        fired = self.alerts("check")["fired"]
        self.assertEqual(len(fired), 1)
        self.assertIn("crossed %s" % ("above" if p2 > p1 else "below"), fired[0])

    def test_crypto_runs_on_weekends(self):
        self.alerts("add", "BTCUSDT", "--above", "1")
        self.set_now("2026-10-24T15:00:00Z")
        # fixtures end on Oct 20, so a Saturday clock has no fresh BTC bars — the check reports it, not crashes
        res = self.alerts("check")
        self.assertEqual(res["skipped"], [])


class TestMemeAlerts(AlertsCase):
    NOW = DEMOS["meme"]["now"]

    def test_liquidity_drop(self):
        res = self.alerts("add", MEME_PASS, "--liquidity-drop", "30")
        self.assertAlmostEqual(res["added"][0]["baseline"]["liquidity_usd"], 412350.0)
        self.assertIn("PUPKIN", res["added"][0]["display"])
        self.assertEqual(self.alerts("check")["fired"], [])
        doc = self.read_state("alerts.json")
        doc["alerts"][0]["baseline"]["liquidity_usd"] = 700000.0  # pretend the pool was deeper when we set it
        self.write_state("alerts.json", doc)
        fired = self.alerts("check")["fired"]
        self.assertEqual(len(fired), 1)
        self.assertIn("liquidity fell", fired[0])
        self.assertEqual(self.alerts("check")["fired"], [])

    def test_dev_selling_and_holder_jump(self):
        mod = load(SKILL, "alerts")
        snapshots = [{"creator_pct": 10.0, "top10_pct": 20.0}, {"creator_pct": 10.0, "top10_pct": 20.0},
                     {"creator_pct": 4.0, "top10_pct": 33.0}]
        with mock.patch.object(mod, "_safety_metrics", side_effect=snapshots + snapshots[-1:] * 4):
            self.alerts("add", MEME_PASS, "--dev-selling", "25")
            self.alerts("add", MEME_PASS, "--holder-jump", "10")
            fired = self.alerts("check")["fired"]
        self.assertEqual(len(fired), 2, fired)
        self.assertTrue(any("dev wallet share fell from 10.0% to 4.0%" in f for f in fired))
        self.assertTrue(any("top-10 holders now 33.0%" in f for f in fired))

    def test_meme_from_plan_adds_liquidity_exit(self):
        self.write_state("plan.json", {"plans": {MEME_ID: MEME_PLAN}, "latest": MEME_ID})
        res = self.alerts("add", "--from-plan")
        self.assertEqual(sorted(a["type"] for a in res["added"]), ["liquidity_drop", "stop", "target"])
        self.assertIn("Meme coins", res["disclaimer"])


class TestCalendar(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def test_2026_early_close_and_2027_holiday(self):
        cal26 = self.run_json(SKILL, "nyse_calendar", ["--year", "2026"])["calendar"]
        self.assertIn("2026-11-27", [e["date"] for e in cal26["early_closes"]])
        self.assertIn("2026-12-24", [e["date"] for e in cal26["early_closes"]])
        self.assertEqual(cal26["source"], "official NYSE calendar")
        cal27 = self.run_json(SKILL, "nyse_calendar", ["--year", "2027"])["calendar"]
        self.assertIn("2027-07-05", [h["date"] for h in cal27["holidays"]])
        cal28 = self.run_json(SKILL, "nyse_calendar", ["--year", "2028"])["calendar"]
        self.assertIn("rule-based", cal28["source"])

    def test_status_and_next_sessions(self):
        res = self.run_json(SKILL, "nyse_calendar", ["--status", "--next", "3"])
        self.assertEqual(res["status"]["state"], "open")
        self.assertEqual([s["date"] for s in res["next_sessions"]], ["2026-10-20", "2026-10-21", "2026-10-22"])
        self.set_now("2026-11-26T15:00:00Z")  # Thanksgiving
        res = self.run_json(SKILL, "nyse_calendar", ["--next", "1"])
        self.assertEqual(res["status"]["holiday"], "Thanksgiving Day")
        self.assertEqual(res["next_sessions"][0]["date"], "2026-11-27")
        self.assertTrue(res["next_sessions"][0]["early_close"])
        self.assertEqual(res["next_sessions"][0]["close_et"], "1:00 p.m.")

    def test_importable_status(self):
        mod = load(SKILL, "nyse_calendar")
        self.assertEqual(mod.status("2026-10-24T15:00:00Z")["state"], "closed")


if __name__ == "__main__":
    unittest.main()
