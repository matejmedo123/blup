#!/usr/bin/env python3
"""Arbitrage Gap Monitor — how big is the price gap between venues, and is anything left after costs?

Meme coins: the same token across its DEX pools (DexScreener). Crypto: the same
coin across exchanges (Binance, Coinbase, Kraken), with USDT converted to USD.
For every buy-here/sell-there route it subtracts both legs' fees, slippage at
your size and network costs. It never trades — on free, delayed data any gap
that survives costs has almost certainly been closed already by MEV bots that
react in milliseconds. It is a learning tool, not a signal.

Examples:
  python3 arb.py SOL:<mint> --size-usd 500
  python3 arb.py BTCUSDT ETHUSDT --size-usd 2000
  python3 arb.py --from-setups --asset meme
"""
from __future__ import annotations

import os
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, html, http, market_clock, state, symbols, trade_sim  # noqa: E402
from shared.sources import binance, coinbase, dexscreener, kraken  # noqa: E402

# Pool fees by DEX (percent per swap). Many DEXs run several fee tiers — these are typical
# defaults, so the result is an estimate; check the pool's real tier before believing a gap.
DEX_FEE_PCT = {"raydium": 0.25, "orca": 0.30, "meteora": 0.25, "pumpswap": 0.25, "pumpfun": 1.0,
               "lifinity": 0.30, "phoenix": 0.05, "uniswap": 0.30, "aerodrome": 0.30, "pancakeswap": 0.25,
               "sushiswap": 0.30, "baseswap": 0.25, "camelot": 0.30}
DEFAULT_DEX_FEE_PCT = 0.30
# Rough cost of one swap transaction in USD (priority fees / gas swing a lot).
NETWORK_COST_USD = {"solana": 0.01, "base": 0.05, "bsc": 0.10, "ethereum": 5.0}
# Retail taker fees in percent (your tier may be lower).
CEX_TAKER_PCT = {"Binance": 0.10, "Coinbase": 0.60, "Kraken": 0.40}
CEX_SLIPPAGE_PCT = 0.02
MAX_SLIPPAGE_PCT = 50.0  # beyond this a leg is simply untradeable at the chosen size

REALITY = ("Real arbitrage is a millisecond race won by bots that sit next to the exchange or validator "
           "(on Solana: MEV searchers with Jito bundles). Free public APIs lag by seconds to minutes, so a gap "
           "you can see here is almost always gone before anyone could act. Stories of tiny stakes turned into "
           "fortunes by \"arbitrage bots\" are survivorship bias at best — and \"arbitrage bot\" offers that ask "
           "for your private key or a deposit are a common scam.")


def build_parser():
    p = cli.parser("arb.py", __doc__)
    p.add_argument("symbols", nargs="*", help="meme coin (SOL:<mint>, base:0x…) or crypto symbol (BTCUSDT)")
    p.add_argument("--size-usd", type=float, help="trade size per leg (default: meme = max position %% of "
                                                   "account, crypto = $1,000)")
    p.add_argument("--from-setups", action="store_true", help="check every symbol in trader/setups.json")
    return p


def _venue(name, price, fee_pct, slip_pct, extra_cost_pct=0.0, liquidity=None, stale=False, note="", url=""):
    return {"venue": name, "price": price, "fee_pct": fee_pct, "slippage_pct": slip_pct,
            "network_pct": extra_cost_pct, "liquidity_usd": liquidity, "stale": stale, "note": note, "url": url,
            "too_thin": False}


