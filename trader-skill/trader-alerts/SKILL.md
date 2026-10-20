---
name: trader-alerts
description: Price alerts that ring once — a price above/below/crossing a level, a plan's stop or target, a ±% move from the previous close (stocks) or 24 h ago (crypto/meme), the NYSE opening bell, and meme-coin alarms (pool liquidity pulled, dev wallet selling, top-holder concentration jump). Designed to run on a schedule with /loop or a scheduled task; stock alerts only during NYSE hours, crypto and meme 24/7. Use when the user says "alert me when TSLA hits 365", "ping me if BTC crosses 67.7k", "watch my stop", "set alerts from my plan", "tell me at the opening bell", "warn me if liquidity drops", "is the market open", "NYSE holidays".
---

# Trader · Price Alerts

Keeps a list of alerts in `trader/alerts.json`. `check` looks at every active alert once,
rings each at most once (status → `fired`, logged to `trader/alerts_log.jsonl`) and stays
quiet otherwise. The opening bell is the one recurring alert: once per trading day.

- **Stocks** are checked only while the NYSE regular session is open (`--anytime` overrides).
  The NYSE calendar (2026–2027 official holidays and 1:00 p.m. early closes) lives in
  `nyse_calendar.py`.
- **Crypto and meme coins** are checked 24/7.
- **Meme-only:** `--liquidity-drop 30` (pool liquidity −30 % from when the alert was set),
  `--dev-selling 25` (creator wallet share down 25 % relative, via `/trader-rugcheck`),
  `--holder-jump 10` (top-10 holder share up 10 points).

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add TSLA --above 365
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add BTCUSDT --cross 67700
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add TSLA --pct-move 5
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --opening-bell
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --from-plan            # stop + target (+ liquidity exit for meme) of the latest plan
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add SOL:<mint> --liquidity-drop 30
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add SOL:<mint> --dev-selling 25
python3 "${CLAUDE_SKILL_DIR}/alerts.py" list
python3 "${CLAUDE_SKILL_DIR}/alerts.py" check
python3 "${CLAUDE_SKILL_DIR}/alerts.py" rearm al-0002
python3 "${CLAUDE_SKILL_DIR}/alerts.py" remove al-0003
python3 "${CLAUDE_SKILL_DIR}/nyse_calendar.py" --status --next 5
python3 "${CLAUDE_SKILL_DIR}/nyse_calendar.py" --year 2027
```

**On a schedule** — every 5 minutes in this session:

```
/loop 5m python3 "${CLAUDE_SKILL_DIR}/alerts.py" check
```

or create a scheduled task that runs `python3 "${CLAUDE_SKILL_DIR}/alerts.py" check` every
5–15 minutes (stocks: on weekdays 9:30–16:00 ET; crypto/meme: around the clock). Each alert
rings once, so a schedule never spams; re-arm with `rearm ID`.

Offline demo: add `--offline --now 2026-10-20T14:15:00Z` (fixtures, no network).
Common flags: `--asset`, `--json`, `--now`, `--home`, `--note "text"`.

## Reads / writes

- Reads `trader/plan.json` (for `--from-plan`), `trader/rugcheck/*.json` (meme safety
  baselines when `/trader-rugcheck` cannot run), live quotes via the shared data layer.
- Writes `trader/alerts.json` (definitions + state) and appends `trader/alerts_log.jsonl`
  (every ring, with time and value).

## How to present results

When `check` rings, show each `ALERT …` line as is, then the suggested action: a stop alert →
"the plan says exit"; a target alert → follow the plan (scale out / take profit); a meme
liquidity or dev-selling alert → consider the liquidity exit from the plan. If nothing rang,
say so in one line. Mention skipped stock alerts and the next open when the market is
closed. Always add the disclaimer (stronger for meme coins) and that quotes may be delayed.

## Never

- Never place, modify or cancel an order because an alert rang — tell the user; orders go
  through `/trader-risk` → `/trader-broker` with the user's explicit "yes".
- Never touch wallets or keys; meme-coin exits are done by the user in their own wallet.
- Never re-ring a fired alert unless the user re-arms it.
