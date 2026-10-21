"""The checks: six desks per decision, "is it normal?" against the lab, and backtest vs reality."""
from __future__ import annotations

import unittest

from shared import config, data, health, market_clock as mc, setups, shadow, state
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load
from tests.test_lab import ap

DAY = 86400
NOW = "2026-10-20T00:30:00Z"
import random as _random
_rng = _random.Random(1)
REF = [2.0 if _rng.random() < 0.4 else -0.5 for _ in range(400)]  # 40 % winners in time order, ~+0.5R a trade
LAB = {"families": [{"setup": "trend_breakout", "test_trades": [[i, r] for i, r in enumerate(REF)]}]}


def trades(rs, setup="trend_breakout"):
    return [{"id": "t%d" % i, "setup": setup, "r": r, "at": "2026-01-%02dT00:00:00Z" % (1 + i % 28)}
            for i, r in enumerate(rs)]


class IsItNormal(TraderTestCase):
    def test_too_early_then_normal_then_alarm(self):
        ref = REF
        self.assertEqual(health.evaluate(trades([-0.5] * 5), ref)["status"], "early")
        self.assertEqual(health.evaluate(trades([1.0] * 20), [])["status"], "unknown")
        typical = health.evaluate(trades([-0.5, 2.0, -0.5, -0.5, 2.0, -0.5, 2.0, -0.5, -0.5, 2.0] * 3), ref)
        self.assertEqual(typical["status"], "normal", typical["text"])
        self.assertEqual([c["name"] for c in typical["checks"]], ["losing streak", "recent result", "drawdown"])
        weak = health.evaluate(trades([-0.5, -0.5, 2.0, -0.5, 2.0, -0.5, -0.5, -0.5, 2.0, -0.5] * 3), ref)
        self.assertEqual(weak["status"], "watch")  # 30 % winners where the backtest had 40 %: worth watching
        five = health.evaluate(trades([-0.5, 2.0, -0.5, -0.5, 2.0] * 2 + [-0.5] * 5 + [2.0, -0.5, 2.0, -0.5, -0.5] * 3), ref)
        self.assertEqual(five["checks"][0]["verdict"], "normal")  # five losses in a row in 30 trades: half the histories
        early5 = health.evaluate(trades([2.0, 2.0] + [-0.5] * 5 + [2.0] * 5), ref)
        self.assertEqual(early5["checks"][0]["verdict"], "watch")  # in only 12 trades it is rarer (≈ 1 history in 5)
        broken = health.evaluate(trades([2.0] + [-0.5] * 19), ref)
        self.assertEqual(broken["status"], "alarm")
        self.assertIn("worse than 9 of 10", broken["text"])
        self.assertLess(broken["checks"][1]["p"], 0.10)

    def test_a_runner_split_counts_once(self):
        journal = load("trader-journal", "journal")
        base = {"source": "autopilot", "asset": "crypto", "setup": "trend_breakout", "risk_per_unit": 10.0,
                "status": "closed", "entry": {"time": "2026-09-01T00:01:00Z", "price": 100.0}}
        journal.save_trade(dict(base, id="trd-p", qty=1.0, pnl_usd=20.0, r_net=2.0,
                                runner={"part": "sold", "of_qty": 3.0}, exit={"time": "2026-09-10T00:01:00Z"}))
        journal.save_trade(dict(base, id="trd-p-ride", qty=2.0, status="open", runner={"part": "ride", "from": "trd-p"}))
        self.assertEqual(health.live_trades(), [])  # judged when the ride ends
        journal.save_trade(dict(base, id="trd-p-ride", qty=2.0, pnl_usd=40.0, r_net=2.0,
                                runner={"part": "ride", "from": "trd-p"}, exit={"time": "2026-10-01T00:01:00Z"}))
        journal.save_trade(dict(base, id="trd-q", qty=1.0, pnl_usd=-5.0, r_net=-0.5, setup="trend_ema",
                                exit={"time": "2026-09-05T00:01:00Z"}))
        live = health.live_trades()
        self.assertEqual([(t["id"], round(t["r"], 3)) for t in live], [("trd-q", -0.5), ("trd-p", 2.0)])
        self.assertEqual(health.live_trades(since="2026-09-06T00:00:00Z")[0]["id"], "trd-p")

    def test_reference_is_every_lab_trade_in_the_order_they_ended(self):
        self.write_state("backtests/lab-crypto.json", {"families": [
            {"setup": "trend_breakout", "validated": True, "test_trades": [[10, 1.0], [30, -0.5]],
             "runner": {"helps": True, "test_trades": [[12, 3.0], [30, -0.5]]}},
            {"setup": "trend_ema", "validated": True, "test_trades": [[20, 2.0], [40, -0.4]]},
            {"setup": "asia_range", "validated": False, "test_trades": [[5, -9.0]]}]})  # not traded, not compared
        self.write_state("backtests/lab-etf.json", {"families": [{"setup": "etf_trend", "test_trades": [[25, 0.5]]}]})
        cfg = config.load_config()
        self.assertEqual(health.reference(cfg), [1.0, 2.0, 0.5, -0.5, -0.4])
        cfg["autopilot"]["runner"]["enabled"] = True
        self.assertEqual(health.reference(cfg), [3.0, 2.0, 0.5, -0.5, -0.4])

    def test_alarm_pauses_once_and_resume_starts_over(self):
        self.write_state("backtests/lab-crypto.json", LAB)
        journal = load("trader-journal", "journal")
        for i in range(20):
            journal.save_trade({"id": "trd-%d" % i, "source": "autopilot", "setup": "trend_breakout", "status": "closed",
                                "r_net": 2.0 if i == 0 else -0.5, "exit": {"time": "2026-10-%02dT00:01:00Z" % (1 + i)}})
        cfg = config.load_config()
        acts = []
        doc = ap().check_health(cfg, {"dd_reset_at": None}, mc.parse_iso(NOW), acts)
        self.assertEqual(doc["status"], "alarm")
        self.assertTrue(doc["pause"])
        self.assertTrue(any("PAUSED by the health check" in a for a in acts))
        again = ap().check_health(cfg, {"dd_reset_at": None}, mc.parse_iso(NOW), [])
        self.assertFalse(again.get("pause"))  # the same alarm does not pause twice
        resumed = ap().check_health(cfg, {"dd_reset_at": "2026-10-20T00:00:00Z"}, mc.parse_iso(NOW), [])
        self.assertEqual(resumed["status"], "early")  # after a resume the record starts over
        cfg["autopilot"]["health"]["pause_on_alarm"] = False
        state.write_json(health.FILE, {})
        self.assertFalse(ap().check_health(cfg, {"dd_reset_at": None}, mc.parse_iso(NOW), []).get("pause"))


