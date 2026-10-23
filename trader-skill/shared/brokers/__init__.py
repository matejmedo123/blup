"""Brokers the autopilot can trade through: the local simulator (default), Alpaca (paper / live) or Bybit EU
(crypto spot and spot margin; paper = Bybit's testnet).

    get(cfg)            → the configured broker, or BrokerError saying exactly what is missing
    live_readiness(cfg) → (ok, [missing items]) for the live opt-in in docs/SCHEMAS.md

Live is never reached by accident: every item of the opt-in must be in place, and a config that
asks for live but misses one is an error — it never falls back to paper or "upgrades" to live.
"""
from __future__ import annotations

from .. import secrets
from .base import Broker, BrokerError, broker_symbol, data_symbol  # noqa: F401

LIVE_PHRASE = "I ACCEPT REAL MONEY RISK"
REAL = ("alpaca", "bybit")  # the brokers that can hold real money
LIVE_KEYS = {"alpaca": ("ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY"), "bybit": ("BYBIT_LIVE_KEY", "BYBIT_LIVE_SECRET")}
PAPER_KEYS = {"alpaca": ("ALPACA_PAPER_KEY_ID", "ALPACA_PAPER_SECRET_KEY"),
              "bybit": ("BYBIT_TESTNET_KEY", "BYBIT_TESTNET_SECRET")}
PAPER_HOW = {"alpaca": "free paper keys: alpaca.markets → Paper Trading → API Keys",
             "bybit": "free testnet keys: testnet.bybit.com → API (test funds from the testnet faucet)"}


def _ap(cfg: dict) -> dict:
    return (cfg or {}).get("autopilot") or {}


def mode_of(cfg: dict) -> str:
    ap = _ap(cfg)
    if (ap.get("broker") or "simulator") == "simulator":
        return "simulator"
    return "live" if ap.get("mode") == "live" else "paper"


def live_readiness(cfg: dict, book: bool = True) -> tuple:
    """book=False: the five opt-in steps alone. A running live bot is checked that way — a paper trade left in the
    book then holds up new entries (the cycle says why), never the exits and the KILL of the live trades."""
    ap = _ap(cfg)
    missing = []
    kind = ap.get("broker") or "simulator"
    if kind not in REAL:
        missing.append('config autopilot.broker must be "alpaca" or "bybit" (live trading needs a real broker)')
    if ap.get("mode") != "live":
        missing.append('config autopilot.mode must be "live"')
    if (cfg or {}).get("paper", True) is not False:
        missing.append("config paper must be false")
    for name in LIVE_KEYS.get(kind, LIVE_KEYS["alpaca"]):
        if not secrets.has(name):
            missing.append("%s must be set (environment or trader/secrets.env)" % name)
    if (ap.get("live_confirmation") or "") != LIVE_PHRASE:
        missing.append('config autopilot.live_confirmation must be exactly "%s"' % LIVE_PHRASE)
    # trades still open in the simulator or the paper account would sit in the book of a live bot — never acted on
    # there (the live account may hold the same coins, and they are yours), but never closed either
    if not book:
        return (not missing), missing
    from .. import state
    try:
        items = ((state.read_json("autopilot/book.json", {}) or {}).get("items") or {}).values()
    except ValueError:
        items = []
    away = [it for it in items if it.get("status") in ("submitting", "pending", "open")
            and (it.get("broker"), it.get("mode")) != (kind, "live")]
    if away:
        missing.append("%d trade(s) from the simulator or the paper account are still open in autopilot/book.json "
                       "(%s) — close them there first (KILL), then `autopilot.py forget --confirm FORGET`" % (
                           len(away), ", ".join(sorted({str(it.get("symbol")) for it in away}))))
    return (not missing), missing


def paper_readiness(cfg: dict) -> tuple:
    kind = _ap(cfg).get("broker") or "simulator"
    if kind == "simulator":
        return True, []
    missing = ["%s must be set — %s" % (n, PAPER_HOW[kind]) for n in PAPER_KEYS[kind] if not secrets.has(n)]
    return (not missing), missing


def get(cfg: dict) -> Broker:
    ap = _ap(cfg)
    kind = ap.get("broker") or "simulator"
    if kind not in ("simulator",) + REAL:
        raise BrokerError('unknown autopilot.broker %r — use "simulator", "alpaca" or "bybit"' % kind)
    if ap.get("mode") == "live":
        ok, missing = live_readiness(cfg, book=False)
        if not ok:
            raise BrokerError("live trading refused — missing: " + "; ".join(missing))
        return _real(kind)("live", cfg)
    if kind == "simulator":
        from .simulator import SimBroker
        return SimBroker(cfg)
    ok, missing = paper_readiness(cfg)
    if not ok:
        raise BrokerError("%s paper trading needs keys — missing: %s" % (kind.capitalize(), "; ".join(missing)))
    return _real(kind)("paper", cfg)


def _real(kind: str):
    if kind == "bybit":
        from .bybit import BybitBroker
        return BybitBroker
    from .alpaca import AlpacaBroker
    return AlpacaBroker