def meme_venues(sym, size_usd):
    resolved, best, pairs, warnings = data.resolve_meme(sym)
    pools = [p for p in pairs if p.get("price_usd")]
    venues = []
    net_cost = NETWORK_COST_USD.get(resolved.chain, 0.05)
    for p in sorted(pools, key=lambda p: -(p.get("liquidity_usd") or 0)):
        slip = trade_sim.estimate_slippage_pct(size_usd, p.get("liquidity_usd"))
        trades_5m = p["txns"]["m5"]["buys"] + p["txns"]["m5"]["sells"]
        stale = trades_5m == 0
        note = "no trades in the last 5 min — its price may be stale" if stale else "%d trades in 5 min" % trades_5m
        v = _venue("%s %s…%s" % (p["dex"], p["pair_address"][:4], p["pair_address"][-4:]),
                   p["price_usd"], DEX_FEE_PCT.get(p["dex"].lower(), DEFAULT_DEX_FEE_PCT),
                   slip if slip is not None else MAX_SLIPPAGE_PCT, 100.0 * net_cost / size_usd,
                   p.get("liquidity_usd"), stale, note, p.get("url"))
        if v["slippage_pct"] >= MAX_SLIPPAGE_PCT:
            # the linear impact estimate explodes once the trade is bigger than the pool — say so instead
            v["slippage_pct"] = MAX_SLIPPAGE_PCT
            v["too_thin"] = True
            v["note"] = "pool too thin for %s — %s" % (fmt.money(size_usd, decimals=0), note)
        venues.append(v)
    return resolved, venues, warnings


def _usdt_usd():
    try:
        return kraken.ticker("USDTUSD")["price"], ""
    except (http.SourceError, KeyError, ValueError):
        return 1.0, "USDT/USD rate unavailable — assumed 1.0000"


def crypto_venues(sym, size_usd):
    warnings = []
    usdt, note = _usdt_usd()
    if note:
        warnings.append(note)
    venues = []
    quote_usdt = sym.binance.endswith("USDT")
    for name, fn, in_usdt in (("Binance", lambda: binance.ticker_24h(sym.binance), quote_usdt),
                              ("Coinbase", lambda: coinbase.ticker(sym.coinbase), False),
                              ("Kraken", lambda: kraken.ticker(sym.kraken), sym.kraken.endswith("USDT"))):
        try:
            q = fn()
        except (http.SourceError, KeyError, ValueError) as exc:
            warnings.append("%s: %s" % (name, exc))
            continue
        price = q["price"] * (usdt if in_usdt else 1.0)
        venues.append(_venue(name, price, CEX_TAKER_PCT[name], CEX_SLIPPAGE_PCT,
                             note="USDT price × %.4f" % usdt if in_usdt else "USD price"))
    return sym, venues, warnings


def routes(venues):
    out = []
    for buy in venues:
        for sell in venues:
            if buy is sell or not buy["price"] or sell["price"] <= buy["price"]:
                continue
            if buy.get("too_thin") or sell.get("too_thin"):
                continue
            gross = (sell["price"] / buy["price"] - 1) * 100
            costs = (buy["fee_pct"] + sell["fee_pct"] + buy["slippage_pct"] + sell["slippage_pct"]
                     + buy["network_pct"] + sell["network_pct"])
            out.append({"buy": buy["venue"], "sell": sell["venue"], "gross_pct": gross, "costs_pct": costs,
                        "net_pct": gross - costs, "stale_leg": buy["stale"] or sell["stale"],
                        "fees_pct": buy["fee_pct"] + sell["fee_pct"],
                        "slippage_pct": buy["slippage_pct"] + sell["slippage_pct"],
                        "network_pct": buy["network_pct"] + sell["network_pct"]})
    return sorted(out, key=lambda r: -r["net_pct"])


