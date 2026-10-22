#!/usr/bin/env python3
"""Meme-coin sniper — new DEX tokens on pump.fun, PumpSwap, Raydium, Meteora, PancakeSwap, Base: found early,
checked hard, traded small.

Every cycle it looks where the meme-coin season is now (which chain and launchpad has the busy new pools), pulls
the newest and busiest tokens there (pump.fun, DexScreener profiles and boosts, GeckoTerminal new and trending
pools), and puts each through the checks a careful trader makes before buying:

* liquidity — what OUR size really gets back if we sell at once (a Jupiter round trip on Solana; the pool's depth
  elsewhere), never just the market cap;
* holders — the biggest wallets without the pool, the curve, lockers and exchanges; the creator's share;
* rug pull and honeypot — mint and freeze authority, LP locked or burned, a sell that works, taxes (RugCheck,
  honeypot.is);
* fake hype — trades per wallet (bots), volume against liquidity (wash trading), paid boosts, too young to judge.

Only then a strategy may fire: early momentum (volume and buyers accelerating before the crowd), a breakout after
consolidation, or the first strength after a pullback. Every trade has a stop, a partial take-profit, a trailing
stop, a time stop, and it is sold at once when the liquidity drains or the token turns dangerous. Every candidate,
bought or not, is followed for a day — `sniper.py report` shows which checks and strategies would have paid.

Paper by default. Live only on Solana, only from a wallet of its own (`sniper.py wallet new`), with a hard cap on
what that wallet may hold, and only after `sniper.mode "live"` and `sniper.live_confirmation` are set.

Examples:
  python3 sniper.py season                  # where meme coins trade now
  python3 sniper.py scan                    # one cycle: candidates, checks, decisions (paper)
  python3 sniper.py run --loop              # every interval_sec, until stopped
  python3 sniper.py status                  # positions, today, budget
  python3 sniper.py report                  # what happened to every candidate after 15 min, 1 h, 4 h, 24 h
  python3 sniper.py wallet new              # a new bot wallet — prints only its address
  python3 sniper.py check-live              # what is missing for live trading
  python3 sniper.py sell <address> | kill   # sell one position | sell everything and switch off
"""
from __future__ import annotations

import os
import re
import sys
import time

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, config, fmt, http, indicators, market_clock, notify, secrets, skills, state, symbols  # noqa: E402
from shared.sources import dexscreener, geckoterminal, jupiter, pumpfun  # noqa: E402

LIVE_PHRASE = "I ACCEPT MEME COIN RISK"
BOOK = "sniper/book.json"
CANDIDATES = "sniper/candidates.jsonl"
TRADES = "sniper/trades.jsonl"
SEASON = "sniper/season.json"
SAFETY = "sniper/safety.json"
LIVE_CHAINS = ("solana",)       # signing is implemented for Solana only; elsewhere paper and alerts
CURVE_DEXES = ("pumpfun", "pump-fun", "pumpdotfun")  # a bonding curve: no LP to pull, its own liquidity rules
POOL_FEE_PCT = {"pumpfun": 1.0, "pumpswap": 0.25, "raydium": 0.25, "meteora": 0.25, "orca": 0.30,
                "pancakeswap": 0.25, "uniswap": 0.30, "aerodrome": 0.30}
NETWORK_COST_USD = {"solana": 0.02, "bsc": 0.10, "base": 0.05, "ethereum": 4.0}
MAJORS = {"SOL", "WSOL", "USDC", "USDT", "WETH", "ETH", "WBNB", "BNB", "CBBTC", "WBTC", "JUP", "BONK"}
CHECKPOINTS = (("m15", 900), ("h1", 3600), ("h4", 14400), ("h24", 86400))


# --- settings -----------------------------------------------------------------------------------------------

def settings(cfg: dict) -> dict:
    s = dict(config.DEFAULT_CONFIG["sniper"])
    s.update((cfg or {}).get("sniper") or {})
    s["strategies"] = dict(config.DEFAULT_CONFIG["sniper"]["strategies"], **(s.get("strategies") or {}))
    s["exits"] = dict(config.DEFAULT_CONFIG["sniper"]["exits"], **(s.get("exits") or {}))
    return s


def live_readiness(cfg: dict) -> tuple:
    """(ok, missing): live needs all of it — the mode, the phrase, a bot wallet. The wallet cap is checked
    before every buy (it needs the balance)."""
    s = settings(cfg)
    missing = []
    if s.get("mode") != "live":
        missing.append('config sniper.mode must be "live"')
    if (s.get("live_confirmation") or "") != LIVE_PHRASE:
        missing.append('config sniper.live_confirmation must be exactly "%s"' % LIVE_PHRASE)
    if not secrets.has("SNIPER_SOL_SECRET"):
        missing.append("a bot wallet (sniper.py wallet new — then fund it with a small amount of SOL)")
    return (not missing), missing


def is_live(cfg: dict) -> bool:
    return live_readiness(cfg)[0]


# --- where the season is ------------------------------------------------------------------------------------

def season(cfg: dict, now_ts: float, force: bool = False) -> dict:
    """Which chain and launchpad has the busy new pools right now: the volume of pools younger than a day among
    each chain's trending pools. Refreshed every 10 minutes; the scan spends its budget where the season is."""
    s = settings(cfg)
    doc = state.read_json(SEASON, {}) or {}
    if not force and doc.get("at") and now_ts - market_clock.ts(doc["at"]) < 600:
        return doc
    chains, notes = {}, []
    for chain in s["chains"]:
        net = geckoterminal.CHAIN_TO_NETWORK.get(chain)
        if not net:
            continue
        try:
            rows = geckoterminal.pools(net, "trending_pools", duration="1h")
        except http.SourceError as exc:
            notes.append("%s: %s" % (chain, exc))
            continue
        young = [r for r in rows if r.get("created_at") and now_ts - r["created_at"] < 86400]
        dexes = {}
        for r in young:
            dexes[r["dex"]] = dexes.get(r["dex"], 0.0) + (r["volume"].get("h1") or 0.0)
        chains[chain] = {"young_pools": len(young), "volume_h1": round(sum(r["volume"].get("h1") or 0 for r in young)),
                         "launchpads": sorted(dexes, key=lambda d: -dexes[d])[:3]}
    total = sum(c["volume_h1"] for c in chains.values()) or 1.0
    for c in chains.values():
        c["share"] = round(c["volume_h1"] / total, 3)
    doc = {"at": market_clock.iso(now_ts), "chains": chains, "notes": notes,
           "hot": sorted(chains, key=lambda k: -chains[k]["volume_h1"])}
    state.write_json(SEASON, doc)
    return doc


