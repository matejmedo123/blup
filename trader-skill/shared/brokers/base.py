"""The broker interface the autopilot talks to — a local simulator or Alpaca.

Every method returns plain dicts in the docs/SCHEMAS.md shapes, so the autopilot and the
dashboard never care which broker sits behind them. Every call is logged to
trader/broker/log.jsonl — never with a key, token or password in it.
"""
from __future__ import annotations

from .. import market_clock, state, symbols


class BrokerError(Exception):
    pass


ORDER_FIELDS = ("id", "client_order_id", "symbol", "asset", "side", "type", "qty", "limit_price", "stop_price",
                "status", "filled_qty", "filled_avg_price", "submitted_at", "filled_at", "leg", "parent_id",
                "time_in_force")
OPEN_STATUSES = ("new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding",
                 "pending_replace", "replaced", "calculated")


def broker_symbol(raw, asset: str = None) -> str:
    """TSLA → TSLA · BTCUSDT / BTC-USD → BTC/USD (how Alpaca names crypto pairs)."""
    sym = raw if isinstance(raw, symbols.Symbol) else symbols.parse(raw, asset=asset)
    if sym.asset == "meme":
        raise BrokerError("meme coins are never traded through a broker — they are manual-only")
    return sym.alpaca if sym.asset == "crypto" else sym.base


def data_symbol(broker_sym: str, asset: str) -> symbols.Symbol:
    """The inverse: BTC/USD → a crypto Symbol the data layer can fetch candles for."""
    return symbols.parse(broker_sym, asset=asset)


def order_dict(**kw) -> dict:
    out = {k: None for k in ORDER_FIELDS}
    out.update(kw)
    return out


class Broker:
    name = "base"
    mode = "simulator"

    # -- reads -----------------------------------------------------------------------------
    def sync(self) -> None:
        """Bring the broker's view up to date (the simulator processes fills here)."""

    def account(self) -> dict:
        raise NotImplementedError

    def positions(self) -> list:
        raise NotImplementedError

    def open_orders(self) -> list:
        return [o for o in self.orders() if o.get("status") in OPEN_STATUSES]

    def orders(self, since: str = None) -> list:
        raise NotImplementedError

    def tradable(self, asset: str):
        """Base symbols this broker can trade for an asset class, or None for "no restriction"."""
        return None

    def clock(self) -> dict:
        st = market_clock.market_status()
        return {"is_open": st["state"] == "open", "next_open": st.get("next_open"), "next_close": st.get("closes_at")}

    # -- writes ----------------------------------------------------------------------------
    def place_entry(self, order: dict) -> dict:
        """Stocks: bracket (entry limit + take-profit limit + stop). Crypto: the entry limit only."""
        raise NotImplementedError

    def place_stop(self, symbol: str, qty: float, stop_price: float, client_order_id: str = None,
                   asset: str = "crypto") -> dict:
        raise NotImplementedError

    def place_exit(self, symbol: str, qty: float, kind: str = "market", limit_price: float = None,
                   client_order_id: str = None, asset: str = "stock") -> dict:
        raise NotImplementedError

    def cancel(self, order_id: str) -> dict:
        raise NotImplementedError

    def cancel_all(self) -> list:
        out = []
        for o in self.open_orders():
            try:
                out.append(self.cancel(o["id"]))
            except BrokerError as exc:
                out.append({"id": o["id"], "error": str(exc)})
        return out

    def close_position(self, symbol: str) -> dict:
        raise NotImplementedError

    def close_all(self) -> list:
        out = []
        for p in self.positions():
            try:
                out.append(self.close_position(p["symbol"]))
            except BrokerError as exc:
                out.append({"symbol": p["symbol"], "error": str(exc)})
        return out

    # -- bookkeeping -------------------------------------------------------------------------
    def log(self, action: str, **fields) -> None:
        rec = {"at": market_clock.iso(market_clock.now_utc()), "broker": self.name, "mode": self.mode,
               "action": action}
        for k, v in fields.items():
            if any(s in k.lower() for s in ("key", "secret", "token", "password", "auth")):
                continue
            rec[k] = v
        try:
            state.append_jsonl("broker/log.jsonl", rec)
        except OSError:
            pass
