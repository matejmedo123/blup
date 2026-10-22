"""Tests for moonbag.py: the ladder (half at every doubling, the last part kept), the watch, the stop, the fills,
and a budget that knows only what had happened at the moment of each buy (python3 -m unittest test_moonbag)."""
import unittest

import moonbag as M
import replay as R

T0 = 1_788_000_000 // 300 * 300


class FlatSol:
    def at(self, ts):
        return 100.0


def coin(closes, curve_minutes=30.0, start=T0, deep=True):
    """5-minute bars from closes (open = previous close, high/low = max/min of the two)."""
    # depth at price p: sqrt(base × quote × p × SOL) USD on the quote side — ~$300M deep, or $100 thin
    res = {"mint": "M%d" % start, "day": "2026-09-01", "block_ts": start, "ts": start,
           "base_amt": 1e15 if deep else 100.0, "quote_amt": 1e9 if deep else 1.0, "quote_mint": R.WSOL}
    bars, prev = [], closes[0]
    for i, c in enumerate(closes):
        bars.append([start + 300 * i, prev, max(prev, c), min(prev, c), c, 1.0])
        prev = c
    return M.Coin(res, bars, [], FlatSol(), curve_minutes)


def variant(**kw):
    v = {"wait_min": 5, "watch": "none", "bundle": False, "first_tp": 2.0, "stop": None, "fill": "next"}
    v.update(kw)
    return v


class Ladder(unittest.TestCase):
    def test_half_at_every_doubling_and_the_last_part_is_kept(self):
        # bought at ~1.0 (the second bar's open), then 2×, 4×, 8×, and it ends at 8×
        tr = M.simulate(coin([1.0, 1.0, 2.1, 2.1, 4.2, 4.2, 8.4, 8.4, 8.4]), variant())
        self.assertEqual(tr["sales"], 3)                          # at 2×, 4× and 8×: half each time
        self.assertTrue(tr["first_tp"])
        got = [f for _, f in tr["flows"][1:]]
        self.assertAlmostEqual(got[0], 10 * 2.1 / 2 * (1 - M.FEE) ** 2 - M.GAS_USD, delta=0.05)
        self.assertAlmostEqual(tr["left_usd"], 10 / 8 * 8.4 * (1 - M.FEE) ** 2, delta=0.05)  # 1/8 of it rides on
        self.assertGreater(tr["pnl"], 20)

    def test_a_sale_below_its_level_does_not_sell_twice_at_that_level(self):
        # the close crosses 2×, the next open is back at 1.8×: one sale there, the next level is 4×
        c = coin([1.0, 1.0, 2.05])
        c.bars.append((T0 + 900, 300, 1.8, 2.05, 1.8, 2.05))
        c.bars.append((T0 + 1200, 300, 2.05, 2.05, 2.0, 2.05))
        tr = M.simulate(c, variant())
        self.assertEqual(tr["sales"], 1)

    def test_no_stop_rides_a_rug_to_zero_a_stop_gets_out(self):
        rug = [1.0, 1.0, 0.9, 0.6, 0.001, 0.001]
        none = M.simulate(coin(rug), variant())
        self.assertLess(none["pnl"], -9.9)
        stopped = M.simulate(coin(rug), variant(stop=0.5))
        self.assertEqual(stopped["exit"], "stop")
        self.assertLess(stopped["pnl"], -9.9)  # decided on the 0.6 close, filled at the next open: the rug bar
        level = M.simulate(coin(rug), variant(stop=0.5, fill="level"))
        self.assertLess(level["pnl"], -9.9)    # the stop's bar low was the rug too
        # decided on the 0.45 close, sold at the next open (0.45), not at that bar's 0.4 close
        soft = M.simulate(coin([1.0, 1.0, 0.9, 0.45, 0.4, 0.001]), variant(stop=0.5))
        self.assertAlmostEqual(soft["pnl"], 10 * (1 - M.FEE) ** 2 * 0.45 - 10 - 2 * M.GAS_USD, delta=0.02)

    def test_the_stop_is_only_before_the_first_sale(self):
        tr = M.simulate(coin([1.0, 1.0, 2.1, 2.1, 0.3, 0.3]), variant(stop=0.5))
        self.assertEqual(tr["exit"], "held")  # half is sold: the rest is free and rides
        self.assertEqual(tr["sales"], 1)


class Watch(unittest.TestCase):
    def test_held_means_above_the_graduation_price_and_never_halved(self):
        up = coin([1.0] * 6 + [1.2] * 3 + [1.3] * 4)
        self.assertIsNotNone(M.simulate(up, variant(wait_min=30, watch="held")))
        below = coin([1.0] * 3 + [0.9] * 10)
        self.assertIsNone(M.simulate(below, variant(wait_min=30, watch="held")))
        dipped = coin([1.0, 0.45, 1.0, 1.1, 1.2, 1.2, 1.2, 1.3, 1.3])
        self.assertIsNone(M.simulate(dipped, variant(wait_min=30, watch="held")))
        self.assertIsNotNone(M.simulate(dipped, variant(wait_min=30, watch="none")))

    def test_bundled_launches_are_skipped_when_asked(self):
        self.assertIsNone(M.simulate(coin([1.0] * 5, curve_minutes=3.0), variant(bundle=True)))
        self.assertIsNone(M.simulate(coin([1.0] * 5, curve_minutes=None), variant(bundle=True)))
        self.assertIsNotNone(M.simulate(coin([1.0] * 5, curve_minutes=3.0), variant(bundle=False)))

    def test_price_impact_in_a_thin_pool(self):
        thin = M.simulate(coin([1.0] * 5, deep=False), variant())
        deep = M.simulate(coin([1.0] * 5), variant())
        self.assertLess(thin["pnl"], deep["pnl"] - 1)


class Wallet(unittest.TestCase):
    def trade(self, at, flows=(), left=0.0):
        return {"entry_t": at, "day": "2026-09-01", "flows": [(at, -10.05)] + list(flows), "left_usd": left}

    def test_a_buy_needs_the_cash_and_sales_come_back_in_time(self):
        # ten buys empty the €100.50 needed; the first sells for €20 an hour after the 11th coin shows up
        first = self.trade(T0, flows=[(T0 + 7200, 20.0)])
        others = [self.trade(T0 + 60 * i) for i in range(1, 9)]
        late = self.trade(T0 + 3600)
        later = self.trade(T0 + 9000, left=4.0)
        bought, w = M.bankroll([first] + others + [late, later], cash=100.0)
        self.assertNotIn(late, bought)   # at T0+1h the cash was €9.55
        self.assertIn(later, bought)     # by then the first sale had come in
        self.assertAlmostEqual(w["cash"], 100 - 10 * 10.05 + 20.0, places=6)
        self.assertEqual(w["moonbags"], 4.0)
        self.assertEqual(w["broke_at"], T0 + 3600)

    def test_twenty_buys_a_day(self):
        trades = [self.trade(T0 + i, flows=[(T0 + i, 10.05)]) for i in range(25)]
        self.assertEqual(len(M.bankroll(trades, cash=1000.0)[0]), 20)

    def test_out_after_a_day_without_doubling(self):
        flat = coin([1.0] * 400)          # 33 h of nothing
        kept = M.simulate(flat, variant())
        out = M.simulate(flat, variant(tp_within_h=24))
        self.assertEqual((kept["exit"], out["exit"]), ("held", "time"))
        self.assertLess(out["flows"][-1][0] - out["entry_t"], 24 * 3600 + 900)


if __name__ == "__main__":
    unittest.main()