# --- discovery ----------------------------------------------------------------------------------------------

def discover(cfg: dict, now_ts: float, notes: list) -> list:
    """Candidates [{chain, address, source}] — the newest and busiest tokens of the chains in season, pump.fun
    coins about to graduate, and fresh DexScreener profiles / boosts. One entry per token."""
    s = settings(cfg)
    sea = season(cfg, now_ts)
    seen, out = set(), []

    def add(chain, address, source, extra=None):
        if chain not in s["chains"] or not address or (chain, address) in seen:
            return
        seen.add((chain, address))
        out.append(dict(extra or {}, chain=chain, address=address, source=source))
    for chain in sea.get("hot") or s["chains"]:
        net = geckoterminal.CHAIN_TO_NETWORK.get(chain)
        for kind, dur in (("trending_pools", "5m"), ("new_pools", None)):
            try:
                for r in geckoterminal.pools(net, kind, duration=dur):
                    add(chain, r["address"], "geckoterminal %s" % kind.split("_")[0], {"pool": r})
            except (http.SourceError, TypeError) as exc:
                notes.append("%s %s: %s" % (chain, kind, exc))
    for t in x_discover(cfg)[:15]:  # what X talks about right now — often before the volume comes
        add(t["chain"], t["address"], "X (%d posts)" % t["x_posts"], {"x": t})
    if "solana" in s["chains"]:
        try:
            for c in pumpfun.near_graduation(30):
                if c["curve_progress"] >= 0.7 and not c["banned"]:
                    add("solana", c["address"], "pump.fun near graduation", {"pumpfun": c})
        except http.SourceError as exc:
            notes.append("pump.fun: %s" % exc)
    for fn, src in ((dexscreener.profiles_latest, "dexscreener profile"), (dexscreener.boosts_latest, "dexscreener boost")):
        try:
            for r in fn()[:30]:
                add(r["chain"], r["address"], src, {"boost": r.get("boost_amount") if "boost" in src else None,
                                                   "links": r.get("links") or []})
        except http.SourceError as exc:
            notes.append("%s: %s" % (src, exc))
    # the season's chain first, then the freshest
    rank = {c: i for i, c in enumerate(sea.get("hot") or [])}
    out.sort(key=lambda c: rank.get(c["chain"], 9))
    return out


def market_data(cands: list, now_ts: float) -> dict:
    """{(chain, address): DexScreener best pair} — 30 tokens per request."""
    by_chain = {}
    for c in cands:
        by_chain.setdefault(c["chain"], []).append(c["address"])
    out = {}
    for chain, addrs in by_chain.items():
        try:
            pairs = dexscreener.tokens(chain, addrs, now_ts)
        except http.SourceError:
            continue
        for a in addrs:
            mine = [p for p in pairs if (p.get("base") or {}).get("address") == a]
            if mine:
                out[(chain, a)] = dexscreener.best_pair(mine)
    return out


# --- the checks ---------------------------------------------------------------------------------------------

def prefilter(c: dict, pair: dict, s: dict, now_ts: float) -> list:
    """Cheap reasons to skip before any safety source is asked. [] = go on."""
    why = []
    sym = ((pair.get("base") or {}).get("symbol") or "").upper()
    if sym in MAJORS or sym in symbols.STABLECOINS:
        why.append("%s is a major or a stablecoin, not a meme launch" % sym)
    age_min = (now_ts - pair["created_at"]) / 60.0 if pair.get("created_at") else None
    curve = pair.get("dex") in CURVE_DEXES
    if age_min is None:
        why.append("pool age unknown")
    elif age_min < float(s["min_age_min"]):
        why.append("only %.0f min old — too young to judge (min %s)" % (age_min, s["min_age_min"]))
    elif age_min > float(s["max_age_hours"]) * 60:
        why.append("%.0f h old — past the launch window (max %s h)" % (age_min / 60, s["max_age_hours"]))
    liq = pair.get("liquidity_usd")
    if not curve and (liq is None or liq < float(s["min_liquidity_usd"])):
        why.append("liquidity %s under %s" % (fmt.compact_usd(liq) if liq else "unknown",
                                               fmt.compact_usd(float(s["min_liquidity_usd"]))))
    if liq and (pair.get("volume") or {}).get("h1", 0) / liq > float(s["max_vol_liq_ratio"]):
        why.append("hour volume %.0f× the liquidity — wash trading" % (pair["volume"]["h1"] / liq))
    pool = c.get("pool") or {}
    t = (pool.get("txns") or {}).get("h1") or {}
    wallets = (t.get("buyers") or 0) + (t.get("sellers") or 0)
    if wallets and (t.get("buys", 0) + t.get("sells", 0)) / float(wallets) > float(s["max_tx_per_wallet"]):
        why.append("%.1f trades per wallet in the last hour — bots, not people" % (
            (t.get("buys", 0) + t.get("sells", 0)) / float(wallets)))
    pf = c.get("pumpfun") or {}
    if pf.get("banned"):
        why.append("banned on pump.fun")
    if pf.get("transfer_fee_bps"):
        why.append("transfer fee %.1f %%" % (pf["transfer_fee_bps"] / 100.0))
    return why


