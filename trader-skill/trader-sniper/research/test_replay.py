"""Tests for replay.py's execution of the sniper rules (python3 -m unittest test_replay)."""
import unittest

import replay as R


class FlatSol:
    def at(self, ts):
        return 100.0


def coin(bars, start=1_000_200, base_amt=1e8, quote_amt=1000.0):
    """A graduated coin with a big pool (1000 SOL vs 1e8 tokens) unless told otherwise."""
    res = {"kind": "grad", "mint": "M%d" % start, "day": "2026-09-01", "ts": start, "block_ts": start,
           "base_amt": base_amt, "quote_amt": quote_amt, "quote_mint": R.WSOL}
    rec = {"src": "test", "bars": [[start + 300 * i] + list(b) for i, b in enumerate(bars)]}
    return R.Coin(res, rec, FlatSol(), 180000.0, None)


class Execution(unittest.TestCase):
    def setUp(self):
        self.s = R.sniper.settings({})

    def test_baseline_stop_fills_at_low_and_counts_costs(self):
        # 1e-3 USD/token; at minute 10 we buy, then a bar dips 50 %
        bars = [(1e-3, 1e-3, 1e-3, 1e-3, 100.0)] * 3 + [(1e-3, 1e-3, 5e-4, 6e-4, 100.0)] + \
            [(6e-4, 6e-4, 6e-4, 6e-4, 10.0)] * 5
        r = R.Replay([coin(bars)], self.s, mode="baseline").run()
        self.assertEqual(len(r.trades), 1)
        t = r.trades[0]
        self.assertEqual(t["exit"], "stop")
        self.assertAlmostEqual(t["ret"], -0.5, delta=0.02)      # filled at the low, not at -25 %

    def test_take_profit_half_then_trail(self):
        bars = [(1e-3, 1e-3, 1e-3, 1e-3, 100.0)] * 3 + [(1e-3, 1.6e-3, 1e-3, 1.6e-3, 100.0),
                                                        (1.6e-3, 2e-3, 1.6e-3, 2e-3, 100.0),
                                                        (2e-3, 2e-3, 1.4e-3, 1.4e-3, 100.0)] + \
            [(1.4e-3, 1.4e-3, 1.4e-3, 1.4e-3, 1.0)] * 3
        r = R.Replay([coin(bars)], self.s, mode="baseline").run()
        t = r.trades[0]
        self.assertEqual(t["exit"], "tp+trail")
        # half at +50 % (effective), half at the bar low 1.4e-3 (+40 % minus costs)
        self.assertAlmostEqual(t["ret"], 0.5 * 0.5 + 0.5 * 0.4, delta=0.03)

    def test_time_stop_after_6h(self):
        bars = [(1e-3, 1e-3, 1e-3, 1e-3, 100.0)] * 120
        r = R.Replay([coin(bars)], self.s, mode="baseline").run()
        t = r.trades[0]
        self.assertEqual(t["exit"], "time")
        self.assertAlmostEqual((t["exit_t"] - t["entry_t"]) / 3600.0, 6.0, delta=0.1)
        self.assertLess(t["ret"], 0)            # fees + gas on a flat price

    def test_budget_caps_open_positions(self):
        bars = [(1e-3, 1e-3, 1e-3, 1e-3, 100.0)] * 100
        coins = [coin(bars, start=1_000_200 + 60 * i) for i in range(15)]
        r = R.Replay(coins, self.s, mode="baseline").run()
        self.assertEqual(len(r.trades), 10)     # max 10 positions / EUR 100 open
        r2 = R.Replay(coins, self.s, mode="baseline", budget=False).run()
        self.assertEqual(len(r2.trades), 15)

    def test_pair_snapshot_uses_closed_bars_only(self):
        bars = [(1e-3, 1e-3, 1e-3, 1e-3, 100.0), (1e-3, 2e-3, 1e-3, 2e-3, 500.0)]
        c = coin(bars)
        p = R.pair_at(c, c.start + 300)          # only the first bar has closed
        self.assertEqual(p["price_usd"], 1e-3)
        p = R.pair_at(c, c.start + 600)
        self.assertEqual(p["price_usd"], 2e-3)
        self.assertEqual(p["volume"]["m5"], 500.0)

    def test_liquidity_from_starting_reserves(self):
        c = coin([(1e-3, 1e-3, 1e-3, 1e-3, 1.0)], base_amt=1e8, quote_amt=1000.0)
        # starting price 1000 SOL / 1e8 tokens = 1e-5 SOL = 1e-3 USD at SOL 100: quote side $100k
        self.assertAlmostEqual(c.liquidity(c.start, 1e-3), 200_000, delta=1)


if __name__ == "__main__":
    unittest.main()
