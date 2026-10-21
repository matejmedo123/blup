"""Adapt: the autopilot learns from its own closed trades — and only ever gets more careful."""
from __future__ import annotations

import json

from tests.helpers import TraderTestCase
from shared import adapt, config

NOW = "2026-10-20T20:00:00Z"


def trade(i, r, setup="orb15", asset="stock", key="NVDA", day=None, source="autopilot", r_net=True):
    t = {"id": "trd-%d" % i, "symbol": key, "symbol_key": key, "display": key, "asset": asset, "setup": setup,
         "status": "closed", "source": source, "pnl_usd": r * 100,
         "exit": {"time": day or "2026-10-%02dT15:%02d:00Z" % (1 + i // 50, i % 50), "price": 1, "reason": "stop"},
         "r_multiple": r + 0.05}
    if r_net:
        t["r_net"] = r
    return t


class Adapt(TraderTestCase):
    NOW = NOW

    def journal(self, trades):
        self.write_state("journal.json", {"trades": trades})

    def equity(self, points):
        p = self.home / "broker" / "equity.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as fh:
            for at, eq in points:
                fh.write(json.dumps({"at": at, "equity": eq, "cash": eq, "mode": "simulator"}) + "\n")

    def ev(self):
        return adapt.evaluate(config.load_config())

    def test_empty_record_is_neutral(self):
        doc = self.ev()
        self.assertEqual((doc["risk_mult"], doc["drawdown_pause"], doc["setups"], doc["new_events"]),
                         (1.0, False, {}, []))
        self.assertEqual(adapt.check(doc, "stock", "orb15", "NVDA"), (True, None))
        self.assertTrue((self.home / "autopilot" / "adapt.json").exists())
        self.assertNotIn("new_events", self.read_state("autopilot/adapt.json"))

    def test_losing_setup_is_paused_then_gets_a_clean_slate(self):
        rs = [-1, 0.5, -1, -1, 0.8, -1, -1, 0.3]   # expectancy -0.425R over 8 trades
        keys = ["NVDA", "AMD", "TSLA", "META", "AAPL", "PLTR", "COIN", "MU"]
        trades = [trade(i, r, key=k) for i, (r, k) in enumerate(zip(rs, keys))]
        trades.append(trade(20, -1, setup="orb15", asset="stock", key="X", source="ticket"))  # manual trades don't count
        trades.append(trade(21, -1, setup="momentum", asset="crypto", key="BTCUSDT"))
        self.journal(trades)
        doc = self.ev()
        s = doc["setups"]["stock:orb15"]
        self.assertEqual((s["trades"], s["wins"], s["status"]), (8, 3, "paused"))
        self.assertAlmostEqual(s["expectancy_r"], -0.425)
        self.assertEqual(s["until"], "2026-10-27T20:00:00Z")
        self.assertEqual(doc["setups"]["crypto:momentum"]["status"], "active")
        self.assertEqual([e["kind"] for e in doc["new_events"]], ["setup_paused"])
        ok, why = adapt.check(doc, "stock", "orb15", "NVDA")
        self.assertFalse(ok)
        self.assertIn("orb15 paused on stock until 2026-10-27", why)
        self.assertEqual(adapt.check(doc, "crypto", "orb15", "BTCUSDT"), (True, None))
        self.assertEqual(self.ev()["new_events"], [])  # nothing new on the next cycle
        self.set_now("2026-10-28T14:00:00Z")
        doc = self.ev()
        s = doc["setups"]["stock:orb15"]
        self.assertEqual((s["status"], s["trades"], s["since"]), ("active", 0, "2026-10-27T20:00:00Z"))
        self.assertEqual([e["kind"] for e in doc["new_events"]], ["setup_resumed"])
        self.assertTrue(adapt.check(doc, "stock", "orb15", "NVDA")[0])

    def test_r_net_preferred_and_min_trades(self):
        self.journal([trade(i, -1, key="K%d" % i, r_net=False) for i in range(7)])
        doc = self.ev()
        self.assertEqual(doc["setups"]["stock:orb15"]["status"], "active")  # 7 < min_trades
        self.assertAlmostEqual(doc["setups"]["stock:orb15"]["expectancy_r"], -0.95)  # r_multiple when r_net missing

    def test_symbol_cooldown_and_risk_cut_until_a_win(self):
        self.journal([trade(1, 0.9, key="AMD"), trade(2, -1, key="TSLA"), trade(3, 0.0, key="NVDA"),
                      trade(4, -1, key="TSLA"), trade(5, -1, key="TSLA")])
        doc = self.ev()
        self.assertEqual(doc["symbols"]["TSLA"]["status"], "cooldown")
        self.assertEqual(doc["symbols"]["TSLA"]["until"], "2026-10-25T20:00:00Z")
        self.assertEqual(doc["symbols"]["NVDA"]["status"], "active")
        self.assertEqual(doc["loss_streak"], 3)  # the 0R scratch neither extends nor breaks it
        self.assertEqual(doc["risk_mult"], 0.5)
        self.assertEqual(adapt.risk_mult(doc), 0.5)
        self.assertEqual(sorted(e["kind"] for e in doc["new_events"]), ["risk_reduced", "symbol_cooldown"])
        ok, why = adapt.check(doc, "stock", "orb30", "TSLA")
        self.assertFalse(ok)
        self.assertIn("TSLA sits out until 2026-10-25", why)
        trades = self.read_state("journal.json")["trades"] + [trade(6, 1.2, key="AMD", day="2026-10-20T19:00:00Z")]
        self.journal(trades)
        doc = self.ev()
        self.assertEqual((doc["loss_streak"], doc["risk_mult"]), (0, 1.0))
        self.assertEqual([e["kind"] for e in doc["new_events"]], ["risk_restored"])
        self.assertEqual(doc["symbols"]["TSLA"]["status"], "cooldown")  # a win elsewhere doesn't end it early

    def test_future_trades_invisible_to_a_pinned_clock(self):
        self.journal([trade(i, -1, key="TSLA", day="2026-10-21T15:%02d:00Z" % i) for i in range(3)])
        doc = self.ev()
        self.assertEqual((doc["loss_streak"], doc["symbols"]), (0, {}))

    def test_drawdown_pause_and_resume_resets_the_peak(self):
        self.equity([("2026-10-20T14:00:00Z", 25000), ("2026-10-20T15:00:00Z", 26000),
                     ("2026-10-20T16:00:00Z", 24000)])
        doc = self.ev()
        self.assertAlmostEqual(doc["drawdown_pct"], 7.69, places=2)
        self.assertFalse(doc["drawdown_pause"])
        self.equity([("2026-10-20T17:00:00Z", 23300), ("2026-10-20T23:00:00Z", 30000)])  # the last is in the future
        doc = self.ev()
        self.assertEqual((doc["equity_peak"], doc["equity"]), (26000.0, 23300.0))
        self.assertTrue(doc["drawdown_pause"])
        self.assertEqual([e["kind"] for e in doc["new_events"]], ["drawdown_pause"])
        ok, why = adapt.check(doc, "crypto", "momentum", "BTCUSDT")
        self.assertFalse(ok)
        self.assertIn("drawdown", why)
        self.assertEqual(self.ev()["new_events"], [])  # still paused, no repeat
        self.write_state("autopilot/control.json", {"paused": False, "dd_reset_at": "2026-10-20T17:00:00Z"})
        doc = self.ev()
        self.assertEqual((doc["equity_peak"], doc["drawdown_pause"], doc["new_events"]), (23300.0, False, []))
        self.set_now("2026-10-21T00:00:00Z")
        doc = self.ev()
        self.assertEqual((doc["equity_peak"], doc["equity"], doc["drawdown_pct"]), (30000.0, 30000.0, 0.0))

    def test_disabled_never_blocks(self):
        self.journal([trade(i, -1, key="TSLA") for i in range(10)])
        self.write_state("config.json", {"autopilot": {"adapt": {"enabled": False}}})
        doc = self.ev()
        self.assertFalse(doc["enabled"])
        self.assertEqual(adapt.check(doc, "stock", "orb15", "TSLA"), (True, None))
        self.assertEqual(adapt.risk_mult(doc), 1.0)
        self.assertEqual(adapt.check(None, "stock", "orb15", "TSLA"), (True, None))

    def test_events_capped(self):
        self.write_state("autopilot/adapt.json", {"events": [{"at": NOW, "kind": "x", "text": str(i)} for i in range(150)],
                                                  "setups": {}, "symbols": {}, "risk_mult": 1.0})
        self.assertEqual(len(self.ev()["events"]), adapt.MAX_EVENTS)
