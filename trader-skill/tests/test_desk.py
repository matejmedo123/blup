"""Trading desk: case file, memo parsing, cross-checks and hard gates for a GO."""
from __future__ import annotations

from tests.helpers import DEMOS, MEME_PASS, ROOT, TOKENS, TraderTestCase, load

ID = "TSLA-20261020-orb15"
PLAN = {"id": ID, "symbol": "TSLA", "asset": "stock", "setup": "orb15", "direction": "long",
        "entry": {"price": 364.18, "time": "2026-10-20T14:15:00Z"},
        "stop": {"price": 358.32, "method": "range_low", "note": ""}, "target": {"price": 375.90, "r_multiple": 2.0},
        "risk_per_unit": 5.86, "time_stop": {"at": "2026-10-20T19:55:00Z", "rule": "flat by 3:55 p.m. ET"},
        "horizon": {"end": "2026-10-20T20:00:00Z", "label": "rest of the session"}, "trailing": None,
        "scale_out": [], "liquidity_exit": None, "interval": "5m", "created_at": "2026-10-20T14:15:00Z"}
RESEARCH = "## Thesis\nORB with relvol 2.8 and a merger headline.\n## Evidence\n- setups.json: orb15 triggered 10:10"
SKEPTIC = ("O1 [critical] Earnings are tomorrow after the close — evidence: news.json 'Q3 earnings preview'\n"
           "O2 [major] Backtest expectancy is negative — evidence: backtests/TSLA-orb15.json\n"
           "O3 [minor] Volume faded after the breakout bar\n## Verdict\nI would pass.")


def tm(ev):
    return {"id": ID, "symbol": "TSLA", "asset": "stock", "entry": 364.18, "stop": 358.32, "target": 375.90,
            "probabilities": {"target": 0.4, "stop": 0.45, "neither": 0.15, "rug": 0.0},
            "expected_value": {"r": ev, "usd": ev * 100}}


