# Running Trader 24/7 on a server

The autopilot only trades while it runs. On a laptop that means "while the lid is open"; on a small
Linux server (VPS) it means around the clock. This folder has everything for that:

| File | What it is |
|------|------------|
| `install-vps.sh` | installs / updates Trader as two systemd services on Ubuntu or Debian |
| `trader-autopilot.service` | the 24/7 bot: `autopilot.py daemon --approve` |
| `trader-dashboard.service` | the web dashboard on `127.0.0.1:8765` (shows and controls the bot) |
| `traderctl` | `sudo traderctl status / pause / resume / kill --confirm KILL / logs / health / lab / restart` |
| `healthcheck.py` | exit 0 when the bot's heartbeat is fresh — for Docker, monitoring or cron |
| `test-bot.sh`, `trader-test-*.service` | optional: a comparison bot on the simulator next to the real one |
| `compare.py` | the real bot and the comparison bot side by side (`sudo traderctl compare`) |
| `trader.env.example` | the keys and passwords file (copy it, never commit the copy) |
| `Dockerfile`, `docker-compose.yml` | the same two services as containers |
| `Caddyfile.example` | HTTPS in front of the dashboard if you own a domain |
| [`NAVOD.sk.md`](NAVOD.sk.md) | the same guide, step by step, in Slovak |

**What "24/7" means here.** Crypto is traded around the clock, every day. US stocks are traded only in
the regular session — 9:30–16:00 New York time (15:30–22:00 in Central Europe for most of the year), new
entries until 15:30 ET, flat by 15:55 ET. Pre-market, after-hours and overnight are skipped on purpose:
every stock setup and backtest in this pack is built on regular-session bars. Outside the session the bot
keeps trading crypto, reading news and filings, and picking the stocks it will watch at the next open.

**It starts on the simulator** — a local paper book, no account, no real money. Real money needs every
live opt-in step in the main README (`autopilot.broker "alpaca"`, `autopilot.mode "live"`,
top-level `paper: false`, live keys and `autopilot.live_confirmation` set to the exact phrase); a key
alone never switches it to live. Trading — automated or not — can lose money.

## What you need

