#!/usr/bin/env python3
"""News Monitor — only what is new since the last check, newest first, with why it matters.

Stocks: Yahoo Finance + Google News headlines per ticker and SEC 8-K filings
(earnings, mergers, guidance, CEO changes). Crypto: CoinDesk, Cointelegraph
and The Block (listings, delistings, ETF flows, hacks, unlocks, regulation,
macro). Meme coins: DexScreener profile updates, boosts, new social links and
sudden liquidity changes.

Examples:
  python3 news.py --asset stock --symbols TSLA,NVDA
  python3 news.py --asset crypto
  python3 news.py --asset meme --symbols SOL:<mint>
  python3 news.py --asset stock --symbols TSLA --offline --now 2026-10-20T14:15:00Z
"""
from __future__ import annotations

import hashlib
import os
import re
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, config, data, html, http, market_clock, state, symbols  # noqa: E402
from shared.sources import dexscreener, rss, sec, yahoo  # noqa: E402

MAX_SEEN = 600
FIRST_RUN_HOURS = 24

# (tag, pattern, importance, why it matters)
STOCK_RULES = [
    ("merger", r"\bmerg(er|ers|e|es|ing)\b|acqui(re|res|red|ring|sition)|takeover|buyout|tie-up|combination"
               r"|\bdeal (talks|chatter)\b", 3, "expect a volatile open and possible halts"),
    ("earnings", r"earnings|\bresults\b|\bq[1-4]\b|quarterly|\beps\b|revenue|profit|deliveries", 2,
     "earnings move the stock in gaps — size down"),
    ("guidance", r"guidance|outlook|forecast|reg(ulation)? fd", 2, "guidance changes reset expectations"),
    ("management", r"\bceo\b|\bcfo\b|chief executive|steps down|resign|appoint|depart", 2,
     "leadership changes can reprice the stock fast"),
    ("offering", r"offering|dilut|share sale|convertible|\batm\b program", 3, "new shares usually pressure the price"),
    ("fda", r"\bfda\b|approval|clinical|trial data|phase [123]", 3, "binary event — huge gap risk"),
    ("analyst", r"upgrade|downgrade|price target|initiat(es|ed) coverage|\brating\b", 1,
     "analyst calls move price for a session or two"),
    ("legal", r"lawsuit|probe|investigation|subpoena|\bsec charges\b|recall|antitrust", 2,
     "legal headlines add downside risk"),
    ("options", r"options traders|implied (move|volatility)|unusual options", 1, "options market expects a big move"),
]
CRYPTO_RULES = [
    ("delisting", r"delist", 3, "delistings drain liquidity and dump price"),
    ("listing", r"(?<!de)\blist(s|ing|ed)?\b|\blaunch(es)? (perpetual|futures|spot)", 2,
     "new listings bring fresh demand — often front-run"),
    ("etf_flows", r"\betfs?\b|inflow|outflow", 2, "ETF flows drive spot demand"),
    ("hack", r"hack|exploit|drain(ed)?|stolen|breach|attacker", 3, "hacks trigger fast sell-offs and contagion"),
    ("token_unlock", r"unlock|vesting|enters circulation", 2, "unlocked supply often gets sold"),
    ("regulation", r"\bsec\b|\bcftc\b|regulat|\bmica\b|lawsuit|court|\bban\b|approv", 2,
     "regulatory news reprices the whole sector"),
    ("macro", r"\bfed\b|fomc|\bcpi\b|inflation|rate cut|rate hike|jobs report|minutes|treasury", 2,
     "macro headlines move all risk assets"),
    ("liquidation", r"liquidat", 2, "liquidation cascades exaggerate moves"),
]
MARKET_TAGS = {"macro", "regulation", "etf_flows", "hack", "delisting"}
COIN_WORDS = {
    "BTC": ["bitcoin", "btc"], "ETH": ["ethereum", "ether", "eth"], "SOL": ["solana", "sol"],
    "XRP": ["xrp", "ripple"], "DOGE": ["dogecoin", "doge"], "BNB": ["bnb"], "ADA": ["cardano", "ada"],
    "AVAX": ["avalanche", "avax"], "LINK": ["chainlink", "link"], "DOT": ["polkadot"], "LTC": ["litecoin", "ltc"],
    "ARB": ["arbitrum", "arb"], "OP": ["optimism"], "SUI": ["sui"], "TON": ["toncoin", "ton"],
    "PEPE": ["pepe"], "SHIB": ["shiba", "shib"], "TRX": ["tron", "trx"], "NEAR": ["near protocol"],
}
WHY_COMBO = {("earnings", "merger"): "expect a volatile open", ("merger", "earnings"): "expect a volatile open"}