class BacktestVsReality(TraderTestCase):
    NOW = NOW

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.cfg = config.load_config()
        end = mc.ts(NOW) - 1800  # the last daily bar closed half an hour ago
        n = 300
        self.btc = [Candle(end - (n - i) * DAY, 100 + i, 100 + i, 100 + i, 100.0 + i, 1) for i in range(n)]
        closes = [100.0] * (n - 6) + [110.0, 109.0, 108.5, 108.0, 107.8, 107.5]  # one breakout, 6 days ago
        self.eth = [Candle(end - (n - i) * DAY, c, c, c, c, 1) for i, c in enumerate(closes)]
        real = data.get_candles

        def fake(symbol, interval="5m", days=None, asset=None, end=None, quote=None):
            sym = data.as_symbol(symbol, asset)
            bars = {"BTCUSDT": self.btc, "ETHUSDT": self.eth}.get(sym.key)
            if bars is None:
                return real(symbol, interval, days=days, asset=asset, end=end, quote=quote)
            return data.Series(sym, interval, bars, "test", [], {})
        data.get_candles = fake
        self.addCleanup(setattr, data, "get_candles", real)
        self.write_state("backtests/playbook.json", {"generated_at": "2026-10-19T00:00:00Z", "entries": {
            "ETHUSDT:trend_breakout@1d": {"symbol": "ETHUSDT", "setup": "trend_breakout", "interval": "1d"}}})
        sig = setups.series_signals("trend_breakout", self.eth, "1d",
                                    context={"btc_up": setups.regime_map(self.btc)})
        self.assertEqual(len(sig), 1)
        self.sid = setups.setup_id("ETHUSDT", sig[0]["window"], "trend_breakout")
        self.price = sig[0]["trigger"]["price"]

    def test_a_signal_with_no_record_is_missed(self):
        doc = shadow.run(self.cfg)
        self.assertEqual([r["outcome"] for r in doc["rows"]], ["missed"])
        self.assertEqual(doc["verdict"], "check")
        self.assertIn("MISSED ETH", doc["problems"][0])

    def test_taken_with_its_slippage_and_skipped_with_its_reason(self):
        self.write_state("autopilot/book.json", {"items": {self.sid: {
            "plan_id": self.sid, "symbol": "ETH/USD", "asset": "crypto", "interval": "1d", "status": "open",
            "entry_fill": self.price * 1.001, "placed_at": "2026-10-14T00:01:00Z", "setup": "trend_breakout"}}})
        doc = shadow.run(self.cfg)
        row = doc["rows"][0]
        self.assertEqual((row["outcome"], row["slippage_bps"]), ("taken", 10.0))
        self.assertEqual(doc["verdict"], "ok", doc["problems"])
        self.assertIn("did what the rules say", doc["text"])
        self.write_state("autopilot/book.json", {"items": {self.sid: {
            "plan_id": self.sid, "symbol": "ETH/USD", "asset": "crypto", "interval": "1d", "status": "open",
            "entry_fill": self.price * 1.01, "placed_at": "2026-10-14T00:01:00Z", "setup": "trend_breakout"}}})
        self.assertIn("SLIPPAGE ETH/USDT: filled 100 bps", shadow.run(self.cfg)["problems"][0])
        self.write_state("autopilot/book.json", {"items": {}})
        state.append_jsonl("autopilot/decisions.jsonl", {"id": self.sid, "action": "skipped",
                                                         "reasons": ["5 open/pending crypto position(s) — max 5"]})
        doc = shadow.run(self.cfg)
        self.assertEqual((doc["rows"][0]["outcome"], doc["verdict"]), ("skipped", "ok"))
        self.assertIn("max 5", doc["rows"][0]["reason"])

    def test_a_trade_the_rules_do_not_explain_is_extra(self):
        state.append_jsonl("autopilot/decisions.jsonl", {"id": self.sid, "action": "skipped", "reasons": ["x"]})
        self.write_state("autopilot/book.json", {"items": {"SOLUSDT-20261015T0000-trend_ema": {
            "symbol": "SOL/USD", "asset": "crypto", "interval": "1d", "status": "open", "setup": "trend_ema",
            "placed_at": "2026-10-16T00:01:00Z"}}})
        doc = shadow.run(self.cfg)
        self.assertIn("extra", [r["outcome"] for r in doc["rows"]])
        self.assertEqual(doc["verdict"], "check")
        self.assertIn("BACKTEST vs REALITY · CHECK", shadow.text(doc))

    def test_check_command_prints_both(self):
        self.write_state("backtests/lab-crypto.json", LAB)
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["check"])
        self.assertEqual(code, 0)
        self.assertIn("HEALTH · EARLY", out)
        self.assertIn("BACKTEST vs REALITY · CHECK", out)
        self.assertIsNotNone(self.read_state("autopilot/shadow.json"))