def verdict(best, n_venues, asset):
    """One label + one plain sentence. Deliberately never says "opportunity"."""
    if n_venues < 2:
        return "only one venue", "Only one %s found — nothing to compare." % ("pool" if asset == "meme" else "venue")
    if best is None:
        return "no tradeable gap", ("No route left once pools too thin for this size are dropped — any visible gap "
                                    "sits in a pool you could not trade without moving the price massively.")
    if best["net_pct"] <= 0:
        return "no edge after costs", ("Biggest gap %s, but costs eat it: %s → net %s."
                                       % (fmt.pct(best["gross_pct"], 2, True), fmt.pct(best["costs_pct"], 2),
                                          fmt.pct(best["net_pct"], 2, True)))
    if best["stale_leg"]:
        return "paper gap on a stale quote", ("The route shows %s net, but one leg has not traded for 5+ minutes — "
                                              "its price is probably stale." % fmt.pct(best["net_pct"], 2, True))
    extra = (" Moving the coins between exchanges also takes minutes to hours and costs a withdrawal fee "
             "(this assumes you already hold inventory on both sides)." if asset == "crypto" else "")
    return "gap above estimated costs", ("On delayed data the best route shows %s net after costs. Expect it to be "
                                         "gone before a human — or this tool — could act.%s"
                                         % (fmt.pct(best["net_pct"], 2, True), extra))


def check(raw, size_usd=None, cfg=None, limits=None, asset=None):
    cfg = cfg or {}
    sym = data.as_symbol(raw, asset)
    if sym.asset == "stock":
        raise ValueError("arbitrage gaps are a crypto / meme-coin thing — %s is a stock" % sym.display)
    if size_usd is None:
        if sym.asset == "meme":
            pct = float((limits or {}).get("meme", {}).get("max_position_pct", 2))
            size_usd = max(10.0, float(cfg.get("account_size", 25000)) * pct / 100.0)
        else:
            size_usd = 1000.0
    if sym.asset == "meme":
        sym, venues, warnings = meme_venues(sym, size_usd)
    else:
        sym, venues, warnings = crypto_venues(sym, size_usd)
    rts = routes(venues)
    best = rts[0] if rts else None
    label, sentence = verdict(best, len(venues), sym.asset)
    prices = [v["price"] for v in venues if v["price"]]
    spread = ((max(prices) / min(prices) - 1) * 100) if len(prices) >= 2 else 0.0
    return {"symbol": sym.display, "key": sym.key, "asset": sym.asset, "checked_at": market_clock.iso(market_clock.now_utc()),
            "size_usd": round(size_usd, 2), "venues": venues, "routes": rts, "best": best, "spread_pct": spread,
            "verdict": label, "summary": sentence, "reality_check": REALITY, "warnings": warnings,
            "assumptions": ["fees are typical default tiers", "slippage assumes a constant-product pool (DEX) "
                            "or %.2f%% (CEX)" % CEX_SLIPPAGE_PCT, "network cost per swap: %s" % ", ".join(
                                "%s $%s" % kv for kv in sorted(NETWORK_COST_USD.items())),
                            "quotes are free public snapshots and lag the market"]}


def text_for(res) -> str:
    n = len(res["venues"])
    noun = ("pool" if res["asset"] == "meme" else "venue") + ("" if n == 1 else "s")
    lines = ["%s — %d %s, size %s per leg" % (res["symbol"], n, noun, fmt.money(res["size_usd"], decimals=0))]
    for v in res["venues"]:
        liq = " · liquidity %s" % fmt.compact_usd(v["liquidity_usd"]) if v["liquidity_usd"] else ""
        lines.append("  %-24s %-14s fee %.2f%% · slippage %.2f%%%s · %s"
                     % (v["venue"], fmt.price(v["price"]), v["fee_pct"], v["slippage_pct"], liq, v["note"]))
    b = res["best"]
    if b:
        lines.append("  best route: buy %s → sell %s · gap %s − costs %s (fees %.2f%% + slippage %.2f%% + network %.2f%%)"
                     " = net %s" % (b["buy"], b["sell"], fmt.pct(b["gross_pct"], 2, True), fmt.pct(b["costs_pct"], 2),
                                    b["fees_pct"], b["slippage_pct"], b["network_pct"], fmt.pct(b["net_pct"], 2, True)))
    lines.append("  Verdict: %s. %s" % (res["verdict"].upper(), res["summary"]))
    for w in res["warnings"]:
        lines.append("  note: %s" % w)
    return "\n".join(lines)


