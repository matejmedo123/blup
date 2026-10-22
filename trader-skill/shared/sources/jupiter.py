"""Jupiter (Solana) quotes — what a swap of OUR size really gets, through every pool Jupiter routes (read-only)."""
from __future__ import annotations

from urllib.parse import urlencode

from .. import http

NAME = "Jupiter"
BASE = "https://lite-api.jup.ag/swap/v1"
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


class NoRoute(http.SourceError):
    """Jupiter answered and found no way through — no pool, or a token that can't be sold. Unlike a timeout or a
    429, this is an answer about the token."""


def quote(input_mint: str, output_mint: str, amount_raw: int, slippage_bps: int = 300) -> dict:
    """{in_raw, out_raw, price_impact_pct, route: [dex labels]} — raises NoRoute when nothing routes (no pool, or
    a token that can't be sold: the honeypot test on Solana), http.SourceError when Jupiter didn't answer. Never a
    cached copy of an older quote: a token that stopped selling an hour ago must not look sellable now."""
    url = "%s/quote?%s" % (BASE, urlencode({"inputMint": input_mint, "outputMint": output_mint,
                                            "amount": int(amount_raw), "slippageBps": int(slippage_bps)}))
    try:
        q = http.get_json(url, ttl=5, allow_stale=False)
    except http.SourceError as exc:
        if exc.status == 400:  # Jupiter's "could not find any route" / "token not tradable"
            raise NoRoute(url, "no route %s → %s" % (input_mint[:6], output_mint[:6]), 400) from None
        raise
    if not isinstance(q, dict) or not q.get("outAmount"):
        raise NoRoute(url, "no route %s → %s" % (input_mint[:6], output_mint[:6]))
    try:
        impact = abs(float(q.get("priceImpactPct") or 0)) * 100.0
    except (TypeError, ValueError):
        impact = None
    return {"in_raw": int(q["inAmount"]), "out_raw": int(q["outAmount"]), "price_impact_pct": impact,
            "route": [((s.get("swapInfo") or {}).get("label") or "?") for s in q.get("routePlan") or []], "raw": q}
