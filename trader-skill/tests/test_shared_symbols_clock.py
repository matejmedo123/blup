"""Symbol detection and the market clock (NYSE calendar 2026–2027, DST, 24/7 windows)."""
from __future__ import annotations

import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

from tests.helpers import TraderTestCase  # noqa: F401  (puts the pack on sys.path)
from shared import market_clock as mc
from shared import symbols

UTC = timezone.utc


class SymbolDetection(unittest.TestCase):
    def test_stock(self):
        s = symbols.parse("tsla")
        self.assertEqual((s.asset, s.key, s.display, s.yahoo, s.stooq), ("stock", "TSLA", "TSLA", "TSLA", "tsla.us"))
        b = symbols.parse("BRK.B")
        self.assertEqual((b.asset, b.yahoo, b.key), ("stock", "BRK-B", "BRK-B"))
        self.assertEqual(symbols.parse("BRK-B").asset, "stock")

    def test_crypto_forms(self):
        for raw, base, quote in (("BTCUSDT", "BTC", "USDT"), ("BTC-USD", "BTC", "USD"), ("btc/usdt", "BTC", "USDT"),
                                 ("ETHUSD", "ETH", "USD"), ("PEPEUSDT", "PEPE", "USDT"), ("SOL", "SOL", "USDT")):
            s = symbols.parse(raw)
            self.assertEqual((s.asset, s.base, s.quote), ("crypto", base, quote), raw)
        s = symbols.parse("BTC-USD")
        self.assertEqual((s.binance, s.coinbase, s.kraken, s.alpaca, s.okx_swap),
                         ("BTCUSDT", "BTC-USD", "XBTUSD", "BTC/USD", "BTC-USDT-SWAP"))
        self.assertEqual(symbols.parse("ETH", quote="USD").quote, "USD")

    def test_meme_forms(self):
        mint = "Fk6KsBpNNTxEMb4bovfUMjB4xZiZ8376ritJ6qzWpump"
        for raw in ("SOL:" + mint, "solana:" + mint, mint):
            s = symbols.parse(raw)
            self.assertEqual((s.asset, s.chain, s.address), ("meme", "solana", mint), raw)
        evm = "0x121a169740236be88462defefcdad9de98ee0346"
        b = symbols.parse("base:" + evm)
        self.assertEqual((b.asset, b.chain, b.gt_network), ("meme", "base", "base"))
        self.assertEqual(symbols.parse(evm).chain, "")  # resolved later via DexScreener
        self.assertTrue(b.explorer_url.startswith("https://basescan.org/token/"))
        self.assertEqual(symbols.parse("eth:" + evm).gt_network, "eth")

    def test_asset_override_and_errors(self):
        self.assertEqual(symbols.parse("BTC", asset="stock").asset, "stock")
        self.assertEqual(symbols.parse("PEPE", asset="meme").asset, "meme")
        self.assertEqual(symbols.parse("AAPL", asset="crypto").asset, "crypto")
        with self.assertRaises(symbols.SymbolError):
            symbols.parse("")
        with self.assertRaises(symbols.SymbolError):
            symbols.parse("not a symbol!!")
        with self.assertRaises(symbols.SymbolError):
            symbols.parse("SOL:Fk6KsBpNNTxEMb4bovfUMjB4xZiZ8376ritJ6qzWpump", asset="stock")

    def test_roundtrip_dict(self):
        s = symbols.parse("base:0x121a169740236be88462defefcdad9de98ee0346")
        self.assertEqual(symbols.from_dict(s.to_dict()).key, s.key)


