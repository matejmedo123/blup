#!/usr/bin/env python3
"""Rug Check — safety gate for a meme coin before anything else happens.

Scores a DEX token 0–100 from free public data (DexScreener, RugCheck for
Solana, honeypot.is for EVM chains) and gives a SAFE / RISKY / DANGER verdict
with the exact reasons. SAFE only ever means "no red flags found in these
checks" — never "safe to buy".

Examples:
  python3 rugcheck.py SOL:<mint>
  python3 rugcheck.py base:0x1234…abcd
  python3 rugcheck.py BONK --asset meme          (name search — verify the address!)
  python3 rugcheck.py SOL:<mint> --offline --now 2026-10-20T15:55:00Z
"""
from __future__ import annotations

import os
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, data, fmt, html, http, market_clock, state, symbols  # noqa: E402
from shared.sources import honeypot, rugcheck_api  # noqa: E402

SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
HEADLINES = {
    "SAFE": "No red flags found in these checks (not a guarantee)",
    "RISKY": "Red flags found — high risk",
    "DANGER": "Serious red flags — do not trade this",
}


# --- storage -----------------------------------------------------------------------

def _rel_name(chain: str, address: str) -> str:
    return "rugcheck/%s-%s.json" % (chain or "unknown", address)


def result_path(chain: str, address: str):
    return state.home() / _rel_name(chain, address)


def load_result(chain: str, address: str):
    """The last saved rugcheck for this token, or None."""
    p = result_path(chain, address)
    if not p.exists():
        return None
    return state.read_json(_rel_name(chain, address))


# --- checks --------------------------------------------------------------------------

class _Checks:
    def __init__(self):
        self.items = []

    def add(self, name, label, ok, severity, value, penalty=0, detail="", reason=""):
        """ok: True / False / None (could not verify). Penalty only counts when ok is not True."""
        self.items.append({"name": name, "label": label, "ok": ok, "severity": severity, "value": value,
                           "penalty": 0 if ok is True else int(penalty), "detail": detail,
                           "reason": reason if ok is not True else ""})

    def failed_critical(self):
        return [c for c in self.items if c["ok"] is False and c["severity"] == "critical"]


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _covered(risk_name: str) -> bool:
    """RugCheck risks already scored by our own checks (don't count them twice)."""
    n = risk_name.lower()
    return (("lp" in n and "lock" in n) or "holder" in n or "mint authority" in n or "freeze authority" in n
            or "low liquidity" in n or "rugged" in n)


def _liquidity(ck, liq):
    if liq is None:
        ck.add("liquidity", "Pool liquidity", False, "critical", "unknown", 40,
               "DexScreener reports no liquidity for this pair", "No liquidity data — the pool may be empty")
    elif liq < 10000:
        ck.add("liquidity", "Pool liquidity", False, "critical", fmt.compact_usd(liq), 40,
               "under $10k: tiny trades move the price and liquidity can vanish",
               "Liquidity is only %s — a few trades move the price and it can vanish" % fmt.compact_usd(liq))
    elif liq < 50000:
        ck.add("liquidity", "Pool liquidity", False, "high", fmt.compact_usd(liq), 15, "under $50k",
               "Thin liquidity (%s) — high slippage and easy to manipulate" % fmt.compact_usd(liq))
    elif liq < 100000:
        ck.add("liquidity", "Pool liquidity", False, "medium", fmt.compact_usd(liq), 5, "under $100k",
               "Modest liquidity (%s)" % fmt.compact_usd(liq))
    else:
        ck.add("liquidity", "Pool liquidity", True, "critical", fmt.compact_usd(liq), detail="at least $100k")


def _lp_lock(ck, pct, verifiable=True):
    if pct is None:
        detail = ("LP lock status is not available from free sources on this chain" if not verifiable
                  else "RugCheck did not report an LP lock")
        ck.add("lp_locked", "LP locked or burned", None, "medium", "unknown", 10, detail,
               "Could not verify that liquidity is locked or burned")
    elif pct < 50:
        ck.add("lp_locked", "LP locked or burned", False, "critical", "%.0f%% locked/burned" % pct, 30,
               "the deployer can remove the pool at any time",
               "LP not locked or burned (%.0f%% locked) — the deployer can pull liquidity" % pct)
    elif pct < 90:
        ck.add("lp_locked", "LP locked or burned", False, "high", "%.0f%% locked/burned" % pct, 10,
               "part of the LP can still be pulled", "Only %.0f%% of the LP is locked or burned" % pct)
    else:
        ck.add("lp_locked", "LP locked or burned", True, "critical", "%.0f%% locked/burned" % pct)