def safety(c: dict, pair: dict, s: dict, now_ts: float) -> dict:
    """RugCheck / honeypot.is through /trader-rugcheck, cached 15 min per token. A bonding curve has no LP to lock
    and its own liquidity: those two checks don't apply there — our own round trip measures it instead."""
    cache = state.read_json(SAFETY, {}) or {}
    key = "%s:%s" % (c["chain"], c["address"])
    hit = cache.get(key)
    if hit and now_ts - hit.get("t", 0) < 60 * float(s["exits"]["recheck_min"]):
        return hit["r"]
    rug = skills.load("trader-rugcheck", "rugcheck")
    try:
        res = rug.check(None, pair=pair, write=False)
    except Exception as exc:  # noqa: BLE001 — no answer is no green light
        r = {"ok": False, "score": 0, "verdict": "UNKNOWN", "reasons": ["safety check failed: %s" % type(exc).__name__],
             "metrics": {}}
    else:
        curve = pair.get("dex") in CURVE_DEXES
        exempt = {"lp_locked", "liquidity"} if curve else set()
        failed = [k for k in res.get("checks") or [] if k.get("ok") is False and k["name"] not in exempt]
        critical = [k for k in failed if k.get("severity") == "critical"]
        score = max(0, 100 - sum(int(k.get("penalty") or 0) for k in failed))
        reasons = [r for r in res.get("reasons") or []
                   if not (curve and ("LP" in r or "iquidity" in r))]
        unverified = any(k["name"] == "safety_source" for k in failed)  # RugCheck / honeypot.is didn't answer
        r = {"ok": not critical and not unverified and score >= float(s["min_safety_score"]),
             "score": score, "verdict": res.get("verdict"), "reasons": reasons[:6], "metrics": res.get("metrics") or {}}
    cache[key] = {"t": now_ts, "r": r}
    if len(cache) > 500:
        for k in sorted(cache, key=lambda k: cache[k].get("t", 0))[:100]:
            cache.pop(k, None)
    state.write_json(SAFETY, cache)
    return r


def sol_usd() -> float:
    q = jupiter.quote(jupiter.SOL_MINT, jupiter.USDC_MINT, 10 ** 9, 50)
    return q["out_raw"] / 1e6


def roundtrip(c: dict, pair: dict, s: dict) -> dict:
    """What OUR size gets back if sold at once. Solana: two Jupiter quotes (buy, then sell what we'd get) — no route
    back means a honeypot or no liquidity. Elsewhere: the pool's depth (constant product) plus its fee."""
    usd = float(s["trade_usd"])
    if c["chain"] == "solana":
        px = sol_usd()
        lamports = int(usd / px * 1e9)
        buy = jupiter.quote(jupiter.SOL_MINT, c["address"], lamports, int(s["slippage_bps"]))
        sell = jupiter.quote(c["address"], jupiter.SOL_MINT, buy["out_raw"], int(s["slippage_bps"]))
        back = sell["out_raw"] / 1e9 * px
        return {"loss_pct": round(100 * (1 - back / usd), 2), "tokens_raw": buy["out_raw"], "sol_usd": px,
                "route": buy["route"], "impact_pct": buy.get("price_impact_pct")}
    liq = float(pair.get("liquidity_usd") or 0)
    if liq <= 0:
        raise http.SourceError("pool", "no liquidity")
    fee = POOL_FEE_PCT.get(pair.get("dex"), 0.3)
    impact = 100.0 * usd / (liq / 2.0)  # each way, constant product, half the pool on each side
    cost = 2 * (impact + fee) + 100.0 * 2 * NETWORK_COST_USD.get(c["chain"], 0.2) / usd
    return {"loss_pct": round(cost, 2), "impact_pct": round(impact, 3), "route": [pair.get("dex")]}


def x_mentions(pair: dict, cfg: dict):
    """Posts on X in the last hour that name the token's $SYMBOL or its address — None without an X token."""
    if not settings(cfg).get("x_mentions"):
        return None
    from shared.sources import x
    sym = ((pair.get("base") or {}).get("symbol") or "").strip()
    addr = (pair.get("base") or {}).get("address") or ""
    q = "(%s%s) -is:retweet" % (("$%s OR " % sym) if sym and sym.isalnum() and len(sym) <= 10 else "", addr)
    try:
        posts = x.search_recent(q, max_results=20, sort="recency", cfg=cfg)
    except Exception:  # noqa: BLE001 — X off, out of budget, or down: the scan goes on without it
        return None
    hour_ago = market_clock.now_utc().timestamp() - 3600
    return sum(1 for p in posts if not p.get("published") or market_clock.ts(p["published"]) >= hour_ago)


X_QUERY = '("pump.fun/coin" OR "CA:" OR "dexscreener.com/solana" OR "four.meme") -is:retweet'
_SOL_ADDR = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])([1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])")
_EVM_ADDR = re.compile(r"\b(0x[0-9a-fA-F]{40})\b")


def x_discover(cfg: dict) -> list:
    """Tokens people post about right now — contract addresses and pump.fun links in fresh posts on X, with how
    many posts (and their authors' followers) named each. [] without an X token; the X budget caps the reads."""
    if not settings(cfg).get("x_mentions"):
        return []
    from shared.sources import x
    try:
        posts = x.search_recent(X_QUERY, max_results=50, sort="recency", cfg=cfg)
    except Exception:  # noqa: BLE001
        return []
    found = {}
    for p in posts:
        text = p.get("text") or ""
        for addr in set(_SOL_ADDR.findall(text)):
            try:
                if len(__import__("shared.solana", fromlist=["b58decode"]).b58decode(addr)) != 32:
                    continue
            except Exception:  # noqa: BLE001 — not base58, or the signing module isn't there: keep pump.fun mints
                if not addr.endswith("pump"):
                    continue
            f = found.setdefault(("solana", addr), {"posts": 0, "followers": 0})
            f["posts"] += 1
            f["followers"] += int(p.get("followers") or 0)
        for addr in set(_EVM_ADDR.findall(text)):
            chain = "bsc" if "four.meme" in text or "bsc" in text.lower() else "base"
            f = found.setdefault((chain, addr.lower()), {"posts": 0, "followers": 0})
            f["posts"] += 1
            f["followers"] += int(p.get("followers") or 0)
    return [{"chain": c, "address": a, "x_posts": v["posts"], "x_followers": v["followers"]}
            for (c, a), v in sorted(found.items(), key=lambda kv: -kv[1]["posts"])]


# --- strategies ---------------------------------------------------------------------------------------------

