#!/usr/bin/env python3
"""Trading Desk — four roles that check each other's work: Researcher, Skeptic, Lead, Trader.

The roles are Claude subagents (agents/trader-*.md); this tool is their shared
desk: it assembles the case file from trader/, stores each role's memo, and
verifies that the Lead answered every objection the Skeptic raised and that a
GO decision clears the hard gates. Only the Trader step touches money, and
only through /trader-broker with your explicit "yes".

Examples:
  python3 desk.py brief TSLA
  python3 desk.py record --id TSLA-20261020-orb15 --role skeptic --file skeptic.md
  python3 desk.py verify --id TSLA-20261020-orb15
  python3 desk.py show --id TSLA-20261020-orb15
"""
from __future__ import annotations

import os
import re
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, config, data, fmt, html, market_clock, skills, state, symbols  # noqa: E402

ROLES = ("researcher", "skeptic", "lead")
# The replay resamples ordinary bars, so an honest replay of a fair 2:1 bracket centres on 0R: the hard gate
# only rejects geometry that is clearly negative. The edge itself has to come from the backtest.
DEFAULTS = {"min_ev_r": -0.05, "max_idea_age_hours": {"stock": 2, "crypto": 4, "meme": 1}, "min_backtest_triggers": 10,
            "min_backtest_expectancy_r": 0.05}
AUTO_TAG = "(auto — rule-based desk, not an AI review)"
OBJECTION = re.compile(r"^\s*(?:[-*]\s*)?\**\s*O(\d+)\s*\**\s*[\[(]\s*(critical|major|minor)\s*[\])]\s*:?\s*(.*)$",
                       re.I | re.M)
RESPONSE = re.compile(r"\bO(\d+)\b\s*\**\s*(?::|—|–|-)+\s*\**\s*(accepted|rebutted|mitigated)\b", re.I)
DECISION = re.compile(r"^\s*\**\s*DECISION\s*\**\s*:\s*\**\s*(GO|NO-GO|NO GO|WAIT)\b", re.I | re.M)


def build_parser():
    p = cli.parser("desk.py", __doc__)
    p.add_argument("action", choices=("brief", "record", "verify", "show", "auto"),
                   help="what to do (auto = rule-based Researcher/Skeptic/Lead memos + verify)")
    p.add_argument("--force", action="store_true", help="auto: overwrite memos that already exist")
    p.add_argument("symbol", nargs="?", help="symbol (brief) — or use --id")
    p.add_argument("--id", help="trade idea id (plan / entry / setup id)")
    p.add_argument("--role", choices=ROLES, help="record: whose memo this is")
    p.add_argument("--file", help="record: memo file (markdown)")
    p.add_argument("--text", help="record: memo text instead of a file")
    return p


# --- the case file -----------------------------------------------------------------------

def _plans():
    return (state.read_json("plan.json", {}) or {}).get("plans") or {}


def _entries():
    return (state.read_json("entries.json", {}) or {}).get("entries") or {}


def _setups():
    return (state.read_json("setups.json", {}) or {}).get("setups") or []


def _key_of(raw: str) -> str:
    try:
        return data.as_symbol(raw).key
    except (symbols.SymbolError, ValueError):
        return ""


def resolve_id(symbol: str = None, idea_id: str = None) -> str:
    if idea_id:
        return idea_id
    if not symbol:
        cli.fail("give a symbol or --id")
    key = _key_of(symbol)
    for pool in (_plans(), _entries()):
        ids = sorted((i for i in pool if i.startswith(key + "-")), key=lambda i: pool[i].get("created_at")
                     or pool[i].get("checked_at") or "", reverse=True)
        if ids:
            return ids[0]
    hits = [h for h in _setups() if h.get("id", "").startswith(key + "-")]
    if hits:
        return sorted(hits, key=lambda h: -(h.get("score") or 0))[0]["id"]
    return "%s-%s-desk" % (key, market_clock.now_utc().strftime("%Y%m%d"))


def _idea_symbol(idea_id: str, case: dict) -> str:
    for src in (case.get("plan"), case.get("entry"), case.get("setup")):
        if src and src.get("symbol"):
            return src["symbol"]
    return idea_id.rsplit("-", 2)[0]