def _authority(ck, name, label, value, meaning):
    if value == "unknown":
        ck.add(name, label, None, "medium", "unknown", 10, "not in the RugCheck summary",
               "Could not verify that the %s is revoked" % label.lower())
    elif value:
        ck.add(name, label, False, "critical", "active (%s…)" % str(value)[:6], 40, meaning,
               "%s is still active — %s" % (label, meaning))
    else:
        ck.add(name, label, True, "critical", "revoked")


def _holders(ck, top10, top1, creator):
    if top10 is None:
        ck.add("top10", "Top-10 holder share", None, "medium", "unknown", 5, "holder list unavailable",
               "Could not check holder concentration")
    elif top10 > 50:
        ck.add("top10", "Top-10 holder share", False, "high", "%.1f%%" % top10, 30,
               "excluding pools, lockers and burn addresses",
               "Top-10 wallets hold %.1f%% of supply — they can dump on buyers" % top10)
    elif top10 > 30:
        ck.add("top10", "Top-10 holder share", False, "medium", "%.1f%%" % top10, 15,
               "excluding pools, lockers and burn addresses", "Top-10 wallets hold %.1f%% of supply" % top10)
    else:
        ck.add("top10", "Top-10 holder share", True, "high", "%.1f%%" % top10,
               detail="excluding pools, lockers and burn addresses")
    if top1 is not None:
        if top1 >= 30:
            ck.add("top_holder", "Largest single holder", False, "critical", "%.1f%%" % top1, 30,
                   "one wallet can crash the price", "Top holder owns %.1f%% of supply" % top1)
        elif top1 >= 15:
            ck.add("top_holder", "Largest single holder", False, "high", "%.1f%%" % top1, 15, "",
                   "Top holder owns %.1f%% of supply" % top1)
        else:
            ck.add("top_holder", "Largest single holder", True, "critical", "%.1f%%" % top1)
    if creator is not None:
        if creator > 10:
            ck.add("creator", "Dev / creator wallet share", False, "high", "%.1f%%" % creator, 15, "",
                   "Dev wallet still holds %.1f%% of supply" % creator)
        elif creator > 5:
            ck.add("creator", "Dev / creator wallet share", False, "medium", "%.1f%%" % creator, 5, "",
                   "Dev wallet holds %.1f%% of supply" % creator)
        else:
            ck.add("creator", "Dev / creator wallet share", True, "high", "%.1f%%" % creator)
    else:
        ck.add("creator", "Dev / creator wallet share", None, "info", "unknown", 0,
               "creator wallet not identified by the free sources")


def _activity(ck, pair, age_h, simulated: bool):
    if age_h is None:
        ck.add("pair_age", "Pair age", None, "info", "unknown", 0, "DexScreener has no creation time")
    elif age_h < 1:
        ck.add("pair_age", "Pair age", False, "medium", "%d min" % max(1, int(age_h * 60)), 10,
               "first-hour launches are the most rug-prone",
               "Brand-new pair (%d minutes old)" % max(1, int(age_h * 60)))
    elif age_h < 24:
        ck.add("pair_age", "Pair age", False, "low", "%.1f h" % age_h, 5, "less than a day of history",
               "Young pair (%.1f hours old)" % age_h)
    else:
        ck.add("pair_age", "Pair age", True, "medium", "%.1f days" % (age_h / 24.0))
    tx = (pair.get("txns") or {}).get("h1") or {}
    buys, sells = int(tx.get("buys") or 0), int(tx.get("sells") or 0)
    value = "%d buys / %d sells" % (buys, sells)
    if buys > 50 and sells == 0 and not simulated:
        ck.add("buy_sell", "Buy/sell balance (1h)", False, "high", value, 20,
               "plenty of buys but zero sells", "Nobody has sold in the last hour despite %d buys — possible honeypot"
               % buys)
    elif buys < 0.5 * sells:
        ck.add("buy_sell", "Buy/sell balance (1h)", False, "medium", value, 10, "sellers dominate",
               "Heavy selling: %d sells vs %d buys in the last hour" % (sells, buys))
    else:
        ck.add("buy_sell", "Buy/sell balance (1h)", True, "medium", value)
    liq = pair.get("liquidity_usd")
    vol = ((pair.get("volume") or {}).get("h24")) or 0.0
    ratio = (vol / liq) if liq else None
    if ratio is not None and ratio > 50:
        ck.add("vol_liq", "24h volume vs liquidity", False, "medium", "%.0f×" % ratio, 10,
               "huge volume on a tiny pool", "24h volume is %.0f× liquidity — possible wash trading / fake volume"
               % ratio)
    else:
        ck.add("vol_liq", "24h volume vs liquidity", True, "medium", "%.1f×" % ratio if ratio is not None else "n/a")
    return buys, sells, vol, ratio