# --- classification ---------------------------------------------------------------------------

def classify(text: str, rules) -> tuple:
    t = (text or "").lower()
    found = []
    for tag, pattern, imp, why in rules:
        if re.search(pattern, t):
            found.append((tag, imp, why))
    if not found:
        return [], "", 1
    found.sort(key=lambda x: -x[1])
    tags = [f[0] for f in found]
    imp = min(3, found[0][1] + (1 if len(found) >= 2 and found[1][1] >= 2 else 0))
    why = WHY_COMBO.get(tuple(tags[:2])) or found[0][2]
    return tags, (" + ".join(tags[:2]) + ": " + why), imp


def norm_title(title: str) -> str:
    """'Tesla … earnings - Reuters' and 'Tesla … earnings' are the same story."""
    t = re.sub(r"\s+[-–|]\s+[^-–|]{2,40}$", "", title or "")
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def _publisher(title: str):
    m = re.search(r"\s+-\s+([^-]{2,40})$", title or "")
    return (title[: m.start()].strip(), m.group(1).strip()) if m else (title, "")


def _item(symbol, source, title, url, published, tags, why, importance, extra=None) -> dict:
    iid = hashlib.sha1(("%s|%s|%s" % (symbol, source, norm_title(title))).encode("utf-8")).hexdigest()[:16]
    d = {"id": iid, "symbol": symbol, "source": source, "title": title, "url": html.safe_url(url),
         "published": published, "tags": tags, "why": why, "importance": importance}
    if extra:
        d.update(extra)
    return d


# --- fetchers ----------------------------------------------------------------------------------

def stock_items(ticker: str, cfg: dict, notes: list) -> list:
    items, seen_titles = [], {}
    feeds = (("Yahoo Finance", yahoo.news_rss_url(ticker)), ("Google News", rss.google_news_url("%s stock" % ticker)))
    for source, url in feeds:
        try:
            raw = rss.fetch(url, source)
        except (http.SourceError, ValueError) as exc:
            notes.append("%s %s: %s" % (ticker, source, exc))
            continue
        for r in raw:
            title, pub = r["title"], source
            if source == "Google News":
                title, publisher = _publisher(title)
                pub = "%s (via Google News)" % publisher if publisher else source
            key = norm_title(title)
            if key in seen_titles:
                seen_titles[key].setdefault("also", []).append(pub)
                continue
            tags, why, imp = classify(title + " " + r.get("summary", ""), STOCK_RULES)
            it = _item(ticker, pub, title, r["url"], r["published"], tags, why or "headline mentions %s" % ticker,
                       imp)
            seen_titles[key] = it
            items.append(it)
    if config.is_offline() or config.sec_user_agent(cfg):
        try:
            cik = sec.cik_for(ticker, cfg)
            if cik:
                for f in sec.filings_8k(cik, cfg):
                    meanings = sec.classify_items(f.get("items_desc", ""))
                    tags = ["8-K"] + [m[0] for m in meanings]
                    desc = "; ".join(m[1] for m in meanings) or (f.get("items_desc") or "current report")
                    imp = 3 if any(m[0] in ("earnings", "merger", "deal", "bankruptcy", "management", "restatement",
                                            "delisting", "dilution") for m in meanings) else 2
                    why = "%s: %s" % (" + ".join(tags[1:3]) or "8-K", "official filing — read it before trading")
                    items.append(_item(ticker, "SEC EDGAR", "8-K filed: %s" % desc, f["url"], f["published"], tags,
                                       why, imp, {"items_desc": f.get("items_desc", "")}))
        except (http.SourceError, ValueError) as exc:
            notes.append("%s SEC: %s" % (ticker, exc))
    else:
        notes.append("SEC 8-K filings skipped — set sec_user_agent (\"Your Name you@domain.com\") in "
                     "trader/config.json or SEC_USER_AGENT")
    return items


