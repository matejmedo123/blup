"""Universe: the autopilot's own pick of stocks and crypto, refreshed on its own schedule."""
from __future__ import annotations

import time
from unittest import mock

from tests.helpers import TraderTestCase
from shared import config, http, universe
from shared.sources import yahoo

NOW = "2026-10-20T15:00:00Z"


class FakeBroker:
    name = "alpaca"
    notes = []

    def __init__(self, bases):
        self.bases = bases

    def tradable(self, asset):
        return set(self.bases) if asset == "crypto" else None


class Universe(TraderTestCase):
    NOW = NOW

    def cfg(self, **universe_cfg):
        if universe_cfg:
            self.write_state("config.json", {"autopilot": {"universe": universe_cfg}})
        return config.load_config()

    def test_default_auto_is_fast_and_explains_itself(self):
        t = time.monotonic()
        cur = universe.current(self.cfg())
        self.assertLess(time.monotonic() - t, 3.0)
        self.assertEqual(sorted(cur), ["crypto", "stock"])
        self.assertEqual(cur["stock"][:5], ["TSLA", "NVDA", "AAPL", "AMD", "META"])  # the watchlist comes first
        self.assertIn("PLTR", cur["stock"])                                           # picked by itself
        self.assertEqual(cur["crypto"][:3], ["BTCUSDT", "ETHUSDT", "SOLUSDT"])
        self.assertIn("XRPUSDT", cur["crypto"])
        doc = self.read_state("autopilot/universe.json")
        self.assertEqual(doc["mode"], "auto")
        self.assertEqual(doc["stock"]["reasons"]["NVDA"], "watchlist")
        self.assertTrue(doc["stock"]["reasons"]["PLTR"].startswith("top mover: gap"))
        self.assertTrue(doc["crypto"]["reasons"]["XRPUSDT"].startswith("top 20 by 24h volume"))
        self.assertEqual(doc["excluded"]["MULN"], "price $0.31 below min_price $2.00")
        self.assertIn("market cap", doc["excluded"]["BYND"])
        for a in ("stock", "crypto"):
            self.assertEqual(doc[a]["refreshed_at"], NOW)
            self.assertTrue(doc[a]["source"])
        self.assertNotIn("USDTUSDT", cur["crypto"])
        self.assertNotIn("WBTCUSDT", cur["crypto"])

    def test_ranking_and_movers(self):
        self.write_state("config.json", {"watchlists": {"stocks": [], "crypto": []},
                                         "autopilot": {"assets": ["stock"], "universe": {"stocks": {
                                             "top_n": 2, "base": ["TSLA", "NVDA", "AAPL", "META"], "max_movers": 2}}}})
        cfg = config.load_config()
        cur = universe.current(cfg)
        self.assertEqual(list(cur), ["stock"])  # crypto is not an enabled asset class
        sp = yahoo.spark(["TSLA", "NVDA", "AAPL", "META"])
        score = {t: abs(d["closes"][0] / d["prev_close"] - 1) + abs(d["closes"][-1] / d["closes"][0] - 1)
                 for t, d in sp.items()}
        top2 = sorted(score, key=lambda t: -score[t])[:2]
        self.assertEqual(cur["stock"][:2], top2)
        movers = cur["stock"][2:]
        self.assertEqual(len(movers), 2)  # capped at max_movers
        doc = self.read_state("autopilot/universe.json")
        for t in movers:
            self.assertRegex(doc["stock"]["reasons"][t], r"^(most active today|day gainer)")
        self.assertNotIn("MULN", cur["stock"])

    def test_movers_off_and_market_cap_floor(self):
        self.write_state("config.json", {"watchlists": {"stocks": []}, "autopilot": {"assets": ["stock"], "universe": {
            "stocks": {"base": ["AAPL"], "include_movers": True, "min_market_cap_usd": 1e15}}}})
        self.assertEqual(universe.current(config.load_config())["stock"], ["AAPL"])
        doc = self.read_state("autopilot/universe.json")
        self.assertIn("market cap", doc["excluded"]["PLTR"])
        self.write_state("config.json", {"watchlists": {"stocks": []}, "autopilot": {"assets": ["stock"], "universe": {
            "stocks": {"base": ["AAPL"], "include_movers": False}}}})
        self.assertEqual(universe.current(config.load_config())["stock"], ["AAPL"])

    def test_always_exclude_and_blocked(self):
        self.write_state("limits.json", {"blocked_symbols": ["META", "ETH-USD"]})
        cfg = self.cfg(always=["COIN", "DOGE-USDT", "SOL:Fk6KsBpNNTxEMb4bovfUMjB4xZiZ8376ritJ6qzWpump"],
                       exclude=["PLTR", "ETHUSDT", "XRPUSDT"])
        cur = universe.current(cfg)
        self.assertIn("COIN", cur["stock"])
        self.assertNotIn("DOGEUSDT", cur["crypto"])   # a meme coin, even listed on an exchange and asked for
        self.assertIn("meme coin", self.read_state("autopilot/universe.json")["excluded"]["DOGEUSDT"])
        for gone in ("META", "PLTR"):
            self.assertNotIn(gone, cur["stock"])
        for gone in ("ETHUSDT", "XRPUSDT"):
            self.assertNotIn(gone, cur["crypto"])
        doc = self.read_state("autopilot/universe.json")
        self.assertIn("limits.json", doc["excluded"]["META"])
        self.assertIn("exclude", doc["excluded"]["PLTR"])
        self.assertEqual(doc["stock"]["reasons"]["COIN"], "always (autopilot.universe.always)")
        self.assertFalse(any("FK6K" in s.upper() for s in cur["crypto"] + cur["stock"]))  # meme coins never

    def test_watchlist_mode_is_v2(self):
        self.write_state("config.json", {"autopilot": {"universe": {"mode": "watchlist"},
                                                       "watchlist": {"stocks": ["NVDA"], "crypto": ["BTCUSDT"]}}})
        calls = []
        with mock.patch.object(http, "get_text", lambda url, *a, **k: calls.append(url)):
            cur = universe.current(config.load_config())
        self.assertEqual(cur, {"stock": ["NVDA"], "crypto": ["BTCUSDT"]})
        self.assertEqual(calls, [])  # no network at all
        self.write_state("config.json", {"autopilot": {"universe": {"mode": "watchlist"}, "assets": ["crypto"]}})
        self.assertEqual(universe.current(config.load_config()), {"crypto": ["BTCUSDT", "ETHUSDT", "SOLUSDT"]})

    def test_refresh_only_when_stale(self):
        cfg = self.cfg()
        universe.current(cfg)
        calls = []
        real = http.get_text

        def spy(url, *a, **k):
            calls.append(url)
            return real(url, *a, **k)
        with mock.patch.object(http, "get_text", spy):
            self.set_now("2026-10-20T15:30:00Z")
            universe.current(cfg)
            self.assertEqual(calls, [])
            self.set_now("2026-10-20T16:01:00Z")  # stocks are older than 60 min, crypto not yet 240
            universe.current(cfg)
            self.assertTrue(calls)
            self.assertTrue(all("yahoo" in u for u in calls), calls)
        doc = self.read_state("autopilot/universe.json")
        self.assertEqual(doc["stock"]["refreshed_at"], "2026-10-20T16:01:00Z")
        self.assertEqual(doc["crypto"]["refreshed_at"], NOW)
        # a settings change refreshes at once
        self.write_state("config.json", {"autopilot": {"universe": {"crypto": {"top_n": 2}}}})
        universe.current(config.load_config())
        doc = self.read_state("autopilot/universe.json")
        self.assertEqual(doc["crypto"]["refreshed_at"], "2026-10-20T16:01:00Z")
        self.assertEqual([p[0] for p in doc["crypto"]["picks"]], ["BTCUSDT", "ETHUSDT"])
        self.assertNotIn("XRPUSDT", doc["crypto"]["symbols"])

    def test_failures_keep_the_previous_list_then_fall_back(self):
        os_env = __import__("os").environ
        cfg = self.cfg()
        first = universe.current(cfg)
        os_env["TRADER_OFFLINE_FAIL"] = "query1.finance.yahoo.com,api.coingecko.com,api.binance.com,data-api.binance.vision"
        self.set_now("2026-10-20T20:00:00Z")
        again = universe.current(cfg)
        self.assertEqual(again, first)
        doc = self.read_state("autopilot/universe.json")
        self.assertTrue(any("kept the list" in w for w in doc["warnings"]), doc["warnings"])
        self.assertEqual(doc["stock"]["refreshed_at"], NOW)
        # with nothing to keep: the watchlists
        (self.home / "autopilot" / "universe.json").unlink()
        cur = universe.current(cfg)
        self.assertEqual(cur["stock"], ["TSLA", "NVDA", "AAPL", "AMD", "META"])
        self.assertEqual(cur["crypto"], ["BTCUSDT", "ETHUSDT", "SOLUSDT"])
        doc = self.read_state("autopilot/universe.json")
        self.assertTrue(any("fell back to the watchlists" in w for w in doc["warnings"]))
        # a failed refresh is not retried every cycle
        calls = []
        real = http.get_text
        with mock.patch.object(http, "get_text", lambda u, *a, **k: calls.append(u) or real(u, *a, **k)):
            self.set_now("2026-10-20T20:05:00Z")
            universe.current(cfg)
        self.assertEqual(calls, [])

    def test_broker_tradable_filter_and_volume_floor(self):
        self.write_state("config.json", {"autopilot": {"universe": {"crypto": {"min_volume_usd": 3e9}}}})
        cur = universe.current(config.load_config(), broker=FakeBroker({"BTC", "ETH", "SOL", "DOGE"}))
        doc = self.read_state("autopilot/universe.json")
        self.assertEqual(doc["excluded"]["XRPUSDT"], "not tradable on alpaca")
        self.assertIn("meme coin", doc["excluded"]["DOGEUSDT"])   # out before the volume floor is even checked
        self.assertIn("below $3.0B", doc["excluded"]["BNBUSDT"])
        self.assertEqual(cur["crypto"], ["BTCUSDT", "ETHUSDT", "SOLUSDT"])
        self.assertIn("tradable on alpaca", doc["crypto"]["source"])