def bars_5m(c: dict, pair: dict, hours: float = 8) -> list:
    net = geckoterminal.CHAIN_TO_NETWORK.get(c["chain"])
    pool = (c.get("pool") or {}).get("pool") or pair.get("pair_address")
    if not net or not pool:
        return []
    try:
        return geckoterminal.ohlcv(net, pool, "5m", days=hours / 24.0, max_pages=1)
    except (http.SourceError, KeyError):
        return []


def signal(c: dict, pair: dict, s: dict, now_ts: float, fetch_bars=bars_5m) -> dict:
    """The first strategy that fires: {strategy, why, stop_pct} or {}. Only closed bars and live pool numbers."""
    st = s["strategies"]
    vol = pair.get("volume") or {}
    tx = pair.get("txns") or {}
    chg = pair.get("price_change") or {}
    age_h = (now_ts - pair["created_at"]) / 3600.0 if pair.get("created_at") else 0.0
    stop = float(s["exits"]["stop_pct"])
    if st.get("graduation") and c.get("pumpfun"):
        pf = c["pumpfun"]
        if 0.9 <= pf["curve_progress"] < 1.0 and pf["replies"] >= 20 and age_h <= 3:
            return {"strategy": "graduation", "stop_pct": stop,
                    "why": "pump.fun curve %.0f %% full, %d replies — about to move to the DEX" % (
                        100 * pf["curve_progress"], pf["replies"])}
    if st.get("momentum") and age_h <= 6:
        avg5 = (vol.get("h1") or 0) / 12.0
        m5 = tx.get("m5") or {}
        if (avg5 > 0 and (vol.get("m5") or 0) >= 2 * avg5 and (chg.get("m5") or 0) >= 3 and (chg.get("h1") or 0) >= 0
                and m5.get("buys", 0) >= 1.3 * max(1, m5.get("sells", 0)) and m5.get("buys", 0) + m5.get("sells", 0) >= 20
                and (chg.get("h1") or 0) < 300):
            return {"strategy": "momentum", "stop_pct": stop,
                    "why": "5-min volume %.1f× the hour's pace, price %+.0f %% in 5 min, buyers ahead %d:%d" % (
                        (vol.get("m5") or 0) / avg5, chg.get("m5") or 0, m5.get("buys", 0), m5.get("sells", 0))}
    if not (st.get("breakout") or st.get("pullback")) or age_h < 2:
        return {}
    bars = fetch_bars(c, pair)
    bars = [b for b in bars if b.t + 300 <= now_ts]  # closed bars only
    if len(bars) >= 26 and st.get("breakout"):
        box, last = bars[-25:-1], bars[-1]
        hi, lo = max(b.h for b in box), min(b.l for b in box)
        avg_v = sum(b.v for b in box) / len(box)
        if lo > 0 and (hi - lo) / lo <= 0.20 and last.c > hi and last.v >= 2 * avg_v:
            return {"strategy": "breakout", "stop_pct": min(stop, 100 * (1 - lo / last.c)),
                    "why": "2 h range of %.0f %% broken on %.1f× volume" % (100 * (hi - lo) / lo, last.v / max(avg_v, 1e-9))}
    if len(bars) >= 30 and st.get("pullback"):
        closes = [b.c for b in bars]
        ema = indicators.ema(closes, 20)
        top_i = max(range(len(bars) - 1), key=lambda i: bars[i].h)
        low_before = min(b.l for b in bars[:top_i + 1])
        top = bars[top_i].h
        after = bars[top_i:]
        dip = min(b.l for b in after)
        if (low_before > 0 and top >= 2 * low_before and 0.3 <= 1 - dip / top <= 0.5 and ema[-1] and ema[-2]
                and closes[-1] > ema[-1] and closes[-2] <= ema[-2]):
            return {"strategy": "pullback", "stop_pct": min(stop, 100 * (1 - dip / closes[-1])),
                    "why": "ran %.0f×, pulled back %.0f %%, back above its 20-bar average" % (
                        top / low_before, 100 * (1 - dip / top))}
    return {}


# --- the book -----------------------------------------------------------------------------------------------

def _book() -> dict:
    b = state.read_json(BOOK, {}) or {}
    b.setdefault("positions", {})
    b.setdefault("days", {})
    b.setdefault("traded", {})
    return b


def _day(book: dict, now_ts: float) -> dict:
    d = market_clock.iso(now_ts)[:10]
    book["traded"] = {k: t for k, t in book["traded"].items() if now_ts - float(t) < 2 * 86400}
    book["days"] = {k: v for k, v in book["days"].items() if k >= market_clock.iso(now_ts - 7 * 86400)[:10]}
    return book["days"].setdefault(d, {"trades": 0, "pnl_usd": 0.0})


def budget_refusal(book: dict, s: dict, now_ts: float, key: str) -> str:
    day = _day(book, now_ts)
    open_usd = sum(float(p.get("cost_usd") or 0) for p in book["positions"].values())
    if key in book["positions"]:
        return "already holding it"
    if now_ts - float(book["traded"].get(key, 0)) < 86400:
        return "traded in the last 24 h"
    if len(book["positions"]) >= int(s["max_positions"]):
        return "%d positions open (max %s)" % (len(book["positions"]), s["max_positions"])
    if open_usd + float(s["trade_usd"]) > float(s["max_open_usd"]) + 1e-9:
        return "%s in meme positions — the cap is %s" % (fmt.money(open_usd), fmt.money(float(s["max_open_usd"])))
    if day["trades"] >= int(s["max_trades_per_day"]):
        return "%d trades today (max %s)" % (day["trades"], s["max_trades_per_day"])
    if -day["pnl_usd"] >= float(s["daily_loss_usd"]):
        return "lost %s today — the daily limit is %s" % (fmt.money(-day["pnl_usd"]), fmt.money(float(s["daily_loss_usd"])))
    return ""


# --- execution ----------------------------------------------------------------------------------------------

def _wallet():
    """(the signing module, the bot's Keypair) — its repr shows only the public key."""
    from shared import solana
    return solana, solana.Keypair(secrets.get("SNIPER_SOL_SECRET"))


def _rpc():
    from shared import solana
    return solana.Rpc(os.environ.get("SOLANA_RPC_URL") or solana.MAINNET_RPC_URL)


def _wallet_usd(px_sol: float) -> float:
    _solana, kp = _wallet()
    return _rpc().get_balance(kp.pubkey_b58) / 1e9 * px_sol