class OnePositionPerCoin(TraderTestCase):
    def test_a_second_setup_on_the_same_coin_is_skipped(self):
        from shared import symbols
        sym = data.as_symbol("BTCUSDT", "crypto")
        book = {"handled": {}, "items": {"BTCUSDT-x-trend_ema": {"status": "pending", "data_key": "BTCUSDT",
                                                                 "setup": "trend_ema"}}}
        c = {"id": "BTCUSDT-x-trend_breakout", "sym": sym, "asset": "crypto", "setup": "trend_breakout"}
        d = ap().judge(c, config.load_config(), config.load_limits(), None, book, True, {}, None)
        self.assertEqual(d["action"], "skipped")
        self.assertIn("already holding or waiting on BTC", d["reasons"][0])


class SixDesks(TraderTestCase):
    def test_a_decision_as_six_desks(self):
        server = load("app", "server")
        gates = [{"name": "backtest expectancy", "ok": True, "detail": "+0.97R"},
                 {"name": "news & filings", "ok": True, "detail": "nothing alarming"},
                 {"name": "exit plan", "ok": True, "detail": "entry · stop · target"},
                 {"name": "idea still fresh", "ok": True, "detail": "1 h"},
                 {"name": "risk · max_position_pct", "ok": False, "detail": "40% of account (max 25%)"},
                 {"name": "AI desk", "ok": True, "detail": "GO"}]
        b = server.board_view({"id": "x", "symbol": "ETH/USD", "action": "skipped", "gates": gates,
                               "desk": {"status": "GO", "objections": 0},
                               "reasons": ["risk BLOCK: max_position_pct"]})
        states = {c["key"]: c["state"] for c in b["columns"]}
        self.assertEqual(states, {"research": "pass", "news": "pass", "strategy": "pass", "execution": "pass",
                                  "risk": "fail", "boss": "pass"})
        self.assertEqual(b["call"], "REJECT")
        taken = server.board_view({"action": "taken", "gates": gates[:4], "reasons": ["desk GO, risk PASS"]})
        self.assertEqual((taken["call"], {c["key"]: c["state"] for c in taken["columns"]}["risk"]), ("BUY", "none"))
        dry = server.board_view({"action": "skipped", "dry_run": True, "gates": gates[:4],
                                 "reasons": ["dry run — the autopilot is not enabled"]})
        self.assertEqual(dry["call"], "WOULD BUY")
        self.assertEqual({c["key"]: c["state"] for c in dry["columns"]}["execution"], "fail")

    def test_checks_endpoint(self):
        server = load("app", "server")
        state.append_jsonl("autopilot/decisions.jsonl", {"id": "a", "action": "skipped", "reasons": ["no gates"]})
        state.append_jsonl("autopilot/decisions.jsonl", {"id": "b", "action": "taken", "symbol": "BTC/USD",
                                                         "gates": [{"name": "exit plan", "ok": True, "detail": ""}],
                                                         "reasons": ["desk GO"]})
        self.write_state("autopilot/health.json", {"status": "normal", "text": "fine"})
        res = server.checks_view()
        self.assertEqual([b["id"] for b in res["board"]], ["b"])  # only decisions that went through the desks
        self.assertEqual((res["health"]["status"], res["shadow"]), ("normal", {}))


if __name__ == "__main__":
    unittest.main()
