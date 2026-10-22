#!/usr/bin/env python3
"""Collect an unbiased sample of new meme-coin pools + their early OHLCV, stdlib only.

Pools are sampled by *creation time*, never by later success:

* ``gt-new``      GeckoTerminal ``/networks/{net}/new_pools`` (10 pages x 20 pools max on the
                  free API; reaches back ~10 min on Solana, ~1 h on BSC, ~3 h on Base)
* ``pump-new``    pump.fun ``/coins?sort=created_timestamp`` (all new bonding-curve coins,
                  dead ones included; offset is capped around 1000, i.e. ~45-60 min back)
* ``pump-grad``   pump.fun ``/coins?...&complete=true`` (coins that graduated to PumpSwap,
                  sorted by creation time; ~1000 coins, ~1-1.5 days back)

Because the free endpoints only reach back minutes to hours, ``record`` keeps polling them on a
cadence shorter than their depth so nothing created during the recording window is missed (or,
for Solana where 200 pools last ~10 minutes, so pools are sampled at regular clock times).

Bars:
* GeckoTerminal pools: 1-minute OHLCV for the first 1000 minutes after the pool opened, plus a
  pool-info snapshot (reserve_in_usd, price, fdv) used to anchor the liquidity model.
* pump.fun bonding-curve coins: pump.fun's own 1-minute candles (only minutes with trades).

Everything is appended to ``data/*.jsonl`` so the backtest runs offline and reproducibly.

    python3 collect.py discover --sources gt-new pump-new pump-grad --networks solana bsc base
    python3 collect.py record --hours 5            # forward recorder (background)
    python3 collect.py bars --min-age-h 2.5        # fetch OHLCV for pools old enough
    python3 collect.py status
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
POOLS_FILE = os.path.join(DATA, "pools.jsonl")
BARS_FILE = os.path.join(DATA, "bars.jsonl")
LOG_FILE = os.path.join(DATA, "collect_log.jsonl")

GT = "https://api.geckoterminal.com/api/v2"
PUMP = "https://frontend-api-v3.pump.fun"
PUMP_SWAP_API = "https://swap-api.pump.fun"
DEXSCREENER = "https://api.dexscreener.com"
DS_FILE = os.path.join(DATA, "dexscreener.jsonl")

UA = "Mozilla/5.0 (compatible; sniper-backtest/0.1; research, low rate)"
# seconds between requests per host; GeckoTerminal's free tier is ~30/min shared per IP,
# and the proxy IP is shared, so stay well under it
MIN_INTERVAL = {"api.geckoterminal.com": float(os.environ.get("GT_INTERVAL", "4.0")), "frontend-api-v3.pump.fun": 0.4,
                "swap-api.pump.fun": 0.4, "api.dexscreener.com": 0.4}
_last = {}
STATS = {"requests": 0, "429": 0, "errors": 0}

# tokens that are the *quote* side of meme pools; if GT lists one as base we ask for the other
QUOTE_TOKENS = {
    "solana": {"So11111111111111111111111111111111111111112",
               "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",   # USDC
               "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",   # USDT
               "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"},
    "bsc": {"0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",          # WBNB
            "0x55d398326f99059ff775485246999027b3197955",          # USDT
            "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",          # USDC
            "0xe9e7cea3dedca5984780bafc599bd69add087d56",          # BUSD
            "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",          # USD1
            "0x0000000000000000000000000000000000000000"},
    "base": {"0x4200000000000000000000000000000000000006",         # WETH
             "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",         # USDC
             "0x0000000000000000000000000000000000000000"},
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def get_json(url: str, tries: int = 6):
    """GET with per-host pacing and exponential back-off on 429/5xx. Returns (status, obj)."""
    host = urlsplit(url).hostname
    gap = MIN_INTERVAL.get(host, 0.5)
    for attempt in range(tries):
        wait = _last.get(host, 0) + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.time()
        STATS["requests"] += 1
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read()[:300]
            if e.code == 429 or e.code >= 500:
                STATS["429" if e.code == 429 else "errors"] += 1
                ra = e.headers.get("Retry-After")
                # GeckoTerminal answers Retry-After: 0-3 s while the per-minute window is still full;
                # retrying that fast only burns the shared quota, so back off for real
                delay = max(float(ra) if ra and ra.isdigit() else 0.0, min(120, 10 * 2 ** attempt))
                delay += random.uniform(0, 3)
                log("HTTP %d on %s -> sleeping %.0fs" % (e.code, host, delay))
                time.sleep(delay)
                continue
            try:
                return e.code, json.loads(body)
            except ValueError:
                return e.code, {"raw": body.decode("utf-8", "replace")}
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            STATS["errors"] += 1
            delay = min(60, 5 * 2 ** attempt)
            log("network error %r on %s -> sleeping %ds" % (e, host, delay))
            time.sleep(delay)
    return None, None


def append_jsonl(path: str, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


def read_jsonl(path: str):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue  # a half-written last line from an interrupted run
    return out


def iso_to_ts(s):
    if not s:
        return None
    import datetime as _dt
    return int(_dt.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(
        tzinfo=_dt.timezone.utc).timestamp())


def fnum(x):
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


# ----------------------------------------------------------------------------- discovery

def _gt_pool_row(net: str, p: dict, now: int, source: str) -> dict:
    a = p.get("attributes") or {}
    rel = p.get("relationships") or {}
    base = ((rel.get("base_token") or {}).get("data") or {}).get("id", "")
    quote = ((rel.get("quote_token") or {}).get("data") or {}).get("id", "")
    base_addr = base.split("_", 1)[-1]
    quote_addr = quote.split("_", 1)[-1]
    quotes = QUOTE_TOKENS.get(net, set())
    norm = (lambda s: s.lower()) if net != "solana" else (lambda s: s)
    # the meme token is whichever side is not a known quote asset
    token_side = "quote" if norm(base_addr) in {norm(q) for q in quotes} and \
        norm(quote_addr) not in {norm(q) for q in quotes} else "base"
    return {
        "key": "gt:%s:%s" % (net, a.get("address")),
        "source": source, "network": net, "address": a.get("address"),
        "dex": ((rel.get("dex") or {}).get("data") or {}).get("id"),
        "name": a.get("name"), "base_token": base_addr, "quote_token": quote_addr,
        "token_side": token_side,
        "created_ts": iso_to_ts(a.get("pool_created_at")), "seen_ts": now,
        "snap": {"reserve_usd": fnum(a.get("reserve_in_usd")), "fdv_usd": fnum(a.get("fdv_usd")),
                 "mcap_usd": fnum(a.get("market_cap_usd")),
                 "base_price_usd": fnum(a.get("base_token_price_usd")),
                 "quote_price_usd": fnum(a.get("quote_token_price_usd")),
                 "vol_h1": fnum((a.get("volume_usd") or {}).get("h1")),
                 "tx_h1": (a.get("transactions") or {}).get("h1")},
    }


def ds_pairs(net: str, addrs):
    """DexScreener pair state (30 per request). GeckoTerminal reports reserve_in_usd = 0 for many
    Uniswap v4 / CL pools; DexScreener's liquidity.usd fills that gap."""
    out = {}
    addrs = [a for a in addrs if a]
    for i in range(0, len(addrs), 30):
        chunk = addrs[i:i + 30]
        st, d = get_json("%s/latest/dex/pairs/%s/%s" % (DEXSCREENER, net, ",".join(chunk)))
        if st != 200 or not isinstance(d, dict):
            continue
        for p in d.get("pairs") or []:
            a = p.get("pairAddress") or ""
            out[a if net == "solana" else a.lower()] = {
                "ds_liq_usd": fnum((p.get("liquidity") or {}).get("usd")),
                "ds_price_usd": fnum(p.get("priceUsd")),
                "ds_base_token": (p.get("baseToken") or {}).get("address"),
                "ds_fdv": fnum(p.get("fdv")), "ds_ts": int(time.time())}
    return out