class Desk(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def setUp(self):
        super().setUp()
        self.write_state("plan.json", {"plans": {ID: PLAN}, "latest": ID})
        self.write_state("timemachine/TSLA-20261020.json", tm(0.12))
        self.write_state("backtests/TSLA-orb15.json", {"summary": "Last 59 sessions: 33 triggers, 6 hit target, "
                                                                  "17 hit stop, 10 neither.", "triggers": 33,
                                                       "expectancy_r": -0.21})

    def record(self, role, text):
        code, out, err = self.run_tool("trader-desk", "desk", ["record", "--id", ID, "--role", role, "--text", text])
        self.assertEqual(code, 0, err)
        return out

    def verify(self):
        return self.run_json("trader-desk", "desk", ["verify", "--id", ID])

    def test_help(self):
        code, out, _ = self.run_tool("trader-desk", "desk", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("Skeptic", out)

    def test_brief_finds_the_idea_by_symbol(self):
        case = self.run_json("trader-desk", "desk", ["brief", "TSLA"])
        self.assertEqual(case["id"], ID)
        self.assertEqual(case["plan"]["stop"]["price"], 358.32)
        self.assertEqual(case["timemachine"]["expected_value"]["r"], 0.12)
        self.assertTrue(any(m["what"] == "no news checked" for m in case["missing"]))
        self.assertTrue((self.home / "desk" / ID / "case.json").exists())

    def test_go_verified_when_everything_is_answered(self):
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        out = self.record("lead", "O1: mitigated — half size and flat before the close\nO2: rebutted — sample is "
                                  "regime-dependent; today has 2.8x relvol\nO3: accepted — noted\nDECISION: GO")
        self.assertIn("decision GO", out)
        res = self.verify()
        self.assertEqual(res["status"], "GO", res)
        self.assertEqual([o["response"] for o in res["objections"]], ["mitigated", "rebutted", "accepted"])
        self.assertTrue(any("ticket.py" in c for c in res["trader_next"]))
        self.assertTrue(any("yes" in c for c in res["trader_next"]))
        soft = {g["name"]: g for g in res["gates"]}["backtest expectancy"]
        self.assertFalse(soft["ok"])
        self.assertFalse(soft["hard"])  # the Lead may weigh it, it does not block by itself
        self.assertTrue((self.home / res["report"]).exists())

    def test_unanswered_objection_blocks_go(self):
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: rebutted — fine\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")
        self.assertTrue(any("did not answer O2" in b for b in res["blockers"]))
        self.assertEqual(res["trader_next"], [])

    def test_accepted_critical_objection_blocks_go(self):
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: accepted\nO2: rebutted — x\nO3: accepted\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")
        self.assertTrue(any("O1 is a critical objection" in b for b in res["blockers"]))

    def test_negative_time_machine_ev_is_a_hard_gate(self):
        self.write_state("timemachine/TSLA-20261020.json", tm(-0.3))
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: mitigated — a\nO2: rebutted — b\nO3: accepted — c\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")
        self.assertTrue(any("Time Machine expected value" in b for b in res["blockers"]))

    def test_stale_replay_after_plan_change_blocks(self):
        self.write_state("plan.json", {"plans": {ID: dict(PLAN, stop={"price": 360.0, "method": "price"})}, "latest": ID})
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: mitigated — a\nO2: rebutted — b\nO3: accepted — c\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")

    def test_no_go_and_incomplete(self):
        res = self.verify()
        self.assertEqual(res["status"], "INCOMPLETE")
        self.record("researcher", RESEARCH)
        self.record("skeptic", "Looks great to me.")
        self.record("lead", "DECISION: NO-GO")
        res = self.verify()
        self.assertEqual(res["status"], "NO-GO")
        self.assertTrue(any("raised no objections" in i for i in res["issues"]))
        self.assertEqual(res["trader_next"], [])

    def test_parsers_accept_markdown_variants(self):
        desk = load("trader-desk", "desk")
        obs = desk.parse_objections("- **O1** [Critical]: thin liquidity\n* O2 (minor) meh\nO1 [major] duplicate")
        self.assertEqual([(o["id"], o["severity"]) for o in obs], [("O1", "critical"), ("O2", "minor")])
        self.assertEqual(desk.parse_responses("**O1** — Rebutted: no\nO2 - mitigated"), {"O1": "rebutted", "O2": "mitigated"})
        self.assertEqual(desk.parse_decision("**DECISION:** No Go"), "NO-GO")
        self.assertIsNone(desk.parse_decision("we decided nothing"))

    def test_agents_exist_and_never_trade(self):
        for role in ("researcher", "skeptic", "lead"):
            text = (ROOT / "agents" / ("trader-%s.md" % role)).read_text(encoding="utf-8")
            self.assertTrue(text.startswith("---\nname: trader-%s\n" % role))
            self.assertIn("Never", text)
            self.assertIn("trader-broker", text)  # each one is told it may not run it


class DeskMeme(TraderTestCase):
    NOW = DEMOS["meme"]["now"]

    def test_meme_without_rugcheck_fails_hard_gate(self):
        mid = "solana-%s-20261020-momentum" % TOKENS["PUPKIN"]["address"]
        plan = dict(PLAN, id=mid, symbol=MEME_PASS, asset="meme", setup="momentum",
                    entry={"price": 0.004712, "time": "2026-10-20T15:55:00Z"},
                    stop={"price": 0.00429, "method": "range_low"}, target={"price": 0.005978, "r_multiple": 3.0})
        self.write_state("plan.json", {"plans": {mid: plan}, "latest": mid})
        case = self.run_json("trader-desk", "desk", ["verify", "--id", mid])
        gate = {g["name"]: g for g in case["gates"]}["rugcheck"]
        self.assertFalse(gate["ok"])
        self.assertTrue(gate["hard"])
