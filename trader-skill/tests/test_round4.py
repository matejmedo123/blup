"""Round four: what a real broker does between two requests (a cancel still pending, a sale refused, an order
that landed but can't be read yet), a KILL that must end, and the backtest and the bot trading the same thing."""
from __future__ import annotations

import json
import os
import urllib.error
from unittest import mock

from shared import config, data, http, market_clock as mc, state
from shared.brokers import BrokerError
from shared.brokers.alpaca import AlpacaBroker
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load
from tests import test_autopilot as _ta, test_runner as _tr  # their classes, not collected a second time here
from tests.test_autopilot import Seller
from tests.test_runner import fake_closes


def ap():
    return load("trader-autopilot", "autopilot")


class SlowCancel(Seller):
    """Alpaca: a cancelled stop sits in pending_cancel (still holding the shares) for a while."""
    status_after_cancel = "pending_cancel"

    def lookup(self, order_id):
        return [{"id": order_id, "status": self.status_after_cancel}]


class Refuses(Seller):
    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="stock"):
        self.calls.append(("exit", symbol, qty))
        raise BrokerError("Alpaca rejected the order (HTTP 403): potential wash trade detected")


class ExitsAtARealBroker(_ta.OnlyWhatTheBotOwns):
    def setUp(self):
        super().setUp()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z",
                       stop_order_id="s1", swing=True)
        self.stop = [{"id": "s1", "symbol": "NVDA", "side": "sell", "type": "stop", "status": "new"}]
        self.pos = [{"symbol": "NVDA", "asset": "stock", "qty": 25.0, "last": 101.0}]

    def test_the_sale_waits_until_the_cancel_is_confirmed(self):
        b = SlowCancel()
        with mock.patch.object(ap(), "CANCEL_WAIT_SEC", 0):
            acts = ap().manage_exits(b, self.book, self.pos, self.stop, self.cfg)
        self.assertIn(("cancel", "s1"), b.calls)
        self.assertFalse([c for c in b.calls if c[0] in ("exit", "close")])
        self.assertIn("not confirmed", acts[0])
        self.assertEqual(self.it["stop_order_id"], "s1")

    def test_a_stop_that_filled_meanwhile_is_not_sold_again_out_of_your_shares(self):
        b = SlowCancel()
        b.status_after_cancel = "filled"
        acts = ap().manage_exits(b, self.book, self.pos, self.stop, self.cfg)
        self.assertFalse([c for c in b.calls if c[0] in ("exit", "close")])
        self.assertIn("filled meanwhile", acts[0])

    def test_a_refused_sale_puts_the_stop_back_and_waits(self):
        b = Refuses()
        self.cfg["notify"] = {"enabled": True, "ntfy_topic": "trader-test-topic-1234567890"}
        acts = ap().manage_exits(b, self.book, self.pos, self.stop, self.cfg)
        self.assertIn(("stop", "NVDA", 10.0, 95.0), b.calls)  # its own 10, not your 15
        self.assertTrue(any("refused the sale of NVDA" in a for a in acts), acts)
        self.assertTrue(self.it["exit_refused_at"])
        self.assertTrue(any(n["event"] == "error" and "refused" in n["title"]
                            for n in state.read_jsonl("notifications.jsonl")))
        b.calls.clear()  # 5 minutes later, with its stop back in place: no new attempt yet
        self.set_now("2026-10-20T15:05:00Z")
        stop_back = [{"id": self.it["stop_order_id"], "client_order_id": "ord-p1-s1", "symbol": "NVDA",
                      "side": "sell", "type": "stop", "status": "new"}]
        self.assertEqual(ap().manage_exits(b, self.book, self.pos, stop_back, self.cfg), [])
        self.assertEqual(b.calls, [])
        self.set_now("2026-10-20T15:20:00Z")  # 20 minutes later it tries again
        ap().manage_exits(b, self.book, self.pos, stop_back, self.cfg)
        self.assertIn(("exit", "NVDA", 10.0), b.calls)

    def test_an_old_stop_id_the_broker_does_not_know_is_no_stop(self):
        self.it.update(stop_retry_at="2026-10-19T15:00:00Z", time_stop="2027-01-01T00:00:00Z")
        self.assertIsNone(ap()._live_stop(self.it, []))
        self.it["stop_retry_at"] = "2026-10-20T14:58:00Z"  # placed two minutes ago: not in the list yet
        self.assertIsNotNone(ap()._live_stop(self.it, []))