def _coin_mentions(text: str, coins) -> list:
    t = " %s " % (text or "").lower()
    out = []
    for c in coins:
        for w in COIN_WORDS.get(c, [c.lower()]):
            if re.search(r"(?<![a-z0-9])%s(?![a-z0-9])" % re.escape(w), t):
                out.append(c)
                break
    return out


def crypto_items(coins, notes: list) -> list:
    items, seen = [], set()
    for source, url in rss.CRYPTO_FEEDS.items():
        try:
            raw = rss.fetch(url, source)
        except (http.SourceError, ValueError) as exc:
            notes.append("%s: %s" % (source, exc))
            continue
        for r in raw:
            key = norm_title(r["title"])
            if key in seen:
                continue
            seen.add(key)
            text = r["title"] + " " + r.get("summary", "")
            tags, why, imp = classify(text, CRYPTO_RULES)
            mentioned = _coin_mentions(text, coins)
            if mentioned:
                for c in mentioned:
                    items.append(_item(c, source, r["title"], r["url"], r["published"], tags,
                                       why or "headline mentions %s" % c, imp))
            elif set(tags) & MARKET_TAGS:
                items.append(_item("market", source, r["title"], r["url"], r["published"], ["market"] + tags,
                                   why, max(1, imp - 1)))
    return items


def meme_items(tokens, snapshots: dict, now, notes: list) -> list:
    items = []
    lists = {}
    for name, fn in (("profiles", dexscreener.profiles_latest), ("boosts_top", dexscreener.boosts_top),
                     ("boosts_latest", dexscreener.boosts_latest)):
        try:
            lists[name] = fn()
        except http.SourceError as exc:
            lists[name] = []
            notes.append("DexScreener %s: %s" % (name, exc))
    stamp = market_clock.iso(now)
    for raw in tokens:
        try:
            pair = data.get_pair(raw)
        except data.DataUnavailable as exc:
            notes.append(str(exc))
            continue
        sym = symbols.from_dict(pair["symbol"])
        key = sym.key
        label = pair["base"]["symbol"] or sym.display
        links = sorted(set([w for w in pair.get("websites") or []] + [s["url"] for s in pair.get("socials") or []
                                                                         if s.get("url")]))
        snap = {"liquidity_usd": pair.get("liquidity_usd"), "links": links, "boosts": pair.get("boosts_active") or 0,
                "price_usd": pair.get("price_usd"), "at": stamp}
        prev = snapshots.get(key)
        sym_str = "%s:%s" % (sym.chain, sym.address)
        in_profiles = [p for p in lists["profiles"] if data.dexscreener_same(p["address"], sym.address)]
        if prev is None:
            if in_profiles:
                items.append(_item(sym_str, "DexScreener", "%s published/updated its DexScreener token profile" % label,
                                   pair.get("url"), stamp, ["profile_update"],
                                   "profile_update: team paid for a listing page — attention, not quality", 1,
                                   {"display": label}))
            if snap["boosts"]:
                items.append(_item(sym_str, "DexScreener", "%s is boosted on DexScreener (%d active boosts)"
                                   % (label, snap["boosts"]), pair.get("url"), stamp, ["boost"],
                                   "boost: paid promotion — expect hype-driven volume, not a quality signal", 1,
                                   {"display": label}))
        else:
            old_liq, new_liq = prev.get("liquidity_usd"), snap["liquidity_usd"]
            if old_liq and new_liq is not None:
                change = (new_liq / old_liq - 1) * 100
                if abs(change) >= 20:
                    drop = change < 0
                    items.append(_item(sym_str, "DexScreener", "%s liquidity %s %.0f%% ($%s → $%s)" % (
                        label, "dropped" if drop else "jumped", abs(change), "{:,.0f}".format(old_liq),
                        "{:,.0f}".format(new_liq)), pair.get("url"), stamp, ["liquidity_change"],
                        "liquidity_change: %s" % ("liquidity is leaving — possible rug in progress, check now"
                                                  if drop else "new liquidity — moves get easier, so do exits"),
                        3 if drop else 2, {"display": label, "change_pct": round(change, 1)}))
            new_links = [l for l in links if l not in (prev.get("links") or [])]
            if new_links:
                items.append(_item(sym_str, "DexScreener", "%s added social links: %s" % (label, ", ".join(new_links)),
                                   pair.get("url"), stamp, ["new_social"],
                                   "new_social: fresh marketing push — verify the accounts are real", 1,
                                   {"display": label}))
            if snap["boosts"] != (prev.get("boosts") or 0):
                items.append(_item(sym_str, "DexScreener", "%s boosts changed %d → %d" % (
                    label, prev.get("boosts") or 0, snap["boosts"]), pair.get("url"), stamp, ["boost"],
                    "boost: paid promotion changed — hype can fade as fast as it came", 1, {"display": label}))
        snapshots[key] = snap
    return items


