"""Round five: a trade from another account, a close whose answer was lost, a cancel still pending a cycle later,
a meme coin in another spelling, a "yes" that belongs to another ticket — none of it may move money it shouldn't."""
from __future__ import annotations

import json
import os
import socket
import urllib.error
from unittest import mock

from shared import brokers, config, http, state, symbols
from shared.brokers import BrokerError
from shared.brokers.alpaca import AlpacaBroker
from shared.brokers.simulator import SimBroker
from tests import test_autopilot as _ta
from tests.helpers import TraderTestCase, load
from tests.test_autopilot import FakeBroker, Seller


def ap():
    return load("trader-autopilot", "autopilot")


class AnotherAccountsTrade(TraderTestCase):
    """A simulator trade left in the book when the bot moves to Alpaca: never sold out of the new account."""
    NOW = "2026-10-20T15:00:00Z"

    def book(self):
        return {"handled": {}, "items": {"p": {
            "plan_id": "p", "order_id": "ord-p", "symbol": "BTC/USD", "data_key": "BTCUSDT", "asset": "crypto",
            "qty": 0.05, "stop": 64000.0, "target": 90000.0, "time_stop": "2026-10-19T00:00:00Z", "status": "open",
            "placed_at": "2026-10-10T00:00:00Z", "filled_at": "2026-10-10T00:01:00Z", "broker": "simulator",
            "mode": "simulator", "stop_order_id": "sim-9"}}}

    def test_exits_and_kill_leave_it_alone_and_say_so(self):
        b, book = Seller(), self.book()
        yours = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 1.0, "last": 70000.0}]  # your own coin at Alpaca
        self.assertEqual(ap().manage_exits(b, book, yours, [], config.load_config()), [])
        acts = ap().kill(b, book, config.load_config(), "test", [], yours)
        self.assertEqual(b.calls, [])
        self.assertTrue(any("cannot reach" in a for a in acts), acts)
        self.assertEqual(ap().reconcile(b, book, yours, [], config.load_config(), config.load_limits()), [])
        self.assertEqual(book["items"]["p"]["status"], "open")

    def test_live_waits_until_they_are_closed_or_forgotten(self):
        config.ensure_home()
        state.write_json("autopilot/book.json", self.book())
        cfg = config.load_config()
        cfg["autopilot"].update(broker="alpaca", mode="live", live_confirmation=brokers.LIVE_PHRASE)
        cfg["paper"] = False
        os.environ["ALPACA_LIVE_KEY_ID"], os.environ["ALPACA_LIVE_SECRET_KEY"] = "AKTESTLIVE123456", "SKTESTLIVE123456"
        ok, missing = brokers.live_readiness(cfg)
        self.assertFalse(ok)
        self.assertTrue(any("still open" in m for m in missing), missing)
        res = ap().forget_foreign(cfg)
        self.assertEqual(len(res["forgotten"]), 1)
        self.assertEqual(state.read_json("autopilot/book.json")["items"]["p"]["status"], "left")
        self.assertTrue(brokers.live_readiness(cfg)[0])


class LostAnswers(TraderTestCase):
    def broker(self):
        b = AlpacaBroker.__new__(AlpacaBroker)
        b.mode, b.cfg = "paper", {}
        b.log = lambda *a, **k: None
        return b

    def test_a_close_whose_answer_was_lost_is_unsure_not_refused(self):
        with mock.patch.object(AlpacaBroker, "_send", side_effect=socket.timeout("timed out")):
            with self.assertRaises(BrokerError) as cm:
                self.broker().close_position("NVDA")
        self.assertIn(ap().UNSURE_ORDER, str(cm.exception))

    def test_a_refused_close_is_refused(self):
        err = urllib.error.HTTPError("u", 403, "no", {}, None)
        with mock.patch.object(AlpacaBroker, "_send", side_effect=err), \
                mock.patch.object(AlpacaBroker, "_message", staticmethod(lambda e: "insufficient qty")):
            with self.assertRaises(BrokerError) as cm:
                self.broker().close_position("NVDA")
        self.assertNotIn(ap().UNSURE_ORDER, str(cm.exception))


class CancelsAcrossCycles(_ta.OnlyWhatTheBotOwns):
    def setUp(self):
        super().setUp()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z",
                       stop_order_id="s1", swing=True)
        self.pos = [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 101.0}]

    def test_a_cancel_pending_since_last_cycle_is_still_waited_for(self):
        class Pending(Seller):
            def lookup(self, order_id):
                return [{"id": order_id, "status": "pending_cancel"}]
        b = Pending()
        pending = [{"id": "s1", "symbol": "NVDA", "side": "sell", "type": "stop", "status": "pending_cancel"}]
        with mock.patch.object(ap(), "CANCEL_WAIT_SEC", 0):
            acts = ap().manage_exits(b, self.book, self.pos, pending, self.cfg)
        self.assertFalse([c for c in b.calls if c[0] in ("exit", "close", "cancel")], b.calls)
        self.assertIn("not confirmed", acts[0])

    def test_a_stop_that_partly_filled_and_was_cancelled_counts_as_sold(self):
        class Part(Seller):
            def lookup(self, order_id):
                return [{"id": order_id, "status": "canceled", "filled_qty": "4"}]
        b = Part()
        stop = [{"id": "s1", "symbol": "NVDA", "side": "sell", "type": "stop", "status": "new"}]
        acts = ap().manage_exits(b, self.book, self.pos, stop, self.cfg)
        self.assertFalse([c for c in b.calls if c[0] in ("exit", "close")])
        self.assertIn("filled meanwhile", acts[0])

    def test_a_price_through_the_stop_sells_even_while_backing_off(self):
        b = Seller()
        self.it.update(time_stop="2027-01-01T00:00:00Z", exit_refused_at="2026-10-20T14:58:00Z",
                       stop_order_id="gone")
        low = [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 90.0}]  # under the 95 stop
        ap().manage_exits(b, self.book, low, [], self.cfg)
        self.assertTrue([c for c in b.calls if c[0] in ("exit", "close")], b.calls)


