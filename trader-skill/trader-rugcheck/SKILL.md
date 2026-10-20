---
name: trader-rugcheck
description: Safety gate for meme coins (DEX tokens on Solana, Base, Ethereum, BSC). Scores a token 0–100 for rug-pull and honeypot risk — liquidity, LP lock/burn, mint and freeze authority, buy/sell tax, holder concentration, dev wallet share, pair age, fake-volume signs — and returns SAFE / RISKY / DANGER with the exact reasons. Use before anything else happens with a meme coin, e.g. "is this token a rug?", "rugcheck SOL:<mint>", "check this contract 0x… on base", "is PUPKIN safe?", "honeypot check".
---

# Trader · Rug Check 🛡️

Every meme coin goes through this gate before entry, sizing, risk or a wallet
checklist. It pulls free public data — DexScreener (pair, liquidity, age,
buys/sells), RugCheck (Solana: authorities, LP lock, holders, known risks) and
honeypot.is (EVM: buy/sell simulation, taxes, holders) — and scores it.

* Score starts at 100; each failed check subtracts a penalty.
* **DANGER** — any critical failure (LP unlocked, mint/freeze authority live,
  honeypot, ≥30 % sell tax, one wallet ≥30 %, already rugged) or score < 50.
* **RISKY** — score 50–74, or the safety source was unavailable.
* **SAFE** — score ≥ 75 and no critical failure. It means *"no red flags found
  in these checks"*, never "safe to buy".

The scanner runs this automatically on every meme hit; the risk manager
BLOCKS any meme order without a fresh SAFE result.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/rugcheck.py" SOL:<mint>
python3 "${CLAUDE_SKILL_DIR}/rugcheck.py" base:0x…            # EVM token on Base
python3 "${CLAUDE_SKILL_DIR}/rugcheck.py" BONK --asset meme   # name search — verify the address it picks
python3 "${CLAUDE_SKILL_DIR}/rugcheck.py" SOL:<mint> --json   # machine-readable
```

Offline demo (fixtures, no network):

```bash
python3 "${CLAUDE_SKILL_DIR}/rugcheck.py" SOL:<PUPKIN mint from tests/fixtures/manifest.json> --offline --now 2026-10-20T15:55:00Z
```

| Option | Meaning |
|---|---|
| `SYMBOL` | `SOL:<mint>`, `base:0x…`, `ethereum:0x…`, `bsc:0x…`, a bare address, or a name with `--asset meme` |
| `--json` | print the full result as JSON |
| `--no-html` / `--open` | skip / open the HTML report |
| `--offline`, `--now`, `--home` | fixtures, pinned clock, state folder |

## Reads / writes

* writes `trader/rugcheck/{chain}-{address}.json` (score, verdict, checks, reasons, metrics)
* writes `trader/reports/rugcheck-{chain}-{addr8}.html`
* other skills import `check(symbol, pair=None, write=True)`, `load_result(chain, address)`, `result_path(...)`

## How to present results

Lead with the verdict and score, then the reasons (most severe first), e.g.
"**DANGER 0/100** — LP not locked or burned (0 % locked); top holder owns
40 % of supply." For SAFE say "no red flags found in these checks" and remind
that this is not a guarantee. Give the report path and the "verify it
yourself" links (DexScreener, explorer, RugCheck / honeypot.is). Always end
with the meme-coin disclaimer.

## Never

* Never say a token is "safe", "safe to buy" or "legit" — only "no red flags found in these checks".
* Never ask for, read or store private keys, seed phrases or wallet files; never sign or swap.
* Never override a DANGER verdict, or call a token cleared when a safety source was unavailable.
* Never treat DexScreener boosts or volume as proof of quality — volume can be faked.