def report(results, asset) -> str:
    body = [html.card("", "<p class='summary'>%s</p>" % html.esc(REALITY))]
    for res in results:
        rows = [[v["venue"], fmt.price(v["price"]), "%.2f%%" % v["fee_pct"], "%.2f%%" % v["slippage_pct"],
                 fmt.compact_usd(v["liquidity_usd"]) if v["liquidity_usd"] else "—", v["note"]] for v in res["venues"]]
        rrows = [[r["buy"], r["sell"], fmt.pct(r["gross_pct"], 2, True), fmt.pct(r["costs_pct"], 2),
                  html.Html("<b class='%s'>%s</b>" % ("good" if r["net_pct"] > 0 else "bad",
                                                      html.esc(fmt.pct(r["net_pct"], 2, True))))]
                 for r in res["routes"][:8]]
        inner = (html.tiles([("Venues", str(len(res["venues"]))), ("Widest spread", fmt.pct(res["spread_pct"], 2)),
                             ("Best net", fmt.pct(res["best"]["net_pct"], 2, True) if res["best"] else "n/a",
                              "good" if res["best"] and res["best"]["net_pct"] > 0 else "bad"),
                             ("Size per leg", fmt.money(res["size_usd"], decimals=0))])
                 + "<p><b>%s.</b> %s</p>" % (html.esc(res["verdict"].capitalize()), html.esc(res["summary"]))
                 + html.table(["Venue", "Price", "Fee", "Slippage", "Liquidity", "Note"], rows)
                 + ("<h3 style='margin-top:12px'>Routes (buy → sell)</h3>"
                    + html.table(["Buy", "Sell", "Gap", "Costs", "Net"], rrows) if rrows else ""))
        body.append(html.card(res["symbol"], inner))
    body.append(html.card("Assumptions", "<ul>%s</ul>" % "".join(
        "<li>%s</li>" % html.esc(a) for a in (results[0]["assumptions"] if results else []))))
    return html.page("Arbitrage gap monitor", "".join(body), "read-only · never trades · %s"
                     % market_clock.iso(market_clock.now_utc()), asset=asset)


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    raws = list(args.symbols)
    if args.from_setups:
        hits = (state.read_json("setups.json", {}) or {}).get("setups") or []
        for h in hits:
            if h.get("asset") in ("crypto", "meme") and (not args.asset or h["asset"] == args.asset):
                raws.append(h["symbol"])
    if not raws:
        cli.fail("give at least one crypto or meme-coin symbol (or --from-setups)")
    results, errors = [], []
    seen = set()
    for raw in raws:
        try:
            res = check(raw, args.size_usd, ctx.cfg, ctx.limits, args.asset)
        except (data.DataUnavailable, ValueError, symbols.SymbolError) as exc:
            errors.append("%s: %s" % (raw, exc))
            continue
        if res["key"] in seen:
            continue
        seen.add(res["key"])
        results.append(res)
        state.write_json("arb/%s.json" % res["key"], res)
        state.append_jsonl("arb_log.jsonl", {k: res[k] for k in ("checked_at", "key", "verdict", "spread_pct")})
    if not results:
        for e in errors:
            sys.stderr.write("trader: %s\n" % e)
        return cli.EXIT_DATA
    assets = sorted({r["asset"] for r in results})
    path = None
    if not args.no_html:
        path = html.write_report("arb-%s.html" % market_clock.now_utc().strftime("%Y%m%d-%H%M"), report(results, assets))
    text = "\n\n".join(text_for(r) for r in results)
    text += "\n\nReality check: " + REALITY + "\nThis monitor only watches — it never trades."
    if errors:
        text += "\n" + "\n".join("  skipped %s" % e for e in errors)
    if path:
        text += "\n" + cli.report_line(path)
    cli.emit(args, text, {"results": results, "errors": errors, "report": cli.rel(path)}, assets)
    cli.maybe_open(args, path)
    return 0


if __name__ == "__main__":
    cli.run(main)