def _find_file(folder: str, prefix: str):
    d = state.home() / folder
    if not d.exists():
        return None
    files = sorted(d.glob(prefix + "*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def build_case(idea_id: str, symbol: str = None) -> dict:
    case = {"id": idea_id, "pack_root": _ROOT, "built_at": market_clock.iso(market_clock.now_utc())}
    case["plan"] = _plans().get(idea_id)
    case["entry"] = _entries().get(idea_id)
    case["setup"] = next((h for h in _setups() if h.get("id") == idea_id), None)
    raw = symbol or _idea_symbol(idea_id, case)
    try:
        sym = data.as_symbol(raw)
    except (symbols.SymbolError, ValueError):
        sym = None
    shown = (case.get("plan") or case.get("entry") or {}).get("symbol_display")
    case["symbol"] = shown or (sym.display if sym else raw)
    case["symbol_arg"] = raw
    case["asset"] = sym.asset if sym else (case.get("plan") or {}).get("asset")
    key = sym.key if sym else idea_id.rsplit("-", 2)[0]
    case["symbol_key"] = key
    setup = (case.get("plan") or case.get("entry") or case.get("setup") or {}).get("setup")
    case["setup_name"] = setup
    news = state.read_json("news.json", {}) or {}
    case["news"] = [n for n in news.get("items") or []
                    if not n.get("symbol") or _key_of(n.get("symbol", "")) in (key, "")][:12]
    case["feed_scope"] = _feed_scope(sym, raw, case.get("asset"))
    case["feed"] = build_feed(case, sym)
    case["rugcheck"] = None
    if sym and sym.asset == "meme" and sym.chain and sym.address:
        case["rugcheck"] = state.read_json("rugcheck/%s-%s.json" % (sym.chain, sym.address))
    bt = state.read_json("backtests/%s-%s.json" % (key, setup)) if setup else None
    case["backtest"] = bt
    tm = None
    tm_file = _find_file("timemachine", key + "-")
    if tm_file:
        tm = state.read_json(state.rel(tm_file))
        if tm and tm.get("id") not in (None, idea_id):
            tm = None
    case["timemachine"] = tm
    orders = [o for o in (state.read_json("orders.json", {}) or {}).get("orders") or [] if o.get("plan_id") == idea_id]
    case["order"] = orders[-1] if orders else None
    case["missing"] = missing_steps(case)
    return case


# --- news & filings (news_feed.json) -------------------------------------------------------------

FEED_FIELDS = ("id", "title", "source", "kind", "published", "tags", "importance", "credibility", "sentiment", "url",
               "symbol")
FEED_MAX = 15


def news_gate_cfg(cfg: dict) -> dict:
    base = (config.DEFAULT_CONFIG.get("autopilot") or {}).get("news_gate") or {}
    return config.deep_merge(base, ((cfg or {}).get("autopilot") or {}).get("news_gate") or {})


def _feed_scope(sym, raw, asset):
    if sym is None:
        return None
    if sym.asset == "stock":
        return "stock:%s" % sym.key
    if sym.asset == "crypto":
        return "crypto:%s" % sym.base
    return "meme:%s" % raw


def _credibility(it: dict) -> int:
    if it.get("credibility") is not None:
        return int(it["credibility"])
    try:
        return int(skills.load("trader-news", "news").credibility(it))
    except Exception:
        return 1


def _age_h(it: dict, now_ts: float):
    if not it.get("published"):
        return None
    try:
        return (now_ts - market_clock.parse_iso(it["published"]).timestamp()) / 3600.0
    except (TypeError, ValueError):
        return None


def build_feed(case: dict, sym) -> list:
    """The symbol's news-feed items inside the lookback (+ recent market-wide crypto items), newest first."""
    cfg = config.load_config()
    ng = news_gate_cfg(cfg)
    asset = case.get("asset") or "stock"
    look = float((ng.get("lookback_hours") or {}).get(asset if asset != "meme" else "crypto") or 24)
    market_h = float(ng.get("market_hours") or 6)
    now_ts = market_clock.now_utc().timestamp()
    names = set()
    if sym is not None:
        names = {sym.key.upper(), (sym.base or "").upper(), (sym.display or "").upper()}
        if sym.asset == "meme":
            names.add(str(case.get("symbol_arg") or "").upper())
    names.discard("")
    pool = list((state.read_json("news_feed.json", {}) or {}).get("items") or [])
    pool += [dict(n, credibility=_credibility(n)) for n in case.get("news") or []]
    out, seen = [], set()
    for it in pool:
        if it.get("id") in seen:
            continue
        age = _age_h(it, now_ts)
        if age is None or age < -0.01:
            continue
        mine = str(it.get("symbol") or "").upper() in names and (it.get("asset") in (None, asset)
                                                                  or asset == "meme")
        market = (asset == "crypto" and str(it.get("symbol") or "") == "market"
                  and it.get("asset") in (None, "crypto") and age <= market_h)
        if not (mine and age <= look) and not market:
            continue
        seen.add(it.get("id"))
        row = {k: it.get(k) for k in FEED_FIELDS}
        row["credibility"] = _credibility(it)
        row["tags"] = list(it.get("tags") or [])
        out.append(row)
    flagged = {f["item"]["id"] for f in _news_flags_for(out, asset, ng, now_ts)}
    out.sort(key=lambda r: r.get("published") or "", reverse=True)
    keep = [r for r in out if r["id"] in flagged][:FEED_MAX]
    keep += [r for r in out if r["id"] not in flagged][:max(0, FEED_MAX - len(keep))]
    keep.sort(key=lambda r: r.get("published") or "", reverse=True)
    return keep


def _news_flags_for(items: list, asset: str, ng: dict, now_ts: float) -> list:
    if asset not in ("stock", "crypto"):
        return []
    crit = set((ng.get("critical_tags") or {}).get(asset) or [])
    major = set((ng.get("major_tags") or {}).get(asset) or [])
    min_cred = int(ng.get("min_credibility") or 0)
    out = []
    for it in items:
        if _credibility(it) < min_cred:
            continue
        tags = list(it.get("tags") or [])
        market = it.get("symbol") == "market"
        hit = next((t for t in tags if t in crit), None)
        sev = "critical" if hit else None
        if not hit:
            hit = next((t for t in tags if t in major), None)
            sev = "major" if hit else None
        if not hit:
            continue
        if market:  # it is about the whole market, not this coin: one level softer
            sev = "major"
        out.append({"severity": sev, "tag": hit, "item": it, "age_h": _age_h(it, now_ts), "market": market})
    out.sort(key=lambda f: (f["severity"] != "critical", f["age_h"] if f["age_h"] is not None else 1e9))
    return out


def news_flags(case: dict, cfg: dict) -> list:
    """Critical / major news and filings for this idea: [{"severity","tag","item","age_h","market"}]."""
    ng = news_gate_cfg(cfg)
    if not ng.get("enabled", True):
        return []
    return _news_flags_for(case.get("feed") or [], case.get("asset") or "stock", ng,
                           market_clock.now_utc().timestamp())


def _ago(h) -> str:
    if h is None:
        return "time unknown"
    if h < 1:
        return "%d min ago" % max(0, round(h * 60))
    return "%.1f h ago" % h


def _filings_skipped(case: dict, cfg: dict) -> bool:
    return case.get("asset") == "stock" and not config.is_offline() and not config.sec_user_agent(cfg)


def _feed_refreshed(case: dict):
    scope = case.get("feed_scope")
    if not scope:
        return None
    return ((state.read_json("news_feed.json", {}) or {}).get("refreshed") or {}).get(scope)


def _cmd(skill: str, tool: str, args: str) -> str:
    return 'python3 "%s" %s' % (os.path.join(_ROOT, skill, tool), args)


def missing_steps(case: dict) -> list:
    sym, idea = case["symbol_arg"], case["id"]
    out = []
    if not case.get("setup") and not case.get("entry"):
        out.append(("researcher", "no scanner hit or entry yet", _cmd("trader-entry", "entry.py", '"%s"' % sym)))
    if not case.get("news"):
        out.append(("researcher", "no news checked", _cmd("trader-news", "news.py", '--symbols "%s"' % sym)))
    if case.get("asset") == "meme" and not case.get("rugcheck"):
        out.append(("researcher", "no rugcheck", _cmd("trader-rugcheck", "rugcheck.py", '"%s"' % sym)))
    if not case.get("plan"):
        out.append(("researcher", "no exit plan", _cmd("trader-exit", "exit.py", "--id %s" % idea)))
    if case.get("setup_name") and not case.get("backtest"):
        out.append(("skeptic", "no backtest of this setup",
                    _cmd("trader-backtest", "backtest.py", '"%s" --setup %s' % (sym, case["setup_name"]))))
    if case.get("plan") and not case.get("timemachine") and not (case["plan"].get("exit_rule")):
        out.append(("skeptic", "no Time Machine run", _cmd("trader-timemachine", "replay.py", "--id %s --seed 7" % idea)))
    return [{"role": r, "what": w, "run": c} for r, w, c in out]


# --- gates and cross-checks --------------------------------------------------------------------

def _gate(name, ok, detail, hard=True):
    return {"name": name, "ok": bool(ok), "hard": hard, "detail": detail}


def gates(case: dict, cfg: dict, limits: dict) -> list:
    desk_cfg = _desk_cfg(cfg)
    out = []
    plan = case.get("plan")
    if plan:
        e, s, t = plan["entry"]["price"], plan["stop"]["price"], plan["target"]["price"]
        out.append(_gate("exit plan", s < e < t, "entry %s · stop %s · target %s" % (fmt.price(e), fmt.price(s),
                                                                                      fmt.price(t))))
        age_h = (market_clock.now_utc() - market_clock.parse_iso(plan["entry"]["time"])).total_seconds() / 3600.0
        max_age = max_idea_age(desk_cfg, case.get("asset"), plan)
        out.append(_gate("idea still fresh", age_h <= max_age, "entry was %.1f h ago (limit %s h)" % (age_h, max_age),
                         hard=False))
    else:
        out.append(_gate("exit plan", False, "no plan in trader/plan.json — run /trader-exit"))
    if case.get("asset") == "meme":
        rc = case.get("rugcheck")
        allowed = (limits.get("meme") or {}).get("required_rugcheck_verdicts") or ["SAFE"]
        if rc:
            age_m = (market_clock.now_utc() - market_clock.parse_iso(rc["checked_at"])).total_seconds() / 60.0
            max_m = (limits.get("meme") or {}).get("rugcheck_max_age_minutes", 60)
            out.append(_gate("rugcheck", rc.get("verdict") in allowed and age_m <= max_m,
                             "%s (score %s), %.0f min old — allowed %s within %s min"
                             % (rc.get("verdict"), rc.get("score"), age_m, "/".join(allowed), max_m)))
        else:
            out.append(_gate("rugcheck", False, "no rugcheck for this token — a meme coin without one is always blocked"))
    tm = case.get("timemachine")
    if tm:
        ev = (tm.get("expected_value") or {}).get("r")
        p = tm.get("probabilities") or {}
        matches = not plan or (abs(tm.get("stop", 0) - plan["stop"]["price"]) < 1e-12
                               and abs(tm.get("target", 0) - plan["target"]["price"]) < 1e-12)
        out.append(_gate("Time Machine run on this plan", matches,
                         "replayed with the current stop/target" if matches else "stop/target changed since the replay"))
        out.append(_gate("Time Machine expected value", ev is not None and ev >= desk_cfg["min_ev_r"],
                         "EV %s · target %s / stop %s / neither %s (minimum EV %s)"
                         % (fmt.r(ev), fmt.prob(p.get("target")), fmt.prob(p.get("stop")), fmt.prob(p.get("neither")),
                            fmt.r(desk_cfg["min_ev_r"]))))
    elif plan and plan.get("exit_rule"):
        out.append(_gate("Time Machine", True, "not applicable — this plan exits on a rule (%s), which the replay "
                         "can't model; the backtest lab's walk-forward result is the evidence"
                         % (plan["exit_rule"].get("text") or plan["exit_rule"].get("type")), hard=False))
    else:
        out.append(_gate("Time Machine", False, "no replay yet — run /trader-timemachine"))
    bt = case.get("backtest")
    if bt:
        exp = bt.get("expectancy_r")
        out.append(_gate("backtest expectancy", exp is not None and exp >= 0,
                         "%s · expectancy %s after costs" % (bt.get("summary", ""), fmt.r(exp)), hard=False))
        out.append(_gate("backtest sample size", (bt.get("triggers") or 0) >= desk_cfg["min_backtest_triggers"],
                         "%s triggers (want ≥ %s)" % (bt.get("triggers"), desk_cfg["min_backtest_triggers"]), hard=False))
    else:
        out.append(_gate("backtest", False, "setup not backtested", hard=False))
    out.append(_news_gate(case, cfg, desk_cfg))
    return out


def _news_gate(case: dict, cfg: dict, desk_cfg: dict) -> dict:
    ng = desk_cfg.get("news_gate") or news_gate_cfg(cfg)
    feed = case.get("feed") or []
    asset = case.get("asset") or "stock"
    look = (ng.get("lookback_hours") or {}).get(asset if asset != "meme" else "crypto")
    if not ng.get("enabled", True):
        return _gate("news & filings", True, "news gate off (autopilot.news_gate.enabled)", hard=False)
    flags = news_flags(case, cfg)
    if flags:
        f = flags[0]
        return _gate("news & filings", False, "%d alarming item(s) — worst: %s %s (%s, %s)" % (
            len(flags), f["severity"], f["tag"], f["item"].get("source"), _ago(f["age_h"])), hard=False)
    if not feed and not _feed_refreshed(case):
        return _gate("news & filings", False, "never fetched for this symbol", hard=False)
    extra = " · SEC filings not checked (set sec_user_agent)" if _filings_skipped(case, cfg) else ""
    return _gate("news & filings", True, "%d item(s) in the last %s h, nothing alarming%s" % (len(feed), look, extra),
                 hard=False)


def memo_path(idea_id: str, role: str):
    return state.path("desk", idea_id, "%s.md" % role)


def read_memo(idea_id: str, role: str) -> str:
    p = state.home() / "desk" / idea_id / ("%s.md" % role)
    return p.read_text(encoding="utf-8") if p.exists() else ""


def parse_objections(text: str) -> list:
    out, seen = [], set()
    for m in OBJECTION.finditer(text or ""):
        n = int(m.group(1))
        if n in seen:
            continue
        seen.add(n)
        out.append({"id": "O%d" % n, "severity": m.group(2).lower(), "text": m.group(3).strip()})
    return out


def parse_responses(text: str) -> dict:
    out = {}
    for m in RESPONSE.finditer(text or ""):
        out.setdefault("O%d" % int(m.group(1)), m.group(2).lower())
    return out


def parse_decision(text: str):
    m = DECISION.search(text or "")
    return m.group(1).upper().replace("NO GO", "NO-GO") if m else None


def verify(idea_id: str, case: dict, cfg: dict, limits: dict) -> dict:
    memos = {r: read_memo(idea_id, r) for r in ROLES}
    issues = []
    for r in ROLES:
        if not memos[r].strip():
            issues.append("%s memo missing — record it with: desk.py record --id %s --role %s --file …" % (r, idea_id, r))
    objections = parse_objections(memos["skeptic"])
    if memos["skeptic"].strip() and not objections:
        issues.append("the Skeptic raised no objections in the O1 [severity] format — a skeptic who finds nothing "
                      "did not look hard enough")
    responses = parse_responses(memos["lead"])
    for o in objections:
        o["response"] = responses.get(o["id"])
        if not o["response"]:
            issues.append("the Lead did not answer %s (%s)" % (o["id"], o["severity"]))
    decision = parse_decision(memos["lead"])
    if memos["lead"].strip() and not decision:
        issues.append("the Lead memo has no 'DECISION: GO | NO-GO | WAIT' line")
    g = gates(case, cfg, limits)
    blockers = []
    if decision == "GO":
        blockers += ["hard gate failed: %s — %s" % (x["name"], x["detail"]) for x in g if x["hard"] and not x["ok"]]
        blockers += ["%s is a critical objection the Lead accepted without mitigating it" % o["id"]
                     for o in objections if o["severity"] == "critical" and o.get("response") == "accepted"]
        blockers += issues
    if decision == "GO" and not blockers:
        status, headline = "GO", "Cleared by the desk. The Trader may size, risk-check and prepare a ticket; nothing is sent without your yes."
    elif decision == "GO":
        status, headline = "BLOCKED", "The Lead said GO, but the desk cannot clear it: " + "; ".join(blockers[:3])
    elif decision in ("NO-GO", "WAIT"):
        status = decision
        headline = ("The Trader stands down, no money moves." if decision == "NO-GO"
                    else "The Lead wants a condition met first; the Trader stands down for now.")
    else:
        status, headline = "INCOMPLETE", "The desk has not finished: " + "; ".join(issues[:2] or ["no Lead decision yet"])
    return {"id": idea_id, "symbol": case.get("symbol"), "asset": case.get("asset"), "status": status,
            "decision": decision, "headline": headline, "objections": objections, "issues": issues,
            "blockers": blockers, "gates": g, "verified_at": market_clock.iso(market_clock.now_utc()),
            "trader_next": trader_next(case, status)}


def max_idea_age(d: dict, asset: str, plan: dict = None) -> float:
    """Hours an idea stays fresh; a signal on daily bars stays good for longer than an intraday one."""
    hours = float(d["max_idea_age_hours"].get(asset or "stock", 2))
    if (plan or {}).get("interval") == "1d":  # a daily stock signal waits over a weekend or a holiday
        return max(hours, 96.0 if (asset or "stock") == "stock" else 12.0)
    return hours


def _desk_cfg(cfg: dict) -> dict:
    out = dict(DEFAULTS)
    gates_cfg = ((cfg.get("autopilot") or {}).get("gates") or {})
    for k in ("min_backtest_triggers", "min_backtest_expectancy_r"):
        if k in gates_cfg:
            out[k] = gates_cfg[k]
    if "min_tm_ev_r" in gates_cfg:  # one replay threshold for the desk and the autopilot
        out["min_ev_r"] = gates_cfg["min_tm_ev_r"]
    out["news_gate"] = news_gate_cfg(cfg)
    out.update(cfg.get("desk") or {})
    return out


def auto_memos(case: dict, cfg: dict, limits: dict) -> dict:
    """Mechanical Researcher / Skeptic / Lead: the same checks every time, written as desk memos.

    The Skeptic turns every weak number into a numbered objection; the Lead accepts what the data
    says and only decides GO when there is nothing critical or major left.
    """
    d = _desk_cfg(cfg)
    plan, bt, tm, rc = case.get("plan"), case.get("backtest"), case.get("timemachine"), case.get("rugcheck")
    sym, asset = case.get("symbol"), case.get("asset")
    # Researcher
    r = ["## Thesis %s" % AUTO_TAG]
    src = case.get("entry") or case.get("setup") or {}
    if plan:
        r.append("%s on %s: %s. Entry %s · stop %s · target %s." % (
            plan.get("label") or plan.get("setup"), sym, src.get("rule") or "setup triggered",
            fmt.price(plan["entry"]["price"]), fmt.price(plan["stop"]["price"]), fmt.price(plan["target"]["price"])))
    else:
        r.append("%s: no exit plan yet." % sym)
    r.append("## Evidence")
    if case.get("setup"):
        h = case["setup"]
        m = h.get("metrics") or {}
        r.append("- setups.json: %s, score %s%s" % (h.get("status"), h.get("score"),
                                                     ", relvol %.1f×" % m["relvol"] if m.get("relvol") else ""))
    if bt:
        r.append("- backtests: %s expectancy %s after costs" % (bt.get("summary"), fmt.r(bt.get("expectancy_r"))))
    if tm:
        p = tm.get("probabilities") or {}
        r.append("- timemachine: target first %s, stop first %s, EV %s" % (
            fmt.prob(p.get("target")), fmt.prob(p.get("stop")), fmt.r((tm.get("expected_value") or {}).get("r"))))
    if rc:
        r.append("- rugcheck: %s (score %s)" % (rc.get("verdict"), rc.get("score")))
    now_ts = market_clock.now_utc().timestamp()
    feed = case.get("feed") or []
    look = (d["news_gate"].get("lookback_hours") or {}).get(asset if asset != "meme" else "crypto")
    for n in feed[:5]:
        r.append("- news %s (%s, %s): %s%s" % (
            n.get("source"), n.get("kind") or "news", _ago(_age_h(n, now_ts)), n.get("title"),
            " [%s]" % ", ".join(n["tags"]) if n.get("tags") else ""))
    if not feed:
        r.append("- news: %s" % ("no headlines or filings in the last %s h" % look if _feed_refreshed(case)
                                 else "never fetched for this symbol"))
    r.append("## Data gaps")
    r.append("- a rule-based desk reads only the numbers above; it cannot judge context the way a human or AI reviewer can")
    # Skeptic
    obj = []

    def o(sev, text):
        obj.append("O%d [%s] %s" % (len(obj) + 1, sev, text))
    if not plan:
        o("critical", "no exit plan — nothing to size or protect")
    if not bt:
        o("major", "this rule was never backtested on %s" % sym)
    else:
        exp, n = bt.get("expectancy_r"), bt.get("triggers") or 0
        if exp is None or exp < 0:
            o("critical", "this rule lost money on %s: expectancy %s after costs over %d triggers — evidence: %s"
              % (sym, fmt.r(exp), n, bt.get("summary")))
        elif exp < d["min_backtest_expectancy_r"]:
            o("major", "the edge is too thin to pay for mistakes: expectancy %s (want ≥ %s)"
              % (fmt.r(exp), fmt.r(d["min_backtest_expectancy_r"])))
        if n < d["min_backtest_triggers"]:
            o("major", "thin sample: only %d past triggers (want ≥ %d)" % (n, d["min_backtest_triggers"]))
    rule_exit = bool(plan and plan.get("exit_rule"))
    if not tm and not rule_exit:
        o("critical", "no Time Machine replay of this plan")
    elif tm:
        ev = (tm.get("expected_value") or {}).get("r")
        p = tm.get("probabilities") or {}
        if ev is None or ev < d["min_ev_r"]:
            o("critical", "the replay says this geometry loses: EV %s (minimum %s)" % (fmt.r(ev), fmt.r(d["min_ev_r"])))
        if (p.get("rug") or 0) >= 0.05:
            o("major", "%s of replays end in a rug pull" % fmt.prob(p.get("rug")))
        if p.get("target") is not None and p.get("stop") is not None and p["stop"] >= 2 * max(p["target"], 1e-9):
            o("minor", "stop first is %s vs target first %s — fine only if the backtest edge is real"
              % (fmt.prob(p["stop"]), fmt.prob(p["target"])))
    if asset == "meme":
        allowed = (limits.get("meme") or {}).get("required_rugcheck_verdicts") or ["SAFE"]
        if not rc or rc.get("verdict") not in allowed:
            o("critical", "rugcheck is %s — meme coins need %s" % ((rc or {}).get("verdict") or "missing", "/".join(allowed)))
    if plan:
        age_h = (market_clock.now_utc() - market_clock.parse_iso(plan["entry"]["time"])).total_seconds() / 3600.0
        if age_h > max_idea_age(d, asset, plan):
            o("major", "the idea is stale: entry was %.1f h ago" % age_h)
    shown = {}
    for f in news_flags(case, cfg):
        if shown.get(f["severity"], 0) >= 3:
            continue
        shown[f["severity"]] = shown.get(f["severity"], 0) + 1
        it = f["item"]
        what = "market-wide %s news" % f["tag"] if f["market"] else "%s %s" % (
            "filing" if it.get("kind") == "filing" else "news", f["tag"])
        o(f["severity"], "%s: \"%s\" — %s, %s" % (what, it.get("title"), it.get("source"), _ago(f["age_h"])))
    if d["news_gate"].get("enabled", True):
        if not (case.get("feed") or []) and not _feed_refreshed(case):
            o("minor", "news and filings were never fetched for %s — the desk is blind to headlines" % sym)
        if _filings_skipped(case, cfg):
            o("minor", "SEC filings were not checked — set sec_user_agent (\"Your Name you@domain.com\") in "
                       "trader/config.json")
    if any("earnings" in (n.get("tags") or []) for n in (case.get("feed") or []) + (case.get("news") or [])):
        o("minor", "earnings headlines in the feed — event risk inside or right after the holding window")
    if rule_exit:
        o("minor", "the exit is a rule (%s): the result depends on the backtest lab's out-of-sample record, not on a "
          "replay of this exact trade" % (plan["exit_rule"].get("text") or plan["exit_rule"].get("type")))
    else:
        o("minor", "the replay resamples ordinary bars — it cannot see news shocks, halts or gaps")
    sk = obj + ["## Verdict %s" % AUTO_TAG]
    severities = [x.split("[", 1)[1].split("]", 1)[0] for x in obj]
    blocking = [x for x, sev in zip(obj, severities) if sev in ("critical", "major")]
    sk.append("Blocking objections: %d." % len(blocking) if blocking else "Nothing blocking found in the numbers.")
    # Lead
    lead = []
    for x, sev in zip(obj, severities):
        tag = x.split(" ", 1)[0]
        lead.append("%s: accepted — %s" % (tag, "the numbers say so" if sev != "minor" else "noted"))
    decision = "NO-GO" if blocking else "GO"
    lead.append("DECISION: %s" % decision)
    lead.append(("Rule-based call: %d blocking objection(s) — the Trader stands down." % len(blocking)) if blocking else
                "Rule-based call: the backtest shows an edge, the replay does not reject the geometry, nothing "
                "critical or major is open. The Trader may size, risk-check and prepare a ticket.")
    lead.append(AUTO_TAG)
    return {"researcher": "\n".join(r), "skeptic": "\n".join(sk), "lead": "\n".join(lead)}


def auto_review(idea_id: str, cfg: dict, limits: dict, force: bool = True, symbol: str = None) -> dict:
    """Write rule-based memos for all three roles and verify — used by the demo and the autopilot."""
    case = build_case(idea_id, symbol)
    memos = auto_memos(case, cfg, limits)
    for role, text in memos.items():
        p = memo_path(idea_id, role)
        if force or not p.exists():
            p.write_text(text + "\n", encoding="utf-8")
    state.append_jsonl("desk/%s/log.jsonl" % idea_id, {"at": market_clock.iso(market_clock.now_utc()), "role": "auto"})
    result = verify(idea_id, case, cfg, limits)
    state.write_json("desk/%s/case.json" % idea_id, case)
    state.write_json("desk/%s/desk.json" % idea_id, result)
    return result


def trader_next(case: dict, status: str) -> list:
    if status != "GO":
        return []
    idea = case["id"]
    return [_cmd("trader-sizer", "size.py", "--id %s" % idea), _cmd("trader-risk", "risk.py", ""),
            _cmd("trader-broker", "ticket.py", "prepare"),
            "show the ticket to the user and wait for an explicit \"yes\" before ticket.py approve"]


# --- output -------------------------------------------------------------------------------------

def _memo_html(text: str, limit: int = 1800) -> str:
    if not text.strip():
        return "<p class='muted'>no memo yet</p>"
    t = text.strip()
    cut = len(t) > limit
    t = t[:limit]
    paras = [html.esc(p).replace("\n", "<br>") for p in re.split(r"\n\s*\n", t)]
    return "".join("<p>%s</p>" % p for p in paras) + ("<p class='muted'>…</p>" if cut else "")


ROLE_CARDS = (("researcher", "Researcher", "News · filings · setup · rugcheck", "#0a7d74"),
              ("skeptic", "Skeptic", "Tries to prove it wrong", "#cf222e"),
              ("lead", "Lead", "Makes the call — answers every objection", "#9a6700"),
              ("trader", "Trader", "Only one touching money — and only after your yes", "#1a7f37"))


def report(case: dict, result: dict) -> str:
    tone = {"GO": "good", "NO-GO": "bad", "BLOCKED": "bad", "WAIT": "warn"}.get(result["status"], "info")
    body = [html.tiles([("Desk status", result["status"], tone), ("Symbol", case.get("symbol") or "?"),
                        ("Objections", str(len(result["objections"]))),
                        ("Hard gates", "%d / %d passed" % (sum(1 for g in result["gates"] if g["hard"] and g["ok"]),
                                                          sum(1 for g in result["gates"] if g["hard"])))]),
            html.card("", "<p class='summary'><b>%s — %s</b></p><p class='muted'>Four roles that check each other's "
                          "work: the Skeptic attacks the Researcher's case, the Lead must answer every objection, "
                          "and this desk verifies the Lead's call against hard gates.</p>"
                      % (html.esc(result["status"]), html.esc(result["headline"])))]
    cards = []
    for role, title, sub, color in ROLE_CARDS:
        if role == "trader":
            if result["trader_next"]:
                inner = "<ol>%s</ol>" % "".join("<li><code>%s</code></li>" % html.esc(c) for c in result["trader_next"])
            else:
                inner = "<p>Stands down — no sizing, no ticket, no money moves.</p>"
        else:
            inner = _memo_html(read_memo(case["id"], role))
        cards.append("<section class='card' style='border-top:4px solid %s'><h2 style='color:%s'>%s</h2>"
                     "<div class='sub'>%s</div>%s</section>" % (color, color, html.esc(title), html.esc(sub), inner))
    body.append("<div class='grid' style='grid-template-columns:repeat(auto-fit,minmax(min(100%%,420px),1fr))'>%s</div>"
                % "".join(cards))
    if result["objections"]:
        rows = [[o["id"], o["severity"], o["text"][:160], o.get("response") or "— unanswered —"]
                for o in result["objections"]]
        body.append(html.card("Skeptic's objections and the Lead's answers",
                              html.table(["#", "Severity", "Objection", "Lead"], rows)))
    rows = [[g["name"], "hard" if g["hard"] else "soft", html.Html("<b class='%s'>%s</b>" % (
        "good" if g["ok"] else ("bad" if g["hard"] else "warn"), "pass" if g["ok"] else "fail")), g["detail"]]
            for g in result["gates"]]
    body.append(html.card("Gates", html.table(["Gate", "Type", "Result", "Detail"], rows)))
    if result["issues"]:
        body.append(html.card("Cross-check issues", "<ul>%s</ul>" % "".join(
            "<li>%s</li>" % html.esc(i) for i in result["issues"])))
    return html.page("Trading desk · %s" % (case.get("symbol") or case["id"]), "".join(body),
                     "%s · %s" % (case["id"], result["verified_at"]), asset=case.get("asset"))


def brief_text(case: dict) -> str:
    lines = ["Desk case file · %s · %s" % (case["symbol"], case["id"]),
             "  pack: %s" % case["pack_root"]]
    plan = case.get("plan")
    if plan:
        lines.append("  plan: entry %s · stop %s · target %s (%s)" % (
            fmt.price(plan["entry"]["price"]), fmt.price(plan["stop"]["price"]), fmt.price(plan["target"]["price"]),
            plan.get("setup")))
    if case.get("entry"):
        lines.append("  entry: %s — %s" % (case["entry"].get("status"), case["entry"].get("rule")))
    if case.get("rugcheck"):
        lines.append("  rugcheck: %s (score %s)" % (case["rugcheck"].get("verdict"), case["rugcheck"].get("score")))
    if case.get("backtest"):
        lines.append("  backtest: %s" % case["backtest"].get("summary"))
    if case.get("timemachine"):
        tm = case["timemachine"]
        p = tm.get("probabilities") or {}
        lines.append("  time machine: target %s · stop %s · EV %s" % (
            fmt.prob(p.get("target")), fmt.prob(p.get("stop")), fmt.r((tm.get("expected_value") or {}).get("r"))))
    lines.append("  news items: %d" % len(case.get("news") or []))
    if case["missing"]:
        lines.append("Still missing:")
        for m in case["missing"]:
            lines.append("  [%s] %s → %s" % (m["role"], m["what"], m["run"]))
    lines.append("Case file: %s" % state.path("desk", case["id"], "case.json"))
    return "\n".join(lines)


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    ctx = cli.init(args)
    idea_id = resolve_id(args.symbol, args.id)
    if args.action == "record":
        if not args.role or not (args.file or args.text):
            cli.fail("record needs --role and --file or --text")
        text = args.text if args.text is not None else open(args.file, encoding="utf-8").read()
        p = memo_path(idea_id, args.role)
        p.write_text(text.rstrip() + "\n", encoding="utf-8")
        state.append_jsonl("desk/%s/log.jsonl" % idea_id, {"at": market_clock.iso(market_clock.now_utc()),
                                                           "role": args.role, "chars": len(text)})
        extra = ""
        if args.role == "skeptic":
            extra = " · %d objections parsed" % len(parse_objections(text))
        if args.role == "lead":
            extra = " · decision %s" % (parse_decision(text) or "missing")
        cli.emit(args, "Recorded the %s memo for %s → %s%s" % (args.role, idea_id, p, extra),
                 {"id": idea_id, "role": args.role, "file": state.rel(p)})
        return 0
    if args.action == "auto":
        auto_review(idea_id, ctx.cfg, ctx.limits, force=args.force or True, symbol=args.symbol)
    case = build_case(idea_id, args.symbol)
    state.write_json("desk/%s/case.json" % idea_id, case)
    if args.action == "brief":
        cli.emit(args, brief_text(case), case, case.get("asset"))
        return 0
    result = verify(idea_id, case, ctx.cfg, ctx.limits)
    state.write_json("desk/%s/desk.json" % idea_id, result)
    path = None
    if not args.no_html:
        path = html.write_report("desk-%s.html" % idea_id, report(case, result))
    lines = ["Desk · %s · %s" % (case.get("symbol"), idea_id), "Status: %s — %s" % (result["status"], result["headline"])]
    for o in result["objections"]:
        lines.append("  %s [%s] %s → Lead: %s" % (o["id"], o["severity"], o["text"][:90], o.get("response") or "UNANSWERED"))
    for g in result["gates"]:
        lines.append("  %s %-30s %s%s" % ("✓" if g["ok"] else "✗", g["name"], g["detail"], "" if g["hard"] else " (soft)"))
    for i in result["issues"]:
        lines.append("  issue: %s" % i)
    if result["trader_next"]:
        lines.append("Trader next (main conversation only — the user must type yes):")
        lines += ["  %s" % c for c in result["trader_next"]]
    if path:
        lines.append(cli.report_line(path))
    cli.emit(args, "\n".join(lines), dict(result, report=cli.rel(path)), case.get("asset"))
    cli.maybe_open(args, path)
    return 0


if __name__ == "__main__":
    cli.run(main)
