"""Data layer: source parsers, offline routing, fallbacks, closed-candle rule, cache and HTTP politeness."""
from __future__ import annotations

import json
import os
import time
import unittest
import urllib.error
from unittest import mock

from tests.helpers import DEMOS, MEME_FAIL, MEME_PASS, TOKENS, TraderTestCase
from shared import cache, config, data, http, market_clock as mc
from shared.sources import (binance, coinbase, coingecko, dexscreener, geckoterminal, honeypot, kraken, nasdaq, rss,
                            rugcheck_api, sec, stooq, yahoo)


class Parsers(unittest.TestCase):
    def test_yahoo_chart_skips_nulls(self):
        obj = {"chart": {"result": [{"meta": {"regularMarketPrice": 2}, "timestamp": [1, 2, 3],
                                     "indicators": {"quote": [{"open": [1, None, 3], "high": [1, 2, 3],
                                                               "low": [1, 2, 3], "close": [1, 2, 3],
                                                               "volume": [10, 20, None]}]}}], "error": None}}
        candles, meta = yahoo.parse_chart(obj)
        self.assertEqual([c.t for c in candles], [1, 3])
        self.assertEqual(candles[-1].v, 0.0)
        with self.assertRaises(ValueError):
            yahoo.parse_chart({"chart": {"result": None, "error": {"description": "No data found"}}})

    def test_yahoo_spark_both_formats(self):
        new = yahoo.parse_spark({"TSLA": {"close": [1.0, None, 2.0], "chartPreviousClose": 0.9}})
        self.assertEqual(new["TSLA"], {"closes": [1.0, 2.0], "prev_close": 0.9})
        old = yahoo.parse_spark({"spark": {"result": [{"symbol": "AAPL", "response": [{
            "meta": {"chartPreviousClose": 5}, "indicators": {"quote": [{"close": [6, 7]}]}}]}]}})
        self.assertEqual(old["AAPL"]["closes"], [6, 7])

    def test_binance_coinbase_kraken_formats(self):
        k = binance.parse_klines([[1792531500000, "1", "3", "0.5", "2", "10", 0, "0", 1, "0", "0", "0"], ["bad"]])
        self.assertEqual((k[0].t, k[0].h, k[0].c), (1792531500, 3.0, 2.0))
        cb = coinbase.parse_candles([[200, 1, 4, 2, 3, 9], [100, 1, 4, 2, 3, 9]])  # [t, low, high, open, close, vol]
        self.assertEqual([(c.t, c.o, c.h, c.l, c.c) for c in cb], [(100, 2.0, 4.0, 1.0, 3.0), (200, 2.0, 4.0, 1.0, 3.0)])
        kr = kraken.parse_ohlc({"error": [], "result": {"XXBTZUSD": [[1, "1", "2", "0.5", "1.5", "1.2", "7", 3]],
                                                        "last": 1}})
        self.assertEqual((kr[0].c, kr[0].v), (1.5, 7.0))

    def test_stooq_end_stamped_shift(self):
        # 15:35 Warsaw (CEST) on 2026-10-20 = 13:35Z = 9:35 ET → bar stamped at its end, shift back
        text = "Date,Time,Open,High,Low,Close,Volume\n2026-10-20,15:35:00,1,2,0.5,1.5,100\n2026-10-20,15:40:00,1.5,2,1,1.8,90\n"
        bars = stooq.parse_csv(text, "5m")
        self.assertEqual(mc.iso(bars[0].t), "2026-10-20T13:30:00Z")
        with self.assertRaises(ValueError):
            stooq.parse_csv("No data", "5m")

    def test_geckoterminal_sorted_oldest_first(self):
        obj = {"data": {"attributes": {"ohlcv_list": [[300, 1, 2, 0.5, 1.5, 9], [0, 1, 2, 0.5, 1.2, 3]]}}}
        self.assertEqual([c.t for c in geckoterminal.parse_ohlcv(obj)], [0, 300])

    def test_coingecko_drops_stables_and_wrapped(self):
        rows = coingecko.parse_markets([{"symbol": "usdt"}, {"symbol": "btc", "name": "Bitcoin"}, {"symbol": "wbtc"}])
        self.assertEqual([r["symbol"] for r in rows], ["BTC"])
        # a dollar stablecoin missing from the list is still caught: $1, flat, named like one
        rows = coingecko.parse_markets([
            {"symbol": "usdz", "name": "Zeta Dollar", "current_price": 0.9998, "price_change_percentage_24h": 0.01},
            {"symbol": "usdg", "name": "Global Dollar", "current_price": 1.0, "price_change_percentage_24h": 0.0},
            {"symbol": "abc", "name": "Abc", "current_price": 1.01, "price_change_percentage_24h": 0.2},
            {"symbol": "usual", "name": "Usual", "current_price": 1.0, "price_change_percentage_24h": 6.5}])
        self.assertEqual([r["symbol"] for r in rows], ["ABC", "USUAL"])

    def test_dexscreener_normalize(self):
        p = dexscreener.normalize_pair({"chainId": "solana", "pairAddress": "P", "priceUsd": "0.5",
                                        "liquidity": {"usd": 1000}, "txns": {"h1": {"buys": 3, "sells": 1}},
                                        "pairCreatedAt": 3600 * 1000, "baseToken": {"address": "A", "symbol": "X"},
                                        "info": {"socials": [{"type": "twitter", "url": "https://x.com/a"}]}},
                                       now_ts=7200)
        self.assertEqual((p["price_usd"], p["liquidity_usd"], p["age_hours"]), (0.5, 1000.0, 1.0))
        self.assertEqual(p["txns"]["h1"], {"buys": 3, "sells": 1})
        self.assertEqual(p["txns"]["m5"], {"buys": 0, "sells": 0})
        self.assertEqual(dexscreener.best_pair([{"chain": "solana", "liquidity_usd": 1}, {"chain": "solana", "liquidity_usd": 5}])
                         ["liquidity_usd"], 5)

    def test_rss_parse_and_refuse_entities(self):
        feed = ("<rss><channel><item><title><![CDATA[Hello <b>world</b>]]></title><link>javascript:alert(1)</link>"
                "<pubDate>Tue, 20 Oct 2026 13:05:00 +0000</pubDate></item></channel></rss>")
        items = rss.parse(feed, "Test")
        self.assertEqual(items[0]["title"], "Hello world")
        self.assertEqual(items[0]["url"], "")  # non-http link dropped
        self.assertEqual(items[0]["published"], "2026-10-20T13:05:00Z")
        bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>'
        with self.assertRaises(ValueError):
            rss.parse(bomb, "Evil")

    def test_sec_items(self):
        self.assertEqual([t for t, _ in sec.classify_items("items 2.02 and 9.01")], ["earnings"])
        self.assertEqual([t for t, _ in sec.classify_items("Items 5.02, 7.01")], ["management", "guidance"])

    def test_nasdaq_parse_skips_test_and_etf(self):
        text = ("Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\n"
                "AAA|A|Q|N|N|100|N|N\nQQQ|Q|G|N|N|100|Y|N\nZZZ|Z|Q|Y|N|100|N|N\nFile Creation Time: x|||||||\n")
        self.assertEqual([r["ticker"] for r in nasdaq.parse(text, "nasdaq")], ["AAA"])

    def test_rugcheck_summary_handles_live_account_objects(self):
        rep = {"topHolders": [{"address": "r", "owner": "VAULT", "pct": 20.0}, {"address": "w", "owner": "w", "pct": 3.0}],
               "markets": [{"pubkey": "POOL", "liquidityAAccount": {"mint": "M", "owner": "VAULT", "amount": 1},
                            "liquidityBAccount": {"mint": "S", "owner": "VAULT"}, "lp": {"lpLockedPct": 100}}],
               "token": {"supply": 100}}
        self.assertEqual(rugcheck_api.summarize(rep, "")["top_holder_pct"], 3.0)

    def test_rugcheck_summary_excludes_pool(self):
        rep = {"topHolders": [{"address": "v", "owner": "POOL", "pct": 30.0}, {"address": "w", "owner": "w", "pct": 12.0}],
               "markets": [{"pubkey": "POOL", "lp": {"lpLockedPct": 100}}], "mintAuthority": None,
               "freezeAuthority": None, "token": {"supply": 100}, "creatorBalance": 0}
        s = rugcheck_api.summarize(rep, "POOL")
        self.assertEqual((s["top_holder_pct"], s["top10_pct"], s["lp_locked_pct"]), (12.0, 12.0, 100.0))
        self.assertIsNone(s["mint_authority"])


