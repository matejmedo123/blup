---
name: trader-sizer
description: Position sizer for day trades in US stocks, crypto and DEX meme coins. Turns the exit plan (entry, stop) into an order proposal sized by risk — (account × risk %) ÷ (entry − stop) — capped by max position %, rounded to whole/fractional shares or the exchange lot size, and for meme coins capped by pool liquidity and slippage. Use when the user asks "how many shares should I buy", "size this trade", "position size for BTC", "how much should I put into this meme coin", "what's my risk on this", or right after /trader-exit and /trader-timemachine.
---

# Trader · Position Sizer

Sizes the latest exit plan (or `--id`) and writes an order **proposal** — never an order.

- **Formula:** risk budget = min(account × risk %, `max_risk_per_trade_usd`); quantity = budget ÷ (entry − stop).
- **Caps** (from `trader/limits.json`, per asset class): `max_position_pct` of the account; for meme coins also
  `max_pct_of_pool` of pool liquidity and `max_slippage_pct` (constant-product price-impact estimate).
- **Rounding:** stocks → whole shares (fractional to 4 dp if `fractional_shares: true` in config);
  crypto → floored to the exchange lot step (Binance exchangeInfo → Coinbase → built-in default), minimum size and
  notional enforced; meme coins → a USD amount.
- **Limit price:** stocks entry + max($0.01, 0.5 bp) → `$364.18 → $364.20`; crypto entry × 1.0002 rounded up to tick;
  meme coins have no limit price, only a max slippage.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/size.py"                           # latest plan in trader/plan.json
python3 "${CLAUDE_SKILL_DIR}/size.py" --id TSLA-20261020-orb15
python3 "${CLAUDE_SKILL_DIR}/size.py" --risk-pct 0.25 --account 10000
python3 "${CLAUDE_SKILL_DIR}/size.py" --size-usd 200             # meme: smaller amount if below every cap
python3 "${CLAUDE_SKILL_DIR}/size.py" --offline --now 2026-10-20T14:15:00Z   # demo on fixtures
```

Options: `--id PLAN_ID`, `--account USD`, `--risk-pct P`, `--size-usd X`, plus the common
`--asset --offline --fixtures --now --home --json --no-html --open`.

## Reads / writes

- Reads `trader/plan.json` (from /trader-exit), `trader/config.json`, `trader/limits.json`,
  `trader/rugcheck/{chain}-{address}.json` (meme, attached to the order if present).
- Writes `trader/orders.json` — one order with `status: "proposed"` (replaces an older *proposed* order for the same plan).

## How to present results

Lead with the one-line order: e.g. `BUY 17 TSLA ≈ $6,191 · risk $99.62 (0.40% of account) · limit $364.20 · capped by
max position 25%`. Then say which cap bound the size and why it matters, and that the next step is /trader-risk.
For meme coins state the USD amount, estimated slippage and share of the pool, and repeat the meme disclaimer.
Always end with the disclaimer line the tool prints.

## Never

- Never present the proposal as an order or imply anything was bought — nothing is sent anywhere.
- Never raise the caps yourself or edit `limits.json` to make a trade fit; tell the user which limit binds.
- Never size a short or leveraged position — this pack sizes long, unleveraged trades only.