def _attach_ds(net, rows):
    ds = ds_pairs(net, [r["address"] for r in rows])
    for r in rows:
        x = ds.get(r["address"] if net == "solana" else (r["address"] or "").lower())
        if x:
            r["snap"].update(x)
    return rows


def discover_gt_new(networks, pages=10):
    now = int(time.time())
    rows, depth = [], {}
    for net in networks:
        oldest = None
        for page in range(1, pages + 1):
            st, d = get_json("%s/networks/%s/new_pools?page=%d" % (GT, net, page))
            if st != 200 or not isinstance(d, dict) or not d.get("data"):
                log("gt-new %s page %d -> %s" % (net, page, st))
                break
            for p in d["data"]:
                r = _gt_pool_row(net, p, now, "gt-new")
                rows.append(r)
                if r["created_ts"]:
                    oldest = r["created_ts"] if oldest is None else min(oldest, r["created_ts"])
        _attach_ds(net, [r for r in rows if r["network"] == net])
        depth[net] = (now - oldest) / 60.0 if oldest else None
        log("gt-new %s: depth %.1f min" % (net, depth[net] or -1))
    return rows, depth


def _pump_row(c: dict, now: int, source: str) -> dict:
    mcap_usd = fnum(c.get("usd_market_cap")) or fnum(c.get("market_cap_usd"))
    mcap_q = fnum(c.get("market_cap_quote")) or fnum(c.get("market_cap"))
    qdec = int(c.get("quote_decimals") or 9)
    bdec = int(c.get("base_decimals") or 6)
    supply = fnum(c.get("total_supply")) or 1e15
    vq = fnum(c.get("virtual_quote_reserves")) or fnum(c.get("virtual_sol_reserves"))
    quote_usd = (mcap_usd / mcap_q) if mcap_usd and mcap_q else None
    return {
        "key": "pump:%s" % c.get("mint"), "source": source, "network": "solana",
        "address": c.get("bonding_curve"), "mint": c.get("mint"), "dex": "pump-fun",
        "name": "%s / %s" % (c.get("symbol"), "SOL" if (c.get("quote_mint") or "").startswith("1111")
                             or not c.get("quote_mint") else c.get("quote_mint")[:6]),
        "created_ts": int((c.get("created_timestamp") or 0) / 1000) or None, "seen_ts": now,
        "complete": bool(c.get("complete")), "pump_swap_pool": c.get("pump_swap_pool"),
        "quote_mint": c.get("quote_mint"),
        "snap": {"mcap_usd": mcap_usd, "fdv_usd": mcap_usd,
                 "price_usd": (mcap_usd / (supply / 10 ** bdec)) if mcap_usd else None,
                 # virtual quote reserve in USD: what a bonding-curve trade actually prices against
                 "virtual_quote_usd": (vq / 10 ** qdec * quote_usd) if vq and quote_usd else None,
                 "ath_mcap_usd": fnum(c.get("ath_market_cap")),
                 "last_trade_ts": int((c.get("last_trade_timestamp") or 0) / 1000) or None},
    }


