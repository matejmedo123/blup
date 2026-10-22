"""The sniper's backtest harness (trader-sniper/research) keeps running on the sniper's real rules: if sniper.py
changes a function the replay imports, this fails here and not months later, when someone re-runs the study."""
from __future__ import annotations

import os
import sys
import unittest

RESEARCH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "trader-sniper", "research")


def load_tests(loader, tests, pattern):
    if RESEARCH not in sys.path:
        sys.path.insert(0, RESEARCH)
    suite = unittest.TestSuite()
    for name in ("test_backtest", "test_replay"):
        suite.addTests(loader.loadTestsFromName(name))
    return suite
