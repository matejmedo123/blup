"""honeypot.is public API (EVM chains) — buy/sell simulation, taxes, top holders."""
from __future__ import annotations

from urllib.parse import quote

from .. import http

NAME = "honeypot.is"
BASE = "https://api.honeypot.is"
_BURN = {"0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"}


def check(address: str, chain_id: int) -> dict:
    d = http.get_json("%s/v2/IsHoneypot?address=%s&chainID=%d" % (BASE, quote(address), chain_id), ttl=300)
    sim = d.get("simulationResult") or {}
    code = d.get("contractCode") or {}
    summary = d.get("summary") or {}
    pair = (d.get("pair") or {})
    return {
        "is_honeypot": bool((d.get("honeypotResult") or {}).get("isHoneypot")),
        "simulation_ok": bool(d.get("simulationSuccess")),
        "buy_tax": sim.get("buyTax"),
        "sell_tax": sim.get("sellTax"),
        "transfer_tax": sim.get("transferTax"),
        "open_source": code.get("openSource"),
        "is_proxy": code.get("isProxy"),
        "risk": summary.get("risk"),
        "risk_level": summary.get("riskLevel"),
        "flags": [f.get("flag") if isinstance(f, dict) else str(f) for f in summary.get("flags") or []],
        "holders": (d.get("token") or {}).get("totalHolders"),
        "pair_address": d.get("pairAddress") or (pair.get("pair") or {}).get("address"),
        "pair_liquidity": pair.get("liquidity"),
    }


def top_holders(address: str, chain_id: int, exclude=()) -> dict:
    d = http.get_json("%s/v1/TopHolders?address=%s&chainID=%d" % (BASE, quote(address), chain_id), ttl=300)
    total = float(d.get("totalSupply") or 0)
    skip = {a.lower() for a in exclude if a} | _BURN
    pcts = []
    for h in d.get("holders") or []:
        addr = str(h.get("address") or "").lower()
        if addr in skip:
            continue
        if total > 0:
            pcts.append(100.0 * float(h.get("balance") or 0) / total)
    pcts.sort(reverse=True)
    return {"top10_pct": round(sum(pcts[:10]), 2) if pcts else None,
            "top_holder_pct": round(pcts[0], 2) if pcts else None}