def discover_pump(complete: bool, max_offset=2000, limit=50):
    now = int(time.time())
    rows, offset, oldest = [], 0, None
    src = "pump-grad" if complete else "pump-new"
    while offset <= max_offset:
        url = ("%s/coins?sort=created_timestamp&order=DESC&limit=%d&offset=%d&includeNsfw=true%s"
               % (PUMP, limit, offset, "&complete=true" if complete else ""))
        st, d = get_json(url)
        if st != 200 or not isinstance(d, list) or not d:
            break
        for c in d:
            r = _pump_row(c, now, src)
            if complete and r.get("pump_swap_pool"):
                # the graduated coin is traded on its PumpSwap pool: sample that pool
                r = dict(r, key="gt:solana:%s" % r["pump_swap_pool"], address=r["pump_swap_pool"],
                         dex="pumpswap", base_token=r["mint"], token_side="base",
                         coin_created_ts=r["created_ts"], created_ts=None)
            rows.append(r)
            ts = r.get("coin_created_ts") or r.get("created_ts")
            if ts:
                oldest = ts if oldest is None else min(oldest, ts)
        offset += limit
    depth = (now - oldest) / 3600.0 if oldest else None
    log("%s: %d coins, max offset %d, depth %.2f h" % (src, len(rows), offset - limit, depth or -1))
    return rows, depth


