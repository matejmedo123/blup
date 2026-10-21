"""Brokers the autopilot can trade through: the local simulator (default) or Alpaca (paper / live).

    get(cfg)            → the configured broker, or BrokerError saying exactly what is missing
    live_readiness(cfg) → (ok, [missing items]) for the live opt-in in docs/SCHEMAS.md

Live is never reached by accident: every item of the opt-in must be in place, and a config that
asks for live but misses one is an error — it never falls back to paper or "upgrades" to live.
"""
from __future__ import annotations

from .. import secrets
from .base import Broker, BrokerError, broker_symbol, data_symbol  # noqa: F401

LIVE_PHRASE = "I ACCEPT REAL MONEY RISK"


def _ap(cfg: dict) -> dict:
    return (cfg or {}).get("autopilot") or {}


def mode_of(cfg: dict) -> str:
    ap = _ap(cfg)
    if (ap.get("broker") or "simulator") == "simulator":
        return "simulator"
    return "live" if ap.get("mode") == "live" else "paper"


def live_readiness(cfg: dict) -> tuple:
    ap = _ap(cfg)
    missing = []
    if (ap.get("broker") or "simulator") != "alpaca":
        missing.append('config autopilot.broker must be "alpaca" (live trading needs a real broker)')
    if ap.get("mode") != "live":
        missing.append('config autopilot.mode must be "live"')
    if (cfg or {}).get("paper", True) is not False:
        missing.append("config paper must be false")
    for name in ("ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY"):
        if not secrets.has(name):
            missing.append("%s must be set (environment or trader/secrets.env)" % name)
    if (ap.get("live_confirmation") or "") != LIVE_PHRASE:
        missing.append('config autopilot.live_confirmation must be exactly "%s"' % LIVE_PHRASE)
    return (not missing), missing


def paper_readiness(cfg: dict) -> tuple:
    if (_ap(cfg).get("broker") or "simulator") == "simulator":
        return True, []
    missing = ["%s must be set — free paper keys: alpaca.markets → Paper Trading → API Keys" % n
               for n in ("ALPACA_PAPER_KEY_ID", "ALPACA_PAPER_SECRET_KEY") if not secrets.has(n)]
    return (not missing), missing


def get(cfg: dict) -> Broker:
    ap = _ap(cfg)
    kind = ap.get("broker") or "simulator"
    if kind not in ("simulator", "alpaca"):
        raise BrokerError('unknown autopilot.broker %r — use "simulator" or "alpaca"' % kind)
    if ap.get("mode") == "live":
        ok, missing = live_readiness(cfg)
        if not ok:
            raise BrokerError("live trading refused — missing: " + "; ".join(missing))
        from .alpaca import AlpacaBroker
        return AlpacaBroker("live", cfg)
    if kind == "simulator":
        from .simulator import SimBroker
        return SimBroker(cfg)
    ok, missing = paper_readiness(cfg)
    if not ok:
        raise BrokerError("Alpaca paper trading needs keys — missing: " + "; ".join(missing))
    from .alpaca import AlpacaBroker
    return AlpacaBroker("paper", cfg)