def _sanitize_report(rep):
    """Live RugCheck reports nest account *objects* in markets[] where summarize() expects address strings."""
    if not isinstance(rep, dict) or not isinstance(rep.get("markets"), list):
        return rep
    out = dict(rep)
    markets = []
    for m in rep["markets"]:
        if not isinstance(m, dict):
            continue
        m2 = dict(m)
        for k in ("pubkey", "liquidityAAccount", "liquidityBAccount"):
            v = m2.get(k)
            if isinstance(v, dict):
                m2[k] = v.get("owner") or v.get("pubkey") or ""
            elif v is not None and not isinstance(v, str):
                m2[k] = ""
        markets.append(m2)
    out["markets"] = markets
    return out


def _solana_checks(ck, mint, pair, warnings, sources):
    try:
        rep = rugcheck_api.report(mint)
        summ = rugcheck_api.summarize(_sanitize_report(rep), pair.get("pair_address") or "")
        sources["rugcheck"] = "ok"
    except http.SourceError as exc:
        sources["rugcheck"] = "unavailable"
        warnings.append("RugCheck unavailable: %s" % exc)
        summ = None
    except (TypeError, KeyError, ValueError, AttributeError) as exc:
        sources["rugcheck"] = "unavailable"
        warnings.append("RugCheck report could not be read (%s: %s)" % (type(exc).__name__, exc))
        summ = None
    if summ is None:
        ck.add("safety_source", "RugCheck report", False, "high", "unavailable", 20,
               "mint/freeze authority, LP lock and holders could not be verified",
               "RugCheck was unavailable — authorities, LP lock and holders are unverified")
        _lp_lock(ck, None)
        return {}
    if summ.get("rugged"):
        ck.add("rugged", "RugCheck: already rugged", False, "critical", "yes", 100, "RugCheck marks this token as rugged",
               "RugCheck marks this token as already rugged")
    _authority(ck, "mint_authority", "Mint authority", summ.get("mint_authority"),
               "new tokens can be minted and dumped on holders")
    _authority(ck, "freeze_authority", "Freeze authority", summ.get("freeze_authority"),
               "your tokens can be frozen so you cannot sell")
    _lp_lock(ck, summ.get("lp_locked_pct"))
    _holders(ck, summ.get("top10_pct"), summ.get("top_holder_pct"), summ.get("creator_pct"))
    if summ.get("transfer_fee_pct"):
        ck.add("transfer_fee", "Transfer fee", False, "high", "%.1f%%" % summ["transfer_fee_pct"], 15,
               "a fee is taken on every transfer", "Token charges a %.1f%% transfer fee" % summ["transfer_fee_pct"])
    for risk in summ.get("risks") or []:
        if _covered(risk["name"]) or risk["level"] not in ("danger", "warn"):
            continue
        danger = risk["level"] == "danger"
        ck.add("rc_" + risk["name"].lower().replace(" ", "_")[:40], "RugCheck: %s" % risk["name"], False,
               "high" if danger else "low", risk.get("value") or risk["level"], 15 if danger else 5,
               risk.get("description") or "", "RugCheck flags: %s" % risk["name"])
    rs = summ.get("risk_score")
    if rs is not None:
        ck.add("rc_score", "RugCheck risk score (lower is better)", not (rs > 50), "medium", "%s/100" % rs, 10,
               "RugCheck's own normalised risk score", "RugCheck's own risk score is high (%s/100)" % rs)
    return summ