* A VPS with Ubuntu 22.04/24.04 or Debian 12, 1 vCPU, 1–2 GB RAM, ~5 GB disk — about €4–6 a month
  (Hetzner Cloud, a Websupport VPS, …; check the provider's current prices). **Shared web hosting is not
  enough**: it cannot keep a program running.
* Python 3.8 or newer (Ubuntu and Debian ship it). Nothing else — the pack is stdlib-only.
* Optional: a domain (for HTTPS), the ntfy app or a Telegram bot (phone alerts), an Alpaca paper
  account, an X API token, an Anthropic API key (optional AI desk).

## Install with systemd (recommended)

```bash
# on your computer: copy the trader-skill folder to the server
scp -r trader-skill you@SERVER:~/

# on the server
ssh you@SERVER
sudo bash ~/trader-skill/deploy/install-vps.sh
```

The script creates a `trader` system user, copies the code to `/opt/trader` (read-only for the bot),
keeps all state in `/var/lib/trader`, creates `/etc/trader/trader.env` (chmod 600) from the example,
installs both services, enables them at boot and starts them. Run it again any time to update: code is
replaced, state and keys are kept, services are restarted.

Then:

```bash
sudo nano /etc/trader/trader.env            # password, SEC_USER_AGENT, optional keys
sudo -u trader nano /var/lib/trader/config.json   # assets, universe, notifications, AI desk
sudo -u trader nano /var/lib/trader/limits.json   # risk limits
sudo traderctl restart                      # pick up the changes
sudo traderctl health                       # OK = the heartbeat is fresh
sudo traderctl status                       # what it is doing, today's trades, positions
sudo traderctl logs                         # follow the log (Ctrl+C to leave)
```

**A stop or restart can take up to two minutes**: on SIGTERM (or SIGHUP — a closed terminal) the daemon
judges no further ideas, finishes the order it is sending and the exits of the cycle it is in, and then
exits; one waiting for another cycle's lock gives up at once. systemd waits 120 s (`TimeoutStopSec=120`),
Docker 2 minutes (`stop_grace_period: 2m`). Killed in the middle anyway, nothing is doubled: an entry is
booked as `submitting` before it is sent and found again at the broker by its client order id.

**A stuck cycle restarts itself**: a cycle running for 20 minutes (a socket that never answers) makes the
daemon say so, notify you and exit with code 70 — systemd / Docker start it again. `healthcheck.py` fails
when the heartbeat is stale, a cycle has run for 15 minutes, or every cycle has failed for an hour (the
heartbeat's `last_ok_at`).

## Or with Docker

```bash
cd trader-skill/deploy
cp trader.env.example trader.env    # the compose file reads it; it is git-ignored
nano trader.env                     # TRADER_DASHBOARD_PASSWORD is required for Docker
docker compose up -d --build        # WITH_AI=1 docker compose up -d --build  → + the AI desk SDK
docker compose logs -f autopilot
docker compose exec autopilot python3 trader-autopilot/autopilot.py status
docker compose exec autopilot python3 deploy/healthcheck.py
```

Two containers share one volume (`trader-data`, mounted at `/data`): `autopilot` runs the daemon,
`dashboard` serves the web app on `127.0.0.1:8765` of the host with `--no-autopilot --news-every 0`
(the daemon trades and refreshes the news feed — the dashboard never does it a second time). The
autopilot container is marked unhealthy when its heartbeat goes stale.

## Opening the dashboard

The dashboard never listens on a public address. Two ways in:

1. **SSH tunnel** (nothing to configure):
   `ssh -L 8765:127.0.0.1:8765 you@SERVER`, then open <http://127.0.0.1:8765> on your computer.
2. **HTTPS with your own domain**: install Caddy and use `Caddyfile.example`. Set
   `TRADER_DASHBOARD_PASSWORD` first — the dashboard refuses every request that arrives through a reverse
   proxy without a password, and marks its session cookie `Secure` behind HTTPS.

The **Bot** tab shows whether the bot is alive (heartbeat), the trading hours in your time zone, every
decision with its reasons, and the Pause / Run once / KILL buttons. The **Brain** tab shows the symbols it
picked and why, what it learned from its own trades, the optional AI desk and the notifications.

## A comparison bot next to it

To try another setup on the same market without touching the real bot — e.g. more risk:

```bash
sudo bash /opt/trader/deploy/test-bot.sh                  # 3 % risk, BTC/ETH 4 %, 2× (the default)
sudo bash /opt/trader/deploy/test-bot.sh --risk 2 --core-risk 3 --leverage 1   # any other profile
sudo traderctl compare                                   # both side by side, from the same start
sudo traderctl test status                               # any traderctl command for the comparison bot
sudo bash /opt/trader/deploy/test-bot.sh --remove         # stop it (its record stays in /var/lib/trader-test)
```

It always trades the **simulator**, in its own folder `/var/lib/trader-test`, with the real bot's capital and
playbook as a start. Its services never read `/etc/trader/trader.env` and cannot see `/var/lib/trader`, so it
has no broker keys at all; the script copies only the dashboard password (into `/etc/trader/trader-test.env`)
and refuses to start if its config names a real broker. No phone notifications, no AI desk, no X news — the
same rules otherwise. Its dashboard listens on `127.0.0.1:8766`: an SSH tunnel with 8766, `tailscale serve
--bg --https=8443 8766`, or the second block in `Caddyfile.example`. The browser tab and the page header show
each bot's risk and leverage, so the two dashboards are not mixed up. Judge them on the same period and after
20+ closed trades each — before that the difference is mostly chance.

## Phone notifications

* **ntfy** (free, no account): install the ntfy app, subscribe to a long random topic name, then in
  `config.json` set `"notify": {"enabled": true, "ntfy_topic": "<that topic>"}`. Anyone who knows the
  topic can read the alerts — make it long and random.
* **Telegram**: create a bot with @BotFather, put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` into the env
  file and set `"telegram": true` in the `notify` section.

`sudo traderctl notify-test` sends a test message. Alerts: started/stopped, trade opened/closed, kill
switch, pauses, what it learned, repeated errors, and a daily summary after the US close.

## Stopping it

| You want to … | Do this |
|---------------|---------|
| stop new trades, keep managing open ones | Pause on the dashboard, or `sudo traderctl pause` |
| close everything **now** | KILL on the dashboard, or `sudo traderctl kill --confirm KILL` |
| stop the program | `sudo traderctl stop` (positions stay open — KILL first if you want them closed) |
| start again | Resume on the dashboard / `sudo traderctl resume`; `sudo traderctl start` |

The bot also stops itself: the daily loss limit trips the kill switch, and equity 10 % below its peak
(`autopilot.adapt.max_drawdown_pct`) pauses it until you resume.

## Updating

Copy the new `trader-skill` folder to the server and run `sudo bash ~/trader-skill/deploy/install-vps.sh`
again (Docker: `docker compose up -d --build`). Your state, journal, config and keys are kept.

## Security checklist

* `trader.env` / `/etc/trader/trader.env` hold your keys: chmod 600, never in git, never pasted anywhere.
* Firewall: `sudo ufw allow OpenSSH && sudo ufw enable` (plus `80,443/tcp` only if you use Caddy). Port
  8765 is never opened.
* The services run as the unprivileged `trader` user and can write only `/var/lib/trader`.
* No dashboard response ever contains a secret; configured keys are only shown as "set / not set".
