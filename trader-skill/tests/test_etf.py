"""Bear markets: the ETF trend while crypto is in a bear market, held for days; idle cash earns T-bill interest."""
from __future__ import annotations

import random
import unittest

from shared import config, data, market_clock as mc, setups, state
from shared.brokers.simulator import SimBroker
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load
from tests.test_lab import ap, entry, lab

DAY = 86400
NOW = "2026-10-20T15:00:00Z"  # a Tuesday, 11:00 a.m. ET — the US market is open


def series(n, drift, seed=1, start=None):
    rng = random.Random(seed)
    start = start or (mc.ts(NOW) - (n + 1) * DAY)
    out, px = [], 100.0
    for i in range(n):
        o, px = px, px * (1 + drift + rng.uniform(-0.012, 0.012))
        out.append(Candle(start + i * DAY, o, max(o, px) * 1.004, min(o, px) * 0.996, px, 1000.0))
    return out


def etf_signal_series():
    """A rising ETF cut off right at a day the trend rule fires — the signal is on the newest closed bar."""
    bars = series(700, 0.0012, seed=4)
    sig = setups.series_signals("etf_trend", bars, "1d")
    assert sig, "the synthetic ETF never fired"
    i = sig[-1]["trigger"]["index"]
    shift = mc.ts(NOW) - DAY - bars[i].t - 3600  # the signal bar closed an hour ago
    return [Candle(c.t + shift, c.o, c.h, c.l, c.c, c.v) for c in bars[:i + 1]]


class EtfRule(TraderTestCase):
    def test_fires_only_above_its_own_200_day_average(self):
        up = series(700, 0.0012, seed=4)
        self.assertTrue(setups.series_signals("etf_trend", up, "1d"))
        for s in setups.series_signals("etf_trend", up, "1d"):
            i = s["trigger"]["index"]
            self.assertGreater(up[i].c, sum(c.c for c in up[i - 199:i + 1]) / 200.0)
        self.assertEqual(setups.series_signals("etf_trend", series(700, -0.002, seed=5), "1d"), [])
        self.assertIn("etf_trend", setups.for_asset("stock", "series"))
        self.assertNotIn("etf_trend", setups.for_asset("crypto"))

    def test_daily_stock_plans_are_held_for_days(self):
        exit_mod = load("trader-exit", "exit")
        bars = series(300, 0.001)
        t0 = mc.ts(NOW)
        day_trade = exit_mod.plan_levels(bars[-1].c, t0, "stock", bars, horizon_s=250 * DAY)
        swing = exit_mod.plan_levels(bars[-1].c, t0, "stock", bars, horizon_s=250 * DAY, swing=True)
        self.assertLess(mc.ts(day_trade["time_stop"]["at"]) - t0, DAY)  # flat by 3:55 p.m. ET
        self.assertEqual(mc.ts(swing["time_stop"]["at"]) - t0, 250 * DAY)

    def test_desk_waits_over_a_weekend_for_a_daily_stock_signal(self):
        desk = load("trader-desk", "desk")
        d = {"max_idea_age_hours": {"stock": 2, "crypto": 4}}
        self.assertEqual(desk.max_idea_age(d, "stock", {"interval": "1d"}), 96.0)
        self.assertEqual(desk.max_idea_age(d, "crypto", {"interval": "1d"}), 12.0)
        self.assertEqual(desk.max_idea_age(d, "stock", {"interval": "5m"}), 2)