def _evm_checks(ck, chain, address, pair, warnings, sources):
    chain_id = symbols.HONEYPOT_CHAIN_ID.get(chain)
    hp = None
    if chain_id:
        try:
            hp = honeypot.check(address, chain_id)
            sources["honeypot"] = "ok"
        except http.SourceError as exc:
            sources["honeypot"] = "unavailable"
            warnings.append("honeypot.is unavailable: %s" % exc)
    else:
        sources["honeypot"] = "unsupported chain"
    out = {}
    if hp is None:
        ck.add("safety_source", "honeypot.is simulation", False, "high", "unavailable", 20,
               "buy/sell simulation and taxes could not be checked",
               "honeypot.is was unavailable — could not simulate a sell or read taxes")
    else:
        out.update(is_honeypot=hp.get("is_honeypot"), buy_tax=hp.get("buy_tax"), sell_tax=hp.get("sell_tax"))
        if hp.get("is_honeypot"):
            ck.add("honeypot", "Honeypot simulation", False, "critical", "HONEYPOT", 100, "a simulated sell failed",
                   "honeypot.is simulation says you cannot sell this token (honeypot)")
        elif not hp.get("simulation_ok"):
            ck.add("honeypot", "Honeypot simulation", None, "high", "simulation failed", 15,
                   "could not simulate a buy and sell", "Sell simulation failed — cannot confirm you can sell")
        else:
            ck.add("honeypot", "Honeypot simulation", True, "critical", "buy and sell simulated OK")
        sell, buy = _num(hp.get("sell_tax")), _num(hp.get("buy_tax"))
        if sell is not None:
            if sell >= 30:
                ck.add("sell_tax", "Sell tax", False, "critical", "%.1f%%" % sell, 40, "",
                       "Sell tax is %.1f%% — most of your money stays behind" % sell)
            elif sell > 10:
                ck.add("sell_tax", "Sell tax", False, "high", "%.1f%%" % sell, 25, "", "High sell tax (%.1f%%)" % sell)
            else:
                ck.add("sell_tax", "Sell tax", True, "critical", "%.1f%%" % sell)
        if buy is not None:
            ck.add("buy_tax", "Buy tax", not (buy > 10), "high", "%.1f%%" % buy, 15, "",
                   "High buy tax (%.1f%%)" % buy)
        if hp.get("open_source") is False:
            ck.add("open_source", "Verified source code", False, "medium", "not verified", 10,
                   "nobody can read what the contract does", "Contract source code is not verified")
        elif hp.get("open_source"):
            ck.add("open_source", "Verified source code", True, "medium", "verified")
        if hp.get("is_proxy"):
            ck.add("proxy", "Upgradeable proxy", False, "low", "proxy", 5, "the logic can be swapped later",
                   "Contract is an upgradeable proxy — rules can change after you buy")
    try:
        th = honeypot.top_holders(address, chain_id, exclude=[pair.get("pair_address") or ""]) if chain_id else None
    except http.SourceError as exc:
        warnings.append("honeypot.is top holders unavailable: %s" % exc)
        th = None
    th = th or {}
    out.update(top10_pct=th.get("top10_pct"), top_holder_pct=th.get("top_holder_pct"))
    _lp_lock(ck, None, verifiable=False)
    _holders(ck, th.get("top10_pct"), th.get("top_holder_pct"), None)
    return out


