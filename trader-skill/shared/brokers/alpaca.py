"""Alpaca Trading API (paper by default) — the only place in the pack that sends real orders.

Talks REST through urllib directly (trading calls are never cached). Keys come from
shared.secrets and only ever travel in request headers: never in exceptions, logs, state files
or anything the dashboard can return. A POST is never blindly retried: after a timeout or a 5xx
the order is looked up by its client_order_id first, so a slow network can't double an order.
"""
from __future__ import annotations

import json
import math
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from .. import config, data, market_clock, secrets, symbols
from .base import Broker, BrokerError, order_dict

BASE = {"paper": "https://paper-api.alpaca.markets", "live": "https://api.alpaca.markets"}
KEYS = {"paper": ("ALPACA_PAPER_KEY_ID", "ALPACA_PAPER_SECRET_KEY"),
        "live": ("ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY")}
TIMEOUT = 15
QUOTES = ("USDT", "USDC", "USD", "BTC")
TRADABLE_TTL = 6 * 3600


def _fmt_price(x: float, asset: str, tick: float = None) -> str:
    if tick:
        nd = max(0, -int(math.floor(math.log10(float(tick)) + 1e-9)))
        return ("%." + str(nd) + "f") % (round(float(x) / tick) * tick)
    if asset == "stock":
        return "%.2f" % float(x) if float(x) >= 1 else "%.4f" % float(x)
    return ("%.8f" % float(x)).rstrip("0").rstrip(".")


def _fmt_qty(q: float) -> str:
    q = float(q)
    return str(int(q)) if q == int(q) else ("%.9f" % q).rstrip("0").rstrip(".")