class EtfLab(TraderTestCase):
    def test_lab_runs_on_etfs_and_writes_its_own_playbook(self):
        rising = {s: series(2400, 0.0009, seed=i) for i, s in enumerate(("GLD", "UUP", "DBC"))}
        rising["BTCUSDT"] = series(2700, -0.002, seed=9)  # a long crypto bear market: every ETF day counts
        real = lab().history

        def fake(sym, interval, days, now_ts, asset="crypto"):
            self.assertEqual(asset, "crypto" if sym.key == "BTCUSDT" else "stock")
            return [c for c in rising[sym.key] if c.t + DAY <= now_ts], "test"
        lab().history = fake
        self.addCleanup(setattr, lab(), "history", real)
        args = lab().build_parser().parse_args(["--etf", "--symbols", "GLD,UUP,DBC", "--no-html", "--min-pooled",
                                                "20", "--min-pooled-test", "10", "--min-test", "3"])
        ctx = type("Ctx", (), {"cfg": config.load_config(), "now": mc.parse_iso(NOW)})()
        doc = lab().run(args, ctx)["doc"]
        self.assertEqual((doc["asset"], doc["timeframes"]), ("etf", ["1d"]))
        self.assertEqual([f["setup"] for f in doc["families"]], ["etf_trend"])
        self.assertEqual(doc["families"][0]["when"], "crypto_bear")  # tested on the days the bot trades it
        self.assertGreater(doc["families"][0]["signals"], 0)
        rising["BTCUSDT"] = series(2700, 0.002, seed=9)  # crypto never in a bear market: no ETF trade to count
        doc = lab().run(args, ctx)["doc"]
        self.assertEqual(doc["families"][0]["signals"], 0)
        rising["BTCUSDT"] = series(2700, -0.002, seed=9)
        doc = lab().run(args, ctx)["doc"]
        self.assertEqual(doc["costs"]["fee_bps"], 0)  # stock costs, not crypto
        self.assertIsNotNone(state.read_json("backtests/playbook-etf.json"))
        self.assertIsNone(state.read_json("backtests/playbook.json"))  # the crypto playbook is left alone
        self.assertIn("ETFs only from this list", lab().text(doc)) if doc["validated"] else None


class EtfSleeve(TraderTestCase):
    NOW = NOW

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.cfg = config.load_config()
        self.cfg["autopilot"]["etf_trend"].update(enabled=True, symbols=["GLD"])
        self.btc = series(400, -0.004, seed=2)   # Bitcoin far below its 200-day average
        self.gld = etf_signal_series()
        real = data.get_candles

        def fake(symbol, interval="5m", days=None, asset=None, end=None, quote=None):
            sym = data.as_symbol(symbol, asset)
            bars = {"BTCUSDT": self.btc, "GLD": self.gld}.get(sym.key)
            if bars is None or interval != "1d":
                return real(symbol, interval, days=days, asset=asset, end=end, quote=quote)
            return data.Series(sym, "1d", [c for c in bars if c.t + DAY <= mc.ts(mc.now_utc())], "test", [], {})
        data.get_candles = fake
        self.addCleanup(setattr, data, "get_candles", real)
        e = entry("GLD", "etf_trend", "1d", stop="rule", target_r=None, horizon="250d")
        self.write_state("backtests/playbook-etf.json", {"generated_at": "2026-10-19T00:00:00Z",
                                                        "entries": {"GLD:etf_trend@1d": e}})
        self.book = {"items": {}, "handled": {}}

    def test_in_a_crypto_bear_market_it_finds_the_etf_signal(self):
        cands, notes = ap().etf_candidates(self.cfg, self.book, {})
        self.assertEqual(len(cands), 1, notes)
        c = cands[0]
        self.assertEqual((c["asset"], c["interval"], c["setup"], c["sym"].key), ("stock", "1d", "etf_trend", "GLD"))
        plan = ap().make_plan(c, self.cfg)
        self.assertTrue(plan["swing"])
        self.assertEqual(plan["exit_rule"]["type"], "close_below_ema")
        self.assertGreater(mc.ts(plan["time_stop"]["at"]) - mc.ts(plan["entry"]["time"]), 200 * DAY)

    def test_waits_while_crypto_is_in_a_bull_market(self):
        self.btc = series(400, 0.004, seed=2)
        cands, notes = ap().etf_candidates(self.cfg, self.book, {})
        self.assertEqual(cands, [])
        self.assertIn("crypto is in a bull market", notes[0])
        self.cfg["autopilot"]["etf_trend"]["when"] = "always"
        self.assertEqual(len(ap().etf_candidates(self.cfg, self.book, {})[0]), 1)

    def test_only_what_the_etf_lab_validated_and_only_in_the_session(self):
        (self.home / "backtests" / "playbook-etf.json").unlink()
        cands, notes = ap().etf_candidates(self.cfg, self.book, {})
        self.assertEqual(cands, [])
        self.assertIn("lab.py --etf", notes[0])
        self.cfg["autopilot"]["etf_trend"]["required_lab"] = False
        self.assertEqual(len(ap().etf_candidates(self.cfg, self.book, {})[0]), 1)
        self.set_now("2026-10-20T13:35:00Z")  # 9:35 a.m. ET — too early
        self.assertEqual(ap().etf_candidates(self.cfg, self.book, {}), ([], []))
        self.cfg["autopilot"]["etf_trend"]["enabled"] = False
        self.set_now(NOW)
        self.assertEqual(ap().etf_candidates(self.cfg, self.book, {}), ([], []))

    def test_rule_exit_waits_for_the_market_to_open(self):
        from tests.test_autopilot import FakeBroker
        b = FakeBroker()
        b.pos = [{"symbol": "GLD", "asset": "stock", "qty": 3.0, "last": 90.0}]
        it = {"plan_id": "p", "order_id": "o", "symbol": "GLD", "data_key": "GLD", "asset": "stock", "qty": 3.0,
              "stop": 50.0, "target": 1e9, "time_stop": "2027-06-01T00:00:00Z", "status": "open", "swing": True,
              "placed_at": "2026-09-01T14:00:00Z", "filled_at": "2026-09-01T14:00:00Z", "broker": "alpaca",
              "mode": "paper", "exit_rule": dict(setups.exit_rule("etf_trend"), interval="1d")}
        self.gld = self.gld[:-1] + [Candle(self.gld[-1].t, 60, 60, 60, 60.0, 1)]  # far below the 50-day EMA
        book = {"items": {"p": dict(it, broker_order_id="e1")}, "handled": {}}
        it = book["items"]["p"]
        legs = [{"id": "sl", "parent_id": "e1", "symbol": "GLD", "side": "sell", "type": "stop", "status": "held",
                 "leg": "stop"}]
        self.set_now("2026-10-21T02:00:00Z")  # night in New York: its GTC stop is there, nothing to do
        self.assertEqual(ap().manage_exits(b, book, b.pos, legs, self.cfg), [])
        acts = ap().manage_exits(b, book, b.pos, [], self.cfg)  # …and if the stop were gone, it would get one back
        self.assertIn("put back", acts[0])
        self.set_now("2026-10-21T15:00:00Z")
        ap().manage_exits(b, book, b.pos, [], self.cfg)
        self.assertEqual((it["exit_reason"], b.calls[-1]), ("rule", ("close", "GLD")))


