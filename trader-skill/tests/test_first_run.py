"""A new install: the bot starts on the simulator before the profile sets the capital — the account follows it."""
from __future__ import annotations

from shared import config, state
from shared.brokers.simulator import SimBroker
from tests.helpers import TraderTestCase


class SimCapital(TraderTestCase):
    def test_an_untouched_book_follows_the_capital_set_later(self):
        state.write_json("broker/sim.json", {"cash": 25000.0, "starting_cash": 25000.0, "currency": "USD", "seq": 0,
                                             "orders": [], "positions": {}, "fills": [],
                                             "created_at": "2026-10-25T12:00:00Z", "last_sync": None})
        config.update_file("config.json", {"account_size": 1000, "autopilot": {"sim_starting_cash": 1000}})
        acct = SimBroker(config.load_config()).account()
        self.assertEqual((acct["equity"], acct["cash"], acct["starting_cash"]), (1000.0, 1000.0, 1000.0))
        self.assertNotEqual(acct["account_id"], "sim-2026-10-25T12:00:00Z")  # a new account: the chart starts again

    def test_a_book_with_trades_is_never_reset(self):
        state.write_json("broker/sim.json", {"cash": 24000.0, "starting_cash": 25000.0, "currency": "USD", "seq": 3,
                                             "orders": [{"id": "o1"}], "positions": {}, "fills": [{"id": "f1"}],
                                             "created_at": "2026-10-25T12:00:00Z", "last_sync": None})
        config.update_file("config.json", {"account_size": 1000, "autopilot": {"sim_starting_cash": 1000}})
        b = SimBroker(config.load_config())
        self.assertEqual((b.book["cash"], b.book["starting_cash"]), (24000.0, 25000.0))


class OldAccountOnTheDashboard(TraderTestCase):
    """The simulator started again at $1,000: the $25,000 account before it is no red −$24,000 on the dashboard."""
    NOW = "2026-10-25T15:00:00Z"

    def test_chart_daily_and_totals_show_only_the_new_account(self):
        from tests.helpers import load
        config.update_file("config.json", {"account_size": 1000, "autopilot": {"sim_starting_cash": 1000}})
        for at, eq, acct in (("2026-10-24T20:00:00Z", 25000.0, "sim-A"), ("2026-10-25T09:00:00Z", 25000.0, "sim-A"),
                             ("2026-10-25T10:00:00Z", 1000.0, "sim-B"), ("2026-10-25T14:00:00Z", 1012.5, "sim-B")):
            state.append_jsonl("broker/equity.jsonl", {"at": at, "equity": eq, "mode": "simulator",
                                                       "account": "simulator/simulator/" + acct})
        srv = load("app", "server")
        eq = srv.equity_view()
        self.assertEqual([p["v"] for p in eq["points"]], [1000.0, 1012.5])
        self.assertEqual((eq["daily"], eq["start"]), ([{"date": "2026-10-25", "pnl": 12.5}], 1000.0))
        cfg = config.load_config()
        acct = srv.account_view(cfg, srv.trade_stats([]), [])
        self.assertEqual((acct["pnl_today"], acct["pnl_total"]), (12.5, 12.5))

    def test_a_broker_account_starts_at_its_first_equity(self):
        from tests.helpers import load
        for at, eq, acct in (("2026-10-24T20:00:00Z", 1000.0, "simulator/simulator/sim-B"),
                             ("2026-10-25T10:00:00Z", 5000.0, "bybit/paper/demo"),
                             ("2026-10-25T14:00:00Z", 4950.0, "bybit/paper/demo")):
            state.append_jsonl("broker/equity.jsonl", {"at": at, "equity": eq, "account": acct})
        eq = load("app", "server").equity_view()
        self.assertEqual((eq["daily"], eq["start"]), ([{"date": "2026-10-25", "pnl": -50.0}], 5000.0))
