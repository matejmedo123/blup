"""Jupiter (Solana) quotes — what a swap of OUR size really gets, through every pool Jupiter routes (read-only)."""
from __future__ import annotations

from urllib.parse import urlencode

from .. import http

NAME = "Jupiter"
BASE = "https://lite-api.jup.ag/swap/v1"
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


def quote(input_mint: str, output_mint: str, amount_raw: int, slippage_bps: int = 300) -> dict:
    """{in_raw, out_raw, price_impact_pct, route: [dex labels]} — raises http.SourceError when nothing routes
    (no pool, or a token that can't be sold: the honeypot test on Solana)."""
    url = "%s/quote?%s" % (BASE, urlencode({"inputMint": input_mint, "outputMint": output_mint,
                                            "amount": int(amount_raw), "slippageBps": int(slippage_bps)}))
    q = http.get_json(url, ttl=5)
    if not isinstance(q, dict) or not q.get("outAmount"):
        raise http.SourceError("jupiter", "no route %s → %s" % (input_mint[:6], output_mint[:6]))
    try:
        impact = abs(float(q.get("priceImpactPct") or 0)) * 100.0
    except (TypeError, ValueError):
        impact = None
    return {"in_raw": int(q["inAmount"]), "out_raw": int(q["outAmount"]), "price_impact_pct": impact,
            "route": [((s.get("swapInfo") or {}).get("label") or "?") for s in q.get("routePlan") or []], "raw": q}