def _swap(input_mint: str, output_mint: str, amount_raw: int, slippage_bps: int, priority: int) -> dict:
    """One swap from the bot wallet. A send whose answer was lost is looked up before anything else — never sent
    a second time (it may have gone through)."""
    solana, kp = _wallet()
    rpc = _rpc()
    try:
        res = solana.swap(rpc, kp, input_mint, output_mint, int(amount_raw), int(slippage_bps), int(priority))
    except solana.TransportError as exc:
        sig = getattr(exc, "signature", None)
        if not sig:
            raise
        res = {"signature": sig, "status": rpc.confirm(sig), "quote": {}}
    if res.get("status") not in ("confirmed", "finalized"):
        raise RuntimeError("swap not confirmed: %s (%s)" % (res.get("status"), res.get("signature")))
    return res


def buy(c: dict, pair: dict, sig: dict, rt: dict, s: dict, cfg: dict, now_ts: float) -> dict:
    """A position {…} — paper fills at the quoted price; live sends the swap from the bot wallet."""
    usd = float(s["trade_usd"])
    price = float(pair.get("price_usd") or 0)
    live = is_live(cfg) and c["chain"] in LIVE_CHAINS
    pos = {"chain": c["chain"], "address": c["address"], "symbol": (pair.get("base") or {}).get("symbol") or "",
           "pair": pair.get("pair_address") or "", "dex": pair.get("dex") or "", "url": pair.get("url") or "",
           "strategy": sig["strategy"], "why": sig["why"], "opened_at": market_clock.iso(now_ts),
           "entry_price": price, "cost_usd": usd, "stop_pct": float(sig["stop_pct"]), "peak_price": price,
           "entry_liquidity": pair.get("liquidity_usd"), "mode": "live" if live else "paper", "sold_part": False}
    if c["chain"] == "solana" and rt.get("tokens_raw"):
        pos["tokens_raw"] = int(rt["tokens_raw"])
        pos["entry_price"] = usd / max(1e-18, rt["tokens_raw"])  # per raw unit: what our size really paid
        pos["price_unit"] = "raw"
    else:
        impact = float(rt.get("impact_pct") or 0) + POOL_FEE_PCT.get(pair.get("dex"), 0.3)
        pos["entry_price"] = price * (1 + impact / 100.0)
        pos["tokens"] = usd / pos["entry_price"] if pos["entry_price"] else 0.0
        pos["price_unit"] = "usd"
    if live:
        _solana, kp = _wallet()
        held = _wallet_usd(rt["sol_usd"])
        if held > float(s["wallet_cap_usd"]):
            raise RuntimeError("the bot wallet holds %s — over its cap of %s; move the rest out first" % (
                fmt.money(held), fmt.money(float(s["wallet_cap_usd"]))))
        res = _swap(jupiter.SOL_MINT, c["address"], int(usd / rt["sol_usd"] * 1e9), int(s["slippage_bps"]),
                    int(s["priority_lamports"]))
        _ui, raw, _dec = _rpc().get_token_balance(kp.pubkey_b58, c["address"])
        if int(raw) <= 0:
            raise RuntimeError("bought (%s) but the wallet shows no %s yet" % (res.get("signature"), pos["symbol"]))
        pos.update(tokens_raw=int(raw), entry_price=usd / max(1, int(raw)), buy_tx=res.get("signature"))
    return pos


def value_now(pos: dict, pair: dict, s: dict) -> tuple:
    """(USD we would get selling all now, price used for stops) — a Jupiter sell quote on Solana."""
    if pos.get("price_unit") == "raw":
        px = sol_usd()
        try:
            q = jupiter.quote(pos["address"], jupiter.SOL_MINT, int(pos["tokens_raw"]), int(s["slippage_bps"]))
        except http.SourceError:
            return 0.0, 0.0  # no route back: as good as nothing
        usd = q["out_raw"] / 1e9 * px
        return usd, usd / max(1, int(pos["tokens_raw"]))
    price = float(pair.get("price_usd") or 0)
    liq = float(pair.get("liquidity_usd") or 0)
    gross = price * float(pos.get("tokens") or 0)
    impact = 100.0 * gross / (liq / 2.0) if liq > 0 else 100.0
    net = gross * max(0.0, 1 - (impact + POOL_FEE_PCT.get(pos.get("dex"), 0.3)) / 100.0)
    return net, net / float(pos["tokens"]) if pos.get("tokens") else 0.0


def sell(pos: dict, part: float, reason: str, s: dict, cfg: dict, now_ts: float, usd_now: float) -> dict:
    """Sell `part` (0–1) of a position: the USD received — paper at the quoted value, live through Jupiter."""
    got = usd_now * part
    if pos.get("mode") == "live":
        _solana, kp = _wallet()
        held = int(_rpc().get_token_balance(kp.pubkey_b58, pos["address"])[1])
        amount = held if part >= 1.0 else min(held, int(int(pos["tokens_raw"]) * part))  # never more than it holds
        if amount <= 0:
            return {"usd": 0.0, "part": part, "reason": reason + " (nothing left in the wallet)",
                    "at": market_clock.iso(now_ts)}
        # a falling meme coin moves fast: the sale gets twice the entry's slippage room
        res = _swap(pos["address"], jupiter.SOL_MINT, amount, int(s["slippage_bps"]) * 2, int(s["priority_lamports"]))
        got = int((res.get("quote") or {}).get("outAmount") or 0) / 1e9 * sol_usd() or usd_now * part
        pos.setdefault("sell_txs", []).append(res.get("signature"))
    return {"usd": round(got, 4), "part": part, "reason": reason, "at": market_clock.iso(now_ts)}


