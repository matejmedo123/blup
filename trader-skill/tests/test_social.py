"""Social layer: X (pay-per-use, budgeted, token never leaks), StockTwits, and the ranked news feed."""
from __future__ import annotations

import json
import os
import unittest
from unittest import mock

from tests.helpers import DEMOS, ROOT, TraderTestCase, load
from shared import http, market_clock
from shared.sources import stocktwits, x

TOKEN = "fake-token-NEVER-PRINT-ME-12345"
SKILL, TOOL = "trader-news", "news"


class SocialCase(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def setUp(self):
        super().setUp()
        self._saved_token = os.environ.get("X_BEARER_TOKEN")
        os.environ["X_BEARER_TOKEN"] = TOKEN

    def tearDown(self):
        if self._saved_token is None:
            os.environ.pop("X_BEARER_TOKEN", None)
        else:
            os.environ["X_BEARER_TOKEN"] = self._saved_token
        super().tearDown()

    def config(self, **news):
        cfg = {"news": {"x": dict({"enabled": True, "max_reads_per_day": 300, "poll_minutes": 15}, **news)}}
        self.write_state("config.json", cfg)

    def spy(self):
        calls = []
        real = http.get_text

        def wrapper(url, *a, **k):
            calls.append(url)
            return real(url, *a, **k)
        return calls, mock.patch.object(http, "get_text", wrapper)


class XSource(SocialCase):
    def test_queries(self):
        self.assertEqual(x.cashtag_query("TSLA", "stock", "Tesla"), '($TSLA OR "Tesla") -is:retweet -is:reply lang:en')
        self.assertEqual(x.cashtag_query("BTC", "crypto", "bitcoin"), "($BTC OR #bitcoin) -is:retweet -is:reply lang:en")
        q = x.accounts_query(["@DeItaone", "tier10k"])
        self.assertEqual(q, "(from:DeItaone OR from:tier10k) -is:retweet")
        long_q = x.accounts_query(["account_%02d_with_a_long_name" % i for i in range(40)])
        self.assertLessEqual(len(long_q), 512)
        self.assertTrue(long_q.startswith("(from:account_00"))

    def test_parse_and_offline_search(self):
        posts = x.search_recent(x.cashtag_query("TSLA", "stock", "Tesla"))
        self.assertEqual(len(posts), 5)  # the 14:30 post is after the pinned 14:15 clock
        top = posts[0]
        self.assertEqual(top["author"], "@FixtureSquawk")  # relevancy → most engagement first
        self.assertEqual(top["metrics"], {"likes": 4200, "reposts": 1300, "replies": 310, "quotes": 220})
        self.assertEqual(top["url"], "https://x.com/FixtureSquawk/status/1848000000000000002")
        self.assertEqual(top["published"], "2026-10-20T12:58:00Z")

    def test_no_token_means_no_request(self):
        os.environ.pop("X_BEARER_TOKEN")
        calls, patch = self.spy()
        with patch:
            with self.assertRaises(x.XUnavailable) as ctx:
                x.search_recent("$TSLA")
        self.assertTrue(ctx.exception.status.startswith("no token"))
        self.assertEqual(calls, [])

    def test_budget_is_enforced_before_the_request(self):
        self.config(max_reads_per_day=12)
        calls, patch = self.spy()
        with patch:
            first = x.search_recent(x.cashtag_query("TSLA", "stock", "Tesla"))
            again = x.search_recent(x.cashtag_query("TSLA", "stock", "Tesla"))  # cached: not bought twice
            with self.assertRaises(x.XUnavailable) as ctx:
                x.search_recent(x.cashtag_query("BTC", "crypto", "bitcoin"))  # 7 reads left < 10 minimum
        self.assertEqual(len(first), 5)
        self.assertEqual(again, first)
        self.assertEqual(len(calls), 1)
        self.assertEqual(ctx.exception.status, "budget exhausted (5 reads today)")
        usage = self.read_state("x_usage.json")
        self.assertEqual((usage["date"], usage["reads"], usage["requests"], usage["max_reads_per_day"]),
                         ("2026-10-20", 5, 1, 12))

    def test_request_shrinks_to_the_remaining_budget(self):
        self.config(max_reads_per_day=15)
        x._record(4)
        calls, patch = self.spy()
        with patch:
            x.search_recent("$TSLA", max_results=50)
        self.assertIn("max_results=11", calls[0])

    def test_budget_resets_each_utc_day(self):
        self.write_state("x_usage.json", {"date": "2026-10-19", "reads": 300, "requests": 30})
        self.assertEqual(x.usage()["reads"], 0)

    def test_http_errors_become_statuses(self):
        for code, status in ((401, x.ST_REJECTED), (402, x.ST_PLAN), (403, x.ST_PLAN), (429, x.ST_RATE)):
            def boom(url, *a, **k):
                raise http.SourceError(url, "api.x.com request failed", code)
            with mock.patch.object(http, "get_text", boom):
                with self.assertRaises(x.XUnavailable) as ctx:
                    x.search_recent("$NVDA %d" % code)
            self.assertEqual(ctx.exception.status, status)
            self.assertNotIn(TOKEN, str(ctx.exception))
        self.assertIsNone(self.read_state("x_usage.json"))  # failed requests are not counted as reads

    def test_token_only_in_the_header(self):
        seen = {}

        def capture(url, *a, **k):
            seen["url"], seen["headers"] = url, k.get("headers")
            return json.dumps({"meta": {"result_count": 0}})
        with mock.patch.object(http, "get_text", capture):
            self.assertEqual(x.search_recent("$AAPL"), [])
        self.assertNotIn(TOKEN, seen["url"])
        self.assertEqual(seen["headers"], {"Authorization": "Bearer " + TOKEN})


class StockTwitsSource(SocialCase):
    def test_symbol_mapping(self):
        self.assertEqual(stocktwits.st_symbol("BTCUSDT", "crypto"), "BTC.X")
        self.assertEqual(stocktwits.st_symbol("ETH", "crypto"), "ETH.X")
        self.assertEqual(stocktwits.st_symbol("BRK-B", "stock"), "BRK.B")

    def test_summary_math(self):
        raw = json.loads((ROOT / "tests" / "fixtures" / "http" / "stocktwits" / "TSLA.json").read_text(encoding="utf-8"))
        now = market_clock.parse_iso(self.NOW).timestamp()
        visible = [m for m in raw["messages"] if market_clock.parse_iso(m["created_at"]).timestamp() <= now]
        bull = sum(1 for m in visible if ((m.get("entities") or {}).get("sentiment") or {}).get("basic") == "Bullish")
        bear = sum(1 for m in visible if ((m.get("entities") or {}).get("sentiment") or {}).get("basic") == "Bearish")
        last_hour = sum(1 for m in visible if now - 3600 <= market_clock.parse_iso(m["created_at"]).timestamp())
        s = stocktwits.stream("TSLA", "stock", now_ts=now)
        summ = s["summary"]
        self.assertEqual((summ["count"], summ["bullish"], summ["bearish"], summ["last_hour"]),
                         (len(visible), bull, bear, last_hour))
        self.assertAlmostEqual(summ["bullish_pct"], round(100.0 * bull / (bull + bear), 1))
        self.assertFalse(summ["capped"])
        self.assertTrue(s["messages"][0]["url"].startswith("https://stocktwits.com/"))
        self.assertEqual([m["published"] for m in s["messages"]],
                         sorted((m["published"] for m in s["messages"]), reverse=True))

    def test_empty_summary(self):
        self.assertEqual(stocktwits.summarize([], 0)["bullish_pct"], None)


class Feed(SocialCase):
    NOW = DEMOS["btc"]["now"]  # 14:40Z — stock and crypto news are both out

    def feed(self, **kw):
        news = load(SKILL, TOOL)
        res = news.refresh_feed(**kw)
        return news, res, self.read_state("news_feed.json")

    def test_refresh_merges_ranks_and_orders(self):
        news, res, doc = self.feed(symbols=["TSLA", "BTCUSDT"])
        self.assertEqual(res["sources"]["X"], "ok")
        self.assertEqual(res["sources"]["StockTwits"], "ok")
        self.assertEqual(res["new"], len(doc["items"]))
        items = doc["items"]
        pubs = [i["published"] for i in items]
        self.assertEqual(pubs, sorted(pubs, reverse=True))
        merger = [i for i in items if news.similar(i["title"], "Tesla–SpaceX merger mania strikes Wall Street ahead "
                                                              "of earnings")]
        self.assertEqual(len(merger), 1)
        self.assertEqual(merger[0]["source"], "Yahoo Finance")
        self.assertIn("X @fixture_wire", merger[0]["also"])
        for it in items:
            for key in ("id", "symbol", "asset", "source", "kind", "author", "title", "url", "published", "tags",
                        "why", "importance", "sentiment", "metrics", "score"):
                self.assertIn(key, it)

    def test_ranking_filings_and_wires_beat_chatter(self):
        _, _, doc = self.feed(symbols=["TSLA"])
        items = doc["items"]
        sec = [i for i in items if i["source"] == "SEC EDGAR"][0]
        wire = [i for i in items if i["source"] == "X" and i.get("wire")][0]
        chatter = [i for i in items if i["source"] == "StockTwits"]
        retail = [i for i in items if i["source"] == "X" and i["author"] == "@moonboy_fixture"][0]
        self.assertTrue(chatter)
        self.assertEqual(sec["kind"], "filing")
        for c in chatter + [retail]:
            self.assertGreater(sec["score"], c["score"])
            self.assertGreater(wire["score"], c["score"])
        self.assertEqual(retail["importance"], 1)
        summary = [c for c in chatter if c.get("crowd_summary")][0]
        self.assertIn("TSLA on StockTwits:", summary["title"])
        self.assertLessEqual(len([c for c in chatter if not c.get("crowd_summary")]), 2)

    def test_engagement_relative_to_the_author(self):
        news = load(SKILL, TOOL)
        now = market_clock.parse_iso(self.NOW).timestamp()
        base = {"@a": 10, "*": 10}
        loud = {"source": "X", "author": "@a", "metrics": {"likes": 900, "reposts": 300}, "importance": 1}
        usual = {"source": "X", "author": "@a", "metrics": {"likes": 8, "reposts": 1}, "importance": 1}
        self.assertGreater(news.score(loud, now, base), news.score(usual, now, base))

    def test_cap_and_second_refresh(self):
        self.write_state("config.json", {"news": {"feed_max_items": 5}})
        _, res, doc = self.feed(symbols=["TSLA", "BTCUSDT"])
        self.assertEqual(len(doc["items"]), 5)
        _, res2, doc2 = self.feed(symbols=["TSLA", "BTCUSDT"])
        self.assertEqual(res2["new"], 0)
        self.assertEqual(len(doc2["items"]), 5)

    def test_refreshed_per_symbol(self):
        _, _, doc = self.feed(symbols=["TSLA", "BTCUSDT"])
        self.assertEqual(doc["refreshed"], {"stock:TSLA": self.NOW, "crypto:BTC": self.NOW})
        self.set_now("2026-10-20T14:55:00Z")
        _, _, doc = self.feed(symbols=["TSLA"])
        self.assertEqual(doc["refreshed"], {"stock:TSLA": "2026-10-20T14:55:00Z", "crypto:BTC": self.NOW})

    def test_one_crowd_summary_per_symbol(self):
        self.feed(symbols=["TSLA"])
        self.set_now("2026-10-20T15:05:00Z")
        _, _, doc = self.feed(symbols=["TSLA"])
        sums = [i for i in doc["items"] if i.get("crowd_summary") and i["symbol"] == "TSLA"]
        self.assertEqual(len(sums), 1)
        self.assertTrue(sums[0]["published"].startswith("2026-10-20T15:05"))

    def test_statuses_when_x_fails_or_has_no_token(self):
        os.environ.pop("X_BEARER_TOKEN")
        _, res, _ = self.feed(symbols=["TSLA"])
        self.assertTrue(res["sources"]["X"].startswith("no token"))
        os.environ["X_BEARER_TOKEN"] = TOKEN

        def boom(url, *a, **k):
            if "api.x.com" in url:
                raise http.SourceError(url, "failed", 401)
            return real(url, *a, **k)
        real = http.get_text
        with mock.patch.object(http, "get_text", boom):
            _, res, _ = self.feed(symbols=["NVDA"])
        self.assertEqual(res["sources"]["X"], x.ST_REJECTED)
        self.assertEqual(res["sources"]["StockTwits"], "ok")

    def test_token_never_written_or_printed(self):
        code, out, err = self.run_tool(SKILL, TOOL, ["--feed", "--symbols", "TSLA,BTCUSDT"])
        self.assertEqual(code, 0, err)
        self.assertIn("News feed · best", out)
        code, out2, err2 = self.run_tool(SKILL, TOOL, ["--symbols", "TSLA", "--json"])
        self.assertEqual(code, 0, err2)
        for text in (out, err, out2, err2):
            self.assertNotIn(TOKEN, text)
        for path in self.home.rglob("*"):
            if path.is_file():
                self.assertNotIn(TOKEN, path.read_text(encoding="utf-8", errors="replace"), str(path))


if __name__ == "__main__":
    unittest.main()