def cmd_discover(args):
    allrows, info = [], {}
    if "gt-new" in args.sources:
        rows, depth = discover_gt_new(args.networks)
        allrows += rows
        info["gt-new-depth-min"] = depth
    if "pump-new" in args.sources:
        rows, depth = discover_pump(False)
        allrows += rows
        info["pump-new-depth-h"] = depth
    if "pump-grad" in args.sources:
        rows, depth = discover_pump(True)
        allrows += rows
        info["pump-grad-depth-h"] = depth
    append_jsonl(POOLS_FILE, allrows)
    append_jsonl(LOG_FILE, [{"ts": int(time.time()), "cmd": "discover", "sources": args.sources,
                             "networks": args.networks, "rows": len(allrows), **info,
                             "http": dict(STATS)}])
    log("discover: %d rows appended %s" % (len(allrows), info))


def cmd_record(args):
    """Forward recorder: poll each source on a cadence shorter than how far back it reaches."""
    cadence = {"gt:solana": args.solana_every_min * 60, "gt:bsc": 45 * 60, "gt:base": 120 * 60,
               "pump-new": 40 * 60, "pump-grad": 6 * 3600}
    nets = {"gt:" + n for n in args.networks}
    due = {k: 0 for k in cadence if (k in nets or not k.startswith("gt:"))}
    end = time.time() + args.hours * 3600
    while time.time() < end:
        now = time.time()
        for k in sorted(due):
            if due[k] > now:
                continue
            try:
                if k.startswith("gt:"):
                    net = k[3:]
                    pages = args.solana_pages if net == "solana" else 10
                    rows, depth = discover_gt_new([net], pages=pages)
                    info = {"depth_min": depth.get(net)}
                else:
                    rows, depth = discover_pump(k == "pump-grad")
                    info = {"depth_h": depth}
                append_jsonl(POOLS_FILE, rows)
                append_jsonl(LOG_FILE, [{"ts": int(time.time()), "cmd": "record", "source": k,
                                         "rows": len(rows), **info, "http": dict(STATS)}])
            except Exception as e:  # keep recording; one bad response must not end the run
                log("record %s failed: %r" % (k, e))
            due[k] = now + cadence[k]
        time.sleep(20)


# ----------------------------------------------------------------------------- bars

def load_pools():
    """Merge discovery rows per key: earliest snapshot kept as 'first_snap' (closest to listing)."""
    pools = {}
    for r in read_jsonl(POOLS_FILE):
        k = r.get("key")
        if not k:
            continue
        if k not in pools:
            r = dict(r)
            r["first_snap"] = r.get("snap")
            r["first_seen_ts"] = r.get("seen_ts")
            r["n_seen"] = 1
            pools[k] = r
        else:
            p = pools[k]
            p["n_seen"] += 1
            p["last_snap"] = r.get("snap")
            for f in ("created_ts", "coin_created_ts", "complete", "pump_swap_pool"):
                if r.get(f) and not p.get(f):
                    p[f] = r[f]
            # first non-empty reserve snapshot is the best 'at listing' liquidity we have
            fs = p.get("first_snap") or {}
            if not fs.get("reserve_usd") and (r.get("snap") or {}).get("reserve_usd"):
                p["first_reserve_snap"] = dict(r["snap"], seen_ts=r.get("seen_ts"))
    return pools


def load_bars():
    out = {}
    for r in read_jsonl(BARS_FILE):
        out[r["key"]] = r  # the latest fetch wins
    return out


def gt_pool_info(net: str, addrs):
    """Current pool attributes via the multi endpoint (30 pools per request)."""
    out = {}
    for i in range(0, len(addrs), 30):
        chunk = addrs[i:i + 30]
        st, d = get_json("%s/networks/%s/pools/multi/%s" % (GT, net, ",".join(chunk)))
        if st != 200 or not isinstance(d, dict):
            log("multi %s -> %s" % (net, st))
            continue
        for p in d.get("data") or []:
            a = p.get("attributes") or {}
            out[a.get("address")] = {
                "created_ts": iso_to_ts(a.get("pool_created_at")),
                "reserve_usd": fnum(a.get("reserve_in_usd")), "fdv_usd": fnum(a.get("fdv_usd")),
                "base_price_usd": fnum(a.get("base_token_price_usd")),
                "quote_price_usd": fnum(a.get("quote_token_price_usd")),
                "vol_h24": fnum((a.get("volume_usd") or {}).get("h24")),
                "dex": ((p.get("relationships") or {}).get("dex") or {}).get("data", {}).get("id"),
                "base_token": (((p.get("relationships") or {}).get("base_token") or {})
                               .get("data") or {}).get("id", "").split("_", 1)[-1],
            }
    return out


