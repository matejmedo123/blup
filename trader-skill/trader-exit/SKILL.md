---
name: trader-exit
description: Exit Planner for day trades in US stocks, crypto and DEX meme coins. Turns a triggered entry into a full plan — stop (range low, below the breakout level, or ATR-based), R-multiple target, time stop (stocks flat by 3:55 p.m. ET, crypto/meme after a 1h/4h/24h horizon), optional trailing stop, and for meme coins scale-out levels plus a liquidity exit. Use when the user says "where's my stop?", "plan the exit", "what's my target?", "set stop and target for this entry", "how do I get out of this meme coin?".
---

# Trader · Exit Planner

Builds the exit plan for an entry from `/trader-entry` (or one you type in):

- **Stop** — `auto` (default): the structural low (opening-range / Asia-range / flag low) when it is
  within 4×ATR; otherwise just below the breakout level (1×ATR); otherwise entry − 1.5×ATR.
  Also `range`, `level`, `atr` or a fixed price.
- **Target** — entry + R × (entry − stop); default 2R (meme coins 3R).
- **Time stop** — stocks: flat by 3:55 p.m. ET (12:55 p.m. on 1:00 p.m. early-close days);
  crypto/meme: entry + horizon (config `crypto_horizon` / `meme_horizon`, default 4h).
- **Trailing** (optional) — `breakeven:1` (stop to entry after +1R), `atr:2`, `pct:5`.
- **Meme coins** — scale-outs (default sell 50 % at 2× — recovers the initial stake) and a
  liquidity exit (get out if pool liquidity drops 30 % from its level at entry). DEX swaps have no
  stop orders, so the plan says to set alerts and exit manually.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/exit.py"                                  # latest triggered entry
python3 "${CLAUDE_SKILL_DIR}/exit.py" --id TSLA-20261020-orb15 --target-r 2 --trail breakeven:1
python3 "${CLAUDE_SKILL_DIR}/exit.py" --id <meme-entry-id> --scale 0.5@2,0.25@4 --liq-drop 30 --horizon 4h
# ad hoc, without an entries.json record
python3 "${CLAUDE_SKILL_DIR}/exit.py" BTC-USD --entry 67448.60 --entry-time 2026-10-20T14:40:00Z \
    --stop-ref 66612.40 --trigger-level 67420 --setup asia_range
# offline demo
python3 "${CLAUDE_SKILL_DIR}/exit.py" --offline --id TSLA-20261020-orb15 --now 2026-10-20T14:15:00Z
```

Options: `--stop auto|range|level|atr|PRICE`, `--atr-mult`, `--target-r`, `--horizon 1h|4h|24h`,
`--trail none|breakeven:R|atr:K|pct:P`, `--scale F@M,...`, `--liq-drop PCT`, plus the common
`--asset --offline --now --home --json --no-html --open`.

## Reads / writes (in `trader/`)

- reads `entries.json` (latest triggered entry or `--id`), `config.json`
- writes `plan.json` (`plans[<id>]` + `latest`) — the Time Machine, sizer, alerts and journal read it
- writes `reports/plan-<id>.html` (candles with entry / stop / target lines)

## How to present results

Lead with the one-liner exactly as printed — "Get in $364.18 · Stop $358.32 · Target $375.90 (2R) ·
Time stop 3:55 p.m. ET" — then the one-line reason for the stop and, for meme coins, the scale-out
and liquidity-exit lines. Suggest `/trader-timemachine` next to replay the trade 10,000 times.
Always include the disclaimer line.

## Never

- Never place or modify orders; this only writes a plan.
- Never move a stop further away to "give it room" without the user asking — risk is set here.
- Never touch wallets/keys or call a broker/exchange trading API.
