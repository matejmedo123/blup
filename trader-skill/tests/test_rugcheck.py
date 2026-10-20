"""trader-rugcheck: verdicts on the three fixture tokens, scoring rules, fail-safe behaviour."""
import os
import unittest

from tests.helpers import DEMOS, MEME_FAIL, MEME_NEW, MEME_PASS, TOKENS, TraderTestCase, load

SKILL, TOOL = "trader-rugcheck", "rugcheck"


class RugcheckTest(TraderTestCase):
    NOW = DEMOS["meme"]["now"]

    def setUp(self):
        super().setUp()
        self.rc = load(SKILL, TOOL)

    def test_help(self):
        code, out, _ = self.run_tool(SKILL, TOOL, ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("SAFE / RISKY / DANGER", out)

    def test_pass_token_is_safe(self):
        r = self.run_json(SKILL, TOOL, [MEME_PASS])
        self.assertEqual(r["verdict"], "SAFE")
        self.assertGreaterEqual(r["score"], 75)
        self.assertEqual(r["headline"], "No red flags found in these checks (not a guarantee)")
        self.assertEqual(r["metrics"]["lp_locked_pct"], 100.0)
        self.assertAlmostEqual(r["metrics"]["top10_pct"], 17.8, places=1)  # AMM pool excluded
        self.assertIsNone(r["metrics"]["mint_authority"])
        self.assertEqual(r["sources"]["rugcheck"], "ok")
        self.assertIn("meme", r["disclaimer"].lower())

    def test_fail_token_is_danger_with_reasons(self):
        r = self.run_json(SKILL, TOOL, [MEME_FAIL])
        self.assertEqual(r["verdict"], "DANGER")
        joined = " | ".join(r["reasons"])
        self.assertIn("LP not locked or burned (0% locked)", joined)
        self.assertIn("Top holder owns 40.0% of supply", joined)
        self.assertTrue(r["reasons"][0].startswith("LP not locked"))
        names = {c["name"]: c for c in r["checks"]}
        self.assertFalse(names["lp_locked"]["ok"])
        self.assertEqual(names["top_holder"]["severity"], "critical")

    def test_new_evm_launch_is_risky(self):
        r = self.run_json(SKILL, TOOL, [MEME_NEW])
        self.assertEqual(r["chain"], "base")
        self.assertEqual(r["verdict"], "RISKY")
        self.assertEqual(r["sources"]["honeypot"], "ok")
        self.assertEqual(r["metrics"]["sell_tax"], 4.0)
        self.assertAlmostEqual(r["metrics"]["top10_pct"], 27.2, places=1)  # pool excluded
        self.assertTrue(any("Brand-new pair" in x for x in r["reasons"]))

    def test_writes_state_and_report(self):
        code, out, err = self.run_tool(SKILL, TOOL, [MEME_FAIL])
        self.assertEqual(code, 0, err)
        addr = TOKENS["MLAMBO"]["address"]
        saved = self.rc.load_result("solana", addr)
        self.assertEqual(saved["verdict"], "DANGER")
        self.assertTrue(saved["report"].startswith("reports/rugcheck-solana-"))
        self.assertTrue((self.home / saved["report"]).exists())
        self.assertIn("Verdict: DANGER", out)
        self.assertNotIn("safe to buy", out.lower())

    def test_never_says_safe_to_buy(self):
        for sym in (MEME_PASS, MEME_FAIL, MEME_NEW):
            code, out, _ = self.run_tool(SKILL, TOOL, [sym, "--no-html"])
            self.assertEqual(code, 0)
            self.assertNotIn("safe to buy", out.lower())

    def test_check_api_with_given_pair(self):
        from shared import data
        sym, pair, _, _ = data.resolve_meme(MEME_PASS)
        r = self.rc.check(sym, pair, write=False)
        self.assertEqual(r["verdict"], "SAFE")
        self.assertFalse(self.rc.result_path("solana", TOKENS["PUPKIN"]["address"]).exists())
        s = self.rc.summary(r)
        self.assertEqual(set(s), {"verdict", "score", "checked_at", "file", "reasons"})

    def test_safety_source_down_caps_at_risky(self):
        os.environ["TRADER_OFFLINE_FAIL"] = "api.rugcheck.xyz"
        r = self.run_json(SKILL, TOOL, [MEME_PASS, "--no-html"])
        self.assertEqual(r["sources"]["rugcheck"], "unavailable")
        self.assertNotEqual(r["verdict"], "SAFE")
        self.assertTrue(any("RugCheck was unavailable" in x for x in r["reasons"]))

    def test_scoring_rules_on_synthetic_pair(self):
        ck = self.rc._Checks()
        self.rc._liquidity(ck, 8000)
        self.rc._lp_lock(ck, 95)
        self.rc._authority(ck, "mint_authority", "Mint authority", "Abc123", "can mint")
        self.assertEqual([c["name"] for c in ck.failed_critical()], ["liquidity", "mint_authority"])
        self.assertEqual(sum(c["penalty"] for c in ck.items), 80)

    def test_live_report_shape_with_nested_accounts(self):
        """Real RugCheck reports nest account objects in markets[]; holders owned by the pool are excluded."""
        from shared.sources import rugcheck_api
        rep = {"markets": [{"pubkey": "POOL", "liquidityA": "RESA", "liquidityAAccount": {"owner": "POOLAUTH"},
                            "liquidityBAccount": {"owner": "POOLAUTH"}, "lp": {"lpLockedPct": 100}}],
               "topHolders": [{"address": "RESA", "owner": "POOLAUTH", "pct": 9.0},
                              {"address": "W1", "owner": "W1", "pct": 4.0}],
               "mintAuthority": None, "freezeAuthority": None}
        summ = rugcheck_api.summarize(self.rc._sanitize_report(rep), "")
        self.assertEqual(summ["top_holder_pct"], 4.0)
        self.assertEqual(summ["lp_locked_pct"], 100.0)

    def test_rejects_non_meme(self):
        code, _, err = self.run_tool(SKILL, TOOL, ["TSLA", "--asset", "stock"])
        self.assertEqual(code, 2)
        self.assertIn("meme", err)


if __name__ == "__main__":
    unittest.main()
