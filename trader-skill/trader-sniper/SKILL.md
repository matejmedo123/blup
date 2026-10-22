---
name: trader-sniper
description: Meme-coin sniper for DEX tokens — pump.fun, PumpSwap, Raydium, Meteora on Solana, PancakeSwap / four.meme on BSC, Base. Finds new tokens where the meme season is now, checks each like a careful trader (liquidity at our trade size, top holders, rug pull and honeypot, fake hype and bots), fires on early momentum, a breakout after consolidation or the first strength after a pullback, and manages every position (stop, partial take-profit, trailing stop, time stop, instant exit when liquidity drains). Paper by default; live only on Solana from a separate bot wallet with a hard cap. Use when the user asks for a "sniper bot", "pump.fun bot", "trade new meme coins automatically", "which chain is hot for memes", "how did the sniper do".
---

# Trader · Meme-coin sniper 🎯

**Most new meme coins go to zero.** The sniper trades them small ($10 a trade, at most $100 in meme positions
by default), only after the checks below, and follows every candidate — bought or not — for a day, so you can
see whether the checks and strategies are worth anything before you risk more.

## What it does each cycle (every `interval_sec`, 45 s by default)

1. **Season** — which chain and launchpad has the busy new pools now (GeckoTerminal trending pools younger
   than a day, by chain and DEX). The scan starts where the season is (`sniper.py season`).
2. **Discovery** — the newest and busiest pools there (GeckoTerminal), pump.fun coins close to graduating, and
   fresh DexScreener profiles and boosts.
3. **Cheap checks** — not a major or stablecoin; old enough to judge (`min_age_min`) and not past the launch
   window (`max_age_hours`); liquidity ≥ `min_liquidity_usd`; hour volume not a multiple of the liquidity
   (wash trading, `max_vol_liq_ratio`); trades per wallet (bots, `max_tx_per_wallet`); pump.fun bans and
   transfer fees.
4. **Safety** (`/trader-rugcheck`, cached 15 min) — mint and freeze authority revoked, LP locked or burned, top
   holders without pools / lockers / exchanges, creator's share, taxes and a sell simulation (honeypot.is on
   EVM), RugCheck's own risks. No answer from the source is no green light. A pump.fun bonding curve has no LP
   to pull: there the LP and pool-liquidity checks give way to our round trip.
5. **Our size, both ways** — on Solana two Jupiter quotes: what $10 buys, and what selling that gets back.
   No route back = honeypot or no liquidity. Elsewhere the pool's depth and fee. Over
   `max_roundtrip_loss_pct` → skip.
6. **Strategy** — `momentum` (5-min volume ≥ 2× the hour's pace, price up, buyers ahead of sellers, not
   already up 300 % — the FOMO hasn't arrived), `breakout` (a quiet 2-hour range ≤ 20 % broken on ≥ 2×
   volume), `pullback` (after doubling, a 30–50 % pullback that closes back over the 20-bar average),
   `graduation` (pump.fun curve ≥ 90 % full — off by default, the riskiest). X posts naming the token in
   the last hour are recorded when an X token is set.
7. **Budget** — `trade_usd`, `max_open_usd`, `max_positions`, `max_trades_per_day`, `daily_loss_usd`, not the
   same token twice in 24 h.
8. **Exits, every cycle** — stop (`stop_pct`, tighter for breakout / pullback), take `take_profit_part` at
   `take_profit_pct`, trail the rest `trail_pct` under the high, time stop, and sell at once when liquidity
   falls `liquidity_drop_pct` below what it was at entry, when no route back exists, or when the token turns
   dangerous (rugged, authority back).

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/sniper.py" season          # where meme coins trade now
python3 "${CLAUDE_SKILL_DIR}/sniper.py" scan            # one cycle, nothing bought
python3 "${CLAUDE_SKILL_DIR}/sniper.py" run --loop      # needs "sniper": {"enabled": true}; paper unless live
python3 "${CLAUDE_SKILL_DIR}/sniper.py" status
python3 "${CLAUDE_SKILL_DIR}/sniper.py" report          # every candidate 15 min / 1 h / 4 h / 24 h later
python3 "${CLAUDE_SKILL_DIR}/sniper.py" sell <address>  # or: kill — sell everything and switch off
```

## Live (Solana only)

1. `sniper.py wallet new` — a new keypair for the bot alone; the key goes to `trader/secrets.env` (0600) and is
   never printed. Send it a small amount of SOL only.
2. `config.json` → `"sniper": {"enabled": true, "mode": "live", "live_confirmation": "I ACCEPT MEME COIN RISK"}`.
3. `sniper.py check-live`. Before every buy the wallet's balance is checked against `wallet_cap_usd` — a
   wallet holding more is refused.

Swaps go through Jupiter (it routes pump.fun curves, PumpSwap, Raydium, Meteora); the transaction is signed on
this machine and sent to `SOLANA_RPC_URL` (default: the public mainnet RPC). Other chains stay paper with
alerts.

## Never

* Never uses or asks for your own wallet's key or seed phrase — only the bot wallet it created itself.
* Never buys without a safety answer, never above the budget, never more than `wallet_cap_usd` in its wallet.
* Never "snipes" the launch block: public APIs are seconds to minutes behind, the first block belongs to MEV
  bots. It aims at the first minutes to hours, after the checks.
