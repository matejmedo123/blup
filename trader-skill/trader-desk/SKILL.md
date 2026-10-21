---
name: trader-desk
description: Run a trade idea past a four-role AI trading desk that checks its own work — Researcher (news, filings, setup, rugcheck), Skeptic (tries to prove it wrong with the backtest and the 10,000-path Time Machine), Lead (answers every objection, decides GO / NO-GO / WAIT) and Trader (the only role that touches money, via /trader-broker and only after the user's explicit yes). Use when the user says "run the desk on TSLA", "have the team look at this trade", "get a second opinion / devil's advocate on this setup", "should I take this trade", or "hire a team of AIs to check my trade".
---

# Trader · Trading Desk (add-on)

Four roles that check each other's work:

| Role | Who | Job |
|---|---|---|
| **Researcher** | subagent `trader-researcher` | builds the sourced case: setup, entry status, news, 8-K filings, rugcheck |
| **Skeptic** | subagent `trader-skeptic` | tries to prove it wrong: backtest, Time Machine, liquidity, event risk → numbered objections `O1 [critical] …` |
| **Lead** | subagent `trader-lead` | answers *every* objection (rebutted / mitigated / accepted) and decides `GO`, `NO-GO` or `WAIT` |
| **Trader** | **you, in the main conversation** | only on a verified GO: sizer → risk → broker ticket → the user's explicit "yes" |

`desk.py` is the shared desk: it builds the case file from `trader/`, stores each memo, and
`verify` checks that the Lead answered every objection and that a GO clears the hard gates
(exit plan, fresh rugcheck for meme coins, a Time Machine run on the current plan with EV ≥ the
minimum). Soft gates (backtest expectancy and sample size, idea freshness) are shown for the Lead to weigh.

## Run

Set `PACK` to the folder that contains this skill's folder (the parent of `${CLAUDE_SKILL_DIR}`) and
`FLAGS` to any common flags (e.g. `--offline --now 2026-10-20T14:15:00Z` for the demo).

1. Case file and id:
   ```bash
   python3 "${CLAUDE_SKILL_DIR}/desk.py" brief TSLA $FLAGS
   ```
   Note the `ID` it prints (e.g. `TSLA-20261020-orb15`).
2. Spawn the subagents **one after another** (Agent tool), each with a prompt containing
   `PACK=<path>`, `SYMBOL=<symbol>`, `ID=<id>`, `FLAGS=<flags>`:
   `trader-researcher` → wait → `trader-skeptic` → wait → `trader-lead`.
   Do not show the Skeptic the Lead's memo, and do not let the Lead rewrite the Skeptic's memo.
3. Verify and report:
   ```bash
   python3 "${CLAUDE_SKILL_DIR}/desk.py" verify --id TSLA-20261020-orb15 $FLAGS
   ```
4. **Trader step — only if the status is `GO`, and only here in the main conversation:** run the
   commands `verify` prints (`/trader-sizer` → `/trader-risk` → `/trader-broker prepare`), show the
   ticket verbatim and wait for the user to type "yes". A subagent can never approve a ticket.

If the `trader-*` agents are not installed (manual copy without `agents/`), play the three roles
yourself in sequence, writing and recording each memo before starting the next role, and keep them
separate: the Skeptic must argue against the case, not summarise it.

Other actions: `desk.py record --id ID --role researcher|skeptic|lead --file memo.md` and
`desk.py show --id ID` (same as verify, without changing anything you have not recorded).

## Rule-based mode and the news & filings gate

`desk.py auto SYMBOL` writes all three memos mechanically (the autopilot uses this on every trigger).
Its Skeptic also reads the symbol's items in `trader/news_feed.json` inside the lookback
(`autopilot.news_gate.lookback_hours`, stock 24 h / crypto 12 h, plus market-wide crypto items from the
last `market_hours`): a credible (≥ `min_credibility`) item tagged with a `critical_tags` entry — for
stocks an offering / dilution, bankruptcy, delisting or restatement 8-K or headline; for coins a hack or
delisting — becomes a **critical** objection, `major_tags` (merger, FDA, change of control; token unlocks)
a **major** one. StockTwits and small X accounts never block on their own. No feed data, or SEC filings
skipped because `sec_user_agent` is not set, is a minor objection. The gate table shows a non-hard
"news & filings" row.

## Optional AI desk via the Claude API (veto-only)

`ai_desk.py` runs the Skeptic and the Lead through the Claude API instead of subagents — used by the
autopilot when `ai_desk.enabled: true`, or by hand:

```bash
python3 "${CLAUDE_SKILL_DIR}/ai_desk.py" --id NVDA-20261020-orb15 $FLAGS
```

It first runs the rule-based desk; only a rule-based **GO** is sent to Claude (default model
`claude-opus-5-5`), which can turn it into NO-GO or WAIT but never revives an idea the rules rejected.
Headlines, posts and filings go in as untrusted data, never instructions. Needs `pip install anthropic`
and `ANTHROPIC_API_KEY` (environment or `trader/secrets.env`); daily caps `ai_desk.max_calls_per_day` /
`max_usd_per_day`; usage in `trader/ai_usage.json`; results in `desk/{id}/ai.json`, `ai_skeptic.md`,
`ai_lead.md`. Offline, without the SDK or key, or over budget it reports `unavailable` and costs nothing.

## Reads / writes

* reads `setups.json`, `entries.json`, `plan.json`, `news.json`, `news_feed.json`, `rugcheck/`, `backtests/`,
  `timemachine/`, `orders.json`, `config.json` (`"desk": {"min_ev_r": 0.0, "min_backtest_triggers": 10}`), `limits.json`
* writes `trader/desk/{id}/case.json`, `research.md`, `skeptic.md`, `lead.md`, `desk.json`, `log.jsonl`
  (AI desk: `ai.json`, `ai_skeptic.md`, `ai_lead.md`, and `trader/ai_usage.json`)
  and `trader/reports/desk-{id}.html` (four role cards, objections with the Lead's answers, gates)

## How to present results

Lead with the desk status (`GO` / `NO-GO` / `WAIT` / `BLOCKED` / `INCOMPLETE`) and the headline, then
the Skeptic's strongest objection and how the Lead answered it, then the gate table and the report path.
On GO, say plainly that nothing moves until the user types "yes" for the exact ticket. Always include
the disclaimer (stronger for meme coins).

## Never

* Never let any subagent run `trader-broker` or approve a ticket; never skip the user's "yes".
* Never override a BLOCKED verdict by editing memos to hide objections.
* Never call a paid API the user did not configure (X token, Anthropic key) and never exceed its daily
  budget; never touch wallets or keys, never promise profit.
* Never let the AI desk approve what the rule-based gates rejected — it is a veto, not an override.
