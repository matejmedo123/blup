"""Established meme coins: off unless switched on; then only the big ones, a year on the exchange, validated by the
lab, at half the risk — and a DEX token never."""
from __future__ import annotations

import json
from unittest import mock

from shared import config, data, market_clock as mc, symbols, universe
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load


def ap():
    return load("trader-autopilot", "autopilot")


def on(rank=40, days=365, mult=0.5):
    return {"autopilot": {"memes": {"enabled": True, "max_rank": rank, "min_listed_days": days, "risk_mult": mult}}}


def rows(*pairs):
    return {"coins": [{"symbol": symbols.parse(b + "USDT", asset="crypto"), "rank": r, "volume_24h": 1e9}
                      for b, r in pairs], "source": "test", "warnings": []}


class Universe(TraderTestCase):
    def picks(self, cfg):
        with mock.patch.object(data, "crypto_universe", return_value=rows(("BTC", 1), ("DOGE", 8), ("BONK", 55))):
            picks, excluded = universe._crypto_picks(cfg, None)[:2]
        return [k for k, _ in picks], excluded

    def test_off_by_default(self):
        picks, excluded = self.picks(config.load_config())
        self.assertNotIn("DOGEUSDT", picks)
        self.assertIn("off", excluded["DOGEUSDT"])

    def test_on_only_the_big_ones(self):
        picks, excluded = self.picks(on())
        self.assertIn("DOGEUSDT", picks)
        self.assertNotIn("BONKUSDT", picks)
        self.assertIn("top 40", excluded["BONKUSDT"])


class Judge(TraderTestCase):
    NOW = "2026-10-20T15:00:00Z"

    def cand(self, playbook=True):
        sym = data.as_symbol("DOGEUSDT", "crypto")
        return {"id": "DOGEUSDT-x-trend_ema", "sym": sym, "asset": "crypto", "setup": "trend_ema", "interval": "1d",
                "playbook": {"setup": "trend_ema"} if playbook else None}

    def history(self, days):
        end = mc.ts(self.NOW)
        bars = [Candle(end - (days - i) * 86400, 0.1, 0.1, 0.1, 0.1, 1.0) for i in range(days)]
        return data.Series(data.as_symbol("DOGEUSDT", "crypto"), "1d", bars, "test", [], {})

    def test_refusals(self):
        self.assertIn("off", ap().meme_refusal(self.cand(), config.load_config()))
        self.assertIn("backtest lab validated", ap().meme_refusal(self.cand(playbook=False), on()))
        with mock.patch.object(data, "get_candles", return_value=self.history(200)):
            self.assertIn("199 days on the exchange", ap().meme_refusal(self.cand(), on()))
        with mock.patch.object(data, "get_candles", return_value=self.history(800)):
            self.assertEqual(ap().meme_refusal(self.cand(), on()), "")

    def test_a_dex_token_never(self):
        sym = symbols.meme_symbol("solana", "So11111111111111111111111111111111111111112", "X")
        d = ap().judge({"id": "x", "sym": sym, "asset": "meme", "setup": "trend_ema"}, on(), {}, None,
                       {"items": {}, "handled": {}}, True, {})
        self.assertIn("DEX", d["reasons"][0])

    def test_the_policy_reads_its_settings(self):
        self.assertIsNone(symbols.memes_policy(config.load_config()))
        self.assertEqual(symbols.memes_policy(on(rank=20, mult=3))["risk_mult"], 1.0)  # never more than the full risk
        self.assertEqual(symbols.memes_policy(on(rank=20))["max_rank"], 20)


class Lab(TraderTestCase):
    def test_a_meme_coin_counts_only_after_a_year_listed(self):
        lab = load("trader-backtest", "lab")
        t0 = mc.ts("2024-01-01T00:00:00Z")
        old = [Candle(t0 - (400 - i) * 86400, 1, 1, 1, 1, 1e9) for i in range(400)]
        young = [Candle(t0 - (100 - i) * 86400, 1, 1, 1, 1, 9e9) for i in range(100)]  # bigger, but new
        daily = {"DOGEUSDT": old, "NEWMEMEUSDT": young, "BTCUSDT": old}
        self.assertEqual(lab.pit_members(daily, [t0], 2, {"DOGEUSDT": 365, "NEWMEMEUSDT": 365}),
                         [{"DOGEUSDT", "BTCUSDT"}])
        self.assertIn("NEWMEMEUSDT", lab.pit_members(daily, [t0], 2)[0])


class Profile(TraderTestCase):
    def test_switch(self):
        cfg_on = ap().trend_profile(2, 1, 1, 1000.0, memes=True)[0]
        cfg_off = ap().trend_profile(2, 1, 1, 1000.0)[0]
        self.assertTrue(cfg_on["autopilot"]["memes"]["enabled"])
        self.assertFalse(cfg_off["autopilot"]["memes"]["enabled"])
        self.assertIsNotNone(json.dumps(cfg_on))
