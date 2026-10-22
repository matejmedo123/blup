#!/usr/bin/env python3
"""Historical, survivorship-free sample of pump.fun coins (Solana), stdlib only.

No free API lists coins by creation time more than ~1 day back (pump.fun caps its offset near
1000; GeckoTerminal's new_pools stops at 10 pages), so the sample comes from the chain itself:

* graduated coins: every PumpSwap migration is a ``MigrateV2`` transaction that involves the
  pump.fun migration account 39azUY…; ``getSignaturesForAddress`` pages back through all of them.
  Per UTC day we take N evenly spaced successful migrations (by time, never by outcome).
* curve coins: every pump.fun ``create`` involves the mint-authority PDA TSLvdd…; ~36k a day,
  so per day we read the 1000 creates before 4 anchor times (00/06/12/18 UTC, anchored on a
  migration signature at that time) and take M evenly spaced ones.
* each sampled transaction is fetched once to read its mint (and verify it is a migration /
  create); the coin's state comes from pump.fun, its pools and current liquidity from
  DexScreener, 5-minute candles from pump.fun (its newest 1000 candles — complete for every coin
  that traded in fewer than 1000 distinct 5-minute buckets); coins whose early history is cut
  off get GeckoTerminal 5-minute OHLCV of their PumpSwap pool instead (slow, rate-limited).

    python3 history.py list --days 60
    python3 history.py sample --grad-per-day 40 --curve-per-day 20
    python3 history.py resolve
    python3 history.py enrich
    python3 history.py bars
    python3 history.py status
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collect as C  # noqa: E402

HIST = os.path.join(C.DATA, "hist")
SIGS = os.path.join(HIST, "migration_sigs.jsonl")
SAMPLE = os.path.join(HIST, "sample.jsonl")
RESOLVED = os.path.join(HIST, "resolved.jsonl")
COINS = os.path.join(HIST, "coins.jsonl")
BARS = os.path.join(HIST, "bars5m.jsonl")
LOG = os.path.join(HIST, "log.jsonl")

RPC = os.environ.get("SOLANA_RPC_URL") or "https://api.mainnet-beta.solana.com"
MIGRATION_ACCOUNT = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
CREATE_ACCOUNT = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"   # pump.fun mint authority
QUOTES = {"So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
          "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"}
RPC_GAP = {"getSignaturesForAddress": 0.35, "getTransaction": float(os.environ.get("RPC_TX_GAP", "0.3"))}
_last_rpc = [0.0]


def rpc(method: str, params: list, tries: int = 8):
    for attempt in range(tries):
        wait = _last_rpc[0] + RPC_GAP.get(method, 0.3) - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_rpc[0] = time.time()
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(RPC, data=body, headers={"content-type": "application/json",
                                                                "User-Agent": C.UA})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.loads(r.read())
            if "error" in d:
                code = (d["error"] or {}).get("code")
                if code in (-32429, 429, -32005, -32603, -32004):   # rate limit / slot not ready
                    raise urllib.error.HTTPError(RPC, 429, "rpc", None, None)
                return d
            return d
        except urllib.error.HTTPError as e:
            delay = min(60, 2 * 2 ** attempt) + random.uniform(0, 1)
            C.log("rpc %s HTTP %s -> sleeping %.0fs" % (method, e.code, delay))
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            delay = min(60, 3 * 2 ** attempt)
            C.log("rpc %s error %r -> sleeping %ds" % (method, e, delay))
            time.sleep(delay)
    return {}


def day_of(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")


# ----------------------------------------------------------------------------- list

def cmd_list(args):
    """All migration signatures back to --days (resumable: continues from the oldest stored)."""
    have = C.read_jsonl(SIGS)
    before = have[-1]["sig"] if have else None
    stop_ts = time.time() - args.days * 86400
    oldest = have[-1]["ts"] if have else time.time()
    n = 0
    while oldest > stop_ts:
        p = {"limit": 1000}
        if before:
            p["before"] = before
        d = rpc("getSignaturesForAddress", [MIGRATION_ACCOUNT, p])
        res = d.get("result") or []
        if not res:
            C.log("list: empty page (history limit of this RPC?) at %s" % day_of(int(oldest)))
            break
        rows = [{"sig": r["signature"], "ts": r.get("blockTime") or 0, "slot": r.get("slot"),
                 "ok": r.get("err") is None} for r in res]
        C.append_jsonl(SIGS, rows)
        before = res[-1]["signature"]
        oldest = rows[-1]["ts"] or oldest
        n += len(rows)
        if n % 10000 < 1000:
            C.log("list: %d signatures, back to %s" % (n, day_of(int(oldest))))
    C.append_jsonl(LOG, [{"ts": int(time.time()), "cmd": "list", "days": args.days, "new_sigs": n,
                          "oldest": day_of(int(oldest))}])
    C.log("list done: %d new, oldest %s" % (n, day_of(int(oldest))))


# ----------------------------------------------------------------------------- sample

def _evenly(rows, k):
    if len(rows) <= k:
        return list(rows)
    step = len(rows) / float(k)
    return [rows[int(i * step + step / 2)] for i in range(k)]


def cmd_sample(args):
    sigs = [r for r in C.read_jsonl(SIGS) if r["ok"] and r["ts"]]
    by_day = {}
    for r in sigs:
        by_day.setdefault(day_of(r["ts"]), []).append(r)
    days = sorted(by_day)
    today = day_of(int(time.time()))
    # complete days only: the first listed day is partial, today too
    days = [d for d in days if d != today][1:] if len(days) > 2 else days
    if args.days:
        days = days[-args.days:]
    prev = C.read_jsonl(SAMPLE)
    have = {(r["kind"], r["sig"]) for r in prev}
    done_days = {r["day"] for r in prev}
    out = []
    for d in days:
        if d in done_days:
            continue
        rows = sorted(by_day[d], key=lambda r: r["ts"])
        for r in _evenly(rows, args.grad_per_day):
            if ("grad", r["sig"]) not in have:
                out.append({"kind": "grad", "day": d, "sig": r["sig"], "ts": r["ts"], "migrations_that_day": len(rows)})
        if args.curve_per_day:
            per_anchor = max(1, args.curve_per_day // 4)
            for hh in (0, 6, 12, 18):
                t0 = int(dt.datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp()) + hh * 3600
                anchor = min(rows, key=lambda r: abs(r["ts"] - t0))
                res = rpc("getSignaturesForAddress", [CREATE_ACCOUNT, {"limit": 1000, "before": anchor["sig"]}])
                cr = [x for x in (res.get("result") or []) if x.get("err") is None and x.get("blockTime")]
                cr.sort(key=lambda x: x["blockTime"])
                span = (cr[-1]["blockTime"] - cr[0]["blockTime"]) / 60.0 if cr else 0
                for x in _evenly(cr, per_anchor):
                    if ("curve", x["signature"]) not in have:
                        out.append({"kind": "curve", "day": d, "sig": x["signature"], "ts": x["blockTime"],
                                    "anchor_ts": anchor["ts"], "creates_per_min": round(len(cr) / max(span, 1e-9), 1)})
        C.log("sample %s: %d migrations that day" % (d, len(rows)))
        C.append_jsonl(SAMPLE, out)
        out = []
    C.append_jsonl(SAMPLE, out)
    C.append_jsonl(LOG, [{"ts": int(time.time()), "cmd": "sample", "args": vars(args), "added": len(out),
                          "days": [days[0], days[-1]] if days else None}])
    C.log("sample: %d added over %d days" % (len(out), len(days)))


# ----------------------------------------------------------------------------- resolve

def cmd_resolve(args):
    """getTransaction per sampled signature: the mint, and whether it really is a migration/create."""
    done = {r["sig"] for r in C.read_jsonl(RESOLVED)}
    todo = [r for r in C.read_jsonl(SAMPLE) if r["sig"] not in done]
    C.log("resolve: %d to do" % len(todo))
    batch = []
    for i, r in enumerate(todo):
        # plain "json" is several times smaller than jsonParsed: the public RPC's data cap is the limit
        d = rpc("getTransaction", [r["sig"], {"encoding": "json", "maxSupportedTransactionVersion": 0}])
        tx = d.get("result")
        out = dict(r, mint=None, verified=False)
        if tx:
            logs = (tx.get("meta") or {}).get("logMessages") or []
            ins = [l.split("Instruction: ", 1)[1] for l in logs if "Instruction: " in l]
            want = ("Migrate",) if r["kind"] == "grad" else ("Create",)
            out["verified"] = any(x.startswith(w) for x in ins for w in want)
            out["instructions"] = sorted(set(ins))[:8]
            mints = sorted({b["mint"] for b in (tx.get("meta") or {}).get("postTokenBalances") or []} - QUOTES)
            if r["kind"] == "curve" and not mints:
                # a create may leave no token balance (no dev buy): the new mint signs the create
                msg = tx["transaction"]["message"]
                hdr = msg.get("header") or {}
                n_sign = int(hdr.get("numRequiredSignatures") or 0) - int(hdr.get("numReadonlySignedAccounts") or 0)
                keys = [k if isinstance(k, str) else k.get("pubkey") for k in (msg.get("accountKeys") or [])][:n_sign]
                mints = [k for k in keys if k and k.endswith("pump")] or keys[1:2]
            out["mint"] = mints[0] if len(mints) == 1 else (next((m for m in mints if m.endswith("pump")), None)
                                                           or (mints[0] if mints else None))
            out["n_mints"] = len(mints)
            out["block_ts"] = tx.get("blockTime")
            # the PumpSwap pool = the owner holding both the coin and its quote right after the
            # migration; those two balances are the pool's starting reserves (LP is burned after)
            owners = {}
            for b in (tx.get("meta") or {}).get("postTokenBalances") or []:
                amt = C.fnum((b.get("uiTokenAmount") or {}).get("uiAmountString")) or 0.0
                owners.setdefault(b.get("owner"), {})[b["mint"]] = amt
            if out["mint"]:
                best = None
                for own, bal in owners.items():
                    q = [m for m in bal if m in QUOTES and bal[m] > 0]
                    if bal.get(out["mint"], 0) > 0 and q and (best is None or bal[out["mint"]] > best[1]):
                        best = (own, bal[out["mint"]], q[0], bal[q[0]])
                if best:
                    out.update(pool=best[0], base_amt=best[1], quote_mint=best[2], quote_amt=best[3])
                if r["kind"] == "curve":
                    hold = sorted(((bal.get(out["mint"], 0), own) for own, bal in owners.items()), reverse=True)
                    out["curve_tokens"] = hold[0][0] if hold else None   # left in the curve after a dev buy
                    out["curve_owner"] = hold[0][1] if hold else None
        batch.append(out)
        if len(batch) >= 50:
            C.append_jsonl(RESOLVED, batch)
            batch = []
            C.log("resolve %d/%d" % (i + 1, len(todo)))
    C.append_jsonl(RESOLVED, batch)


# ----------------------------------------------------------------------------- enrich

def ds_tokens(mints):
    out = {}
    for i in range(0, len(mints), 30):
        chunk = mints[i:i + 30]
        st, d = C.get_json("%s/tokens/v1/solana/%s" % (C.DEXSCREENER, ",".join(chunk)))
        if st != 200 or not isinstance(d, list):
            continue
        for p in d:
            m = (p.get("baseToken") or {}).get("address")
            out.setdefault(m, []).append({
                "pair": p.get("pairAddress"), "dex": p.get("dexId"), "labels": p.get("labels"),
                "created_ms": p.get("pairCreatedAt"), "liq_usd": C.fnum((p.get("liquidity") or {}).get("usd")),
                "price_usd": C.fnum(p.get("priceUsd")), "quote": (p.get("quoteToken") or {}).get("address"),
                "fdv": C.fnum(p.get("fdv")), "vol_h24": C.fnum((p.get("volume") or {}).get("h24"))})
    return out


def cmd_enrich(args):
    done = {r["mint"] for r in C.read_jsonl(COINS)}
    rows = [r for r in C.read_jsonl(RESOLVED) if r.get("mint") and r["mint"] not in done]
    mints = sorted({r["mint"] for r in rows})
    C.log("enrich: %d mints" % len(mints))
    ds = ds_tokens(mints)   # pump.fun has no coin-by-mint endpoint any more (/coins/{mint} is 404)
    C.append_jsonl(COINS, [{"mint": m, "fetched_ts": int(time.time()), "coin": None, "ds": ds.get(m) or []}
                           for m in mints])
    C.log("enrich: DexScreener knows %d of %d" % (sum(1 for m in mints if ds.get(m)), len(mints)))


# ----------------------------------------------------------------------------- bars

def pump_candles_5m(mint: str, created_ts: int):
    url = ("%s/v2/coins/%s/candles?interval=5m&limit=1000&currency=USD&createdTs=%d"
           % (C.PUMP_SWAP_API, mint, created_ts * 1000))
    st, d = C.get_json(url)
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


def gt_5m(pool: str, start_ts: int, hours: float):
    end = min(int(time.time()), int(start_ts + hours * 3600) + 300)
    url = ("%s/networks/solana/pools/%s/ohlcv/minute?aggregate=5&limit=1000&currency=usd&token=base"
           "&before_timestamp=%d" % (C.GT, pool, end))
    st, d = C.get_json(url)
    if st != 200 or not isinstance(d, dict):
        return st, None
    rows = (((d.get("data") or {}).get("attributes") or {}).get("ohlcv_list")) or []
    return st, sorted([[int(r[0])] + [float(x) for x in r[1:6]] for r in rows if len(r) >= 6])


def _anchor_ts(res: dict, coin: dict) -> int:
    """When this coin's tradable life we study starts: the migration (graduated) or the create."""
    return int(res.get("block_ts") or res.get("ts"))


