"""Local paper broker — no account, no keys, fills against real (or fixture) 5-min candles.

The fill rules mirror shared.trade_sim.walk so simulated trades match backtests and the Time
Machine: a buy limit fills on the first bar after it was sent whose low reaches the limit (at the
better of limit and open); bracket children watch the bars after the fill; when one bar touches both
the stop and the target the stop wins; a gap through the stop fills at the open; market orders fill
at the last closed bar's close plus slippage. Positions are marked to the last close. The whole book
lives in trader/broker/sim.json.

Leverage (only what config.leverage() allows) lets cash go below zero, down to −(leverage − 1) × equity;
borrowed cash costs ``borrow_rate_pct`` a year, charged as time passes — a backtest that leaves the
interest out flatters leverage.
"""
from __future__ import annotations

from .. import config, data, market_clock, state
from .base import Broker, BrokerError, data_symbol, order_dict

BOOK = "broker/sim.json"
ARCHIVE = "broker/sim-archive.jsonl"
INTERVAL = "5m"
KEEP_DAYS = 30  # finished orders and fills older than this move to the archive: sync walks every order per bar
FINAL = ("filled", "canceled", "expired", "rejected")


def _r(x, nd=6):
    return round(float(x), nd) if x is not None else None


class SimBroker(Broker):
    name = "simulator"
    mode = "simulator"

    def __init__(self, cfg: dict = None):
        self.cfg = cfg or config.load_config()
        self._candles = {}
        self._spans = {}  # (symbol, asset) → the oldest time the fetched series surely covers
        self.save_error = None
        self.book = state.read_json(BOOK) or self._new_book()

    # -- book -----------------------------------------------------------------------------------
    def _new_book(self) -> dict:
        cash = float((self.cfg.get("autopilot") or {}).get("sim_starting_cash") or self.cfg.get("account_size") or 25000)
        return {"cash": cash, "starting_cash": cash, "currency": "USD", "seq": 0, "orders": [], "positions": {},
                "fills": [], "created_at": market_clock.iso(market_clock.now_utc()), "last_sync": None}

    def _save(self, strict: bool = True) -> None:
        try:
            state.write_json(BOOK, self.book)
            self.save_error = None
        except OSError as exc:
            # a full disk: a sync goes on with the book in memory, so the stops and time stops still act — the
            # autopilot reports it and opens nothing new. A new order that can't be kept is refused instead: the
            # bot must not believe in a stop that the next cycle's book won't have
            self.save_error = "%s: %s" % (type(exc).__name__, exc)
            if strict:
                raise BrokerError("the simulator could not save its book (%s) — the order is not kept" % self.save_error)

    def _next_id(self) -> str:
        self.book["seq"] = int(self.book.get("seq") or 0) + 1
        return "sim-%06d" % self.book["seq"]

    def _costs(self, asset: str) -> tuple:
        c = (self.cfg.get("costs") or {}).get(asset) or {}
        return float(c.get("fee_bps") or 0) / 10000.0, float(c.get("slippage_bps") or 0) / 10000.0

    def _now(self):
        return market_clock.now_utc()

    def _series(self, symbol: str, asset: str, since_ts: int = None):
        key = (symbol, asset)
        now_ts = int(self._now().timestamp())
        # fetched again only when an older bar is needed than the series holds (a 2-day series first, then
        # whatever the oldest unwalked order asks for)
        if key not in self._candles or (since_ts and since_ts < self._spans.get(key, 0)):
            span_days = 2.0
            if since_ts:
                span_days = max(span_days, (now_ts - since_ts) / 86400.0 + 1.0)
            days = int(span_days) + 1 if asset == "stock" else span_days
            try:
                self._candles[key] = data.get_candles(data_symbol(symbol, asset), INTERVAL, days=days).candles
            except data.DataUnavailable as exc:
                raise BrokerError("no prices for %s: %s" % (symbol, exc))
            self._spans[key] = now_ts - int(span_days * 86400) + 86400
        return self._candles[key]

    def _last_close(self, symbol: str, asset: str) -> float:
        bars = self._series(symbol, asset)
        if not bars:
            raise BrokerError("no closed bar yet for %s" % symbol)
        return bars[-1].c

    # -- fills ----------------------------------------------------------------------------------
    def _fill(self, o: dict, price: float, at_ts: int) -> None:
        fee_rate, _ = self._costs(o["asset"])
        qty = float(o["qty"])
        price = round(float(price), 2) if (o["asset"] == "stock" and price >= 1) else _r(price)
        fee = qty * price * fee_rate
        pos = self.book["positions"].get(o["symbol"])
        if o["side"] == "buy":
            self.book["cash"] -= qty * price + fee
            if pos:
                total = pos["qty"] + qty
                pos["avg_entry"] = _r((pos["avg_entry"] * pos["qty"] + price * qty) / total)
                pos["qty"] = _r(total, 8)
            else:
                self.book["positions"][o["symbol"]] = {"symbol": o["symbol"], "asset": o["asset"], "qty": _r(qty, 8),
                                                       "avg_entry": price, "opened_at": market_clock.iso(at_ts),
                                                       "client_order_id": o.get("client_order_id")}
        else:
            if not pos or pos["qty"] < qty - 1e-9:
                o["status"] = "rejected"
                o["reject_reason"] = "no position to sell"
                return
            self.book["cash"] += qty * price - fee
            pos["qty"] = _r(pos["qty"] - qty, 8)
            if pos["qty"] <= 1e-9:
                del self.book["positions"][o["symbol"]]
        o.update(status="filled", filled_qty=qty, filled_avg_price=price, filled_at=market_clock.iso(at_ts),
                 fee=_r(fee, 4))
        self.book["fills"].append({"order_id": o["id"], "client_order_id": o.get("client_order_id"),
                                   "symbol": o["symbol"], "side": o["side"], "qty": qty, "price": price, "fee": _r(fee, 4),
                                   "at": market_clock.iso(at_ts), "leg": o.get("leg")})
        if o["side"] == "buy":
            for child in self.book["orders"]:
                if child.get("parent_id") == o["id"] and child["status"] == "held":
                    child["status"] = "new"
                    child["active_from"] = at_ts  # watches the bars after the fill bar
        else:
            for sib in self.book["orders"]:  # one-cancels-other for the bracket legs
                if (sib is not o and sib.get("parent_id") and sib.get("parent_id") == o.get("parent_id")
                        and sib["status"] in ("new", "held")):
                    sib["status"] = "canceled"
                    sib["canceled_at"] = market_clock.iso(at_ts)

    def sync(self) -> None:
        """Walk every bar since each open order was sent and fill what the bars say would have filled. Each
        symbol remembers the last bar it walked (``walked``), so a position held for months costs one new bar a
        cycle, not every bar since its entry."""
        now_ts = int(self._now().timestamp())
        step = market_clock.interval_seconds(INTERVAL)
        open_orders = [o for o in self.book["orders"] if o["status"] in ("new", "held")]
        walked = self.book.setdefault("walked", {})
        for symbol in list(walked):
            if not any(o["symbol"] == symbol for o in open_orders):
                del walked[symbol]
        for symbol in sorted({o["symbol"] for o in open_orders}):
            mine = [o for o in open_orders if o["symbol"] == symbol]
            asset = mine[0]["asset"]
            since = min(int(o.get("active_from") or market_clock.ts(o["submitted_at"])) for o in mine)
            done = int(walked.get(symbol) or 0)
            bars = [c for c in self._series(symbol, asset, max(since, done)) if c.t >= since - step and c.t > done
                    and c.t + step <= now_ts]
            for bar in bars:
                live = [o for o in mine if o["status"] == "new"]
                if not live:
                    break
                # entries first, then stop legs before take-profit legs (stop-first on a shared bar)
                live.sort(key=lambda o: {"entry": 0, "stop": 1, "exit": 1, "target": 2}.get(o.get("leg") or "entry", 3))
                for o in live:
                    if o["status"] != "new" or bar.t < int(o.get("active_from") or 0):
                        continue
                    if (o.get("time_in_force") == "day" and o.get("expires_at")
                            and bar.t >= market_clock.ts(o["expires_at"])):
                        o["status"] = "expired"
                        continue
                    if o["side"] == "buy" and o["type"] == "limit":
                        if bar.l <= o["limit_price"]:
                            self._fill(o, min(o["limit_price"], bar.o), bar.t + step)
                    elif o["side"] == "sell" and o["type"] in ("stop", "stop_limit"):
                        _, slip = self._costs(o["asset"])
                        if bar.o <= o["stop_price"]:
                            self._fill(o, bar.o * (1 - slip), bar.t)
                        elif bar.l <= o["stop_price"]:
                            self._fill(o, o["stop_price"] * (1 - slip), bar.t + step)
                    elif o["side"] == "sell" and o["type"] == "limit":
                        if bar.h >= o["limit_price"]:
                            self._fill(o, o["limit_price"], bar.t + step)
            if bars:
                walked[symbol] = bars[-1].t
            # day orders that never filled expire at the session close
            for o in mine:
                if (o["status"] in ("new", "held") and o.get("expires_at")
                        and now_ts >= market_clock.ts(o["expires_at"])):
                    o["status"] = "expired" if o.get("leg") == "entry" else "canceled"
        self._mark()
        self._charge_interest(now_ts)
        self._archive(now_ts)
        self.book["last_sync"] = market_clock.iso(now_ts)
        self._save(strict=False)

    def _archive(self, now_ts: int) -> None:
        """Finished orders and fills older than KEEP_DAYS go to broker/sim-archive.jsonl — a bracket stays whole
        while any of its legs still works."""
        cut = market_clock.iso(now_ts - KEEP_DAYS * 86400)
        if self.book.get("archived_until", "") >= cut[:10]:
            return  # once a day is enough
        working = {o.get("parent_id") or o["id"] for o in self.book["orders"] if o["status"] not in FINAL}
        keep, old = [], []
        for o in self.book["orders"]:
            done_at = o.get("filled_at") or o.get("canceled_at") or o.get("submitted_at") or ""
            gone = o["status"] in FINAL and (o.get("parent_id") or o["id"]) not in working and done_at < cut
            (old if gone else keep).append(o)
        fills = [f for f in self.book.get("fills") or [] if (f.get("at") or "") >= cut]
        stale = [f for f in self.book.get("fills") or [] if (f.get("at") or "") < cut]
        if old or stale:
            try:
                state.append_jsonl_rows(ARCHIVE, [dict(r, kind="order") for r in old] +
                                        [dict(r, kind="fill") for r in stale])
            except OSError:
                return  # kept in the book until the archive can be written
            self.book["orders"], self.book["fills"] = keep, fills
        self.book["archived_until"] = cut[:10]

    def _charge_interest(self, now_ts: int) -> None:
        """Borrowed cash costs borrow_rate_pct; idle cash earns cash_yield_pct (T-bills), both by the second."""
        last = self.book.get("interest_at")
        if last is not None and now_ts <= int(last):
            return  # time went back (a clock step, a replay): the next interest runs from the latest time seen
        self.book["interest_at"] = now_ts
        if last is None:
            return
        years = (now_ts - int(last)) / (365.0 * 86400)
        cash = self.book["cash"]
        if cash < 0:
            rate = float(self.cfg.get("borrow_rate_pct") if self.cfg.get("borrow_rate_pct") is not None else 10.0) / 100.0
            fee = -cash * rate * years
            self.book["cash"] -= fee
            self.book["interest_paid"] = _r(float(self.book.get("interest_paid") or 0) + fee, 4)
        elif cash > 0 and float(self.cfg.get("cash_yield_pct") or 0) > 0:
            earned = cash * float(self.cfg["cash_yield_pct"]) / 100.0 * years
            self.book["cash"] += earned
            self.book["interest_earned"] = _r(float(self.book.get("interest_earned") or 0) + earned, 4)

    def leverage(self, asset: str) -> float:
        try:
            limits = config.load_limits()
        except ValueError:  # limits.json being edited: no borrowing until it reads again — fills and stops go on
            return 1.0
        return config.leverage(self.cfg, limits, asset, self.name)[0]

    def _equity(self) -> float:
        return self.book["cash"] + sum(p["qty"] * p.get("last", p["avg_entry"]) for p in self.book["positions"].values())

    def _mark(self) -> None:
        for p in self.book["positions"].values():
            try:
                p["last"] = _r(self._last_close(p["symbol"], p["asset"]))
            except BrokerError:
                p.setdefault("last", p["avg_entry"])

    # -- reads ----------------------------------------------------------------------------------
    def account(self) -> dict:
        equity, cash = self._equity(), self.book["cash"]
        lev = max(self.leverage(a) for a in config.LEVERAGE_ASSETS)
        return {"equity": _r(equity, 2), "cash": _r(cash, 2),
                "buying_power": _r(max(0.0, cash + (lev - 1) * max(equity, 0.0) - self._reserved()), 2),
                "borrowed": _r(max(0.0, -cash), 2), "interest_paid": _r(self.book.get("interest_paid") or 0, 2),
                "interest_earned": _r(self.book.get("interest_earned") or 0, 2),
                "currency": "USD", "starting_cash": self.book.get("starting_cash"), "mode": self.mode}

    def _reserved(self) -> float:
        """Buy orders still waiting hold their cash, as at a real broker — two can't spend the same dollars."""
        return sum(float(o["qty"]) * float(o.get("limit_price") or 0) for o in self.book["orders"]
                   if o.get("side") == "buy" and o.get("status") in ("new", "held"))

    def positions(self) -> list:
        out = []
        for p in self.book["positions"].values():
            last = p.get("last", p["avg_entry"])
            out.append({"symbol": p["symbol"], "asset": p["asset"], "qty": p["qty"], "avg_entry": p["avg_entry"],
                        "last": last, "market_value": _r(p["qty"] * last, 2),
                        "unrealized_pl": _r(p["qty"] * (last - p["avg_entry"]), 2), "opened_at": p.get("opened_at"),
                        "client_order_id": p.get("client_order_id")})
        return out

    def orders(self, since: str = None) -> list:
        out = []
        for o in self.book["orders"]:
            if since and o["submitted_at"] < since:
                continue
            out.append(order_dict(**{k: v for k, v in o.items() if k != "active_from"}))
        return out

    def open_orders(self) -> list:
        return [o for o in self.orders() if o["status"] in ("new", "held")]

    def fills(self) -> list:
        return list(self.book.get("fills") or [])

    # -- writes ---------------------------------------------------------------------------------
    def _new(self, **kw) -> dict:
        now = self._now()
        o = order_dict(id=self._next_id(), submitted_at=market_clock.iso(now), status="new", filled_qty=0, **kw)
        o["active_from"] = int(now.timestamp())
        self.book["orders"].append(o)
        return o

    def _session_end(self, asset: str):
        if asset != "stock":
            return None
        b = market_clock.session_bounds(market_clock.et_date(self._now()))
        return market_clock.iso(b[1]) if b else None

    def place_entry(self, order: dict) -> dict:
        asset = order["asset"]
        if asset == "meme":
            raise BrokerError("meme coins are never auto-traded")
        qty, limit = float(order["qty"]), float(order["limit_price"])
        if qty <= 0 or limit <= 0:
            raise BrokerError("qty and limit price must be positive")
        cid = order.get("client_order_id")
        for o in self.book["orders"] if cid else []:
            if o.get("client_order_id") == cid and o.get("leg") == "entry":  # sent twice: like Alpaca, one order
                return order_dict(**{k: v for k, v in o.items() if k != "active_from"})
        lev = max(1.0, min(float(order.get("leverage") or 1.0), self.leverage(asset)))
        power = self.book["cash"] + (lev - 1) * max(self._equity(), 0.0) - self._reserved()
        if qty * limit > power + 1e-6:
            raise BrokerError("insufficient buying power: %.2f needed, %.2f available (cash %.2f, %g× leverage)" % (
                qty * limit, power, self.book["cash"], lev))
        if self.book.get("interest_at") is None:
            self.book["interest_at"] = int(self._now().timestamp())
        tif = "day" if asset == "stock" else "gtc"
        entry = self._new(client_order_id=order.get("client_order_id"), symbol=order["symbol"], asset=asset,
                          side="buy", type="limit", qty=qty, limit_price=limit, leg="entry", time_in_force=tif,
                          order_class="bracket" if asset == "stock" else "simple",
                          expires_at=self._session_end(asset))
        if asset == "stock":
            for leg, typ, field, price in (("stop", "stop", "stop_price", order["stop_price"]),
                                           ("target", "limit", "limit_price", order["target_price"])):
                child = self._new(client_order_id=None, symbol=order["symbol"], asset=asset, side="sell", type=typ,
                                  qty=qty, leg=leg, parent_id=entry["id"], time_in_force="gtc", **{field: float(price)})
                child["status"] = "held"
        self.log("place_entry", symbol=order["symbol"], qty=qty, limit_price=limit, order_id=entry["id"],
                 client_order_id=order.get("client_order_id"))
        self._save()
        return order_dict(**{k: v for k, v in entry.items() if k != "active_from"})

    def place_stop(self, symbol, qty, stop_price, client_order_id=None, asset="crypto") -> dict:
        o = self._new(client_order_id=client_order_id, symbol=symbol, asset=asset, side="sell", type="stop",
                      qty=float(qty), stop_price=float(stop_price), leg="stop", time_in_force="gtc")
        self.log("place_stop", symbol=symbol, qty=qty, stop_price=stop_price, order_id=o["id"])
        self._save()
        return order_dict(**{k: v for k, v in o.items() if k != "active_from"})

    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="stock") -> dict:
        if kind == "limit":
            o = self._new(client_order_id=client_order_id, symbol=symbol, asset=asset, side="sell", type="limit",
                          qty=float(qty), limit_price=float(limit_price), leg="exit", time_in_force="gtc")
        else:
            _, slip = self._costs(asset)
            last = self._last_close(symbol, asset)
            o = self._new(client_order_id=client_order_id, symbol=symbol, asset=asset, side="sell", type="market",
                          qty=float(qty), leg="exit", time_in_force="gtc")
            self._fill(o, last * (1 - slip), int(self._now().timestamp()))
        self.log("place_exit", symbol=symbol, qty=qty, kind=kind, order_id=o["id"], status=o["status"])
        self._save()
        return order_dict(**{k: v for k, v in o.items() if k != "active_from"})

    def cancel(self, order_id: str) -> dict:
        for o in self.book["orders"]:
            if o["id"] == order_id:
                if o["status"] in ("new", "held"):
                    o["status"] = "canceled"
                    o["canceled_at"] = market_clock.iso(self._now())
                    for child in self.book["orders"]:
                        if child.get("parent_id") == order_id and child["status"] in ("new", "held"):
                            child["status"] = "canceled"
                    self.log("cancel", order_id=order_id)
                    self._save()
                return order_dict(**{k: v for k, v in o.items() if k != "active_from"})
        raise BrokerError("unknown order %s" % order_id)

    def close_position(self, symbol: str) -> dict:
        pos = self.book["positions"].get(symbol)
        for o in self.book["orders"]:
            if o["symbol"] == symbol and o["status"] in ("new", "held"):
                o["status"] = "canceled"
                o["canceled_at"] = market_clock.iso(self._now())
        if not pos:
            self._save()
            return {"symbol": symbol, "status": "flat"}
        return self.place_exit(symbol, pos["qty"], "market", asset=pos["asset"])