class OfflineData(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def test_stock_candles_closed_only(self):
        s = data.get_candles("TSLA")
        self.assertEqual(s.source, "Yahoo Finance")
        self.assertEqual(mc.iso(s.candles[-1].t), "2026-10-20T14:10:00Z")  # the 10:10 bar closed at 10:15
        self.assertEqual(len({mc.et_date(c.t) for c in s.candles}), 60)
        self.assertTrue(all(c.t + 300 <= mc.ts(self.NOW) for c in s.candles))

    def test_stock_fallback_to_stooq(self):
        s = data.get_candles("AMD", days=5)
        self.assertEqual(s.source, "Stooq")
        self.assertTrue(any("Stooq" in w for w in s.warnings))
        self.assertEqual(mc.fmt_et(s.candles[-1].t), "10:10")

    def test_missing_everywhere(self):
        with self.assertRaises(data.DataUnavailable):
            data.get_candles("MSFT")

    def test_quote_from_last_closed_bar_when_pinned(self):
        q = data.get_quote("TSLA")
        self.assertAlmostEqual(q["price"], 364.18)
        self.assertAlmostEqual(q["prev_close"], 359.40)

    def test_universes(self):
        u = data.stock_universe()
        self.assertEqual(u["source"], "SEC EDGAR")
        tickers = [r["ticker"] for r in u["tickers"]]
        self.assertIn("TSLA", tickers)
        self.assertNotIn("OTCZ", tickers)
        c = data.crypto_universe(5)
        self.assertEqual([x["symbol"].key for x in c["coins"]][:3], ["BTCUSDT", "ETHUSDT", "SOLUSDT"])

    def test_nasdaq_fallback_universe(self):
        os.environ["TRADER_OFFLINE_FAIL"] = "www.sec.gov"
        u = data.stock_universe()
        self.assertEqual(u["source"], "Nasdaq Trader")
        self.assertIn("BRK-B", [r["ticker"] for r in u["tickers"]])


class OfflineCrypto(TraderTestCase):
    NOW = DEMOS["btc"]["now"]

    def test_binance_pagination_and_window(self):
        s = data.get_candles("BTCUSDT", days=10)
        self.assertEqual(s.source, "Binance")
        self.assertEqual(len(s), 10 * 288)  # 14:40 ten days ago … the 14:35 bar that just closed
        self.assertEqual(mc.iso(s.candles[-1].t), "2026-10-20T14:35:00Z")
        ts_ = [c.t for c in s.candles]
        self.assertEqual(ts_, sorted(set(ts_)))

    def test_geo_block_falls_to_mirror_then_coinbase_then_kraken(self):
        os.environ["TRADER_OFFLINE_BLOCK"] = "api.binance.com"
        self.assertEqual(data.get_candles("BTCUSDT", days=1).source, "Binance")  # mirror
        os.environ["TRADER_OFFLINE_FAIL"] = "data-api.binance.vision"
        self.assertEqual(data.get_candles("BTCUSDT", days=1).source, "Coinbase")
        os.environ["TRADER_OFFLINE_FAIL"] = "data-api.binance.vision,api.exchange.coinbase.com"
        s = data.get_candles("BTCUSDT", days=1)
        self.assertEqual(s.source, "Kraken")
        self.assertTrue(s.candles[-1].t + 300 <= mc.ts(self.NOW))

    def test_usd_symbol_uses_usdt_pair_with_note(self):
        s = data.get_candles("BTC-USD", days=1)
        self.assertTrue(any("USDT" in w for w in s.warnings))

    def test_derivatives_and_lots(self):
        d = data.derivatives("BTCUSDT")
        self.assertAlmostEqual(d["funding_rate"], 0.00012)
        self.assertGreater(d["oi_change_pct_1h"], 2.0)
        self.assertTrue(all(t <= mc.ts(self.NOW) for t, _, _ in d["oi_series"]))
        lot = data.lot_info("BTCUSDT")
        self.assertEqual((lot["step"], lot["tick"], lot["source"]), (0.00001, 0.01, "Binance"))
        os.environ["TRADER_OFFLINE_FAIL"] = "api.binance.com,data-api.binance.vision,api.exchange.coinbase.com"
        self.assertIn("default", data.lot_info("BTCUSDT")["source"])

    def test_funding_falls_back_to_okx_or_none(self):
        os.environ["TRADER_OFFLINE_BLOCK"] = "fapi.binance.com"
        d = data.derivatives("BTCUSDT")
        self.assertIsNone(d["funding_rate"])  # no OKX fixture: degrade, don't crash
        self.assertTrue(d["warnings"])


class OfflineMeme(TraderTestCase):
    NOW = DEMOS["meme"]["now"]

    def test_resolve_and_candles(self):
        s = data.get_candles(MEME_PASS)
        self.assertEqual(s.source, "GeckoTerminal")
        self.assertEqual(s.meta["pool"], TOKENS["PUPKIN"]["pool"])  # deepest pool chosen
        self.assertLess(s.meta["history_days"], 3)
        self.assertEqual(s.symbol.name, "PUPKIN")
        self.assertEqual(mc.iso(s.candles[-1].t), "2026-10-20T15:50:00Z")

    def test_pair_and_quote(self):
        p = data.get_pair(MEME_FAIL)
        self.assertEqual((p["base"]["symbol"], p["liquidity_usd"]), ("MLAMBO", 61200.0))
        q = data.get_quote(MEME_PASS)
        self.assertAlmostEqual(q["price"], 0.004712)
        self.assertEqual(q["source"], "DexScreener")

    def test_evm_without_chain_and_name_search(self):
        p = data.get_pair(TOKENS["NEWT"]["address"])
        self.assertEqual(p["chain"], "base")
        found = data.get_pair(data.symbols.parse("PUPKIN", asset="meme"))
        self.assertEqual(found["base"]["address"], TOKENS["PUPKIN"]["address"])
        self.assertTrue(found["warnings"])  # name search must tell the user to verify the address

    def test_meme_universe_filters_chain(self):
        u = data.meme_universe(["solana", "base"])
        names = sorted(t["symbol"].name for t in u["tokens"])
        self.assertEqual(names, ["MLAMBO", "NEWT", "PUPKIN"])

    def test_safety_sources(self):
        rep = rugcheck_api.report(TOKENS["MLAMBO"]["address"])
        s = rugcheck_api.summarize(rep, TOKENS["MLAMBO"]["pool"])
        self.assertEqual((s["lp_locked_pct"], s["top_holder_pct"]), (0.0, 40.0))
        hp = honeypot.check(TOKENS["NEWT"]["address"], 8453)
        self.assertEqual((hp["is_honeypot"], hp["sell_tax"], hp["open_source"]), (False, 4.0, False))
        top = honeypot.top_holders(TOKENS["NEWT"]["address"], 8453, exclude=[TOKENS["NEWT"]["pool"]])
        self.assertEqual(top["top_holder_pct"], 8.0)


class CacheAndHttp(TraderTestCase):
    def test_cache_ttl_and_stale(self):
        c = cache.FileCache(self.tmp / "c")
        c.set("https://x.test/a", "body")
        self.assertEqual(c.get("https://x.test/a", 60)[0], "body")
        with mock.patch("time.time", return_value=time.time() + 120):
            self.assertIsNone(c.get("https://x.test/a", 60))
            self.assertEqual(c.get("https://x.test/a", 60, allow_stale=True)[0], "body")
        self.assertEqual(c.clear(), 1)

    def _online(self):
        os.environ.pop("TRADER_OFFLINE", None)

    def test_backoff_on_429_then_success(self):
        self._online()
        calls = []

        class Resp:
            headers = {}

            def __init__(self, body):
                self.body = body

            def read(self, n):  # a stream: the body, then the end
                body, self.body = self.body, b""
                return body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake(req, timeout=0):
            calls.append(req.full_url)
            if len(calls) == 1:
                raise urllib.error.HTTPError(req.full_url, 429, "slow down", {"Retry-After": "0"}, None)
            return Resp(b'{"ok": 1}')
        with mock.patch("urllib.request.urlopen", fake), mock.patch("time.sleep"):
            self.assertEqual(http.get_json("https://api.example.test/x", ttl=0), {"ok": 1})
        self.assertEqual(len(calls), 2)
        self.assertEqual(http.stats["retries"], 1)

    def test_a_server_that_trickles_or_cuts_off_is_a_failed_request(self):
        self._online()

        class Trickle:
            headers = {}

            def read(self, n):
                return b"x"  # a byte at a time, forever

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        class Cut(Trickle):
            headers = {"Content-Length": "100"}

            def __init__(self):
                self.left = b'{"ok"'

            def read(self, n):
                body, self.left = self.left, b""
                return body
        clock = [0.0]

        def mono():
            clock[0] += 1.0
            return clock[0]
        for resp in (Trickle, Cut):
            with mock.patch("urllib.request.urlopen", lambda req, timeout=0, r=resp: r()), \
                    mock.patch("time.sleep"), mock.patch("time.monotonic", mono):
                with self.assertRaises(http.SourceError):
                    http.get_text("https://api.example.test/slow", ttl=0, allow_stale=False, timeout=5)

    def test_geo_block_trips_breaker(self):
        self._online()
        calls = []

        def fake(req, timeout=0):
            calls.append(1)
            raise urllib.error.HTTPError(req.full_url, 451, "unavailable", {}, None)
        with mock.patch("urllib.request.urlopen", fake):
            with self.assertRaises(http.GeoBlocked):
                http.get_text("https://geo.example.test/a", ttl=0)
            with self.assertRaises(http.GeoBlocked):
                http.get_text("https://geo.example.test/b", ttl=0)
        self.assertEqual(len(calls), 1)

    def test_stale_copy_served_when_network_fails(self):
        self._online()
        url = "https://stale.example.test/a"
        http._get_cache().set(url, "old")
        with mock.patch("time.time", return_value=time.time() + 600), \
                mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")), \
                mock.patch("time.sleep"):
            self.assertEqual(http.get_text(url, ttl=60), "old")
        self.assertTrue(http.warnings)

    def test_sec_requires_user_agent_online(self):
        self._online()
        with self.assertRaises(http.SourceError):
            sec.tickers(config.load_config())

    def test_config_defaults_written(self):
        cfg = config.load_config()
        self.assertTrue(cfg["paper"])
        self.assertTrue((self.home / "limits.json").exists())
        (self.home / "config.json").write_text(json.dumps({"account_size": 1000}), encoding="utf-8")
        self.assertEqual(config.load_config()["account_size"], 1000)
        self.assertEqual(config.load_config()["quote_currency"], "USDT")  # defaults merged in


if __name__ == "__main__":
    unittest.main()
