#!/usr/bin/env python3
"""News Monitor — only what is new since the last check, newest first, with why it matters.

Stocks: Yahoo Finance + Google News headlines per ticker and SEC 8-K filings
(earnings, mergers, guidance, CEO changes). Crypto: CoinDesk, Cointelegraph
and The Block (listings, delistings, ETF flows, hacks, unlocks, regulation,
macro). Meme coins: DexScreener profile updates, boosts, new social links and
sudden liquidity changes.

Social: X posts (official API, pay-per-use — needs X_BEARER_TOKEN and stays
inside a daily read budget) for the watchlist cashtags plus a breaking feed from
curated wire-style accounts, and StockTwits crowd sentiment (free). `--feed`
refreshes trader/news_feed.json — every source merged, near-duplicates folded,
ranked — which the dashboard also uses.

Examples:
  python3 news.py --asset stock --symbols TSLA,NVDA
  python3 news.py --feed                         # best news across all sources
  python3 news.py --asset crypto
  python3 news.py --asset meme --symbols SOL:<mint>
  python3 news.py --asset stock --symbols TSLA --offline --now 2026-10-20T14:15:00Z
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import sys
import threading

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, config, data, html, http, market_clock, state, symbols  # noqa: E402
from shared.sources import dexscreener, rss, sec, stocktwits, x, yahoo  # noqa: E402

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
    # "offering" alone is also a product or a discount — only a sale of shares or notes counts
    ("offering", r"\b(public|secondary|follow-on|direct|underwritten|private|stock|share|shares|equity|at-the-market|atm"
                 r"|convertible|notes?|bond|debt|warrant) offering\b|\boffering of\b.{0,40}\b(shares|stock|notes|units"
                 r"|warrants)\b|\bdilut|\bshare sale\b|\bconvertible (senior )?(notes|bonds|debentures)\b|\batm\b program",
     3, "new shares usually pressure the price"),
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
    # whole words only: "breaches $100K" is a price, "hackathon" is an event
    ("hack", r"\bhack(s|ed|er|ers|ing)?\b|\bexploit(s|ed|er|ers)?\b|\bstolen\b|\bdrained\b|\b(security|data) breach"
             r"|\battackers?\b", 3, "hacks trigger fast sell-offs and contagion"),
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


# --- social: X and StockTwits -------------------------------------------------------------------

CRYPTO_WORDS = re.compile(r"\b(crypto|token|blockchain|defi|stablecoin|altcoin|on-?chain|exchange outflow)\b", re.I)
SOCIAL_WHY = "social chatter — crowd mood, not information"
_NAME_SUFFIX = re.compile(r"[,.]?\s+(inc|corp|corporation|co|company|ltd|plc|holdings|group|technologies|platforms)\.?$",
                          re.I)


def _short_name(name: str) -> str:
    n = (name or "").strip()
    for _ in range(3):
        n = _NAME_SUFFIX.sub("", n).strip(" ,.")
    return n.title() if n.isupper() else n


def _stock_names(tickers, cfg) -> dict:
    """Company names for X queries ('Tesla' for TSLA); best effort, silent on failure."""
    try:
        rows = data.stock_universe(cfg)["tickers"]
    except Exception:
        return {}
    want = set(tickers)
    return {r["ticker"]: _short_name(r["name"]) for r in rows if r["ticker"] in want}


def _x_item(post, symbol, asset, rules, wire=False) -> dict:
    text = post["text"]
    tags, why, imp = classify(text, rules)
    title = text if len(text) <= 280 else text[:277] + "…"
    extra = {"asset": asset, "kind": "social", "author": post["author"], "metrics": dict(post["metrics"]),
             "sentiment": None, "x_id": post["id"], "wire": wire, "followers": post.get("followers", 0),
             "verified": post.get("verified", False)}
    it = _item(symbol, "X", title, post["url"], post["published"], tags,
               why or ("wire-style account — confirm before acting" if wire else SOCIAL_WHY), imp, extra)
    it["id"] = hashlib.sha1(("x|%s" % post["id"]).encode("utf-8")).hexdigest()[:16]
    cred = credibility(it)
    if wire:
        it["importance"] = max(imp, 2)
    elif cred <= 2:
        # a keyword in a small account's post is chatter about the story, not the story
        it["importance"] = min(imp, cred)
        if tags:
            it["why"] = "%s (talks about %s)" % (SOCIAL_WHY, " + ".join(tags[:2]))
    return it


def _assign(text: str, stocks, coins):
    """Which watched symbol (and asset) a breaking post is about; 'market' if none."""
    for tag in re.findall(r"\$([A-Za-z]{1,6})\b", text or ""):
        t = tag.upper()
        if t in stocks:
            return t, "stock"
        if t in coins:
            return t, "crypto"
    mentioned = _coin_mentions(text, coins)
    if mentioned:
        return mentioned[0], "crypto"
    low = (text or "").lower()
    for t in stocks:
        if re.search(r"(?<![a-z])%s(?![a-z])" % re.escape(t.lower()), low):
            return t, "stock"
    crypto = bool(_coin_mentions(text, list(COIN_WORDS)) or CRYPTO_WORDS.search(text or ""))
    return "market", "crypto" if crypto else "stock"


def x_items(stocks, coins, cfg, status: dict, breaking_assets=("stock", "crypto")) -> list:
    """Cashtag search per watched symbol + one breaking query over the curated accounts."""
    xs = x.settings(cfg)
    items = []
    names = _stock_names(stocks, cfg) if stocks else {}
    queries = [(t, "stock", x.cashtag_query(t, "stock", names.get(t, ""))) for t in stocks]
    queries += [(c, "crypto", x.cashtag_query(c, "crypto", (COIN_WORDS.get(c) or [""])[0])) for c in coins]
    try:
        for sym, asset, q in queries:
            for post in x.search_recent(q, max_results=10, sort="relevancy", cfg=cfg):
                items.append(_x_item(post, sym, asset, STOCK_RULES if asset == "stock" else CRYPTO_RULES))
        accounts = []
        for a in breaking_assets:
            accounts += [n for n in (xs.get("accounts") or {}).get(a) or [] if n not in accounts]
        if accounts:
            for post in x.breaking(accounts, max_results=20, cfg=cfg):
                sym, asset = _assign(post["text"], stocks, coins)
                rules = CRYPTO_RULES if asset == "crypto" else STOCK_RULES
                it = _x_item(post, sym, asset, rules, wire=True)
                if sym == "market":
                    it["tags"] = ["market"] + it["tags"]
                items.append(it)
        status["X"] = x.ST_OK
    except x.XUnavailable as exc:
        status["X"] = exc.status
    except (ValueError, http.SourceError) as exc:
        status["X"] = "error: %s" % exc
    return items


def crowd_summary(symbol: str, asset: str, now) -> dict:
    """StockTwits stream → {"summary": {...}, "messages": [...]} for one symbol."""
    return stocktwits.stream(symbol, asset, now_ts=now.timestamp())


def _crowd_line(sym: str, summ: dict, suffix: bool = True) -> str:
    n = summ["last_hour"]
    count = ("%d+" % n) if summ.get("capped") else str(n)
    if summ.get("bullish_pct") is None:
        mood = "no bullish/bearish tags"
    else:
        mood = "%.0f%% bullish" % summ["bullish_pct"]
    return "%s on StockTwits: %s messages in the last hour, %s%s" % (
        sym, count, mood, " — crowd mood, not information" if suffix else "")


def _substantive(text: str) -> bool:
    words = [w for w in re.sub(r"https?://\S+|\$[A-Za-z.]+", " ", text or "").split() if re.search(r"[a-z]", w, re.I)]
    return len(words) >= 5


def stocktwits_items(sym: str, asset: str, crowd: dict, now) -> list:
    summ = crowd["summary"]
    pct = summ.get("bullish_pct")
    sentiment = "bullish" if pct is not None and pct >= 60 else ("bearish" if pct is not None and pct <= 40 else None)
    hour = market_clock.iso(now)[:13]
    st_url = "https://stocktwits.com/symbol/%s" % stocktwits.st_symbol(sym, asset)
    head = _item(sym, "StockTwits", _crowd_line(sym, summ, suffix=False), st_url, market_clock.iso(now), ["crowd"],
                 SOCIAL_WHY, 1, {"asset": asset, "kind": "social", "author": None, "sentiment": sentiment,
                                  "metrics": {"messages": summ["count"], "last_hour": summ["last_hour"],
                                              "bullish_pct": pct}, "crowd_summary": True})
    head["id"] = hashlib.sha1(("stsum|%s|%s" % (sym, hour)).encode("utf-8")).hexdigest()[:16]
    out = [head]
    msgs = [m for m in crowd["messages"] if _substantive(m["text"])]
    msgs.sort(key=lambda m: -(m["likes"] * 2 + math.log10(max(m["followers"], 1))))
    for m in msgs[:2]:
        it = _item(sym, "StockTwits", m["text"][:280], m["url"], m["published"], [], SOCIAL_WHY, 1,
                   {"asset": asset, "kind": "social", "author": "@" + m["author"], "sentiment": m["sentiment"],
                    "metrics": {"likes": m["likes"]}, "followers": m["followers"]})
        it["id"] = hashlib.sha1(("st|%s" % m["id"]).encode("utf-8")).hexdigest()[:16]
        out.append(it)
    return out


# --- the aggregated feed (news_feed.json) ----------------------------------------------------------

FEED_FILE = "news_feed.json"
FEED_MAX_AGE_DAYS = 7
FEED_SEEN_IDS = 5000
DUP_JACCARD = 0.6
_FEED_LOCK = threading.Lock()
_STOP = {"the", "and", "for", "with", "from", "that", "this", "into", "after", "ahead", "over", "amid", "says",
         "said", "its", "are", "was", "has", "have", "will", "per", "new", "via"}
OUTLETS = {"Yahoo Finance", "Google News", "CoinDesk", "Cointelegraph", "The Block"}


def _tokens(text: str) -> set:
    t = re.sub(r"https?://\S+|\$[A-Za-z]+|[*]", " ", (text or "").lower())
    t = t.replace("–", " ").replace("—", " ")
    return {w for w in re.findall(r"[a-z0-9]+", t) if len(w) >= 3 and w not in _STOP}


def similar(a: str, b: str) -> bool:
    ta, tb = _tokens(a), _tokens(b)
    if len(ta) < 4 or len(tb) < 4:
        return False
    return len(ta & tb) / float(len(ta | tb)) >= DUP_JACCARD


def credibility(it: dict) -> int:
    """SEC filing and wire-style accounts > major outlets > social chatter."""
    src = it.get("source") or ""
    if src == "SEC EDGAR":
        return 5
    if src == "X":
        if it.get("wire"):
            return 4
        if it.get("verified") and (it.get("followers") or 0) >= 100000:
            return 3
        return 2 if (it.get("followers") or 0) >= 10000 else 1
    if src in OUTLETS or "(via Google News)" in src:
        return 3
    if src == "DexScreener":
        return 2
    return 1  # StockTwits and anything unknown


def source_label(it: dict) -> str:
    if it.get("source") in ("X", "StockTwits") and it.get("author"):
        return "%s %s" % (it["source"], it["author"])
    return it.get("source") or "?"


def fold_duplicates(items: list) -> list:
    """Keep one copy of a story told by several sources: the most credible (then the earliest)."""
    keep = []
    for it in sorted(items, key=lambda i: (-credibility(i), i.get("published") or "")):
        dup = None
        for k in keep:
            if k["id"] == it["id"]:
                dup = k
                break
            if it.get("crowd_summary") or k.get("crowd_summary"):
                continue
            if similar(k["title"], it["title"]):
                dup = k
                break
        if dup is None:
            keep.append(it)
            continue
        if dup["id"] != it["id"]:
            label = source_label(it)
            also = dup.setdefault("also", [])
            if label not in also and label != source_label(dup):
                also.append(label)
            dup["importance"] = max(dup.get("importance") or 1, it.get("importance") or 1)
            for t in it.get("tags") or []:
                if t not in dup.setdefault("tags", []):
                    dup["tags"].append(t)
    return keep


def _engagement(it: dict) -> int:
    m = it.get("metrics") or {}
    return int(m.get("likes") or 0) + 2 * int(m.get("reposts") or 0)


def score(it: dict, now_ts: float, baselines: dict) -> float:
    """credibility, then importance, then unusual engagement for that author, then recency."""
    s = credibility(it) * 10 + (it.get("importance") or 1) * 8
    if it.get("source") == "X":
        eng = _engagement(it)
        base = baselines.get(it.get("author")) or baselines.get("*") or 0
        ratio = (eng + 1.0) / (base + 1.0)
        if eng >= 50 and ratio > 1:
            s += min(10.0, 3 * math.log(ratio, 2))
    pub = it.get("published")
    if pub:
        age_h = max(0.0, (now_ts - market_clock.parse_iso(pub).timestamp()) / 3600.0)
        s += 10 * max(0.0, 1 - age_h / 24.0)
    return round(s, 2)


def _baselines(items: list) -> dict:
    by = {}
    for it in items:
        if it.get("source") == "X":
            by.setdefault(it.get("author"), []).append(_engagement(it))
    out = {}
    allv = []
    for author, vals in by.items():
        allv += vals
        if len(vals) >= 2:
            out[author] = sorted(vals)[len(vals) // 2]
    if allv:
        out["*"] = sorted(allv)[len(allv) // 2]
    return out


def _normalise(it: dict, asset: str) -> dict:
    it.setdefault("asset", asset)
    it.setdefault("kind", "filing" if it.get("source") == "SEC EDGAR" else "news")
    it.setdefault("author", None)
    it.setdefault("sentiment", None)
    it.setdefault("metrics", {})
    if it.get("symbol") == "market" and asset == "crypto":
        it["asset"] = "crypto"
    return it


def _watch(cfg: dict, assets, raw_symbols):
    stocks, coins, memes = [], [], []
    if raw_symbols:
        for raw in raw_symbols:
            try:
                sym = data.as_symbol(raw)
            except (symbols.SymbolError, ValueError):
                continue
            (stocks if sym.asset == "stock" else coins if sym.asset == "crypto" else memes).append(
                sym.key if sym.asset == "stock" else sym.base if sym.asset == "crypto" else raw)
    else:
        wl = cfg.get("watchlists") or {}
        stocks = [symbols.parse(t, asset="stock").key for t in wl.get("stocks") or []]
        coins = [symbols.parse(c, asset="crypto").base for c in wl.get("crypto") or []]
        memes = list(wl.get("meme") or [])
    want = set(assets or ("stock", "crypto", "meme"))
    return ([s for s in stocks if "stock" in want], [c for c in coins if "crypto" in want],
            [m for m in memes if "meme" in want])


def _status_from_notes(notes: list, names, status: dict) -> None:
    for name in names:
        hit = [n for n in notes if name in n]
        if name == "SEC EDGAR" and any("SEC 8-K filings skipped" in n for n in notes):
            status[name] = "skipped — set sec_user_agent in trader/config.json"
        elif hit:
            status[name] = "error: %s" % hit[0][:160]
        else:
            status.setdefault(name, "ok")


def refresh_feed(assets=None, symbols=None, now=None) -> dict:
    """Fetch every source once, fold duplicates, rank, merge into trader/news_feed.json.

    Safe to call from a background thread: every source fails on its own (its status says why), and nothing
    but news_feed.json and x_usage.json is written. The fetching runs without any lock — a slow or rate-limited
    source never makes another caller (the autopilot, right before a trade) wait; only the merge into the file
    is one at a time. Returns {"new": n, "items": total, "sources": {name: status}, "updated_at": iso}.
    """
    return _refresh_feed(assets, symbols, now)


def _refresh_feed(assets, raw_symbols, now) -> dict:
    cfg = config.load_config()
    now = market_clock.parse_iso(now) if now else market_clock.now_utc()
    now_ts = now.timestamp()
    stocks, coins, memes = _watch(cfg, assets, raw_symbols)
    doc = state.read_json(FEED_FILE, {}) or {}
    status, notes, fresh = {}, [], []
    news_cfg = cfg.get("news") or {}
    try:
        for t in stocks:
            fresh += [_normalise(it, "stock") for it in stock_items(t, cfg, notes)]
        if stocks:
            _status_from_notes(notes, ("Yahoo Finance", "Google News", "SEC EDGAR"), status)
    except Exception as exc:  # keep the other sources alive
        status["news"] = "error: %s" % exc
    try:
        if coins:
            before = len(notes)
            fresh += [_normalise(it, "crypto") for it in crypto_items(coins, notes)]
            _status_from_notes(notes[before:], list(rss.CRYPTO_FEEDS), status)
    except Exception as exc:
        status["crypto news"] = "error: %s" % exc
    if stocks or coins:
        if (news_cfg.get("x") or {}).get("enabled", True):
            try:
                bassets = [a for a in ("stock", "crypto") if (a == "stock" and stocks) or (a == "crypto" and coins)]
                fresh += [it for it in x_items(stocks, coins, cfg, status, bassets) if it["asset"] in bassets]
            except Exception as exc:
                status["X"] = "error: %s" % exc
        else:
            status["X"] = x.ST_DISABLED
        if (news_cfg.get("stocktwits") or {}).get("enabled", True):
            errs = []
            for sym, asset in [(t, "stock") for t in stocks] + [(c, "crypto") for c in coins]:
                try:
                    fresh += stocktwits_items(sym, asset, crowd_summary(sym, asset, now), now)
                except Exception as exc:
                    errs.append("%s: %s" % (sym, exc))
            status["StockTwits"] = ("error: " + "; ".join(errs)[:200]) if errs else "ok"
    if memes:
        snaps = doc.setdefault("meme_snapshots", {})
        before = len(notes)
        try:
            fresh += [_normalise(it, "meme") for it in meme_items(memes, snaps, now, notes)]
            status["DexScreener"] = ("error: %s" % notes[before][:160]) if len(notes) > before else "ok"
        except Exception as exc:
            status["DexScreener"] = "error: %s" % exc
    cutoff = now_ts - FEED_MAX_AGE_DAYS * 86400
    fresh = [it for it in fresh if not it.get("published")
             or cutoff <= market_clock.parse_iso(it["published"]).timestamp() <= now_ts]
    snaps = doc.get("meme_snapshots")
    with _FEED_LOCK, state.locked(FEED_FILE):  # what other refreshes wrote while this one was fetching is kept
        doc = state.read_json(FEED_FILE, {}) or {}
        if snaps is not None:
            doc["meme_snapshots"] = dict(doc.get("meme_snapshots") or {}, **snaps)
        return _merge_feed(doc, fresh, status, cutoff, now, now_ts, news_cfg, stocks, coins, memes)


def _merge_feed(doc, fresh, status, cutoff, now, now_ts, news_cfg, stocks, coins, memes) -> dict:
    old = [it for it in doc.get("items") or []
           if not (it.get("published") and market_clock.parse_iso(it["published"]).timestamp() < cutoff)]
    # the crowd summary is a snapshot: the newest one per symbol replaces the previous
    summary_syms = {it["symbol"] for it in fresh if it.get("crowd_summary")}
    old = [it for it in old if not (it.get("crowd_summary") and it["symbol"] in summary_syms)]
    # ids already reported — kept beyond the item cap so capped-out stories are not "new" again next time
    seen_ids = set(doc.get("seen_ids") or []) | {it["id"] for it in old}
    merged = fold_duplicates(old + fresh)
    new_ids = [it["id"] for it in merged if it["id"] not in seen_ids]
    new = len(new_ids)
    base = _baselines(merged)
    for it in merged:
        it["score"] = score(it, now_ts, base)
        it["credibility"] = credibility(it)
    merged.sort(key=lambda it: it.get("published") or "", reverse=True)
    cap = int(news_cfg.get("feed_max_items") or 500)
    seen_list = [i for i in doc.get("seen_ids") or [] if i] + new_ids
    refreshed = dict(doc.get("refreshed") or {})
    for scope in (["stock:%s" % t for t in stocks] + ["crypto:%s" % c for c in coins] + ["meme:%s" % m for m in memes]):
        refreshed[scope] = market_clock.iso(now)
    doc.update({"updated_at": market_clock.iso(now), "items": merged[:cap], "sources": status,
                "seen_ids": seen_list[-FEED_SEEN_IDS:], "refreshed": refreshed})
    state.write_json(FEED_FILE, doc)
    return {"new": new, "items": len(doc["items"]), "sources": status, "updated_at": doc["updated_at"]}


def best(items: list, limit: int = 20) -> list:
    return sorted(items, key=lambda it: -(it.get("score") or 0))[:limit]


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


def render(asset, groups, new, notes, last_checks, crowd=None) -> str:
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
        else:
            lines.append("%s — %d new since last check" % (label, len(mine)))
            for it in mine:
                lines.append(_line(it, asset))
        if crowd and crowd.get(sym):
            lines.append("  ~ " + _crowd_line(sym, crowd[sym]))
    for n in notes:
        lines.append("  note: " + n)
    return "\n".join(lines)


def _line(it, asset, with_symbol=False) -> str:
    mark = {3: "[!!!]", 2: "[!! ]"}.get(it.get("importance"), "[!  ]")
    also = (" (also: %s)" % ", ".join(it["also"])) if it.get("also") else ""
    title = it["title"] if len(it["title"]) <= 160 else it["title"][:157] + "…"
    sym = ("%-6s " % it["symbol"]) if with_symbol else ""
    return "  %s %s  %s%s — %s%s — %s" % (mark, _when(it, asset), sym, title, source_label(it), also, it["why"])


def render_feed(doc: dict, limit: int) -> str:
    items = best(doc.get("items") or [], limit)
    lines = ["News feed · best %d of %d · updated %s" % (len(items), len(doc.get("items") or []),
                                                         market_clock.fmt_utc(doc.get("updated_at") or
                                                                              market_clock.now_utc(), True))]
    for it in items:
        lines.append(_line(it, it.get("asset") or "stock", with_symbol=True))
    srcs = doc.get("sources") or {}
    if srcs:
        lines.append("  sources: " + " · ".join("%s %s" % (k, v) for k, v in sorted(srcs.items())))
    return "\n".join(lines)


def write_report(asset, new, now):
    rows = []
    for it in new:
        rows.append([{3: "!!!", 2: "!!", 1: "!"}.get(it["importance"], ""), _when(it, asset), it["symbol"] if
                     it["symbol"] != "market" else "market", html.link(it["url"], it["title"]) if it.get("url")
                     else it["title"], source_label(it), it["why"]])
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
    p.add_argument("--social", dest="social", action="store_true", default=True,
                   help="include X posts (needs X_BEARER_TOKEN, pay-per-use) and StockTwits crowd mood (default)")
    p.add_argument("--no-social", dest="social", action="store_false", help="headlines and filings only")
    p.add_argument("--feed", action="store_true",
                   help="refresh trader/news_feed.json from every source and print the best items")
    return p


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    now = market_clock.now_utc()
    if args.feed:
        raw = [s.strip() for s in (args.symbols or "").split(",") if s.strip()]
        res = refresh_feed([args.asset] if args.asset else None, raw or None, now)
        doc = state.read_json(FEED_FILE, {}) or {}
        text = render_feed(doc, max(1, args.limit if args.limit != 12 else 20))
        text += "\n  %d new item(s) this refresh · saved %s" % (res["new"], FEED_FILE)
        cli.emit(args, text, {"refresh": res, "best": best(doc.get("items") or [], 20)},
                 sorted({it.get("asset") for it in doc.get("items") or [] if it.get("asset")}) or None)
        return 0
    asset = args.asset or "stock"
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
    crowd = {}
    if args.social and asset in ("stock", "crypto"):
        social_syms = [g for g in groups if g != "market"]
        status = {}
        stocks_ = social_syms if asset == "stock" else []
        coins_ = social_syms if asset == "crypto" else []
        xs = [it for it in x_items(stocks_, coins_, ctx.cfg, status, (asset,)) if it["asset"] == asset]
        if status.get("X") not in (x.ST_OK, None):
            notes.append("X: %s" % status["X"])
        items = fold_duplicates(items + xs)
        if any(it["symbol"] == "market" for it in xs) and "market" not in groups:
            groups.append("market")
        if ((ctx.cfg.get("news") or {}).get("stocktwits") or {}).get("enabled", True):
            for g in social_syms:
                try:
                    crowd[g] = crowd_summary(g, asset, now)["summary"]
                except Exception as exc:
                    notes.append("StockTwits %s: %s" % (g, exc))
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
               "items": trimmed, "notes": notes, "crowd": crowd}
    state.write_json("news.json", payload)
    text = render(asset, groups, trimmed, notes, last_checks, crowd)
    path = None
    if not args.no_html:
        path = write_report(asset, trimmed, now)
        text += "\n" + cli.report_line(path)
    cli.emit(args, text, payload, asset)
    cli.maybe_open(args, path)
    return 0


if __name__ == "__main__":
    cli.run(main)