def gt_minute_bars(net: str, addr: str, created_ts: int, token_side: str, minutes=1000):
    end = min(int(time.time()), created_ts + minutes * 60 + 60)
    url = ("%s/networks/%s/pools/%s/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=%s"
           "&before_timestamp=%d" % (GT, net, addr, token_side, end))
    st, d = get_json(url)
    if st != 200 or not isinstance(d, dict):
        return st, None
    rows = (((d.get("data") or {}).get("attributes") or {}).get("ohlcv_list")) or []
    bars = sorted([[int(r[0])] + [float(x) for x in r[1:6]] for r in rows if len(r) >= 6])
    return st, bars


def pump_candles(mint: str, created_ts: int):
    url = ("%s/v2/coins/%s/candles?interval=1m&limit=1000&currency=USD&createdTs=%d"
           % (PUMP_SWAP_API, mint, created_ts * 1000))
    st, d = get_json(url)
    if st != 200 or not isinstance(d, list):
        return st, None
    bars = []
    for c in d:
        try:
            bars.append([int(c["timestamp"] // 1000), float(c["open"]), float(c["high"]),
                         float(c["low"]), float(c["close"]), float(c["volume"])])
        except (KeyError, TypeError, ValueError):
            continue
    return st, sorted(bars)


def pump_coin(mint: str):
    st, d = get_json("%s/coins/%s" % (PUMP, mint))
    return d if st == 200 and isinstance(d, dict) else None


def _select(pools, have, args, now):
    """Pools to fetch: old enough, not fetched yet (or fetched too young), systematic sample."""
    picked = []
    for k, p in sorted(pools.items(), key=lambda kv: (kv[1].get("created_ts")
                                                      or kv[1].get("coin_created_ts") or 0)):
        if args.sources and p.get("source") not in args.sources:
            continue
        if args.networks and p.get("network") not in args.networks:
            continue
        ts = p.get("created_ts") or p.get("coin_created_ts")
        if not ts or now - ts < args.min_age_h * 3600:
            continue
        if args.created_before and ts >= args.created_before:
            continue
        if p.get("source") == "gt-new" and p.get("network") == "solana" and p.get("dex") == "pump-fun":
            continue    # pump.fun curves are sampled through pump.fun itself (pump-new)
        b = have.get(k)
        # a pool is fetched once it is old enough; re-fetched only if that fetch was younger or
        # failed (a failed fetch must never pass for a pool without trades)
        if b and b.get("status") == 200 and \
                (b.get("fetched_ts", 0) - ts) >= min(args.refetch_below_h, args.min_age_h) * 3600:
            continue
        picked.append(k)
    # deterministic systematic sample by a hash of the key: independent of outcome and time
    net_share = dict((kv.split("=")[0], float(kv.split("=")[1])) for kv in (args.net_sample or []))
    if args.sample < 1.0 or net_share:
        import hashlib
        picked = [k for k in picked
                  if int(hashlib.sha1(k.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
                  < net_share.get(pools[k].get("network"), args.sample)]
    if args.max_pools:
        picked = picked[:args.max_pools]
    return picked


def cmd_bars(args):
    while True:
        n = _bars_pass(args)
        if not args.loop_until or time.time() >= args.loop_until:
            break
        if n == 0:
            time.sleep(300)


def _bars_pass(args):
    pools = load_pools()
    have = load_bars()
    now = int(time.time())
    keys = _select(pools, have, args, now)
    log("bars: %d pools to fetch" % len(keys))
    gt_keys = [k for k in keys if k.startswith("gt:")]
    pump_keys = [k for k in keys if k.startswith("pump:")]
    if args.grad_via_pump:
        # graduated coins' PumpSwap pools without GeckoTerminal (its free quota is shared with the
        # running paper sniper): pump.fun's 1-minute coin candles from the migration on, and the
        # pool's current DexScreener liquidity as the depth anchor (LP is burned on PumpSwap)
        grad = [k for k in gt_keys if pools[k].get("source") == "pump-grad"]
        gt_keys = [k for k in gt_keys if k not in grad]
        ds = ds_pairs("solana", [pools[k]["address"] for k in grad])
        dsc = {}
        for i in range(0, len(grad), 30):   # pairCreatedAt = the migration
            chunk = [pools[k]["address"] for k in grad[i:i + 30]]
            st, d = get_json("%s/latest/dex/pairs/solana/%s" % (DEXSCREENER, ",".join(chunk)))
            for p in (d or {}).get("pairs") or [] if isinstance(d, dict) else []:
                dsc[p.get("pairAddress")] = int((p.get("pairCreatedAt") or 0) / 1000) or None
        batch = []
        for i, k in enumerate(grad):
            p = pools[k]
            created = dsc.get(p["address"]) or p.get("coin_created_ts")
            st, bars = pump_candles(p["base_token"], p.get("coin_created_ts") or created)
            bars = [b for b in (bars or []) if b[0] >= (created or 0) // 60 * 60]
            x = ds.get(p["address"]) or {}
            info = {"reserve_usd": x.get("ds_liq_usd"), "base_price_usd": x.get("ds_price_usd")
                    if x.get("ds_base_token") == p["base_token"] else None, "dex": "pumpswap",
                    "created_ts": created, "ds": x}
            batch.append({"key": k, "fetched_ts": int(time.time()), "status": st, "tf": 60, "bars": bars,
                          "src": "pump-candles-grad", "token_side": "base", "pool_created_ts": created,
                          "info": info})
            if len(batch) >= 25:
                append_jsonl(BARS_FILE, batch)
                batch = []
                log("grad via pump %d/%d" % (i + 1, len(grad)))
        append_jsonl(BARS_FILE, batch)

    # pump.fun bonding-curve coins: own candles + current coin state (separate host, cheap)
    batch = []
    for i, k in enumerate(pump_keys):
        p = pools[k]
        st, bars = pump_candles(p["mint"], p["created_ts"])
        coin = None   # pump.fun's /coins/{mint} answers 404 now; the snapshots carry the curve state
        cur = _pump_row(coin, now, "refresh") if coin else None
        batch.append({"key": k, "fetched_ts": int(time.time()), "status": st, "tf": 60,
                      "bars": bars or [], "src": "pump-candles",
                      "info": {"complete": bool(coin and coin.get("complete")),
                               "pump_swap_pool": coin and coin.get("pump_swap_pool"),
                               "now": cur and cur["snap"]}})
        if len(batch) >= 25:
            append_jsonl(BARS_FILE, batch)
            batch = []
            log("pump bars %d/%d" % (i + 1, len(pump_keys)))
    append_jsonl(BARS_FILE, batch)

    # GeckoTerminal pools, grouped per network for the multi-info call
    by_net = {}
    for k in gt_keys:
        by_net.setdefault(pools[k]["network"], []).append(k)
    for net, ks in by_net.items():
        info = gt_pool_info(net, [pools[k]["address"] for k in ks])
        batch = []
        for i, k in enumerate(ks):
            p = pools[k]
            inf = info.get(p["address"]) or {}
            created = p.get("created_ts") or inf.get("created_ts") or p.get("coin_created_ts")
            side = p.get("token_side") or "base"
            if inf.get("base_token") and p.get("base_token") and inf["base_token"] != p["base_token"]:
                side = "quote"
            st, bars = gt_minute_bars(net, p["address"], created, side)
            batch.append({"key": k, "fetched_ts": int(time.time()), "status": st, "tf": 60,
                          "bars": bars or [], "src": "gt-minute", "token_side": side,
                          "pool_created_ts": created, "info": inf})
            if len(batch) >= 10:
                append_jsonl(BARS_FILE, batch)
                batch = []
                log("gt bars %s %d/%d (http %s)" % (net, i + 1, len(ks), STATS))
        append_jsonl(BARS_FILE, batch)
    append_jsonl(LOG_FILE, [{"ts": int(time.time()), "cmd": "bars", "args": vars(args),
                             "fetched": len(keys), "http": dict(STATS)}])
    return len(keys)


def cmd_ds(args):
    """Current DexScreener liquidity for every GeckoTerminal pool that has bars.

    With --snapshot: one extra discovery snapshot (DexScreener only) for every gt-new pool, used
    for pools discovered before DexScreener was attached to discovery."""
    pools = load_pools()
    if args.snapshot:
        now = int(time.time())
        by_net = {}
        for k, p in pools.items():
            if p.get("source") == "gt-new":
                by_net.setdefault(p["network"], []).append(p)
        rows = []
        for net, ps in by_net.items():
            ds = ds_pairs(net, [p["address"] for p in ps])
            for p in ps:
                x = ds.get(p["address"] if net == "solana" else p["address"].lower())
                if x:
                    rows.append({k2: p.get(k2) for k2 in ("key", "source", "network", "address", "dex",
                                                          "name", "base_token", "quote_token",
                                                          "token_side", "created_ts")}
                                | {"seen_ts": now, "snap": x})
        append_jsonl(POOLS_FILE, rows)
        log("ds snapshot: %d pools" % len(rows))
        return
    have = load_bars()
    done = {r["key"] for r in read_jsonl(DS_FILE)} if not args.all else set()
    by_net = {}
    for k in have:
        p = pools.get(k)
        if p and k.startswith("gt:") and k not in done:
            by_net.setdefault(p["network"], []).append(p)
    rows = []
    for net, ps in by_net.items():
        ds = ds_pairs(net, [p["address"] for p in ps])
        for p in ps:
            x = ds.get(p["address"] if net == "solana" else p["address"].lower())
            rows.append(dict(x or {}, key=p["key"], ts=int(time.time())))
    append_jsonl(DS_FILE, rows)
    log("ds: %d pools" % len(rows))


def cmd_status(args):
    pools = load_pools()
    have = load_bars()
    now = time.time()
    agg = {}
    for k, p in pools.items():
        g = (p.get("source"), p.get("network"))
        a = agg.setdefault(g, {"pools": 0, "with_bars": 0, "oldest_h": 0, "newest_h": 1e9})
        a["pools"] += 1
        a["with_bars"] += 1 if k in have else 0
        ts = p.get("created_ts") or p.get("coin_created_ts")
        if ts:
            a["oldest_h"] = max(a["oldest_h"], (now - ts) / 3600)
            a["newest_h"] = min(a["newest_h"], (now - ts) / 3600)
    for g, a in sorted(agg.items(), key=lambda kv: str(kv[0])):
        print("%-10s %-7s pools=%5d bars=%5d age %.1f-%.1f h" % (g[0], g[1], a["pools"],
              a["with_bars"], a["newest_h"], a["oldest_h"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover")
    d.add_argument("--sources", nargs="+", default=["gt-new", "pump-new", "pump-grad"])
    d.add_argument("--networks", nargs="+", default=["solana", "bsc", "base"])
    r = sub.add_parser("record")
    r.add_argument("--hours", type=float, default=5)
    r.add_argument("--networks", nargs="+", default=["solana", "bsc", "base"])
    r.add_argument("--solana-every-min", type=float, default=20)
    r.add_argument("--solana-pages", type=int, default=3)
    b = sub.add_parser("bars")
    b.add_argument("--min-age-h", type=float, default=2.5)
    b.add_argument("--refetch-below-h", type=float, default=8.0,
                   help="re-fetch pools whose previous fetch covered less than this many hours")
    b.add_argument("--sources", nargs="*", default=None)
    b.add_argument("--networks", nargs="*", default=None)
    b.add_argument("--sample", type=float, default=1.0, help="hash-based systematic sample share")
    b.add_argument("--max-pools", type=int, default=0)
    b.add_argument("--net-sample", nargs="*", default=None, help="per-network share, e.g. bsc=0.6")
    b.add_argument("--grad-via-pump", action="store_true",
                   help="graduated PumpSwap pools from pump.fun candles + DexScreener, not GeckoTerminal")
    b.add_argument("--created-before", type=int, default=0, help="unix ts: ignore pools created later")
    b.add_argument("--loop-until", type=int, default=0,
                   help="unix ts: keep running passes (every 5 min) until then")
    sub.add_parser("status")
    s = sub.add_parser("ds", help="DexScreener liquidity for pools with bars (fills GT reserve=0)")
    s.add_argument("--all", action="store_true")
    s.add_argument("--snapshot", action="store_true")
    args = ap.parse_args(argv)
    {"discover": cmd_discover, "record": cmd_record, "bars": cmd_bars, "status": cmd_status,
     "ds": cmd_ds}[args.cmd](args)


if __name__ == "__main__":
    main()