def _slash(sym: str) -> str:
    """Alpaca returns crypto positions as BTCUSD — the pack uses BTC/USD everywhere."""
    if "/" in sym:
        return sym
    for q in QUOTES:
        if sym.endswith(q) and len(sym) > len(q):
            return sym[: -len(q)] + "/" + q
    return sym


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class AlpacaBroker(Broker):
    name = "alpaca"

    def __init__(self, mode: str = "paper", cfg: dict = None):
        if config.is_offline():
            raise BrokerError("the Alpaca broker does not run in offline mode — use the simulator")
        if mode not in BASE:
            raise BrokerError("unknown Alpaca mode %r" % mode)
        self.mode = mode
        self.cfg = cfg or config.load_config()
        key_name, secret_name = KEYS[mode]
        missing = [n for n in (key_name, secret_name) if not secrets.has(n)]
        if missing:
            raise BrokerError("missing %s — set it in your environment or trader/secrets.env (free paper keys: "
                              "alpaca.markets → Paper Trading → API Keys)" % " and ".join(missing))
        self._key_name, self._secret_name = key_name, secret_name
        self.base = BASE[mode]
        self._tradable = {}
        self.notes = []

    # -- transport ---------------------------------------------------------------------------------
    def _headers(self) -> dict:
        return {"APCA-API-KEY-ID": secrets.get(self._key_name), "APCA-API-SECRET-KEY": secrets.get(self._secret_name),
                "Accept": "application/json", "Content-Type": "application/json",
                "User-Agent": "trader-skill/1.0 autopilot"}

    def _send(self, method: str, path: str, body=None):
        url = self.base + path
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=payload, method=method, headers=self._headers())
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
        return json.loads(raw.decode("utf-8")) if raw.strip() else {}

    @staticmethod
    def _message(err) -> str:
        try:
            body = json.loads(err.read().decode("utf-8"))
            return str(body.get("message") or body)[:300]
        except Exception:
            return getattr(err, "reason", "") or "HTTP %s" % getattr(err, "code", "?")

    def _get(self, path: str, retries: int = 3):
        delay = 1.0
        for attempt in range(retries + 1):
            try:
                return self._send("GET", path)
            except urllib.error.HTTPError as err:
                if err.code in (429, 500, 502, 503, 504) and attempt < retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise BrokerError("Alpaca GET %s failed (HTTP %s): %s" % (path.split("?")[0], err.code, self._message(err)))
            except (urllib.error.URLError, socket.timeout, ConnectionError) as err:
                if attempt < retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise BrokerError("Alpaca GET %s failed: %s" % (path.split("?")[0], getattr(err, "reason", err)))

    def _delete(self, path: str):
        try:
            return self._send("DELETE", path)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return {}
            raise BrokerError("Alpaca DELETE %s failed (HTTP %s): %s" % (path.split("?")[0], err.code, self._message(err)))
        except (urllib.error.URLError, socket.timeout, ConnectionError) as err:
            raise BrokerError("Alpaca DELETE %s failed: %s" % (path.split("?")[0], getattr(err, "reason", err)))

    def _lookup(self, client_order_id: str):
        try:
            return self._send("GET", "/v2/orders:by_client_order_id?client_order_id=%s"
                              % urllib.parse.quote(client_order_id))
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise BrokerError("Alpaca order lookup failed (HTTP %s): %s" % (err.code, self._message(err)))
        except (urllib.error.URLError, socket.timeout, ConnectionError) as err:
            raise BrokerError("Alpaca order lookup failed: %s" % getattr(err, "reason", err))

    def _post_order(self, body: dict) -> dict:
        """POST once; on a timeout or 5xx find out whether it landed before trying again (once)."""
        cid = body.get("client_order_id")
        for attempt in range(2):
            try:
                return self._send("POST", "/v2/orders", body)
            except urllib.error.HTTPError as err:
                if err.code < 500:
                    raise BrokerError("Alpaca rejected the order (HTTP %s): %s" % (err.code, self._message(err)))
                failure = "HTTP %s" % err.code
            except (urllib.error.URLError, socket.timeout, ConnectionError) as err:
                failure = str(getattr(err, "reason", err))
            if not cid:
                raise BrokerError("Alpaca order may or may not have been placed (%s) and has no client id to check — "
                                  "look in the Alpaca dashboard before doing anything else" % failure)
            found = self._lookup(cid)
            if found:
                self.log("post_recovered", client_order_id=cid, order_id=found.get("id"))
                return found
            if attempt == 0:
                time.sleep(1.0)
                continue
            raise BrokerError("Alpaca order failed twice (%s); nothing was found under %s" % (failure, cid))

    # -- mapping -------------------------------------------------------------------------------------
    @staticmethod
    def _order(o: dict, leg: str = None, parent_id: str = None) -> dict:
        asset = "crypto" if o.get("asset_class") == "crypto" or "/" in str(o.get("symbol")) else "stock"
        return order_dict(id=o.get("id"), client_order_id=o.get("client_order_id"), symbol=_slash(o.get("symbol") or ""),
                          asset=asset, side=o.get("side"), type=o.get("type") or o.get("order_type"),
                          qty=_f(o.get("qty")), limit_price=_f(o.get("limit_price")), stop_price=_f(o.get("stop_price")),
                          status=o.get("status"), filled_qty=_f(o.get("filled_qty")),
                          filled_avg_price=_f(o.get("filled_avg_price")), submitted_at=o.get("submitted_at"),
                          filled_at=o.get("filled_at"), leg=leg, parent_id=parent_id,
                          time_in_force=o.get("time_in_force"))

    def _flatten(self, raw: list) -> list:
        out = []
        for o in raw or []:
            out.append(self._order(o, leg=o.get("_leg")))
            for child in o.get("legs") or []:
                leg = "stop" if (child.get("type") or "").startswith("stop") else "target"
                out.append(self._order(child, leg=leg, parent_id=o.get("id")))
        return out

    # -- reads ---------------------------------------------------------------------------------------
    def account(self) -> dict:
        a = self._get("/v2/account")
        if a.get("trading_blocked") or a.get("account_blocked"):
            raise BrokerError("Alpaca says this account is blocked from trading")
        return {"equity": _f(a.get("equity")), "cash": _f(a.get("cash")), "buying_power": _f(a.get("buying_power")),
                "currency": a.get("currency") or "USD", "mode": self.mode, "status": a.get("status")}

    def positions(self) -> list:
        out = []
        for p in self._get("/v2/positions") or []:
            asset = "crypto" if p.get("asset_class") == "crypto" else "stock"
            out.append({"symbol": _slash(p.get("symbol") or "") if asset == "crypto" else p.get("symbol"),
                        "asset": asset, "qty": _f(p.get("qty")), "avg_entry": _f(p.get("avg_entry_price")),
                        "last": _f(p.get("current_price")), "market_value": _f(p.get("market_value")),
                        "unrealized_pl": _f(p.get("unrealized_pl")), "opened_at": None})
        return out

    def orders(self, since: str = None) -> list:
        q = "status=all&nested=true&limit=200&direction=desc"
        if since:
            q += "&after=" + urllib.parse.quote(since)
        return self._flatten(self._get("/v2/orders?" + q))

    def open_orders(self) -> list:
        return self._flatten(self._get("/v2/orders?status=open&nested=true&limit=200"))

    def clock(self) -> dict:
        c = self._get("/v2/clock")
        return {"is_open": bool(c.get("is_open")), "next_open": c.get("next_open"), "next_close": c.get("next_close")}

    # -- writes --------------------------------------------------------------------------------------
    def tradable(self, asset: str):
        """Crypto: the active Alpaca crypto assets ("BTC/USD" → "BTC"); stocks: no restriction.

        A failed lookup returns None (no filter) and leaves a note — a missing asset list must
        never stop the autopilot from trading what it already trades.
        """
        if asset != "crypto":
            return None
        now = time.time()
        hit = self._tradable.get(asset)
        if hit and now - hit[0] < TRADABLE_TTL:
            return set(hit[1])
        try:
            rows = self._get("/v2/assets?asset_class=crypto&status=active", retries=1)
        except BrokerError as exc:
            self.notes.append("Alpaca crypto asset list unavailable: %s" % exc)
            return set(hit[1]) if hit else None
        bases = set()
        for r in rows or []:
            if not isinstance(r, dict) or r.get("tradable") is False:
                continue
            sym = str(r.get("symbol") or "").upper()
            base = sym.split("/", 1)[0] if "/" in sym else next(
                (sym[: -len(q)] for q in QUOTES if sym.endswith(q) and len(sym) > len(q)), sym)
            if base:
                bases.add(base)
        self._tradable[asset] = (now, bases)
        return set(bases)

    def _tick(self, symbol: str, asset: str):
        if asset == "stock":
            return None
        try:
            return data.lot_info(symbols.parse(symbol, asset="crypto")).get("tick")
        except Exception:
            return None

    def place_entry(self, order: dict) -> dict:
        asset = order["asset"]
        if asset == "meme":
            raise BrokerError("meme coins are never auto-traded")
        sym = order["symbol"]
        tick = self._tick(sym, asset)
        body = {"symbol": sym, "qty": _fmt_qty(order["qty"]), "side": "buy", "type": "limit",
                "limit_price": _fmt_price(order["limit_price"], asset, tick),
                "client_order_id": order.get("client_order_id")}
        if asset == "stock":
            if float(order["target_price"]) <= float(order["stop_price"]):
                raise BrokerError("take-profit must be above the stop for a buy bracket")
            body.update(time_in_force="day", order_class="bracket",
                        take_profit={"limit_price": _fmt_price(order["target_price"], asset)},
                        stop_loss={"stop_price": _fmt_price(order["stop_price"], asset)})
        else:
            body["time_in_force"] = "gtc"  # crypto: gtc/ioc only, and no brackets
        res = self._post_order(body)
        self.log("place_entry", symbol=sym, qty=body["qty"], limit_price=body["limit_price"],
                 client_order_id=body.get("client_order_id"), order_id=res.get("id"), status=res.get("status"))
        out = self._order(res, leg="entry")
        return out

    def place_stop(self, symbol, qty, stop_price, client_order_id=None, asset="crypto") -> dict:
        tick = self._tick(symbol, asset)
        body = {"symbol": symbol, "qty": _fmt_qty(qty), "side": "sell", "time_in_force": "gtc",
                "client_order_id": client_order_id}
        if asset == "crypto":
            # crypto has no plain stop orders: a stop-limit a little below the stop keeps it fillable
            body.update(type="stop_limit", stop_price=_fmt_price(stop_price, asset, tick),
                        limit_price=_fmt_price(float(stop_price) * 0.995, asset, tick))
        else:
            body.update(type="stop", stop_price=_fmt_price(stop_price, asset))
        res = self._post_order(body)
        self.log("place_stop", symbol=symbol, qty=body["qty"], stop_price=body["stop_price"], order_id=res.get("id"))
        return self._order(res, leg="stop")

    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="stock") -> dict:
        body = {"symbol": symbol, "qty": _fmt_qty(qty), "side": "sell", "type": kind,
                "time_in_force": "gtc" if asset == "crypto" else "day", "client_order_id": client_order_id}
        if kind == "limit":
            body["limit_price"] = _fmt_price(limit_price, asset, self._tick(symbol, asset))
        res = self._post_order(body)
        self.log("place_exit", symbol=symbol, qty=body["qty"], kind=kind, order_id=res.get("id"))
        return self._order(res, leg="exit")

    def cancel(self, order_id: str) -> dict:
        self._delete("/v2/orders/%s" % urllib.parse.quote(order_id))
        self.log("cancel", order_id=order_id)
        return {"id": order_id, "status": "canceled"}

    def cancel_all(self) -> list:
        res = self._delete("/v2/orders")
        self.log("cancel_all")
        return res if isinstance(res, list) else []

    def close_position(self, symbol: str) -> dict:
        res = self._delete("/v2/positions/%s" % urllib.parse.quote(symbol.replace("/", ""), safe=""))
        self.log("close_position", symbol=symbol, order_id=(res or {}).get("id"))
        return self._order(res, leg="exit") if res else {"symbol": symbol, "status": "flat"}

    def close_all(self) -> list:
        res = self._delete("/v2/positions?cancel_orders=true")
        self.log("close_all")
        return res if isinstance(res, list) else []

    def fills(self) -> list:
        """Filled orders, newest last — the autopilot matches them to its plans by client_order_id."""
        out = [o for o in self.orders() if o.get("status") == "filled"]
        return sorted(out, key=lambda o: o.get("filled_at") or "")