for _name in dir(_ta.OnlyWhatTheBotOwns):  # its own tests run in test_autopilot
    if _name.startswith("test") and _name not in CancelsAcrossCycles.__dict__:
        setattr(CancelsAcrossCycles, _name, None)


class Spellings(TraderTestCase):
    def test_meme_coins_in_lots_and_new_names(self):
        for base in ("1000PEPE", "KPEPE", "1MBABYDOGE", "1000CAT", "PUMP", "DOGE"):
            self.assertTrue(symbols.is_meme_base(base), base)
        for base in ("BTC", "ETH", "SOL", "LINK"):
            self.assertFalse(symbols.is_meme_base(base), base)

    def test_a_blocked_coin_is_blocked_in_any_spelling(self):
        for listed in ("SOL/USD", "SOL-USD", "solusd", "SOLUSDT", "SOL"):
            self.assertTrue(symbols.blocked_hits(["SOLUSDT", "SOL/USDT"], [listed]), listed)
        self.assertEqual(symbols.blocked_hits(["ETHUSDT"], ["SOL/USD"]), [])


class OneYesOneTicket(TraderTestCase):
    def test_a_yes_never_lands_on_another_ticket(self):
        ticket = load("trader-broker", "ticket")
        config.ensure_home()
        state.write_json("tickets.json", {"tickets": [
            {"id": "tkt-a", "status": "awaiting_approval"}, {"id": "tkt-b", "status": "awaiting_approval"}]})
        with self.assertRaises(ValueError) as cm:
            ticket._pick_ticket(None)
        self.assertIn("--ticket", str(cm.exception))
        self.assertEqual(ticket._pick_ticket("tkt-a")["id"], "tkt-a")


class Summary(TraderTestCase):
    NOW = "2026-10-21T20:30:00Z"  # 4:30 p.m. ET, after the summary time

    def test_a_trade_after_the_last_summary_is_in_the_next(self):
        config.ensure_home()
        cfg = config.load_config()
        cfg["notify"] = {"enabled": True, "ntfy_topic": "trader-test-topic-1234567890",
                         "events": ["daily_summary"]}
        state.write_json("journal.json", {"trades": [{"source": "autopilot", "status": "closed", "pnl_usd": 123.0,
                                                       "display": "ETH/USD", "exit": {"time": "2026-10-21T00:02:00Z"}}]})
        st = {"summary_sent": "2026-10-20", "summary_sent_at": "2026-10-20T20:20:00Z", "equity": {"equity": 1000}}
        ap().daily_summary(cfg, st, {}, ap().market_clock.now_utc())
        sent = [n for n in state.read_jsonl("notifications.jsonl") if n["event"] == "daily_summary"]
        self.assertEqual(len(sent), 1)
        self.assertIn("1 trade(s) closed", sent[0]["text"])


class SmallerThings(TraderTestCase):
    def test_a_rotation_whose_replace_fails_archives_nothing(self):
        p = config.ensure_home() / "notifications.jsonl"
        p.write_text("".join(json.dumps({"i": i, "pad": "x" * 200}) + "\n" for i in range(2000)))
        dest = state.path("archive", "n.jsonl.gz")
        with mock.patch("os.replace", side_effect=PermissionError("in use")):
            with self.assertRaises(PermissionError):
                state.rotate_jsonl("notifications.jsonl", 1000, 100, dest)
        self.assertFalse(dest.exists())
        self.assertEqual(len(state.read_jsonl("notifications.jsonl")), 2000)

    def test_the_simulator_forgets_an_order_it_could_not_save(self):
        config.ensure_home()
        b = SimBroker(config.load_config())
        b._candles[("BTC/USD", "crypto")] = []
        with mock.patch.object(state, "write_json", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(BrokerError):
                b.place_stop("BTC/USD", 1.0, 60000.0)
        self.assertEqual(b.book["orders"], [])

    def test_an_infinite_limit_is_no_limit_in_disguise(self):
        config.ensure_home()
        (config.trader_home() / "limits.json").write_text('{"global": {"max_daily_loss_usd": 1e999}}')
        with self.assertRaises(config.ConfigError):
            config.load_limits()

    def test_a_credential_is_never_sent_on_to_another_server(self):
        req = urllib.error.HTTPError
        with self.assertRaises(req):
            http._NoRedirect().redirect_request(mock.Mock(full_url="https://api.x.com/a"), None, 302, "Found", {},
                                                "https://evil.example/")

    def test_the_manual_crypto_order_gets_no_leverage_at_alpaca(self):
        cfg = config.load_config()
        cfg["leverage"] = {"crypto": 2.0}
        limits = config.load_limits()
        limits["crypto"].update(allow_leverage=True, max_leverage=2)
        self.assertEqual(config.leverage(cfg, limits, "crypto", cfg.get("connector") or "alpaca")[0], 1.0)

    def test_fake_broker_stays_an_alpaca_paper_account(self):  # the other tests rely on it
        self.assertEqual((FakeBroker.name, FakeBroker.mode), ("alpaca", "paper"))
