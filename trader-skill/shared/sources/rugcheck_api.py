"""RugCheck (Solana) public token report.

RugCheck's own ``score_normalised`` is a *risk* score (higher = riskier).
Top-holder concentration here excludes AMM pools, lockers and burn accounts,
because the pool itself is usually the largest "holder".
"""
from __future__ import annotations

from urllib.parse import quote

from .. import http

NAME = "RugCheck"
BASE = "https://api.rugcheck.xyz/v1"
_NON_HOLDER_TYPES = {"AMM", "LOCKER", "BURN", "CEX", "PROGRAM", "POOL"}
_BURN = {"1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"}


def report(mint: str) -> dict:
    try:
        return http.get_json("%s/tokens/%s/report" % (BASE, quote(mint)), ttl=300)
    except http.SourceError:
        return http.get_json("%s/tokens/%s/report/summary" % (BASE, quote(mint)), ttl=300)


def summarize(rep: dict, pair_address: str = "") -> dict:
    """Pull the fields the safety checks need out of a full (or summary) report."""
    rep = rep or {}
    known = rep.get("knownAccounts") or {}
    markets = rep.get("markets") or []
    pool_accounts = {pair_address} if pair_address else set()
    for m in markets:
        # live reports give the reserve accounts as objects ({"mint", "owner", ...}), fixtures as strings
        for k in ("pubkey", "liquidityA", "liquidityB", "liquidityAAccount", "liquidityBAccount"):
            v = m.get(k)
            if isinstance(v, str) and v:
                pool_accounts.add(v)
            elif isinstance(v, dict):
                for sub in ("owner", "pubkey", "address"):
                    if isinstance(v.get(sub), str) and v[sub]:
                        pool_accounts.add(v[sub])

    def is_pool_or_locker(h):
        for key in (h.get("owner"), h.get("address")):
            if not key:
                continue
            if key in pool_accounts or key in _BURN:
                return True
            if str((known.get(key) or {}).get("type", "")).upper() in _NON_HOLDER_TYPES:
                return True
        return False
    holders = [h for h in rep.get("topHolders") or [] if not is_pool_or_locker(h)]
    pcts = sorted((float(h.get("pct") or 0) for h in holders), reverse=True)

    lp_pct = rep.get("lpLockedPct")
    if lp_pct is None and markets:
        best = max(markets, key=lambda m: float(((m.get("lp") or {}).get("lpLockedUSD")) or 0)
                   + float(((m.get("lp") or {}).get("quoteUSD")) or 0))
        lp_pct = (best.get("lp") or {}).get("lpLockedPct")

    token = rep.get("token") or {}
    creator = rep.get("creator")
    supply = float(token.get("supply") or 0)
    creator_pct = None
    if rep.get("creatorBalance") is not None and supply > 0:
        creator_pct = 100.0 * float(rep.get("creatorBalance") or 0) / supply
    for h in rep.get("topHolders") or []:
        if creator and (h.get("owner") == creator or h.get("address") == creator):
            creator_pct = max(creator_pct or 0.0, float(h.get("pct") or 0))
    has_auth = "mintAuthority" in rep or "mintAuthority" in token
    return {
        "mint_authority": rep.get("mintAuthority", token.get("mintAuthority")) if has_auth else "unknown",
        "freeze_authority": rep.get("freezeAuthority", token.get("freezeAuthority")) if has_auth else "unknown",
        "lp_locked_pct": float(lp_pct) if lp_pct is not None else None,
        "top10_pct": round(sum(pcts[:10]), 2) if holders else None,
        "top_holder_pct": round(pcts[0], 2) if pcts else None,
        "insider_holders": sum(1 for h in holders if h.get("insider")),
        "creator": creator,
        "creator_pct": round(creator_pct, 2) if creator_pct is not None else None,
        "rugged": bool(rep.get("rugged")),
        "risk_score": rep.get("score_normalised"),
        "risks": [{"name": r.get("name") or "", "level": (r.get("level") or "").lower(),
                   "value": r.get("value") or "", "description": r.get("description") or ""}
                  for r in rep.get("risks") or []],
        "total_holders": rep.get("totalHolders"),
        "transfer_fee_pct": float(((rep.get("transferFee") or {}).get("pct")) or 0),
        "mutable_metadata": bool((rep.get("tokenMeta") or {}).get("mutable")),
        "liquidity_usd": rep.get("totalMarketLiquidity"),
    }
