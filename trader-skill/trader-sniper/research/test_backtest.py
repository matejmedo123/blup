"""Unit tests for the execution model in backtest.py (python3 -m unittest test_backtest)."""
import unittest

import backtest as B


def make_pool(rows, reserve_usd=20_000.0, dex="pumpswap", network="solana", created=None):
    """rows: list of (o, h, l, c, v) one per minute starting at t=6000."""
    t0 = 6000
    bars = [[t0 + 60 * i, o, h, l, c, v] for i, (o, h, l, c, v) in enumerate(rows)]
    meta = {"network": network, "dex": dex, "source": "gt-new", "created_ts": created or t0,
            "snaps": [{"reserve_usd": reserve_usd, "base_price_usd": rows[0][0], "seen_ts": t0}]}
    rec = {"bars": bars, "fetched_ts": t0 + 60 * len(rows), "pool_created_ts": created or t0,
           "info": {"dex": dex}}
    return B.Pool("k", meta, rec)


class ExecutionModel(unittest.TestCase):
    def test_flat_round_trip_costs(self):
        p = make_pool([(1, 1, 1, 1, 10)] * 200)
        e = {"si": 4, "ei": 5, "stop": None, "tps": [], "trail": None, "time_stop_min": 10}
        nc = B.simulate(p, e, {"fee": 0, "gas": 0, "impact": False})
        self.assertAlmostEqual(nc["pnl"], 0.0, places=9)
        tr = B.simulate(p, e)
        # 0.25 % x2 fee + 2 x $0.05 gas + impact ~ 2 x 10/10000
        self.assertAlmostEqual(tr["pnl"], -(0.05 + 0.1 + 0.02), delta=0.01)
        self.assertEqual(tr["exit"], "time")
        self.assertEqual(tr["hold_min"], 10)

    def test_stop_fills_at_bar_low(self):
        rows = [(1, 1, 1, 1, 10)] * 6 + [(1, 1, 0.5, 0.9, 10)] + [(0.9, 0.9, 0.9, 0.9, 1)] * 5
        p = make_pool(rows, reserve_usd=1e12)
        e = {"si": 4, "ei": 5, "stop_pct": 0.3, "tps": [], "trail": None, "time_stop_min": 60}
        tr = B.simulate(p, e, {"fee": 0, "gas": 0})
        self.assertAlmostEqual(tr["ret"], -0.5, places=4)     # low 0.5, not the stop at 0.7
        tr2 = B.simulate(p, e, {"fee": 0, "gas": 0, "stop_fill": "stop"})
        self.assertAlmostEqual(tr2["ret"], -0.3, places=4)

    def test_half_at_target_then_trail(self):
        rows = ([(1, 1, 1, 1, 10)] * 6 + [(1, 1.6, 1, 1.5, 10)] + [(1.5, 2.0, 1.5, 2.0, 10)]
                + [(2.0, 2.0, 1.4, 1.45, 10)] + [(1.45, 1.45, 1.45, 1.45, 1)] * 3)
        p = make_pool(rows, reserve_usd=1e12)
        e = {"si": 4, "ei": 5, "stop_pct": 0.3, "tps": [(0.5, 0.5)], "trail": 0.25,
             "trail_after_tp": True, "time_stop_min": 120}
        tr = B.simulate(p, e, {"fee": 0, "gas": 0})
        # half at 1.5; trail = 2.0*0.75 = 1.5 hit in the bar with low 1.4 -> fills at 1.4
        self.assertAlmostEqual(tr["ret"], 0.5 * 0.5 + 0.5 * 0.4, places=4)
        self.assertEqual(tr["exit"], "tp+trail")

    def test_rug_flag_and_post_rug_fill(self):
        rows = [(1, 1, 1, 1, 10)] * 6 + [(1, 1, 0.02, 0.03, 10)] + [(0.03, 0.03, 0.03, 0.03, 0)] * 3
        p = make_pool(rows)
        e = {"si": 4, "ei": 5, "stop_pct": 0.3, "tps": [], "trail": None, "time_stop_min": 60}
        tr = B.simulate(p, e)
        self.assertTrue(tr["rug"])
        self.assertEqual(tr["exit"], "rug")
        self.assertLess(tr["ret"], -0.97)

    def test_liquidity_scales_with_sqrt_price(self):
        p = make_pool([(1, 1, 1, 1, 10)] * 3, reserve_usd=20_000)
        self.assertAlmostEqual(p.liquidity(1.0), 20_000)
        self.assertAlmostEqual(p.liquidity(0.01), 2_000)

    def test_entry_is_next_bar_open(self):
        rows = [(1, 1, 1, 1, 1)] * 5 + [(1, 1.1, 1, 1.1, 50), (1.2, 1.3, 1.2, 1.3, 9)] + \
            [(1.3, 1.3, 1.3, 1.3, 0)] * 3
        p = make_pool(rows, reserve_usd=1e12)
        e = {"si": 5, "ei": 6, "stop": None, "tps": [], "trail": None, "time_stop_min": 2}
        tr = B.simulate(p, e, {"fee": 0, "gas": 0})
        self.assertAlmostEqual(tr["entry_px"], 1.2)

    def test_launch_signal_needs_rising_closes_and_volume(self):
        rows = [(1, 1, 1, 1, 100)] * 4 + [(1, 1.1, 1, 1.05, 50), (1.05, 1.2, 1.05, 1.1, 300),
                                          (1.1, 1.3, 1.1, 1.2, 400), (1.2, 1.4, 1.2, 1.3, 500)] + \
            [(1.3, 1.3, 1.3, 1.3, 0)] * 10
        p = make_pool(rows)
        sig = B.sig_launch(p, {"window_min": 30, "vol_mult": 2.0, "stop": 0.3, "tp1": 0.5,
                               "tp1_frac": 0.5, "trail": 0.25, "time_stop_min": 120})
        self.assertTrue(sig)
        self.assertEqual(sig[0]["si"], 7)


if __name__ == "__main__":
    unittest.main()