def cmd_bars(args):
    """pump.fun 5-minute candles; if the newest 1000 don't reach back to where the window starts,
    GeckoTerminal for the PumpSwap pool (graduated) — flagged ``truncated`` otherwise."""
    latest = {}
    for r in C.read_jsonl(BARS):
        latest[(r["kind"], r["mint"])] = r
    coins = {r["mint"]: r for r in C.read_jsonl(COINS)}
    res = [r for r in C.read_jsonl(RESOLVED) if r.get("mint") and r.get("verified")]
    if args.gt:
        todo = [r for r in res if latest.get((r["kind"], r["mint"]), {}).get("truncated")
                and latest[(r["kind"], r["mint"])].get("src") != "gt-5m"]
    else:
        todo = [r for r in res if latest.get((r["kind"], r["mint"]), {}).get("status") != 200]
    C.log("bars: %d to do" % len(todo))
    batch = []
    for i, r in enumerate(todo):
        coin = (coins.get(r["mint"]) or {}).get("coin") or {}
        created = int((coin.get("created_timestamp") or 0) / 1000) or int(r.get("block_ts") or r["ts"])
        start = _anchor_ts(r, coin)
        rec = {"kind": r["kind"], "mint": r["mint"], "start_ts": start, "fetched_ts": int(time.time())}
        if args.gt:
            # graduated: the PumpSwap pool from the migration; curve: the bonding-curve pool from the
            # create, then the PumpSwap pool if it graduated inside the window
            bars, st = [], None
            pools = [(r.get("curve_owner"), start)] if r["kind"] == "curve" else [(r.get("pool"), start)]
            if r["kind"] == "curve":
                for p in (coins.get(r["mint"]) or {}).get("ds") or []:
                    if p.get("dex") == "pumpswap" and p.get("created_ms") and \
                            p["created_ms"] / 1000 < start + args.hours * 3600:
                        pools.append((p["pair"], max(int(p["created_ms"] / 1000), start)))
            for pool, t0 in pools:
                if not pool:
                    continue
                st, b = gt_5m(pool, t0, (start + args.hours * 3600 - t0) / 3600.0)
                bars += [x for x in (b or []) if x[0] >= t0 // 300 * 300]
            merged = {}
            for b in bars:
                merged[b[0]] = b if b[0] not in merged else [b[0], merged[b[0]][1], max(merged[b[0]][2], b[2]),
                                                            min(merged[b[0]][3], b[3]), b[4], merged[b[0]][5] + b[5]]
            rec.update(src="gt-5m", status=st, bars=[merged[t] for t in sorted(merged)], truncated=False,
                       pools=[p for p, _ in pools])
        else:
            st, bars = pump_candles_5m(r["mint"], created)
            bars = bars or []
            # the newest 1000 candles: complete only if they reach back to the start of our window
            trunc = len(bars) >= 1000 and bars[0][0] > start + 600
            rec.update(src="pump-5m", status=st, bars=[b for b in bars if b[0] <= start + args.hours * 3600 + 300],
                       truncated=trunc, n_all=len(bars))
        batch.append(rec)
        if len(batch) >= 25:
            C.append_jsonl(BARS, batch)
            batch = []
            C.log("bars %d/%d %s" % (i + 1, len(todo), C.STATS))
    C.append_jsonl(BARS, batch)


def cmd_status(args):
    sigs = C.read_jsonl(SIGS)
    ok = [r for r in sigs if r["ok"]]
    print("migration signatures: %d (%d ok), %s .. %s" % (len(sigs), len(ok), day_of(min(r["ts"] for r in ok)) if ok else "-",
                                                          day_of(max(r["ts"] for r in ok)) if ok else "-"))
    for name, path in (("sample", SAMPLE), ("resolved", RESOLVED), ("coins", COINS), ("bars", BARS)):
        rows = C.read_jsonl(path)
        kinds = {}
        for r in rows:
            kinds[r.get("kind", "-")] = kinds.get(r.get("kind", "-"), 0) + 1
        extra = ""
        if name == "resolved":
            extra = " verified=%d with_mint=%d" % (sum(1 for r in rows if r.get("verified")),
                                                   sum(1 for r in rows if r.get("mint")))
        if name == "bars":
            extra = " truncated=%d empty=%d" % (sum(1 for r in rows if r.get("truncated")),
                                               sum(1 for r in rows if not r.get("bars")))
        print("%-9s %5d %s%s" % (name, len(rows), kinds, extra))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("list")
    a.add_argument("--days", type=float, default=60)
    a = sub.add_parser("sample")
    a.add_argument("--grad-per-day", type=int, default=40)
    a.add_argument("--curve-per-day", type=int, default=20)
    a.add_argument("--days", type=int, default=0, help="only the last N complete days")
    sub.add_parser("resolve")
    sub.add_parser("enrich")
    a = sub.add_parser("bars")
    a.add_argument("--hours", type=float, default=80, help="window after the start (72 h + 6 h hold)")
    a.add_argument("--gt", action="store_true", help="GeckoTerminal for truncated graduated coins")
    sub.add_parser("status")
    args = ap.parse_args(argv)
    os.makedirs(HIST, exist_ok=True)
    {"list": cmd_list, "sample": cmd_sample, "resolve": cmd_resolve, "enrich": cmd_enrich,
     "bars": cmd_bars, "status": cmd_status}[args.cmd](args)


if __name__ == "__main__":
    main()
