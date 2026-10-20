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

from shared import cli, data, fmt, html, market_clock, state, symbols  # noqa: E402

ROLES = ("researcher", "skeptic", "lead")
DEFAULTS = {"min_ev_r": 0.0, "max_idea_age_hours": {"stock": 2, "crypto": 4, "meme": 1}, "min_backtest_triggers": 10}
OBJECTION = re.compile(r"^\s*(?:[-*]\s*)?\**\s*O(\d+)\s*\**\s*[\[(]\s*(critical|major|minor)\s*[\])]\s*:?\s*(.*)$",
                       re.I | re.M)
RESPONSE = re.compile(r"\bO(\d+)\b\s*\**\s*(?::|—|–|-)+\s*\**\s*(accepted|rebutted|mitigated)\b", re.I)
DECISION = re.compile(r"^\s*\**\s*DECISION\s*\**\s*:\s*\**\s*(GO|NO-GO|NO GO|WAIT)\b", re.I | re.M)


def build_parser():
    p = cli.parser("desk.py", __doc__)
    p.add_argument("action", choices=("brief", "record", "verify", "show"), help="what to do")
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
    case["symbol"] = sym.display if sym else raw
    case["symbol_arg"] = raw
    case["asset"] = sym.asset if sym else (case.get("plan") or {}).get("asset")
    key = sym.key if sym else idea_id.rsplit("-", 2)[0]
    case["symbol_key"] = key
    setup = (case.get("plan") or case.get("entry") or case.get("setup") or {}).get("setup")
    case["setup_name"] = setup
    news = state.read_json("news.json", {}) or {}
    case["news"] = [n for n in news.get("items") or []
                    if not n.get("symbol") or _key_of(n.get("symbol", "")) in (key, "")][:12]
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
    if case.get("plan") and not case.get("timemachine"):
        out.append(("skeptic", "no Time Machine run", _cmd("trader-timemachine", "replay.py", "--id %s --seed 7" % idea)))
    return [{"role": r, "what": w, "run": c} for r, w, c in out]


# --- gates and cross-checks --------------------------------------------------------------------

def _gate(name, ok, detail, hard=True):
    return {"name": name, "ok": bool(ok), "hard": hard, "detail": detail}


def gates(case: dict, cfg: dict, limits: dict) -> list:
    desk_cfg = dict(DEFAULTS)
    desk_cfg.update(cfg.get("desk") or {})
    out = []
    plan = case.get("plan")
    if plan:
        e, s, t = plan["entry"]["price"], plan["stop"]["price"], plan["target"]["price"]
        out.append(_gate("exit plan", s < e < t, "entry %s · stop %s · target %s" % (fmt.price(e), fmt.price(s),
                                                                                      fmt.price(t))))
        age_h = (market_clock.now_utc() - market_clock.parse_iso(plan["entry"]["time"])).total_seconds() / 3600.0
        max_age = desk_cfg["max_idea_age_hours"].get(case.get("asset") or "stock", 2)
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
    return out


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
