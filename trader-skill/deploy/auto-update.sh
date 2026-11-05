#!/usr/bin/env bash
# Keep the bot on the latest version of its git branch without a terminal: every 15 minutes a systemd timer
# fetches the branch; a new commit is installed only after the whole test suite passed on it.
#
#   sudo bash deploy/auto-update.sh --install   set it up once (remembers this checkout and its branch)
#   sudo traderctl update                       check now          ·  sudo traderctl update-log   what it did
#   sudo systemctl disable --now trader-update.timer                 switch it off again
#
# Whoever can push to that branch can change the code that runs here: use it only on your own repository.
set -euo pipefail

CONF=/etc/trader/update.conf
STATE=/var/lib/trader-update
LOG=/var/log/trader-update.log
UNIT_DIR=/etc/systemd/system

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root: sudo bash $0 ${*:-}" >&2
  exit 1
fi

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }

if [ "${1:-}" = "--install" ]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  if ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$REPO is not a git checkout — clone the repository and run this from it" >&2
    exit 1
  fi
  BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  install -d -o root -g root -m 700 /etc/trader "$STATE"
  printf 'REPO=%s\nBRANCH=%s\n' "$REPO" "$BRANCH" > "$CONF"
  chmod 600 "$CONF"
  cat > "$UNIT_DIR/trader-update.service" <<UNIT
[Unit]
Description=Trader: install a new version of the branch once its tests pass
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $REPO/trader-skill/deploy/auto-update.sh
TimeoutStartSec=45min
Nice=10
UNIT
  cat > "$UNIT_DIR/trader-update.timer" <<UNIT
[Unit]
Description=Trader: look for a new version every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now trader-update.timer >/dev/null
  say "installed: $REPO, branch $BRANCH, checked every 15 minutes"
  echo "Checking for a new version now (the tests take a few minutes)…"
  exec /bin/bash "$REPO/trader-skill/deploy/auto-update.sh"
fi

[ -r "$CONF" ] || { echo "not set up — run: sudo bash deploy/auto-update.sh --install" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
install -d -o root -g root -m 700 "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { say "another update is still running"; exit 0; }

export GIT_TERMINAL_PROMPT=0  # a timer has nobody to type a password: fail instead of waiting forever
if ! timeout 120 git -C "$REPO" fetch -q origin "$BRANCH"; then
  say "could not fetch $BRANCH — trying again in 15 minutes"
  exit 0
fi
HEAD="$(git -C "$REPO" rev-parse HEAD)"
NEW="$(git -C "$REPO" rev-parse "origin/$BRANCH")"
# compared with what was installed, not with the checkout: a git pull by hand is installed too
if [ "$(cat "$STATE/installed" 2>/dev/null || true)" = "$NEW" ]; then
  exit 0
fi
if [ "$HEAD" != "$NEW" ]; then
  if ! git -C "$REPO" merge-base --is-ancestor "$HEAD" "$NEW"; then
    say "the branch no longer continues from ${HEAD:0:7} (rewritten history) — not updated; run git pull by hand"
    exit 0
  fi
  if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
    say "$REPO has local changes — not updated, so nothing of yours is overwritten"
    exit 0
  fi
fi
if [ "$(cat "$STATE/failed" 2>/dev/null || true)" = "$NEW" ]; then
  exit 0  # its tests failed already: wait for the next commit
fi

say "new version ${NEW:0:7}: $(git -C "$REPO" log -1 --format=%s "$NEW")"
TMP="$(mktemp -d /var/tmp/trader-update.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive "$NEW" trader-skill | tar -x -C "$TMP"
mkdir -p "$TMP/home"
chown -R trader:trader "$TMP"
# the tests run as the bot's own user on a copy: they never see /var/lib/trader or the keys
if ! (cd "$TMP/trader-skill" && timeout 40m runuser -u trader -- env -i PATH=/usr/bin:/bin HOME="$TMP/home" \
      TMPDIR="$TMP" LANG=C.UTF-8 python3 -m unittest discover -s tests -t . > "$STATE/last-tests.txt" 2>&1); then
  echo "$NEW" > "$STATE/failed"
  say "tests FAILED on ${NEW:0:7} — still running ${HEAD:0:7}; details: $STATE/last-tests.txt"
  tail -n 30 "$STATE/last-tests.txt" >> "$LOG"
  exit 1
fi
say "tests passed ($(grep -E '^Ran [0-9]+ tests' "$STATE/last-tests.txt" | tail -1)) — installing"
[ "$HEAD" = "$NEW" ] || git -C "$REPO" merge -q --ff-only "$NEW"
rm -f "$STATE/failed"
if bash "$REPO/trader-skill/deploy/install-vps.sh" >> "$LOG" 2>&1; then
  echo "$NEW" > "$STATE/installed"
  say "installed ${NEW:0:7}, services restarted"
else
  say "install-vps.sh failed after the update to ${NEW:0:7} — see $LOG"
  exit 1
fi