class NyseCalendar(unittest.TestCase):
    def test_official_2026_2027(self):
        self.assertEqual(len(mc.holidays(2026)), 10)
        self.assertEqual(len(mc.holidays(2027)), 10)
        for d in (date(2026, 4, 3), date(2026, 7, 3), date(2026, 11, 26), date(2027, 3, 26), date(2027, 6, 18),
                  date(2027, 7, 5), date(2027, 12, 24)):
            self.assertFalse(mc.is_trading_day(d), d)
        self.assertTrue(mc.is_early_close(date(2026, 11, 27)))
        self.assertTrue(mc.is_early_close(date(2026, 12, 24)))
        self.assertTrue(mc.is_early_close(date(2027, 11, 26)))
        self.assertFalse(mc.is_early_close(date(2027, 12, 23)))

    def test_rules_agree_with_official_table(self):
        for year in (2026, 2027):
            self.assertEqual(set(mc.rule_holidays(year)), set(mc.OFFICIAL_HOLIDAYS[year]), year)
            self.assertEqual(set(mc.rule_early_closes(year)), set(mc.OFFICIAL_EARLY_CLOSES[year]), year)
        self.assertIn(date(2028, 7, 3), mc.rule_early_closes(2028))      # Monday before a Tuesday July 4th
        self.assertNotIn(date(2027, 12, 31), mc.rule_holidays(2028))    # Saturday New Year is not observed

    def test_session_bounds_dst(self):
        o, c = mc.session_bounds(date(2026, 10, 20))  # EDT
        self.assertEqual((mc.iso(o), mc.iso(c)), ("2026-10-20T13:30:00Z", "2026-10-20T20:00:00Z"))
        o, c = mc.session_bounds(date(2026, 11, 27))  # EST + early close
        self.assertEqual((mc.iso(o), mc.iso(c)), ("2026-11-27T14:30:00Z", "2026-11-27T18:00:00Z"))
        self.assertEqual(mc.iso(mc.flat_by(date(2026, 11, 27))), "2026-11-27T17:55:00Z")
        self.assertIsNone(mc.session_bounds(date(2026, 10, 24)))  # Saturday

    def test_fallback_without_zoneinfo(self):
        with mock.patch.object(mc, "_NY", None):
            self.assertEqual(mc.et_offset(datetime(2026, 7, 1, 15, tzinfo=UTC)), timedelta(hours=-4))
            self.assertEqual(mc.et_offset(datetime(2026, 12, 1, 15, tzinfo=UTC)), timedelta(hours=-5))
            self.assertEqual(mc.iso(mc.et_to_utc(date(2026, 3, 9), 9, 30)), "2026-03-09T13:30:00Z")  # day after DST
            self.assertEqual(mc.iso(mc.et_to_utc(date(2026, 3, 6), 9, 30)), "2026-03-06T14:30:00Z")
            self.assertEqual(mc.fmt_et(datetime(2026, 10, 20, 14, 10, tzinfo=UTC)), "10:10")

    def test_market_status(self):
        s = mc.market_status(mc.parse_iso("2026-10-20T14:15:00Z"))
        self.assertEqual((s["state"], s["closes_at"]), ("open", "2026-10-20T20:00:00Z"))
        self.assertEqual(mc.market_status(mc.parse_iso("2026-10-20T12:00:00Z"))["state"], "pre-market")
        self.assertEqual(mc.market_status(mc.parse_iso("2026-10-20T21:00:00Z"))["state"], "after-hours")
        sat = mc.market_status(mc.parse_iso("2026-10-24T15:00:00Z"))
        self.assertEqual((sat["state"], sat["next_open"]), ("closed", "2026-10-26T13:30:00Z"))
        hol = mc.market_status(mc.parse_iso("2026-11-26T15:00:00Z"))
        self.assertEqual((hol["state"], hol["holiday"]), ("closed", "Thanksgiving Day"))

    def test_trading_days(self):
        days = mc.trading_days(date(2026, 9, 9), 3)
        self.assertEqual(days, [date(2026, 9, 4), date(2026, 9, 8), date(2026, 9, 9)])  # skips Labor Day


class Windows(unittest.TestCase):
    def test_buckets(self):
        self.assertEqual(mc.stock_bucket(mc.parse_iso("2026-10-20T14:00:00Z")), "morning")
        self.assertEqual(mc.stock_bucket(mc.parse_iso("2026-10-20T17:00:00Z")), "midday")
        self.assertEqual(mc.stock_bucket(mc.parse_iso("2026-10-20T19:30:00Z")), "power_hour")
        self.assertEqual(mc.crypto_bucket(mc.parse_iso("2026-10-20T03:00:00Z")), "asia")
        self.assertEqual(mc.crypto_bucket(mc.parse_iso("2026-10-20T10:00:00Z")), "europe")
        self.assertEqual(mc.crypto_bucket(mc.parse_iso("2026-10-20T15:00:00Z")), "us")

    def test_crypto_ranges_follow_us_dst(self):
        r = mc.crypto_ranges(date(2026, 10, 20))
        self.assertEqual(mc.iso(r["asia"][1]), "2026-10-20T08:00:00Z")
        self.assertEqual(mc.iso(r["us_open"][0]), "2026-10-20T13:30:00Z")
        self.assertEqual(mc.iso(mc.crypto_ranges(date(2026, 12, 1))["us_open"][0]), "2026-12-01T14:30:00Z")

    def test_horizon_and_iso(self):
        self.assertEqual(mc.parse_horizon("4h"), 14400)
        self.assertEqual(mc.parse_horizon("90m"), 5400)
        self.assertEqual(mc.parse_horizon("1d"), 86400)
        with self.assertRaises(ValueError):
            mc.parse_horizon("soon")
        self.assertEqual(mc.iso(mc.parse_iso("2026-10-20T14:15:00.123456789Z")), "2026-10-20T14:15:00Z")
        self.assertEqual(mc.iso(mc.parse_iso("2026-10-20")), "2026-10-20T00:00:00Z")


class PinnedClock(TraderTestCase):
    NOW = "2026-10-20T14:15:00Z"

    def test_now_is_pinned(self):
        self.assertEqual(mc.iso(mc.now_utc()), "2026-10-20T14:15:00Z")
        self.assertEqual(mc.crypto_context()["us_market"], "open")


if __name__ == "__main__":
    unittest.main()
