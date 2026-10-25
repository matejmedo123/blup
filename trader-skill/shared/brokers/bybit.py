"""Bybit EU spot (and spot margin) through the v5 API — the broker for crypto with leverage in the EU.

Bybit EU GmbH (Vienna) is MiCA-licensed for the EEA; its spot margin lends what the cash in the account does
not cover, at an hourly rate on the borrowed part only (the leverage study: that is the one kind of leverage
that pays — perpetual futures charge funding on the whole position). Paper is Bybit EU's Demo Trading
(api-demo.bybit.eu: the demo account of a bybit.eu login, the paper an EEA resident can get) or Bybit's global
testnet (testnet.bybit.com) — ``autopilot.bybit.paper_venue``; live is api.bybit.eu (``autopilot.bybit.host`` for
another Bybit entity).

Rules this adapter keeps whatever the autopilot asks:
* a sell never borrows (``isLeverage`` 0): selling more than is held fails instead of opening a short;
* a buy borrows only when leverage is allowed (config.leverage) — and Bybit itself is held to 2×;
* stops sit at the exchange as TP/SL orders (``orderFilter`` tpslOrder, market on trigger): the coins are set
  aside for the stop, and it fires when the price gets there, not when the bot next looks;
* a filled buy reports the coins received after Bybit's fee in the coin, so the stop never asks for more than
  the account holds.

Keys come from shared.secrets and travel only in request headers — never in logs, errors or state files. A
POST is never blindly retried: after a timeout or a 5xx the order is looked up by its client id first.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import math
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from .. import config, market_clock, secrets, state
from ..http import read_body
from .base import broker_symbol, Broker, BrokerError, order_dict

BASE = {"paper": "https://api-demo.bybit.eu", "live": "https://api.bybit.eu"}
KEYS = {"paper": ("BYBIT_DEMO_KEY", "BYBIT_DEMO_SECRET"), "live": ("BYBIT_LIVE_KEY", "BYBIT_LIVE_SECRET")}
# where paper trades: (REST host, key names, where the keys come from) — a fixed host each, never a setting: a
# paper host pointed at a live API would trade real money past the live opt-in
PAPER_VENUES = {
    "demo": (BASE["paper"], KEYS["paper"], "Bybit EU demo keys: bybit.eu → profile → Demo Trading → API"),
    "testnet": ("https://api-testnet.bybit.com", ("BYBIT_TESTNET_KEY", "BYBIT_TESTNET_SECRET"),
                "testnet keys: testnet.bybit.com → API"),
}
TIMEOUT = 15
RECV_WINDOW = "10000"
STABLES = ("USDC", "USDT", "USD", "EUR")
INFO_TTL = 6 * 3600
MAX_LEVERAGE = 2  # the account-wide spot margin leverage the adapter sets: never above LEVERAGE_HARD_CAP
LINK_MAX = 36     # Bybit's orderLinkId limit — longer client ids travel as a hash (see _link)
IDS_FILE = "broker/bybit_ids.json"
# replies that do not say no: the order may well be in the book (Bybit sends them with HTTP 200)
UNSURE_CODES = {"10000", "10016", "170007", "170032", "170035", "170146"}
LENDS = ("both", "utaOnly")  # marginTrading values a Unified account can borrow on
NO_COLLATERAL_SWITCH = ("USDT", "USDC")  # always collateral: Bybit refuses to switch them

# Bybit order status → the Alpaca-style statuses the autopilot reads
STATUS = {"New": "new", "Created": "new", "Untriggered": "new", "Active": "new", "PartiallyFilled": "partially_filled",
          "Triggered": "accepted", "Filled": "filled", "Cancelled": "canceled", "PartiallyFilledCanceled": "canceled",
          "Deactivated": "canceled", "Rejected": "rejected"}


def paper_venue(cfg: dict) -> str:
    """"demo" (Bybit EU) or "testnet": config autopilot.bybit.paper_venue, else demo — unless only testnet keys are set,
    as in a setup from before the demo venue."""
    want = str((((cfg or {}).get("autopilot") or {}).get("bybit") or {}).get("paper_venue") or "").strip().lower()
    if want in PAPER_VENUES:
        return want
    demo, testnet = PAPER_VENUES["demo"][1], PAPER_VENUES["testnet"][1]
    if not any(secrets.has(n) for n in demo) and any(secrets.has(n) for n in testnet):
        return "testnet"
    return "demo"


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _iso_ms(ms) -> str:
    try:
        return market_clock.iso(market_clock.from_ts(int(ms) / 1000.0))
    except (TypeError, ValueError):
        return None


def _decimals(step) -> int:
    step = float(step)
    return max(0, -int(math.floor(math.log10(step) + 1e-9))) if step > 0 else 8


def _fmt(x: float, step=None) -> str:
    """A number as Bybit wants it: on the step (rounded down for a quantity) and without float noise."""
    if step:
        nd = _decimals(step)
        return ("%." + str(nd) + "f") % (math.floor(float(x) / float(step) + 1e-9) * float(step))
    return ("%.10f" % float(x)).rstrip("0").rstrip(".")


def _fmt_price(x: float, tick=None) -> str:
    if tick:
        nd = _decimals(tick)
        return ("%." + str(nd) + "f") % (round(float(x) / float(tick)) * float(tick))
    return ("%.10f" % float(x)).rstrip("0").rstrip(".")


def _link(cid: str) -> str:
    """The orderLinkId for a client id: as is when it fits, else a stable hash of it (the same id → the same link,
    so a second send is still refused as a duplicate)."""
    if not cid:
        return None
    if len(cid) <= LINK_MAX and all(c.isalnum() or c in "-_" for c in cid):
        return cid
    return "t" + hashlib.sha256(cid.encode("utf-8")).hexdigest()[:31]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib would resend the key headers to wherever a redirect points — the API never redirects, so refuse."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "unexpected redirect refused", headers, fp)


_OPENER = urllib.request.build_opener(_NoRedirect)


class _Refused(Exception):
    """Bybit answered and said no (retCode ≠ 0): the request did not go through."""

    def __init__(self, code, msg):
        super().__init__("%s (code %s)" % (msg, code))
        self.code, self.msg = code, str(msg)


class BybitBroker(Broker):
    name = "bybit"

    def __init__(self, mode: str = "paper", cfg: dict = None):
        if config.is_offline():
            raise BrokerError("the Bybit broker does not run in offline mode — use the simulator")
        if mode not in BASE:
            raise BrokerError("unknown Bybit mode %r" % mode)
        self.mode = mode
        self.cfg = cfg or config.load_config()
        bcfg = ((self.cfg.get("autopilot") or {}).get("bybit") or {})
        if mode == "paper":
            self.venue = paper_venue(self.cfg)
            self.base, (key_name, secret_name), how = PAPER_VENUES[self.venue]
        else:
            self.venue = "live"
            key_name, secret_name = KEYS["live"]
            self.base, how = bcfg.get("host") or BASE["live"], "Bybit EU → Account → API, trading only, no withdrawals"
        missing = [n for n in (key_name, secret_name) if not secrets.has(n)]
        if missing:
            raise BrokerError("missing %s — set it in your environment or trader/secrets.env (%s)" % (
                " and ".join(missing), how))
        self._key_name, self._secret_name = key_name, secret_name
        self.quote = str(bcfg.get("quote") or "USDC").upper()
        self._info = {}       # "BTCUSDC" → lot and tick
        self._info_at = 0.0
        self._offset_ms = 0   # Bybit's clock minus ours, so a drifting PC clock is not refused
        self._synced = False
        self._prepared = False
        self.notes = []

    # -- transport ---------------------------------------------------------------------------------
    def _now_ms(self) -> int:
        return int(time.time() * 1000) + self._offset_ms

    def _clock_sync(self) -> None:
        if self._synced:
            return
        self._synced = True
        try:
            res = self._call("GET", "/v5/market/time", signed=False)
            server = int(res.get("timeNano") or 0) // 1_000_000 or int(res.get("timeSecond") or 0) * 1000
            if server:
                self._offset_ms = server - int(time.time() * 1000)
        except BrokerError:
            pass

    def _headers(self, payload: str) -> dict:
        ts = str(self._now_ms())
        key = secrets.get(self._key_name)
        sign = hmac.new(secrets.get(self._secret_name).encode("utf-8"),
                        (ts + key + RECV_WINDOW + payload).encode("utf-8"), hashlib.sha256).hexdigest()
        return {"X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-SIGN": sign, "X-BAPI-RECV-WINDOW": RECV_WINDOW,
                "Content-Type": "application/json", "Accept": "application/json",
                "User-Agent": "trader-skill/1.0 autopilot"}

    def _send(self, method: str, path: str, params: dict = None, signed: bool = True) -> dict:
        """One HTTP round trip → the parsed reply. Raises urllib errors and ConnectionError unchanged."""
        params = {k: v for k, v in (params or {}).items() if v is not None}
        if method == "GET":
            query = urllib.parse.urlencode(params, safe="%")  # Bybit's page cursor comes already encoded
            url = self.base + path + ("?" + query if query else "")
            body, payload = None, query
        else:
            payload = json.dumps(params, separators=(",", ":"))
            url, body = self.base + path, payload.encode("utf-8")
        headers = self._headers(payload) if signed else {"Accept": "application/json",
                                                          "User-Agent": "trader-skill/1.0 autopilot"}
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with _OPENER.open(req, timeout=TIMEOUT) as resp:
                raw = read_body(resp, TIMEOUT * 2)
            return json.loads(raw.decode("utf-8")) if raw.strip() else {}
        except (http.client.HTTPException, ValueError, EOFError) as exc:
            raise ConnectionError("unreadable reply from Bybit (%s)" % type(exc).__name__)

    def _call(self, method: str, path: str, params: dict = None, signed: bool = True, retries: int = 0,
              resync: bool = True):
        """The ``result`` of a call; retCode ≠ 0 → _Refused; transport trouble → BrokerError after retries."""
        delay = 1.0
        for attempt in range(retries + 1):
            try:
                rep = self._send(method, path, params, signed)
            except urllib.error.HTTPError as err:
                if err.code in (429, 500, 502, 503, 504) and attempt < retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                if err.code == 403:
                    raise BrokerError("Bybit %s %s refused (HTTP 403) — a blocked country or IP: Bybit EU is for "
                                      "EEA residents, and an API key bound to IPs only answers those" % (method, path))
                raise BrokerError("Bybit %s %s failed (HTTP %s)" % (method, path, err.code))
            except (urllib.error.URLError, socket.timeout, ConnectionError) as err:
                if attempt < retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise BrokerError("Bybit %s %s failed: %s" % (method, path, getattr(err, "reason", err)))
            code = rep.get("retCode")
            if code in (0, "0"):
                return rep.get("result") or {}
            if str(code) == "10002" and resync:  # our clock is off: measure Bybit's again, then once more
                self._synced = False
                self._clock_sync()
                return self._call(method, path, params, signed, retries, resync=False)
            if str(code) in ("10006", "10016", "10018") and attempt < retries:  # rate limit / busy
                time.sleep(delay)
                delay *= 2
                continue
            raise _Refused(code, rep.get("retMsg") or "refused")
        raise BrokerError("Bybit %s %s failed" % (method, path))

    def _get(self, path: str, params: dict = None, signed: bool = True) -> dict:
        self._clock_sync()
        try:
            return self._call("GET", path, params, signed=signed, retries=3)
        except _Refused as exc:
            raise BrokerError("Bybit GET %s refused: %s" % (path, exc))

    # -- client ids ----------------------------------------------------------------------------------
    def _ids(self) -> dict:
        try:
            return state.read_json(IDS_FILE, {}) or {}
        except ValueError:
            return {}

    def _remember(self, cid: str) -> str:
        link = _link(cid)
        if link and link != cid:
            ids = self._ids()
            if ids.get(link) != cid:
                ids[link] = cid
                if len(ids) > 5000:  # the oldest go first — a month of trading is a few hundred
                    ids = dict(list(ids.items())[-4000:])
                state.write_json(IDS_FILE, ids)
        return link

    # -- symbols -------------------------------------------------------------------------------------
    def _pair(self, symbol: str) -> str:
        """BTC/USD (the pack's name) → BTCUSDC (the configured quote)."""
        base = str(symbol).split("/", 1)[0].upper()
        for q in STABLES:
            if "/" not in symbol and base.endswith(q) and len(base) > len(q):
                base = base[: -len(q)]
                break
        return base + self.quote

    def book_symbol(self, raw, asset: str = None) -> str:
        """Bybit's positions read BTC/USD whatever the quote (USDC, USDT): the book must name them the same way, or
        a BTC/USDC trade would never find its position — no exits, no daily loss, a KILL that sells nothing."""
        name = broker_symbol(raw, asset)
        return name.split("/", 1)[0] + "/USD" if "/" in name else name

    def _pack(self, pair: str) -> str:
        pair = str(pair or "").upper()
        for q in (self.quote,) + STABLES:
            if pair.endswith(q) and len(pair) > len(q):
                return pair[: -len(q)] + "/USD"
        return pair

    def _instruments(self) -> dict:
        now = time.time()
        if self._info and now - self._info_at < INFO_TTL:
            return self._info
        rows = (self._get("/v5/market/instruments-info", {"category": "spot"}, signed=False).get("list") or [])
        info = {}
        for r in rows:
            if not isinstance(r, dict) or r.get("status") not in (None, "Trading"):
                continue
            lot, pf = r.get("lotSizeFilter") or {}, r.get("priceFilter") or {}
            info[str(r.get("symbol")).upper()] = {
                "base": str(r.get("baseCoin") or "").upper(), "quote": str(r.get("quoteCoin") or "").upper(),
                "step": _f(lot.get("basePrecision")), "min_amt": _f(lot.get("minOrderAmt")),
                "min_qty": _f(lot.get("minOrderQty")),
                "tick": _f(pf.get("tickSize")), "margin": str(r.get("marginTrading") or "none")}
        if info:
            self._info, self._info_at = info, now
        return self._info

    def _lot(self, symbol: str) -> dict:
        return self._instruments().get(self._pair(symbol)) or {}

    def tradable(self, asset: str):
        """The coins with a spot pair in the configured quote (with margin, only those Bybit lends on)."""
        if asset != "crypto":
            return set()  # Bybit is crypto only: no stock is ever sent here
        try:
            info = self._instruments()
        except BrokerError as exc:
            self.notes.append("Bybit instrument list unavailable: %s" % exc)
            return None
        lev = config.leverage(self.cfg, config.load_limits(), "crypto", self.name)[0]
        return {v["base"] for v in info.values() if v["quote"] == self.quote and (lev <= 1 or v["margin"] in LENDS)}

    def qty_step(self, symbol: str, asset: str) -> float:
        try:
            return float(self._lot(symbol).get("step") or 0)
        except BrokerError:
            return 0.0

    def min_order(self, symbol: str) -> dict:
        """Bybit's smallest order on the pair: {"qty": coins, "value": in the quote coin} (0 when unknown)."""
        try:
            lot = self._lot(symbol)
        except BrokerError:
            return {"qty": 0.0, "value": 0.0}
        return {"qty": float(lot.get("min_qty") or 0), "value": float(lot.get("min_amt") or 0)}

    def _qty(self, symbol: str, qty: float, price: float = None) -> str:
        lot = self._lot(symbol)
        step = lot.get("step")
        q = math.floor(float(qty) / step + 1e-9) * step if step else float(qty)
        if q <= 0:
            raise BrokerError("%s %s rounds to 0 at Bybit's step %s" % (qty, symbol, step))
        if lot.get("min_qty") and q < lot["min_qty"] - 1e-12:
            raise BrokerError("%s %s is below Bybit's minimum order of %s %s" % (
                _fmt(q), symbol, _fmt(lot["min_qty"]), symbol))
        if price and lot.get("min_amt") and q * float(price) < lot["min_amt"] - 1e-9:
            raise BrokerError("%s %s (%.2f %s) is below Bybit's minimum order of %s %s" % (
                _fmt(q), symbol, q * float(price), self.quote, lot["min_amt"], self.quote))
        return _fmt(q, step)

    # -- mapping -------------------------------------------------------------------------------------
    def _order(self, o: dict, ids: dict = None) -> dict:
        ids = self._ids() if ids is None else ids
        link = o.get("orderLinkId") or None
        pair = str(o.get("symbol") or "").upper()
        side = str(o.get("side") or "").lower()
        filled = _f(o.get("cumExecQty")) or 0.0
        base = (self._instruments().get(pair) or {}).get("base") if self._info else None
        base = base or self._pack(pair).split("/", 1)[0]
        fee = o.get("cumFeeDetail") or {}
        if side == "buy" and isinstance(fee, dict) and _f(fee.get(base)):
            filled = max(0.0, filled - float(fee[base]))  # the coins received, after Bybit's fee in the coin
        trig = _f(o.get("triggerPrice")) or None
        kind = str(o.get("orderType") or "").lower()
        if trig and side == "sell":  # a TP/SL or conditional sell: the bot's stops
            kind = "stop" if kind == "market" else "stop_limit"
        status = STATUS.get(str(o.get("orderStatus") or ""), str(o.get("orderStatus") or "").lower() or None)
        return order_dict(id=o.get("orderId"), client_order_id=ids.get(link, link), symbol=self._pack(pair),
                          asset="crypto", side=side, type=kind, qty=_f(o.get("qty")),
                          limit_price=_f(o.get("price")) or None, stop_price=trig, status=status,
                          filled_qty=filled, filled_avg_price=_f(o.get("avgPrice")) or None,
                          submitted_at=_iso_ms(o.get("createdTime")),
                          filled_at=_iso_ms(o.get("updatedTime")) if status == "filled" else None,
                          leg="stop" if kind.startswith("stop") else None, parent_id=None,
                          time_in_force=str(o.get("timeInForce") or "gtc").lower(),
                          updated_at=_iso_ms(o.get("updatedTime")))

    def _orders(self, path: str, params: dict) -> list:
        out, cursor, pages = [], None, 0
        while pages < 10:
            res = self._get(path, dict(params, cursor=cursor))
            out.extend(r for r in (res.get("list") or []) if isinstance(r, dict))
            cursor, pages = res.get("nextPageCursor") or None, pages + 1
            if not cursor:
                break
        return out

    # -- reads ---------------------------------------------------------------------------------------
    def _prices(self) -> dict:
        """Last spot price of every coin in USD, from the tickers — never from the wallet's usdValue, which is 0
        for a coin that is not collateral and whose basis (balance or net of loans) Bybit does not document."""
        rows = self._get("/v5/market/tickers", {"category": "spot"}, signed=False).get("list") or []
        last = {str(r.get("symbol") or "").upper(): _f(r.get("lastPrice")) for r in rows if isinstance(r, dict)}
        out = {"USDC": 1.0, "USDT": 1.0, "USD": 1.0}
        for q in [self.quote] + [x for x in ("USDC", "USDT", "USD") if x != self.quote]:  # the traded pair first
            for pair, px in last.items():
                if px and pair.endswith(q) and len(pair) > len(q):
                    out.setdefault(pair[: -len(q)], px)
        if "EUR" not in out and last.get("USDCEUR"):
            out["EUR"] = 1.0 / last["USDCEUR"]
        return out

    def _wallet(self) -> tuple:
        """(cash in USD — negative while a margin loan is open, {coin: net quantity held}, prices)."""
        res = self._get("/v5/account/wallet-balance", {"accountType": "UNIFIED"})
        acct = (res.get("list") or [{}])[0] or {}
        prices, cash, coins = self._prices(), 0.0, {}
        for c in acct.get("coin") or []:
            name = str(c.get("coin") or "").upper()
            if not name:
                continue
            # walletBalance − spotBorrow (Bybit: "Old walletBalance = New walletBalance − spotBorrow")
            net = (_f(c.get("walletBalance")) or 0.0) - (_f(c.get("spotBorrow")) or 0.0)
            if name in STABLES:
                rate = prices.get(name)
                if rate is None:
                    self.notes.append("no %s price on Bybit — that balance is left out of the cash" % name)
                    continue
                cash += net * rate
            elif net > 0:
                coins[name] = net
            elif net < 0:  # a loan in the coin itself (a margin short you made): owed, so it counts against equity
                if prices.get(name):
                    cash += net * prices[name]
                else:
                    self.notes.append("no %s price on Bybit — a %s %s debt is left out of the equity" % (
                        name, _fmt(-net), name))
        return cash, coins, prices

    def account(self) -> dict:
        cash, coins, prices = self._wallet()
        # equity priced by the bot the same way for every coin (cash plus what the coins are worth now)
        equity = cash + sum(q * (prices.get(c) or 0.0) for c, q in coins.items())
        lev = self._margin_leverage()
        return {"equity": equity, "cash": cash, "buying_power": cash + (lev - 1) * equity,
                "last_equity": None, "currency": "USD", "mode": self.mode, "status": "ACTIVE", "blocked": None,
                "crypto_ok": True, "daytrade_count": 0, "pattern_day_trader": False,
                "account_id": "bybit-demo" if self.venue == "demo" else "bybit-%s" % self.mode,
                "borrowed": max(0.0, -cash)}

    def _margin_leverage(self) -> float:
        st = None
        # Demo Trading lists the same "status and leverage" call under spot-margin-uta
        for path in ("/v5/spot-margin-trade/state", "/v5/spot-margin-uta/status"):
            try:
                st = self._get(path)
                break
            except BrokerError:
                continue
        if st is None:
            return 1.0
        if str(st.get("spotMarginMode")) != "1":
            return 1.0
        return min(float(_f(st.get("spotLeverage")) or 1.0), float(MAX_LEVERAGE))

    def positions(self) -> list:
        _, coins, prices = self._wallet()
        out = []
        for name, qty in sorted(coins.items()):
            last = prices.get(name)
            out.append({"symbol": name + "/USD", "asset": "crypto", "qty": qty, "avg_entry": None, "last": last,
                        "market_value": qty * last if last else None, "unrealized_pl": None, "opened_at": None})
        return out

    def open_orders(self) -> list:
        ids = self._ids()
        raw = self._orders("/v5/order/realtime", {"category": "spot", "openOnly": 0, "limit": 50})
        return [self._order(o, ids) for o in raw]

    def orders(self, since: str = None) -> list:
        """Open orders (stops included) plus Bybit's recent history — what fills and cancels the cycle reads."""
        ids = self._ids()
        live = self._orders("/v5/order/realtime", {"category": "spot", "openOnly": 0, "limit": 50})
        # the last 7 days (Bybit's default window): a startTime would read 7 days from it, not up to now
        hist = self._orders("/v5/order/history", {"category": "spot", "limit": 50})
        seen, out = set(), []
        for o in live + hist:
            if o.get("orderId") in seen:
                continue
            seen.add(o.get("orderId"))
            out.append(self._order(o, ids))
        return out

    def find_client(self, client_order_id: str):
        link = _link(client_order_id)
        for path in ("/v5/order/realtime", "/v5/order/history"):
            rows = self._get(path, {"category": "spot", "orderLinkId": link}).get("list") or []
            if rows:
                return self._order(rows[0])
        return None

    def lookup(self, order_id: str, strict: bool = False) -> list:
        """strict: a failed lookup raises — "not found" must mean Bybit said so, not that it did not answer."""
        for path in ("/v5/order/realtime", "/v5/order/history"):
            try:
                rows = self._get(path, {"category": "spot", "orderId": order_id}).get("list") or []
            except BrokerError:
                if strict:
                    raise
                continue
            if rows:
                return [self._order(rows[0])]
        return []

    def fills(self) -> list:
        out = [o for o in self.orders() if o.get("status") == "filled"]
        return sorted(out, key=lambda o: o.get("filled_at") or "")

    # -- writes --------------------------------------------------------------------------------------
    def _prepare_margin(self) -> None:
        """Margin on at 2× (never more), the quote coin as collateral, loans repaid automatically from sales."""
        if self._prepared:
            return
        self._prepared = True
        steps = [("/v5/spot-margin-trade/switch-mode", {"spotMarginMode": "1"}),
                 ("/v5/spot-margin-trade/set-leverage", {"leverage": str(MAX_LEVERAGE)}),
                 ("/v5/spot-margin-trade/set-auto-repay-mode", {"currency": self.quote, "autoRepayMode": "1"})]
        if self.quote not in NO_COLLATERAL_SWITCH:
            steps.insert(2, ("/v5/account/set-collateral-switch", {"coin": self.quote, "collateralSwitch": "ON"}))
        for path, body in steps:
            try:
                self._call("POST", path, body, retries=1)
            except (_Refused, BrokerError) as exc:
                # already set reads as an error at some endpoints; anything else the next order will show
                self.notes.append("Bybit %s: %s" % (path.rsplit("/", 1)[-1], exc))

    def _post_order(self, body: dict, cid: str = None) -> dict:
        """POST once — never twice. An unclear outcome (a timeout, a 5xx, a "maybe" reply, a duplicate id) is
        looked up by its client id; not found yet is "may or may not have been placed", for the next cycle to look
        up again — never a second order (placement is asynchronous, and a sale sent twice sells your coins)."""
        self._clock_sync()
        try:
            res = self._call("POST", "/v5/order/create", body)
        except _Refused as exc:
            low = exc.msg.lower()
            if "170359" == str(exc.code) or "not support leveraged" in low:
                raise BrokerError("Bybit offers no spot margin to this account (%s) — trade at 1× "
                                  "(profile --leverage 1) or switch margin on at Bybit" % exc)
            if not (str(exc.code) in UNSURE_CODES or "duplicate" in low or ("orderlinkid" in low and "exist" in low)):
                raise BrokerError("Bybit rejected the order: %s" % exc)
            failure = str(exc)
        except BrokerError as exc:
            failure = str(exc)
        else:
            found = self.lookup(res.get("orderId")) if res.get("orderId") else []
            # placement is asynchronous: a just-sent order may not be listed yet — then it reads as new
            return found[0] if found else order_dict(
                id=res.get("orderId"), client_order_id=cid, status="new", symbol=self._pack(body["symbol"]),
                asset="crypto", side=body["side"].lower(), type=body["orderType"].lower(), qty=_f(body.get("qty")),
                limit_price=_f(body.get("price")), stop_price=_f(body.get("triggerPrice")), filled_qty=0.0)
        if not cid:
            raise BrokerError("Bybit order may or may not have been placed (%s) and has no client id to check — "
                              "look in Bybit before doing anything else" % failure)
        for wait in (0.0, 1.0):
            time.sleep(wait)
            try:
                found = self.find_client(cid)
            except BrokerError as exc:
                raise BrokerError("Bybit order may or may not have been placed (%s; %s) — it is looked up again "
                                  "under %s" % (failure, exc, cid))
            if found:
                self.log("post_recovered", client_order_id=cid, order_id=found.get("id"))
                return found
        raise BrokerError("Bybit order may or may not have been placed (%s): nothing under %s yet — it is looked up "
                          "again, never sent twice" % (failure, cid))

    def place_entry(self, order: dict) -> dict:
        if order.get("asset") != "crypto":
            raise BrokerError("Bybit trades crypto only — %s %s is not sent" % (order.get("asset"), order.get("symbol")))
        sym, cid = order["symbol"], order.get("client_order_id")
        lot = self._lot(sym)
        if not lot:
            raise BrokerError("Bybit has no %s spot pair" % self._pair(sym))
        lev = float(order.get("leverage") or 1.0)
        borrow = lev > 1.0 + 1e-9 and config.leverage(self.cfg, config.load_limits(), "crypto", self.name,
                                                      sym.split("/", 1)[0])[0] > 1.0
        if borrow:
            if lot.get("margin") not in LENDS:
                raise BrokerError("Bybit does not lend on %s right now — not bought with leverage" % self._pair(sym))
            self._prepare_margin()
        body = {"category": "spot", "symbol": self._pair(sym), "side": "Buy", "orderType": "Limit",
                "qty": self._qty(sym, order["qty"], order["limit_price"]),
                "price": _fmt_price(order["limit_price"], lot.get("tick")), "timeInForce": "GTC",
                "orderLinkId": self._remember(cid) if cid else None, "isLeverage": 1 if borrow else 0}
        res = self._post_order(body, cid)
        self.log("place_entry", symbol=sym, pair=body["symbol"], qty=body["qty"], limit_price=body["price"],
                 client_order_id=cid, order_id=res.get("id"), status=res.get("status"), margin=bool(borrow))
        return dict(res, leg="entry")

    def place_stop(self, symbol, qty, stop_price, client_order_id=None, asset="crypto", limit_price=None) -> dict:
        """A stop at the exchange: Bybit sets the coins aside and sells at market the moment the price trades at
        the stop (with limit_price: a limit sell at that price instead)."""
        lot = self._lot(symbol)
        pair = self._pair(symbol)
        rows = self._get("/v5/market/tickers", {"category": "spot", "symbol": pair}, signed=False).get("list") or []
        last = next((_f(r.get("lastPrice")) for r in rows if isinstance(r, dict)
                     and str(r.get("symbol") or "").upper() == pair), None)
        if not last:
            raise BrokerError("no %s price from Bybit — a stop is not placed blind" % pair)
        if float(_fmt_price(stop_price, lot.get("tick"))) >= last:
            # a spot TP/SL has no direction: at or above the price it would act as a take-profit, or at once —
            # the bot's own stop check sells instead
            raise BrokerError("stop %s is not below the price %s — not placed at Bybit; the bot sells itself" % (
                _fmt_price(stop_price, lot.get("tick")), _fmt_price(last, lot.get("tick"))))
        body = {"category": "spot", "symbol": self._pair(symbol), "side": "Sell",
                "orderType": "Limit" if limit_price is not None else "Market",
                "qty": self._qty(symbol, qty), "triggerPrice": _fmt_price(stop_price, lot.get("tick")),
                "orderFilter": "tpslOrder", "orderLinkId": self._remember(client_order_id) if client_order_id else None,
                "isLeverage": 0}
        if limit_price is not None:
            body.update(price=_fmt_price(limit_price, lot.get("tick")), timeInForce="GTC")
        else:
            body["marketUnit"] = "baseCoin"
        res = self._post_order(body, client_order_id)
        self.log("place_stop", symbol=symbol, qty=body["qty"], stop_price=body["triggerPrice"], order_id=res.get("id"))
        return dict(res, leg="stop", type="stop" if limit_price is None else "stop_limit",
                    stop_price=_f(body["triggerPrice"]))

    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="crypto") -> dict:
        lot = self._lot(symbol)
        body = {"category": "spot", "symbol": self._pair(symbol), "side": "Sell",
                "orderType": "Limit" if kind == "limit" else "Market", "qty": self._qty(symbol, qty),
                "orderLinkId": self._remember(client_order_id) if client_order_id else None,
                "isLeverage": 0}  # a sale never borrows: more than is held fails, it never opens a short
        if kind == "limit":
            body.update(price=_fmt_price(limit_price, lot.get("tick")), timeInForce="GTC")
        else:
            body["marketUnit"] = "baseCoin"
        res = self._post_order(body, client_order_id)
        self.log("place_exit", symbol=symbol, qty=body["qty"], kind=kind, order_id=res.get("id"))
        return dict(res, leg="exit")

    def cancel(self, order_id: str) -> dict:
        found = self.lookup(order_id, strict=True)  # no answer is an error, never "it is gone"
        if not found:
            return {"id": order_id, "status": "canceled"}  # Bybit has no such order — like Alpaca's 404
        o = found[0]
        if o.get("status") not in ("new", "partially_filled", "accepted"):
            return {"id": order_id, "status": o.get("status")}
        body = {"category": "spot", "symbol": self._pair(o["symbol"]), "orderId": order_id}
        if o.get("stop_price"):
            body["orderFilter"] = "tpslOrder"
        try:
            self._call("POST", "/v5/order/cancel", body)
        except _Refused as exc:
            if str(exc.code) == "170139" or "has been filled" in exc.msg.lower():
                raise BrokerError("Bybit cancel refused: the order has been filled (%s)" % exc)
            done = str(exc.code) in ("170142", "170190", "110001") or any(
                w in exc.msg.lower() for w in ("not exist", "too late", "has been cancel", "has been finished"))
            if not done:
                raise BrokerError("Bybit cancel refused: %s" % exc)
        self.log("cancel", order_id=order_id)
        return {"id": order_id, "status": "canceled"}

    def close_position(self, symbol: str) -> dict:
        """Sell the coin's whole balance at market — called only when all of it is the bot's."""
        held = next((p for p in self.positions() if p["symbol"] == self._pack(self._pair(symbol))), None)
        if not held:
            return {"symbol": symbol, "status": "flat"}
        step = self.qty_step(symbol, "crypto")
        if step and held["qty"] < step:
            return {"symbol": symbol, "status": "flat"}  # dust below Bybit's step cannot be sold
        res = self.place_exit(symbol, held["qty"], "market")
        self.log("close_position", symbol=symbol, order_id=res.get("id"))
        return res