class CashYield(TraderTestCase):
    def test_idle_cash_earns_the_t_bill_rate_in_the_simulator(self):
        cfg = config.load_config()
        b = SimBroker(cfg)
        b.book.update(cash=1000.0, interest_at=0)
        b._charge_interest(365 * DAY)
        self.assertEqual(b.book["cash"], 1000.0)  # off by default
        cfg["cash_yield_pct"] = 4.0
        b = SimBroker(cfg)
        b.book.update(cash=1000.0, interest_at=0)
        b._charge_interest(365 * DAY)
        self.assertAlmostEqual(b.book["cash"], 1040.0, places=6)
        self.assertAlmostEqual(b.account()["interest_earned"], 40.0, places=2)

    def test_profile_turns_on_the_bear_market_plan(self):
        res = self.run_json("trader-autopilot", "autopilot", ["profile", "--capital", "1000"])
        c = res["config"]
        self.assertTrue(c["autopilot"]["etf_trend"]["enabled"])
        self.assertEqual(c["autopilot"]["etf_trend"]["when"], "crypto_bear")
        self.assertEqual(c["cash_yield_pct"], 4.0)
        self.assertEqual(c["autopilot"]["setups"]["stock"], [])  # only what the trend backtest tested trades
        from shared import universe
        self.assertNotIn("stock", universe._assets(c))            # so no stocks are picked for nothing
        res = self.run_json("trader-autopilot", "autopilot", ["profile", "--capital", "1000", "--no-etf",
                                                              "--cash-yield", "3"])
        self.assertFalse(res["config"]["autopilot"]["etf_trend"]["enabled"])
        self.assertEqual(res["config"]["cash_yield_pct"], 3.0)


class SwingBracketAtAlpaca(TraderTestCase):
    def test_a_position_held_for_days_gets_a_gtc_bracket(self):
        from shared.brokers.alpaca import AlpacaBroker
        b = AlpacaBroker.__new__(AlpacaBroker)
        sent = []
        b._post_order = lambda body: sent.append(body) or {"id": "x", "status": "new", "symbol": body["symbol"]}
        b._tick = lambda symbol, asset: 0.01
        b._order = lambda res, leg=None: res
        b.log = lambda *a, **k: None
        for swing in (False, True):
            b.place_entry({"symbol": "GLD", "asset": "stock", "qty": 3, "limit_price": 300.0, "stop_price": 290.0,
                           "target_price": 400.0, "client_order_id": "c", "swing": swing})
        self.assertEqual([x["time_in_force"] for x in sent], ["day", "gtc"])


if __name__ == "__main__":
    unittest.main()