def check(symbol, pair=None, write=True) -> dict:
    """Run every check for one token and (by default) save trader/rugcheck/{chain}-{address}.json."""
    warnings = []
    if pair:
        sym = symbols.meme_symbol(pair["chain"], pair["base"]["address"], pair["base"].get("symbol") or "")
    else:
        sym, pair, _pairs, warnings = data.resolve_meme(symbol)
    now = market_clock.now_utc()
    created = pair.get("created_at")
    age_h = ((now.timestamp() - created) / 3600.0) if created else pair.get("age_hours")
    if age_h is not None and age_h < 0:
        age_h = 0.0
    sources = {"dexscreener": "ok"}
    ck = _Checks()
    _liquidity(ck, pair.get("liquidity_usd"))
    evm = sym.chain in symbols.EVM_CHAINS
    metrics = {"mint_authority": None, "freeze_authority": None, "buy_tax": None, "sell_tax": None,
               "is_honeypot": None, "lp_locked_pct": None, "top10_pct": None, "top_holder_pct": None,
               "creator_pct": None}
    if sym.chain == "solana":
        sources["honeypot"] = "n/a"
        summ = _solana_checks(ck, sym.address, pair, warnings, sources)
        for k in ("mint_authority", "freeze_authority", "lp_locked_pct", "top10_pct", "top_holder_pct",
                  "creator_pct"):
            metrics[k] = summ.get(k)
    elif evm:
        sources["rugcheck"] = "n/a"
        metrics.update(_evm_checks(ck, sym.chain, sym.address, pair, warnings, sources))
    else:
        sources["rugcheck"] = sources["honeypot"] = "unsupported chain"
        ck.add("safety_source", "Safety data", False, "high", "unsupported chain", 20,
               "no free safety source for this chain", "No free safety source for %s" % sym.chain)
    buys, sells, vol, ratio = _activity(ck, pair, age_h, simulated=evm and sources.get("honeypot") == "ok")

    score = max(0, min(100, 100 - sum(c["penalty"] for c in ck.items)))
    criticals = ck.failed_critical()
    if criticals:
        verdict = "DANGER"
    elif score >= 75:
        verdict = "SAFE"
    elif score >= 50:
        verdict = "RISKY"
    else:
        verdict = "DANGER"
    source_down = any(c["name"] == "safety_source" for c in ck.items)
    if source_down and verdict == "SAFE":
        verdict = "RISKY"
    failed = [c for c in ck.items if c["ok"] is not True and c["reason"]]
    failed.sort(key=lambda c: (c["ok"] is not False, SEVERITY_RANK.get(c["severity"], 9), -c["penalty"]))
    reasons = [c["reason"] for c in failed]
    metrics.update(liquidity_usd=pair.get("liquidity_usd"), pair_age_hours=round(age_h, 2) if age_h is not None else None,
                   buys_h1=buys, sells_h1=sells, volume_h24=vol, vol_liq_ratio=round(ratio, 2) if ratio else ratio)
    result = {
        "chain": sym.chain, "address": sym.address, "symbol": pair["base"].get("symbol") or "",
        "name": pair["base"].get("name") or "", "pair_address": pair.get("pair_address") or "",
        "dex": pair.get("dex") or "", "pair_url": pair.get("url") or "",
        "checked_at": market_clock.iso(now), "score": int(score), "verdict": verdict,
        "headline": HEADLINES[verdict],
        "checks": [{k: v for k, v in c.items() if k != "reason"} for c in ck.items],
        "reasons": reasons, "metrics": metrics, "sources": sources, "warnings": warnings,
        "explorer_url": sym.explorer_url, "report": None,
    }
    if write:
        state.write_json(_rel_name(sym.chain, sym.address), result)
    return result


def summary(result: dict) -> dict:
    """Compact form other skills attach to a setup or order."""
    return {"verdict": result["verdict"], "score": result["score"], "checked_at": result["checked_at"],
            "file": _rel_name(result["chain"], result["address"]), "reasons": result["reasons"][:3]}


# --- presentation ---------------------------------------------------------------------

def _safety_links(r: dict) -> list:
    links = []
    if r.get("pair_url"):
        links.append(html.link(r["pair_url"], "DexScreener pair"))
    if r.get("explorer_url"):
        links.append(html.link(r["explorer_url"], "Block explorer"))
    if r["chain"] == "solana":
        links.append(html.link("https://rugcheck.xyz/tokens/%s" % r["address"], "RugCheck"))
    elif r["chain"] in symbols.EVM_CHAINS:
        links.append(html.link("https://honeypot.is/%s?address=%s" % (r["chain"], r["address"]), "honeypot.is"))
    return links