def manage(book: dict, s: dict, cfg: dict, now_ts: float, actions: list) -> None:
    """Every position, every cycle: stop, take part of the profit, trail, time out, run when the liquidity drains
    or the token turns dangerous."""
    if not book["positions"]:
        return
    ex = s["exits"]
    cands = [{"chain": p["chain"], "address": p["address"]} for p in book["positions"].values()]
    md = market_data(cands, now_ts)
    for key, pos in list(book["positions"].items()):
        pair = md.get((pos["chain"], pos["address"])) or {}
        try:
            usd, px = value_now(pos, pair, s)
        except http.SourceError:
            continue
        pos["peak_price"] = max(float(pos.get("peak_price") or 0), px)
        pos["value_usd"] = round(usd, 4)
        entry = float(pos["entry_price"]) or 1e-18
        gain = 100.0 * (px / entry - 1)
        held_h = (now_ts - market_clock.ts(pos["opened_at"])) / 3600.0
        reason = None
        liq0, liq = pos.get("entry_liquidity"), pair.get("liquidity_usd")
        if liq0 and liq is not None and liq < liq0 * (1 - float(ex["liquidity_drop_pct"]) / 100.0):
            reason = "liquidity drained %s → %s" % (fmt.compact_usd(liq0), fmt.compact_usd(liq))
        elif usd <= 0:
            reason = "no way to sell it any more"
        elif gain <= -float(pos["stop_pct"]):
            reason = "stop %.0f %%" % -pos["stop_pct"]
        elif pos.get("sold_part") and px <= pos["peak_price"] * (1 - float(ex["trail_pct"]) / 100.0):
            reason = "trailing stop, %.0f %% under the high" % ex["trail_pct"]
        elif held_h >= float(ex["time_stop_hours"]):
            reason = "time stop (%g h)" % ex["time_stop_hours"]
        else:
            saf = safety(pos, pair, s, now_ts) if pair else {"ok": True}
            if saf.get("verdict") == "DANGER" and any("rugged" in r.lower() or "authority" in r.lower()
                                                      for r in saf.get("reasons") or []):
                reason = "turned dangerous: %s" % (saf["reasons"] or ["?"])[0]
        try:
            if reason:
                fill = sell(pos, 1.0, reason, s, cfg, now_ts, usd)
                _close(book, key, pos, fill, now_ts, actions, cfg)
            elif not pos.get("sold_part") and gain >= float(ex["take_profit_pct"]):
                part = float(ex["take_profit_part"])
                fill = sell(pos, part, "take profit +%.0f %%" % gain, s, cfg, now_ts, usd)
                pos.setdefault("fills", []).append(fill)
                pos["sold_part"] = True
                pos["realized_usd"] = round(float(pos.get("realized_usd") or 0) + fill["usd"], 4)
                if pos.get("tokens_raw"):
                    pos["tokens_raw"] = int(int(pos["tokens_raw"]) * (1 - part))
                if pos.get("tokens"):
                    pos["tokens"] = float(pos["tokens"]) * (1 - part)
                actions.append("%s: sold %.0f %% at %+.0f %% — the rest trails %.0f %% under the high" % (
                    pos["symbol"], 100 * part, gain, ex["trail_pct"]))
        except Exception as exc:  # noqa: BLE001 — a failed sale is retried next cycle; said out loud
            actions.append("%s: sale failed (%s) — retried next cycle" % (pos["symbol"], exc))


def _close(book: dict, key: str, pos: dict, fill: dict, now_ts: float, actions: list, cfg: dict) -> None:
    pos.setdefault("fills", []).append(fill)
    got = float(pos.get("realized_usd") or 0) + fill["usd"]
    pnl = got - float(pos["cost_usd"])
    rec = dict(pos, closed_at=market_clock.iso(now_ts), exit_reason=fill["reason"], proceeds_usd=round(got, 4),
               pnl_usd=round(pnl, 4), pnl_pct=round(100 * pnl / float(pos["cost_usd"]), 1))
    state.append_jsonl(TRADES, rec)
    _day(book, now_ts)["pnl_usd"] = round(_day(book, now_ts)["pnl_usd"] + pnl, 4)
    del book["positions"][key]
    line = "%s sold (%s): %s → %s, %s" % (pos["symbol"], fill["reason"], fmt.money(pos["cost_usd"]), fmt.money(got),
                                         fmt.money(pnl))
    actions.append(line)
    notify.send("trade_closed", "Sniper: %s %s" % (pos["symbol"], fmt.money(pnl)), line, cfg)


# --- one cycle ----------------------------------------------------------------------------------------------

def cycle(cfg: dict, now_ts: float = None, trade: bool = True) -> dict:
    """Exits first, then discovery → checks → strategy → budget → buy. Every judged candidate is logged."""
    s = settings(cfg)
    now_ts = now_ts or market_clock.now_utc().timestamp()
    actions, notes, decisions = [], [], []
    book = _book()
    with state.locked("sniper/book.json", timeout=30):
        book = _book()
        manage(book, s, cfg, now_ts, actions)
        state.write_json(BOOK, book)
    cands = discover(cfg, now_ts, notes)[:max(1, int(s["candidates_per_cycle"])) * 3]
    md = market_data(cands, now_ts)
    judged = 0
    for c in cands:
        pair = md.get((c["chain"], c["address"]))
        if not pair or judged >= int(s["candidates_per_cycle"]):
            continue
        key = "%s:%s" % (c["chain"], c["address"])
        rec = {"at": market_clock.iso(now_ts), "key": key, "symbol": (pair.get("base") or {}).get("symbol"),
               "source": c["source"], "dex": pair.get("dex"), "price_usd": pair.get("price_usd"),
               "liquidity_usd": pair.get("liquidity_usd"), "age_min": round((now_ts - pair["created_at"]) / 60.0)
               if pair.get("created_at") else None}
        why = prefilter(c, pair, s, now_ts)
        if why:
            continue  # cheap skips aren't logged: hundreds a cycle, nothing to learn
        judged += 1
        saf = safety(c, pair, s, now_ts)
        rec.update(safety_score=saf.get("score"), safety=saf.get("verdict"))
        if not saf["ok"]:
            rec.update(action="skipped", reasons=["safety: " + r for r in saf["reasons"][:3]] or ["safety"])
        else:
            try:
                rt = roundtrip(c, pair, s)
            except (http.SourceError, ZeroDivisionError, KeyError) as exc:
                rt = None
                rec.update(action="skipped", reasons=["no way to sell our size back (%s) — honeypot or no liquidity"
                                                      % exc])
            if rt is not None:
                rec["roundtrip_loss_pct"] = rt["loss_pct"]
                if rt["loss_pct"] > float(s["max_roundtrip_loss_pct"]):
                    rec.update(action="skipped", reasons=["buying and selling %s back costs %.1f %% (max %s)" % (
                        fmt.money(float(s["trade_usd"])), rt["loss_pct"], s["max_roundtrip_loss_pct"])])
                else:
                    sig = signal(c, pair, s, now_ts)
                    rec["x_mentions_1h"] = x_mentions(pair, cfg) if sig else None
                    if not sig:
                        rec.update(action="watched", reasons=["no strategy fired"])
                    else:
                        rec.update(strategy=sig["strategy"], signal=sig["why"])
                        with state.locked("sniper/book.json", timeout=30):
                            book = _book()
                            refusal = budget_refusal(book, s, now_ts, key)
                            if refusal:
                                rec.update(action="skipped", reasons=[refusal])
                            elif not trade:
                                rec.update(action="signal", reasons=["scan only"])
                            else:
                                try:
                                    pos = buy(c, pair, sig, rt, s, cfg, now_ts)
                                except Exception as exc:  # noqa: BLE001
                                    rec.update(action="error", reasons=["buy failed: %s" % exc])
                                else:
                                    book["positions"][key] = pos
                                    book["traded"][key] = now_ts
                                    _day(book, now_ts)["trades"] += 1
                                    state.write_json(BOOK, book)
                                    rec.update(action="bought", mode=pos["mode"])
                                    line = "bought %s %s (%s, %s): %s" % (
                                        fmt.money(pos["cost_usd"]), pos["symbol"], sig["strategy"], pos["mode"],
                                        sig["why"])
                                    actions.append(line)
                                    notify.send("trade_opened", "Sniper: %s" % pos["symbol"], line + " · " +
                                                (pair.get("url") or ""), cfg)
        state.append_jsonl(CANDIDATES, rec)
        decisions.append(rec)
    track_outcomes(now_ts)
    return {"at": market_clock.iso(now_ts), "mode": "live" if is_live(cfg) else "paper", "actions": actions,
            "decisions": decisions, "notes": notes, "open": len(_book()["positions"])}


