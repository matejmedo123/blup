"""trader-news: new-since-last-check, dedupe, 8-K classification, crypto filtering, meme snapshots."""
import unittest

from tests.helpers import DEMOS, MEME_PASS, TOKENS, TraderTestCase, load

SKILL, TOOL = "trader-news", "news"


class NewsStockTest(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def test_help(self):
        code, out, _ = self.run_tool(SKILL, TOOL, ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--since", out)

    def test_first_run_then_nothing_new(self):
        r = self.run_json(SKILL, TOOL, ["--asset", "stock", "--symbols", "TSLA"])
        items = r["items"]
        titles = [i["title"] for i in items]
        merger = [i for i in items if "merger mania" in i["title"]]
        self.assertEqual(len(merger), 1)  # Yahoo + Google duplicate merged
        self.assertIn("merger", merger[0]["tags"])
        self.assertIn("earnings", merger[0]["tags"])
        self.assertEqual(merger[0]["importance"], 3)
        self.assertIn("volatile open", merger[0]["why"])
        sec = [i for i in items if i["source"] == "SEC EDGAR"]
        self.assertEqual(len(sec), 1)  # the Oct 2 filing is older than 24 h
        self.assertIn("guidance", sec[0]["tags"])
        self.assertEqual(sec[0]["items_desc"], "items 7.01 and 9.01")
        self.assertNotIn("EV stocks mixed as investors weigh rate path", titles)  # Oct 16, outside 24 h
        published = [i["published"] for i in items]
        self.assertEqual(published, sorted(published, reverse=True))
        self.assertTrue(self.read_state("news_seen.json")["scopes"]["stock:TSLA"]["ids"])
        code, out, _ = self.run_tool(SKILL, TOOL, ["--asset", "stock", "--symbols", "TSLA", "--no-html"])
        self.assertEqual(code, 0)
        self.assertIn("TSLA — no new items since 10:15 ET", out)

    def test_future_items_are_ignored(self):
        self.set_now("2026-10-20T13:30:00Z")  # before the 13:58 Google item
        r = self.run_json(SKILL, TOOL, ["--asset", "stock", "--symbols", "TSLA", "--no-html"])
        self.assertFalse(any("deal chatter" in i["title"] for i in r["items"]))
        self.set_now("2026-10-20T14:15:00Z")
        r = self.run_json(SKILL, TOOL, ["--asset", "stock", "--symbols", "TSLA", "--no-html"])
        self.assertEqual([i["title"] for i in r["items"]], ["Tesla shares climb as SpaceX deal chatter builds"])

    def test_all_flag_shows_seen(self):
        self.run_json(SKILL, TOOL, ["--asset", "stock", "--symbols", "TSLA", "--no-html"])
        r = self.run_json(SKILL, TOOL, ["--asset", "stock", "--symbols", "TSLA", "--all", "--no-html"])
        self.assertTrue(r["items"])

    def test_classify_and_norm_title(self):
        news = load(SKILL, TOOL)
        tags, why, imp = news.classify("Company announces $500M share offering", news.STOCK_RULES)
        self.assertEqual(tags, ["offering"])
        self.assertEqual(imp, 3)
        self.assertEqual(news.norm_title("Big news - Reuters"), news.norm_title("Big news"))


class NewsCryptoTest(TraderTestCase):
    NOW = DEMOS["btc"]["now"]

    def test_crypto_items(self):
        r = self.run_json(SKILL, TOOL, ["--asset", "crypto", "--no-html"])
        by_sym = {}
        for i in r["items"]:
            by_sym.setdefault(i["symbol"], []).append(i)
        self.assertIn("etf_flows", by_sym["BTC"][0]["tags"])
        self.assertIn("listing", by_sym["SOL"][0]["tags"])
        market = [i["title"] for i in by_sym["market"]]
        self.assertTrue(any("exploit" in t for t in market))
        self.assertFalse(any("ARB" in i["title"] for i in r["items"]))  # unlock of an unwatched coin


class NewsMemeTest(TraderTestCase):
    NOW = DEMOS["meme"]["now"]

    def test_meme_profile_then_liquidity_drop(self):
        r = self.run_json(SKILL, TOOL, ["--asset", "meme", "--symbols", MEME_PASS, "--no-html"])
        tags = sorted(t for i in r["items"] for t in i["tags"])
        self.assertEqual(tags, ["boost", "profile_update"])
        seen = self.read_state("news_seen.json")
        key = "solana-" + TOKENS["PUPKIN"]["address"]
        seen["meme_snapshots"][key]["liquidity_usd"] = 600000.0
        seen["meme_snapshots"][key]["links"] = []
        self.write_state("news_seen.json", seen)
        r = self.run_json(SKILL, TOOL, ["--asset", "meme", "--symbols", MEME_PASS, "--no-html"])
        kinds = {t for i in r["items"] for t in i["tags"]}
        self.assertIn("liquidity_change", kinds)
        self.assertIn("new_social", kinds)
        drop = [i for i in r["items"] if "liquidity_change" in i["tags"]][0]
        self.assertEqual(drop["importance"], 3)
        self.assertIn("dropped", drop["title"])

    def test_meme_needs_tokens(self):
        code, _, err = self.run_tool(SKILL, TOOL, ["--asset", "meme"])
        self.assertEqual(code, 2)
        self.assertIn("no meme tokens", err)


class NewsSocialCliTest(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def test_help_lists_social_flags(self):
        code, out, _ = self.run_tool(SKILL, TOOL, ["--help"])
        self.assertEqual(code, 0)
        for flag in ("--feed", "--social", "--no-social"):
            self.assertIn(flag, out)

    def test_crowd_line_and_no_social(self):
        code, out, _ = self.run_tool(SKILL, TOOL, ["--symbols", "TSLA", "--no-html"])
        self.assertEqual(code, 0)
        self.assertIn("TSLA on StockTwits:", out)
        self.assertIn("X: no token", out)  # without X_BEARER_TOKEN, X is skipped with a note
        r = self.run_json(SKILL, TOOL, ["--symbols", "TSLA", "--no-html", "--all"])
        self.assertIn("TSLA", r["crowd"])
        code, out, _ = self.run_tool(SKILL, TOOL, ["--symbols", "TSLA", "--no-html", "--no-social", "--all"])
        self.assertNotIn("StockTwits", out)
        self.assertNotIn("X: ", out)


if __name__ == "__main__":
    unittest.main()