def write_report(r: dict):
    tone = {"SAFE": "good", "RISKY": "warn", "DANGER": "bad"}[r["verdict"]]
    m = r["metrics"]
    body = [html.tiles([
        ("Verdict", r["verdict"], tone), ("Score", "%d / 100" % r["score"], tone),
        ("Liquidity", fmt.compact_usd(m.get("liquidity_usd"))),
        ("LP locked", "%.0f%%" % m["lp_locked_pct"] if m.get("lp_locked_pct") is not None else "unknown"),
        ("Top-10 holders", "%.1f%%" % m["top10_pct"] if m.get("top10_pct") is not None else "unknown"),
        ("Pair age", "%.1f h" % m["pair_age_hours"] if m.get("pair_age_hours") is not None else "unknown"),
    ])]
    inner = "<p class='summary'>%s %s</p>" % (html.pill(r["verdict"], tone), html.esc(r["headline"]))
    if r["reasons"]:
        inner += "<ul>%s</ul>" % "".join("<li>%s</li>" % html.esc(x) for x in r["reasons"])
    else:
        inner += "<p class='muted'>None of the checks below raised a flag. That is not a guarantee: meme-coin " \
                 "data can be manipulated and liquidity can still disappear.</p>"
    body.append(html.card("Verdict", inner))
    rows = []
    for c in r["checks"]:
        status = html.Html("<span class='good'>✓</span>") if c["ok"] is True else (
            html.Html("<span class='bad'>✗</span>") if c["ok"] is False else html.Html("<span class='warn'>?</span>"))
        rows.append([status, c["label"], c["value"], c["severity"], "-%d" % c["penalty"] if c["penalty"] else "",
                     c["detail"]])
    body.append(html.card("Checks", html.table(["", "Check", "Value", "Severity", "Penalty", "Detail"], rows)))
    src = " · ".join("%s: %s" % (k, v) for k, v in sorted(r["sources"].items()))
    links = " · ".join(_safety_links(r))
    body.append(html.card("Verify it yourself", "<p>%s</p><p class='sub'>Token %s on %s · sources %s</p>" % (
        links, html.esc(r["address"]), html.esc(r["chain"]), html.esc(src))))
    title = "Rug Check · %s (%s)" % (r["symbol"] or r["address"][:8], r["chain"])
    page = html.page(title, "".join(body), subtitle="checked %s · %s" % (r["checked_at"], r["address"]),
                     asset="meme")
    return html.write_report("rugcheck-%s-%s.html" % (r["chain"], r["address"][:8]), page)


def render_text(r: dict) -> str:
    lines = ["Rug Check · %s (%s) · %s" % (r["symbol"] or "?", r["chain"], r["address"]),
             "Verdict: %s — %s   Score %d/100" % (r["verdict"], r["headline"], r["score"])]
    for c in r["checks"]:
        mark = "✓" if c["ok"] is True else ("✗" if c["ok"] is False else "?")
        pen = (" (-%d)" % c["penalty"]) if c["penalty"] else ""
        lines.append("  %s %-38s %s%s" % (mark, c["label"], c["value"], pen))
    if r["reasons"]:
        lines.append("Reasons:")
        lines.extend("  - " + x for x in r["reasons"])
    lines.append("Sources: " + " · ".join("%s %s" % (k, v) for k, v in sorted(r["sources"].items())))
    for w in r["warnings"]:
        lines.append("  note: " + w)
    lines.append("Saved: trader/" + _rel_name(r["chain"], r["address"]))
    return "\n".join(lines)


def build_parser():
    p = cli.parser("rugcheck.py", __doc__)
    p.add_argument("symbol", help="SOL:<mint>, base:0x…, ethereum:0x…, bsc:0x…, a bare address, or a name with --asset meme")
    return p


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    cli.init(args)
    if args.asset not in (None, "meme"):
        raise ValueError("rugcheck only checks meme coins (DEX tokens) — got --asset %s" % args.asset)
    sym = data.as_symbol(args.symbol, "meme")
    if sym.asset != "meme":
        raise ValueError("%s is not a DEX token — pass SOL:<mint> or chain:0x…" % args.symbol)
    result = check(sym)
    path = None
    if not args.no_html:
        path = write_report(result)
        result["report"] = state.rel(path)
        state.write_json(_rel_name(result["chain"], result["address"]), result)
    text = render_text(result)
    if path:
        text += "\n" + cli.report_line(path)
    cli.emit(args, text, result, "meme")
    cli.maybe_open(args, path)
    return 0


if __name__ == "__main__":
    cli.run(main)