# --- what happened afterwards -------------------------------------------------------------------------------

def track_outcomes(now_ts: float, max_lookups: int = 60) -> int:
    """Price of every judged candidate 15 min, 1 h, 4 h and 24 h later — bought or not: the forward test."""
    rows = state.tail_jsonl(CANDIDATES, 3000)
    out_doc = state.read_json("sniper/outcomes.json", {}) or {}
    due = {}
    for r in rows:
        if not r.get("price_usd"):
            continue
        t0 = market_clock.ts(r["at"])
        o = out_doc.get(r["key"] + "@" + r["at"]) or {}
        for name, sec in CHECKPOINTS:
            if name not in o and now_ts - t0 >= sec and now_ts - t0 < sec + 86400:
                due.setdefault(r["key"], []).append((r, name))
    if not due:
        return 0
    keys = list(due)[:max_lookups]
    cands = [{"chain": k.split(":", 1)[0], "address": k.split(":", 1)[1]} for k in keys]
    md = market_data(cands, now_ts)
    n = 0
    for k in keys:
        pair = md.get(tuple(k.split(":", 1)))
        for r, name in due[k]:
            o = out_doc.setdefault(r["key"] + "@" + r["at"], {})
            px = (pair or {}).get("price_usd")
            o[name] = round(100.0 * (float(px) / float(r["price_usd"]) - 1), 1) if px else -100.0  # gone = rugged
            n += 1
    if len(out_doc) > 5000:
        for k in sorted(out_doc)[:1000]:
            out_doc.pop(k, None)
    state.write_json("sniper/outcomes.json", out_doc)
    return n


def report() -> dict:
    rows = state.tail_jsonl(CANDIDATES, 5000)
    outs = state.read_json("sniper/outcomes.json", {}) or {}
    groups = {}
    for r in rows:
        o = outs.get(r["key"] + "@" + r["at"])
        if not o:
            continue
        g = "%s · %s" % (r.get("action"), r.get("strategy") or (r.get("reasons") or ["?"])[0].split(":")[0][:40])
        groups.setdefault(g, []).append(o)
    out = {}
    for g, os_ in groups.items():
        row = {"n": len(os_)}
        for name, _ in CHECKPOINTS:
            vals = sorted(o[name] for o in os_ if name in o)
            if vals:
                row[name] = {"median_pct": vals[len(vals) // 2], "up": round(sum(1 for v in vals if v > 0) / len(vals), 2),
                             "rugged": round(sum(1 for v in vals if v <= -90) / len(vals), 2), "n": len(vals)}
        out[g] = row
    trades = state.tail_jsonl(TRADES, 1000)
    pnl = sum(float(t.get("pnl_usd") or 0) for t in trades)
    return {"groups": out, "trades": len(trades), "pnl_usd": round(pnl, 2),
            "wins": sum(1 for t in trades if (t.get("pnl_usd") or 0) > 0)}


# --- wallet -------------------------------------------------------------------------------------------------

def wallet_new() -> str:
    """A fresh keypair for the bot alone, saved to trader/secrets.env (0600). Prints only the address. Refuses when
    one exists — a funded wallet's key is never overwritten."""
    if secrets.has("SNIPER_SOL_SECRET"):
        raise ValueError("a bot wallet already exists (SNIPER_SOL_SECRET) — remove it yourself if you really mean to")
    from shared import solana
    secret, pub = solana.new_keypair()
    path = config.ensure_home() / "secrets.env"
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, ("\n# the meme sniper's own wallet - keep only a small amount of SOL in it\n"
                      "SNIPER_SOL_SECRET=%s\n" % solana.b58encode(secret)).encode("ascii"))
    finally:
        os.close(fd)
    os.chmod(str(path), 0o600)
    return solana.b58encode(pub)


# --- text ---------------------------------------------------------------------------------------------------

def cycle_text(res: dict) -> str:
    lines = ["SNIPER · %s · %s · %d open" % (res["mode"].upper(), res["at"], res["open"])]
    for a in res["actions"]:
        lines.append("  " + a)
    for d in res["decisions"]:
        lines.append("  %-8s %-12s %-10s %s" % (d.get("action"), d.get("symbol") or "?", d.get("strategy") or "",
                                               "; ".join(d.get("reasons") or [d.get("signal") or ""])[:120]))
    for n in res["notes"][:5]:
        lines.append("  note: " + n)
    return "\n".join(lines)