class KillThatEnds(_ta.OnlyWhatTheBotOwns):
    def test_the_first_cancel_time_is_kept(self):
        b = Seller()
        ap().kill(b, self.book, self.cfg, "test", [], [])
        first = self.it["cancel_asked_at"]
        self.set_now("2026-10-20T15:30:00Z")
        ap().kill(b, self.book, self.cfg, "test", [], [])
        self.assertEqual(self.it["cancel_asked_at"], first)

    def test_a_queued_sale_is_left_alone(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", exit_order_id="x9")
        queued = [{"id": "x9", "client_order_id": "ord-p1-x1", "symbol": "NVDA", "side": "sell", "status": "new"}]
        b = Seller()
        out = ap()._kill_one(b, self.it, "test", queued, {"NVDA": {"symbol": "NVDA", "qty": 10.0}}, True)
        self.assertEqual(b.calls, [])
        self.assertIn("queued", out[0])


class AlpacaDuplicate(TraderTestCase):
    def test_an_order_that_landed_but_cannot_be_read_is_never_refused(self):
        b = AlpacaBroker.__new__(AlpacaBroker)
        b.mode, b.cfg = "paper", {}
        b.log = lambda *a, **k: None
        err = urllib.error.HTTPError("u", 422, "dup", {}, None)
        with mock.patch.object(AlpacaBroker, "_send", side_effect=err), \
                mock.patch.object(AlpacaBroker, "_message", staticmethod(lambda e: "client_order_id must be unique")), \
                mock.patch.object(AlpacaBroker, "_lookup", side_effect=BrokerError("lookup failed (HTTP 503)")):
            with self.assertRaises(BrokerError) as cm:
                b._post_order({"client_order_id": "ord-x", "symbol": "BTC/USD"})
        self.assertIn(ap().UNSURE_ORDER, str(cm.exception))


class RideAfterATimeStop(_tr.RideInTheSimulator):
    def test_the_time_stop_lets_two_thirds_ride_like_the_lab(self):
        it = self.book["items"]["p"]
        it["time_stop"] = "2026-10-19T00:00:00Z"
        fake_closes(self, self.RISING + [132.0])  # still rising: no exit rule, in profit, above the average
        acts = self.cycle()
        self.assertEqual(it["runner"]["status"], "riding", acts)
        sold = load("trader-journal", "journal").get_trade("trd-p")
        self.assertEqual(sold["exit"]["reason"], "time")
        self.assertGreater(mc.ts(it["time_stop"]), mc.ts("2026-10-20T00:02:00Z"))  # the ride gets its own horizon


class DailyEntries(TraderTestCase):
    def test_a_daily_entry_may_pay_up_and_its_risk_is_sized_at_that_price(self):
        sizer = load("trader-sizer", "size")
        plan = {"id": "p", "symbol": "ETHUSDT", "asset": "crypto", "entry": {"price": 100.0}, "stop": {"price": 90.0},
                "target": {"price": 150.0}}
        cfg, limits = config.load_config(), config.load_limits()
        tight = sizer.size_order(plan, cfg, limits, account=10000)
        loose = sizer.size_order(dict(plan, entry_slack_pct=1.0), cfg, limits, account=10000)
        self.assertLess(tight["limit_price"], 100.1)
        self.assertAlmostEqual(loose["limit_price"], 101.0, places=4)
        self.assertLessEqual(loose["risk_usd"], tight["risk_usd"] + 0.01)  # never more than the budget
        self.assertAlmostEqual(loose["qty"] * (101.0 - 90.0), loose["risk_usd"], places=0)


class FormingBar(TraderTestCase):
    def test_a_bar_still_forming_when_downloaded_is_not_closed(self):
        t = 1792508400  # 15:00:00Z — a 5-min bar closes on the hour
        os.environ.pop("TRADER_NOW", None)
        with mock.patch.object(data, "pinned_clock", return_value=False):
            http.track()
            http._seen(t - 10)  # downloaded 10 s before 14:55 closed, read at 15:00:15
            self.assertEqual(data._asof(t + 15), t - 10)
            bars = [Candle(t - 600, 1, 1, 1, 1, 1), Candle(t - 300, 1, 1, 1, 1, 1)]
            self.assertEqual([c.t for c in data._clean(bars, 300, data._asof(t + 15))], [t - 600])


class TimeAndCalendar(TraderTestCase):
    def test_replay_refuses_a_folder_that_lived_past_from(self):
        config.ensure_home()
        state.write_json("autopilot/state.json", {"last_cycle": "2026-10-21T12:00:00Z"})
        args = type("A", (), {"start": "2026-10-20T13:30:00Z", "end": "2026-10-20T14:00:00Z", "step": "5m",
                              "approve": True})()
        with self.assertRaises(ValueError) as cm:
            ap().replay(args, config.load_config())
        self.assertIn("--home", str(cm.exception))

    def test_the_global_daily_loss_counts_the_utc_day(self):
        risk = load("trader-risk", "risk")
        state.write_json("journal.json", {"trades": [{"status": "closed", "asset": "stock", "pnl_usd": -780.0,
                                                       "exit": {"time": "2026-10-20T19:55:00Z"}}]})
        self.assertEqual(risk.realized_loss_today("2026-10-21T00:00:30Z"), 0.0)  # a new UTC day for crypto
        self.assertEqual(risk.realized_loss_today("2026-10-21T00:00:30Z", "stock"), 780.0)  # NY day for stocks

    def test_a_playbook_made_after_now_is_refused(self):
        lab = load("trader-backtest", "lab")
        state.write_json(lab.PLAYBOOK, {"generated_at": "2026-10-21T00:00:00Z", "entries": {}})
        pb, why = lab.load_playbook("2026-03-02T00:00:00Z")
        self.assertIsNone(pb)
        self.assertIn("hindsight", why)

    def test_stooq_daily_bars_carry_the_session_date(self):
        from shared.sources import stooq
        bars = stooq.parse_csv("Date,Open,High,Low,Close,Volume\n2026-10-19,1,2,0.5,1.5,100\n", "1d")
        self.assertEqual(mc.iso(bars[0].t), "2026-10-19T13:30:00Z")


class HonestCertainty(TraderTestCase):
    def test_losses_that_come_together_lower_the_profit_chance(self):
        lab = load("trader-backtest", "lab")
        rs = ([2.0] * 30 + [-1.0] * 40) * 4  # the same trades, the losses in streaks as in a crypto bear market
        iid = lab.bootstrap_profit_chance(rs, block=1)
        blocks = lab.bootstrap_profit_chance(rs)
        self.assertLess(blocks, iid)


class Orphans(TraderTestCase):
    def test_an_open_bot_order_outside_the_book_is_reported_once(self):
        config.ensure_home()
        cfg = config.load_config()
        cfg["notify"] = {"enabled": True, "ntfy_topic": "trader-test-topic-1234567890"}
        book = {"items": {"a": {"order_id": "ord-a", "status": "open"}}, "handled": {}}
        orders = [{"id": "1", "client_order_id": "ord-a-s5", "symbol": "ETH/USD", "side": "sell", "status": "new"},
                  {"id": "2", "client_order_id": "ord-lost", "symbol": "BTC/USD", "side": "buy", "status": "new"},
                  {"id": "3", "client_order_id": "mine", "symbol": "BTC/USD", "side": "buy", "status": "new"}]
        ap()._orphans(book, orders, cfg)
        ap()._orphans(book, orders, cfg)
        told = [n for n in state.read_jsonl("notifications.jsonl") if "does not manage" in n["title"]]
        self.assertEqual(len(told), 1)
        self.assertIn("ord-lost", told[0]["text"])
        self.assertNotIn("ord-a-s5", told[0]["text"])


class RepairUnderLock(TraderTestCase):
    def test_a_broken_book_is_restored_and_kept_to_look_at(self):
        state.write_json("autopilot/book.json", {"items": {"a": 1}})
        p = config.ensure_home() / "autopilot" / "book.json"
        p.write_text("{broken")
        self.assertEqual(state.read_json("autopilot/book.json"), {"items": {"a": 1}})
        self.assertEqual(json.loads(p.read_text()), {"items": {"a": 1}})
        self.assertEqual((p.parent / "book.json.broken").read_text(), "{broken")


# these reuse their parents' set-up, not their tests (those run in their own modules)
for _cls, _base in ((ExitsAtARealBroker, _ta.OnlyWhatTheBotOwns), (KillThatEnds, _ta.OnlyWhatTheBotOwns),
                    (RideAfterATimeStop, _tr.RideInTheSimulator)):
    for _name in dir(_base):
        if _name.startswith("test") and _name not in _cls.__dict__:
            setattr(_cls, _name, None)