# --- seen-tracking -----------------------------------------------------------------------------

def _scope(asset: str, symbol: str) -> str:
    return "%s:%s" % (asset, symbol)


def filter_new(items, seen: dict, asset: str, now, since=None, show_all=False) -> list:
    """Keep unseen items, mark everything fetched as seen; first run per symbol = last 24 h."""
    now_ts = now.timestamp()
    out = []
    for it in items:
        pub = it.get("published")
        pub_ts = market_clock.parse_iso(pub).timestamp() if pub else None
        if pub_ts is not None and pub_ts > now_ts:
            continue  # after the pinned clock — not "news" yet
        scope = seen.setdefault(_scope(asset, it["symbol"]), {"ids": [], "last_check": None})
        first = scope["last_check"] is None
        cutoff = market_clock.parse_iso(since).timestamp() if since else (
            now_ts - FIRST_RUN_HOURS * 3600 if first else None)
        is_new = it["id"] not in scope["ids"]
        if (is_new or show_all) and (cutoff is None or pub_ts is None or pub_ts >= cutoff):
            out.append(it)
        if is_new:
            scope["ids"].append(it["id"])
            scope["ids"] = scope["ids"][-MAX_SEEN:]
    out.sort(key=lambda it: it.get("published") or "", reverse=True)
    return out


def _et(t, with_date: bool = False) -> str:
    """24-hour New York time — shared fmt_et is 12-hour without a.m./p.m."""
    e = market_clock.to_et(t)
    hm = "%d:%02d" % (e.hour, e.minute)
    return ("%s %d %s" % (e.strftime("%b"), e.day, hm)) if with_date else hm


def _when(it, asset) -> str:
    if not it.get("published"):
        return "     ?"
    t = market_clock.parse_iso(it["published"])
    if asset == "stock":
        return "%s ET" % _et(t, with_date=market_clock.et_date(t) != market_clock.et_date(market_clock.now_utc()))
    return t.strftime("%H:%M UTC") if t.date() == market_clock.now_utc().date() else t.strftime("%b %d %H:%M UTC")


def render(asset, groups, new, notes, last_checks) -> str:
    lines = ["News Monitor · %s · checked %s" % ({"stock": "stocks", "crypto": "crypto", "meme": "meme coins"}[asset],
                                                 (_et(market_clock.now_utc(), True) + " ET")
                                                 if asset == "stock" else market_clock.fmt_utc(market_clock.now_utc(),
                                                                                               True))]
    for sym in groups:
        mine = [it for it in new if it["symbol"] == sym]
        label = mine[0].get("display", sym) if mine else sym
        if not mine:
            prev = last_checks.get(sym)
            lines.append("%s — no new items%s" % (label, (" since %s" % _when({"published": prev}, asset))
                                                   if prev else ""))
            continue
        lines.append("%s — %d new since last check" % (label, len(mine)))
        for it in mine:
            mark = {3: "[!!!]", 2: "[!! ]"}.get(it["importance"], "[!  ]")
            also = (" (also: %s)" % ", ".join(it["also"])) if it.get("also") else ""
            lines.append("  %s %s  %s — %s%s — %s" % (mark, _when(it, asset), it["title"], it["source"], also,
                                                      it["why"]))
    for n in notes:
        lines.append("  note: " + n)
    return "\n".join(lines)