def status_text(cfg: dict) -> str:
    s = settings(cfg)
    book = _book()
    now_ts = market_clock.now_utc().timestamp()
    day = _day(book, now_ts)
    ok, missing = live_readiness(cfg)
    lines = ["SNIPER · %s · %s/trade · cap %s open · %d/%s trades today · today %s" % (
        "LIVE" if ok else "PAPER", fmt.money(float(s["trade_usd"])), fmt.money(float(s["max_open_usd"])),
        day["trades"], s["max_trades_per_day"], fmt.money(day["pnl_usd"]))]
    for p in book["positions"].values():
        lines.append("  %-10s %-9s %s → %s  (%s, %s)" % (p["symbol"], p["strategy"], fmt.money(p["cost_usd"]),
                                                        fmt.money(p.get("value_usd")), p["mode"], p["url"]))
    if not ok:
        lines.append("Live: off — " + "; ".join(missing))
    return "\n".join(lines)


def build_parser():
    p = cli.parser("sniper.py", __doc__)
    p.add_argument("action", choices=("scan", "run", "status", "season", "report", "wallet", "check-live", "sell",
                                      "kill"))
    p.add_argument("target", nargs="?", help="wallet: new | address | balance · sell: the token address")
    p.add_argument("--loop", action="store_true", help="run: keep going every interval_sec")
    p.add_argument("--max-cycles", type=int, help="run --loop: stop after N cycles")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    cfg = ctx.cfg
    s = settings(cfg)
    if args.action == "season":
        doc = season(cfg, market_clock.now_utc().timestamp(), force=True)
        text = "\n".join(["MEME SEASON · %s" % doc["at"]] + [
            "  %-9s %3.0f %%  %s young pools, %s volume in the last hour · %s" % (
                c, 100 * doc["chains"][c]["share"], doc["chains"][c]["young_pools"],
                fmt.compact_usd(doc["chains"][c]["volume_h1"]), ", ".join(doc["chains"][c]["launchpads"]))
            for c in doc["hot"]] + ["  note: %s" % n for n in doc["notes"]])
        cli.emit(args, text, doc)
        return 0
    if args.action in ("scan", "run"):
        if args.action == "run" and not s.get("enabled"):
            cli.fail('the sniper is off — set "sniper": {"enabled": true} in config.json (paper unless live is set up)')
        n = 0
        while True:
            res = cycle(cfg, trade=args.action == "run")
            cli.emit(args, cycle_text(res), res)
            n += 1
            if not (args.action == "run" and args.loop) or (args.max_cycles and n >= args.max_cycles):
                return 0
            time.sleep(max(15, int(s["interval_sec"])))
            cfg = config.load_config()
            s = settings(cfg)
            if not s.get("enabled"):
                return 0
    if args.action == "status":
        cli.emit(args, status_text(cfg), {"book": _book(), "live": live_readiness(cfg)})
        return 0
    if args.action == "report":
        rep = report()
        lines = ["SNIPER REPORT · %d trades · %s · %d won" % (rep["trades"], fmt.money(rep["pnl_usd"]), rep["wins"]),
                 "What happened to judged candidates afterwards (median change · share up · share rugged):"]
        for g, row in sorted(rep["groups"].items(), key=lambda kv: -kv[1]["n"]):
            parts = ["%s %+.0f%% %.0f%%↑ %.0f%%☠" % (k, row[k]["median_pct"], 100 * row[k]["up"], 100 * row[k]["rugged"])
                     for k, _ in CHECKPOINTS if k in row]
            lines.append("  %-50s n=%-4d %s" % (g[:50], row["n"], " · ".join(parts)))
        cli.emit(args, "\n".join(lines), rep)
        return 0
    if args.action == "check-live":
        ok, missing = live_readiness(cfg)
        cli.emit(args, "Sniper live trading is %s." % ("READY (Solana)" if ok else "OFF") +
                 "".join("\n  missing: %s" % m for m in missing), {"live_ready": ok, "missing": missing})
        return 0
    if args.action == "wallet":
        if args.target == "new":
            try:
                addr = wallet_new()
            except ValueError as exc:
                cli.fail(str(exc))
            cli.emit(args, "New bot wallet: %s\nSend it only what the sniper may trade (e.g. 0.5–1 SOL). The key is in "
                     "trader/secrets.env (0600) — never shown, never sent anywhere." % addr, {"address": addr})
            return 0
        if not secrets.has("SNIPER_SOL_SECRET"):
            cli.fail("no bot wallet yet — sniper.py wallet new")
        _solana, kp = _wallet()
        addr = kp.pubkey_b58
        bal = None
        if args.target == "balance":
            bal = round(_wallet_usd(sol_usd()), 2)
        cli.emit(args, "Bot wallet: %s%s" % (addr, "" if bal is None else " · %s" % fmt.money(bal)),
                 {"address": addr, "usd": bal})
        return 0
    if args.action in ("sell", "kill"):
        actions = []
        now_ts = market_clock.now_utc().timestamp()
        with state.locked("sniper/book.json", timeout=30):
            book = _book()
            md = market_data([{"chain": p["chain"], "address": p["address"]} for p in book["positions"].values()], now_ts)
            for key, pos in list(book["positions"].items()):
                if args.action == "sell" and pos["address"] != args.target:
                    continue
                usd, _ = value_now(pos, md.get((pos["chain"], pos["address"])) or {}, s)
                _close(book, key, pos, sell(pos, 1.0, "by hand" if args.action == "sell" else "kill switch", s, cfg,
                                            now_ts, usd), now_ts, actions, cfg)
            state.write_json(BOOK, book)
        if args.action == "kill":
            config.update_file("config.json", {"sniper": {"enabled": False}})
            actions.append("sniper switched off (sniper.enabled = false)")
        cli.emit(args, "\n".join(actions) or "nothing to sell", {"actions": actions})
        return 0
    return 0


if __name__ == "__main__":
    cli.run(main)
