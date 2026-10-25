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