def write_report(asset, new, now):
    rows = []
    for it in new:
        rows.append([{3: "!!!", 2: "!!", 1: "!"}.get(it["importance"], ""), _when(it, asset), it["symbol"] if
                     it["symbol"] != "market" else "market", html.link(it["url"], it["title"]) if it.get("url")
                     else it["title"], it["source"], it["why"]])
    body = html.card("New since last check", html.table(["", "When", "Symbol", "Headline", "Source", "Why it matters"],
                                                        rows) if rows else "<p class='muted'>Nothing new.</p>")
    page = html.page("News Monitor · %s" % asset, body, subtitle="checked %s" % market_clock.iso(now), asset=asset)
    day = (market_clock.et_date(now) if asset == "stock" else now.date()).strftime("%Y%m%d")
    return html.write_report("news-%s-%s.html" % (asset, day), page)


def build_parser():
    p = cli.parser("news.py", __doc__)
    p.add_argument("--symbols", help="comma-separated symbols (default: the watchlist in trader/config.json)")
    p.add_argument("--all", action="store_true", help="also show items you have already seen")
    p.add_argument("--since", metavar="ISO", help="only items published after this time")
    p.add_argument("--limit", type=int, default=12, help="max items per symbol (default 12)")
    return p


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    asset = args.asset or "stock"
    now = market_clock.now_utc()
    seen_doc = state.read_json("news_seen.json", {}) or {}
    scopes = seen_doc.setdefault("scopes", {})
    snapshots = seen_doc.setdefault("meme_snapshots", {})
    notes = []
    raw_syms = [s.strip() for s in (args.symbols or "").split(",") if s.strip()]
    if asset == "stock":
        tickers = [s.upper() for s in raw_syms] or list(ctx.cfg["watchlists"].get("stocks") or [])
        groups = [symbols.parse(t, asset="stock").key for t in tickers]
        items = []
        for t in groups:
            items.extend(stock_items(t, ctx.cfg, notes))
    elif asset == "crypto":
        bases = []
        for s in raw_syms or (ctx.cfg["watchlists"].get("crypto") or []):
            bases.append(symbols.parse(s, asset="crypto").base)
        groups = bases + ["market"]
        items = crypto_items(bases, notes)
    else:
        tokens = raw_syms or list(ctx.cfg["watchlists"].get("meme") or [])
        if not raw_syms:
            setups_doc = state.read_json("setups.json", {}) or {}
            for h in setups_doc.get("setups") or []:
                if h.get("asset") == "meme" and h["symbol"] not in tokens:
                    tokens.append(h["symbol"])
        if not tokens:
            raise ValueError("no meme tokens to watch — pass --symbols SOL:<mint> or run trader-scanner --asset meme")
        items = meme_items(tokens, snapshots, now, notes)
        groups = []
        for t in tokens:
            try:
                s = data.as_symbol(t, "meme")
                groups.append("%s:%s" % (s.chain, s.address) if s.address else t)
            except symbols.SymbolError:
                groups.append(t)
    last_checks = {g: (scopes.get(_scope(asset, g)) or {}).get("last_check") for g in groups}
    new = filter_new(items, scopes, asset, now, args.since, args.all)
    trimmed = []
    for g in groups:
        trimmed.extend([it for it in new if it["symbol"] == g][: max(1, args.limit)])
    trimmed.extend(it for it in new if it["symbol"] not in groups)
    trimmed.sort(key=lambda it: it.get("published") or "", reverse=True)
    for g in groups:
        scopes.setdefault(_scope(asset, g), {"ids": [], "last_check": None})["last_check"] = market_clock.iso(now)
    state.write_json("news_seen.json", seen_doc)
    payload = {"checked_at": market_clock.iso(now), "asset": asset, "scope": "%s:%s" % (asset, ",".join(groups)),
               "items": trimmed, "notes": notes}
    state.write_json("news.json", payload)
    text = render(asset, groups, trimmed, notes, last_checks)
    path = None
    if not args.no_html:
        path = write_report(asset, trimmed, now)
        text += "\n" + cli.report_line(path)
    cli.emit(args, text, payload, asset)
    cli.maybe_open(args, path)
    return 0


if __name__ == "__main__":
    cli.run(main)
