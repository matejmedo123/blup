#!/usr/bin/env bash
# Put the landing page (site/) on its own address on this server, behind the Caddy that already serves the dashboard.
#
#   sudo bash /opt/trader/deploy/site-on.sh trader.tvojadomena.sk     # or: sudo traderctl site trader.tvojadomena.sk
#   bash deploy/site-on.sh --print trader.tvojadomena.sk              # only show the Caddy block it would add
#   bash deploy/site-on.sh --print-combined bot.tvojadomena.sk        # the block for page + dashboard on one address
#
# Before: a DNS A record for that address pointing at this server, and Caddy installed (deploy/Caddyfile.example).
# A new address gets its own site block. The dashboard's own address (its block is already in the Caddyfile) gets
# both on one address instead: visitors see the landing page, whoever is signed in the dashboard. Either way the
# Caddyfile is checked with caddy validate and the old one put back if it fails; then trader-site (the sign-up list
# behind the form) starts and Caddy reloads. Running it again changes nothing.
set -euo pipefail

PREFIX="${TRADER_PREFIX:-/opt/trader}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
UNIT="${TRADER_SITE_UNIT:-/etc/systemd/system/trader-site.service}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EXAMPLE="$HERE/Caddyfile.example"

PRINT=0
COMBINED=0
if [ "${1:-}" = "--print" ]; then PRINT=1; shift; fi
if [ "${1:-}" = "--print-combined" ]; then PRINT=1; COMBINED=1; shift; fi
DOMAIN="$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')"
if ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
  echo "usage: sudo bash $0 trader.tvojadomena.sk   (the address the landing page should have)" >&2
  exit 2
fi

# the blocks are the commented ones of Caddyfile.example, uncommented, for this address
# (www. only when that name exists too, or Caddy keeps asking for a certificate nobody can get)
example_block() {  # $1: the first line of the commented block
  awk -v first="$1" '$0 == first {on=1} on {print} on && /^#\}$/ {exit}' "$EXAMPLE" | sed 's/^#//'
}
make_block() {  # $1: combined (0/1)
  local body hosts="$DOMAIN"
  if [ "$1" = 1 ]; then
    body="$(example_block '#bot.tvoja-domena.sk {')"
    printf '# trader-site: %s (landing page + dashboard)\n%s {\n%s\n' "$DOMAIN" "$DOMAIN" "$(printf '%s\n' "$body" | sed '1d')"
  else
    body="$(example_block '#tvoja-domena.sk, www.tvoja-domena.sk {')"
    if [ "$PRINT" = 0 ] && getent ahostsv4 "www.$DOMAIN" >/dev/null 2>&1; then hosts="$DOMAIN, www.$DOMAIN"; fi
    printf '# trader-site: %s\n%s {\n%s\n' "$DOMAIN" "$hosts" "$(printf '%s\n' "$body" | sed '1d')"
  fi
}
if [ "$PRINT" = 1 ]; then make_block "$COMBINED"; exit 0; fi

if [ "$(id -u)" -ne 0 ]; then echo "run it as root: sudo bash $0 $DOMAIN" >&2; exit 1; fi
command -v caddy >/dev/null 2>&1 || { echo "Caddy is not installed — set it up first (deploy/Caddyfile.example, step 2)" >&2; exit 1; }
[ -f "$CADDYFILE" ] || { echo "$CADDYFILE is missing — set up Caddy first (deploy/Caddyfile.example)" >&2; exit 1; }
[ -f "$PREFIX/site/index.html" ] || { echo "$PREFIX/site/index.html is missing — run deploy/install-vps.sh first" >&2; exit 1; }
[ -f "$UNIT" ] || { echo "trader-site.service is missing — run deploy/install-vps.sh first" >&2; exit 1; }

# DNS: a warning, not a stop — the record can still be on its way
ips="$( (getent ahostsv4 "$DOMAIN" 2>/dev/null || true) | awk '{print $1}' | sort -u | tr '\n' ' ')"  # getent exits 2 when it has no answer
mine=" $(hostname -I 2>/dev/null || true) "
if [ -z "$ips" ]; then
  echo "note: $DOMAIN does not resolve yet — add an A record for it pointing at this server; HTTPS starts once it does"
else
  for ip in $ips; do
    case "$mine" in *" $ip "*) ;; *) echo "note: $DOMAIN points at $ip, which is not this server ($mine) — check the A record";; esac
  done
fi

# the dashboard's own address: its block (the line "DOMAIN {" up to the next "}" at the start of a line) is replaced
own="$(awk -v first="$DOMAIN {" '$0 == first {on=1} on {print} on && /^\}$/ {exit}' "$CADDYFILE")"
if grep -q "^# trader-site: $DOMAIN\( \|$\)" "$CADDYFILE"; then
  echo "$DOMAIN is already in $CADDYFILE"
else
  if [ -n "$own" ] && ! printf '%s\n' "$own" | grep -q "reverse_proxy 127.0.0.1:8765"; then
    echo "$CADDYFILE already has a block for $DOMAIN that is not the dashboard — choose another address or edit it by hand" >&2
    exit 1
  fi
  cp -p "$CADDYFILE" "$CADDYFILE.before-site"
  if [ -n "$own" ]; then
    echo "$DOMAIN is the dashboard's address: the landing page goes in front of it, the dashboard stays behind Prihlásiť sa"
    awk -v first="$DOMAIN {" '$0 == first {skip=1} !skip {print} skip && /^\}$/ {skip=0}' "$CADDYFILE.before-site" > "$CADDYFILE"
    printf '\n%s\n' "$(make_block 1)" >> "$CADDYFILE"
  else
    printf '\n%s\n' "$(make_block 0)" >> "$CADDYFILE"
  fi
  if ! out="$(caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"; then
    cp -p "$CADDYFILE.before-site" "$CADDYFILE"
    echo "the new Caddyfile did not pass caddy validate — the old one is back in place:" >&2
    printf '%s\n' "$out" | tail -n 5 >&2
    exit 1
  fi
  echo "added $DOMAIN to $CADDYFILE (the previous file: $CADDYFILE.before-site)"
fi

systemctl enable --now trader-site >/dev/null
systemctl reload caddy
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80,443/tcp >/dev/null; fi
echo "Landing page: https://$DOMAIN   (the first HTTPS certificate can take a minute)"
echo "Sign-ups: sudo python3 $PREFIX/site/server.py --data /var/lib/trader-site export"
