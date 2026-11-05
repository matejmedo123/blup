#!/usr/bin/env bash
# Put the landing page (site/) on its own address on this server, behind the Caddy that already serves the dashboard.
#
#   sudo bash /opt/trader/deploy/site-on.sh trader.tvojadomena.sk     # or: sudo traderctl site trader.tvojadomena.sk
#   bash deploy/site-on.sh --print trader.tvojadomena.sk              # only show the Caddy block it would add
#
# Before: a DNS A record for that address pointing at this server, and Caddy installed (deploy/Caddyfile.example).
# It adds one site block to /etc/caddy/Caddyfile (checked with caddy validate, the old file put back if it fails),
# starts trader-site (the sign-up list behind the form) and reloads Caddy. Running it again changes nothing.
set -euo pipefail

PREFIX="${TRADER_PREFIX:-/opt/trader}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
UNIT="${TRADER_SITE_UNIT:-/etc/systemd/system/trader-site.service}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EXAMPLE="$HERE/Caddyfile.example"

PRINT=0
if [ "${1:-}" = "--print" ]; then PRINT=1; shift; fi
DOMAIN="$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')"
if ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
  echo "usage: sudo bash $0 trader.tvojadomena.sk   (the address the landing page should have)" >&2
  exit 2
fi

# the block is the commented landing-page block of Caddyfile.example, uncommented, for this address
# (www. only when that name exists too, or Caddy keeps asking for a certificate nobody can get)
hosts="$DOMAIN"
if [ "$PRINT" = 0 ] && getent ahostsv4 "www.$DOMAIN" >/dev/null 2>&1; then hosts="$DOMAIN, www.$DOMAIN"; fi
block="$(awk '/^#tvoja-domena\.sk, www\.tvoja-domena\.sk \{$/{on=1} on{print} on&&/^#\}$/{exit}' "$EXAMPLE" | sed 's/^#//')"
if [ -z "$block" ]; then echo "the landing-page block is missing from $EXAMPLE" >&2; exit 1; fi
block="# trader-site: $DOMAIN
$hosts {
$(printf '%s\n' "$block" | sed '1d')"
if [ "$PRINT" = 1 ]; then printf '%s\n' "$block"; exit 0; fi

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

if grep -qxF "# trader-site: $DOMAIN" "$CADDYFILE"; then
  echo "$DOMAIN is already in $CADDYFILE"
else
  cp -p "$CADDYFILE" "$CADDYFILE.before-site"
  printf '\n%s\n' "$block" >> "$CADDYFILE"
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
