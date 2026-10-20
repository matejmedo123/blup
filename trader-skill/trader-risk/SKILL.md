---
name: trader-risk
description: Risk manager / pre-trade gate for day trades in stocks, crypto and meme coins. Checks a proposed order against trader/limits.json — max $ risk per trade, max daily loss, max open positions, max position % of account, total crypto and meme exposure caps, blocked symbols, no shorts/margin/leverage/options unless allowed, meme liquidity and slippage limits, daily trade limit — and prints PASS or BLOCK with the reasons. A meme coin that has not passed /trader-rugcheck is always BLOCKED. Use when the user says "risk check this", "can I take this trade", "am I over my limits", "is this within my rules", "check my daily loss", or before /trader-broker.
---

# Trader · Risk Manager

Every order must PASS here before /trader-broker will build a ticket. BLOCK is a normal answer, not an error.

Checks (per asset class `stock` / `crypto` / `meme`, plus a `global` layer, all from `trader/limits.json`):

| Check | Rule |
|-------|------|
| blocked_symbols | symbol not on the blocked list |
| stop_defined | a stop exists and sits below the entry (long only) |
| no_shorts / no_leverage / no_options | blocked unless the class allows them (meme: never) |
| max_risk_per_trade | (entry − stop) × qty ≤ `max_risk_per_trade_usd` |
| max_position_pct | position value ≤ % of account |
| max_open_positions | open journal trades + approved-but-unjournaled tickets, per class and global |
| max_daily_loss | today's realized losses (journal) — blocked once hit, or if this trade's risk would cross it |
| max_daily_trades | approvals today, per class and global |
| max_total_exposure | crypto / meme open value + this trade ≤ cap (meme default 5 % of account) |
| rugcheck_passed (meme) | `trader/rugcheck/{chain}-{address}.json` exists, verdict in `required_rugcheck_verdicts`, younger than `rugcheck_max_age_minutes` |
| min_liquidity / max_slippage / max_pct_of_pool (meme) | pool-size guards |

"Today" is the New York date for stocks and the UTC date for crypto and meme coins. A closed US market is shown as a
warning, not a block.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/risk.py"                                   # newest proposed order
python3 "${CLAUDE_SKILL_DIR}/risk.py" --order ord-TSLA-20261020-141500
python3 "${CLAUDE_SKILL_DIR}/risk.py" --symbol TSLA --qty 40 --entry 364.18 --stop 358.32      # what-if, not saved
python3 "${CLAUDE_SKILL_DIR}/risk.py" --symbol SOL:<mint> --notional 100 --entry 0.0047 --stop 0.0043
```

Options: `--order ID`; ad hoc `--symbol --qty | --notional --entry --stop [--target] [--side buy|sell] [--leverage L]`;
common `--asset --offline --fixtures --now --home --json --no-html --open`.

## Reads / writes

- Reads `trader/orders.json`, `trader/limits.json`, `trader/config.json`, `trader/journal.json`,
  `trader/tickets.json`, `trader/approvals.jsonl`, `trader/rugcheck/*.json`.
- Writes the verdict into the order (`risk` + `status: risk_pass | risk_block`, with an `order_hash` so any later
  change to the order voids the PASS) and appends every verdict to `trader/risk_log.jsonl`.

## How to present results

Start with **PASS** or **BLOCK** in bold, then the reasons for a BLOCK in plain words (e.g. "rugcheck DANGER: LP not
locked or burned; top holder owns 40 % of supply"). Show the check list compactly. After a PASS the next step is
/trader-broker; after a BLOCK suggest the fix (smaller size, wait for tomorrow, run /trader-rugcheck) or skipping the
trade. Always end with the disclaimer the tool prints (stronger one for meme coins).

## Never

- Never override, soften or "work around" a BLOCK, and never edit `limits.json` to turn a BLOCK into a PASS unless the
  user explicitly asks to change a named limit — and then say what risk they are taking on.
- Never treat a meme coin without a fresh passing rugcheck as anything but BLOCKED.
- Never place or send an order from here.
