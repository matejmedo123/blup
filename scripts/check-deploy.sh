#!/usr/bin/env bash
# ============================================================================
# Is the site actually running the build in mobile/dist?
#
#   ./scripts/check-deploy.sh https://blup.sk
#
# "I uploaded everything and it looks the same" has two causes and they need
# different fixes: the files did not arrive, or they arrived and the browser is
# still using yesterday's page. The page names the bundle it wants, so
# comparing that name with the local build settles it — and the cache headers
# say whether it will keep happening.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="${1:-https://blup.sk}"
SITE="${SITE%/}"
DIST="$ROOT/mobile/dist"

if [ ! -d "$DIST" ]; then
  echo "✖ mobile/dist neexistuje — najprv build: cd mobile && npm run build:web"
  exit 1
fi

local_bundle="$(ls "$DIST/_expo/static/js/web/" 2>/dev/null | grep -E '^entry-' | head -1)"
if [ -z "$local_bundle" ]; then
  echo "✖ V mobile/dist som nenašiel žiadny bundle."
  exit 1
fi

html="$(curl -fsS -H 'Cache-Control: no-cache' "$SITE/" 2>/dev/null)" || {
  echo "✖ $SITE/ neodpovedá."
  exit 1
}

live_bundle="$(printf '%s' "$html" | grep -o '_expo/static/js/web/entry-[^"]*\.js' | head -1)"
live_bundle="${live_bundle##*/}"

echo "lokálne: $local_bundle"
echo "na webe: ${live_bundle:-(žiadny nenájdený)}"
echo

if [ "$local_bundle" = "$live_bundle" ]; then
  echo "✓ Server beží na tomto builde."
else
  echo "✗ Server beží na inom builde."
  echo "  Buď sa index.html nenahral, alebo ho medzi tebou a serverom drží cache."
fi

echo
echo "Hlavičky (index.html sa musí overovať, bundle sa môže držať):"
for path in "/" "/_expo/static/js/web/$local_bundle" "/sw.js"; do
  # A GET, not a HEAD: some shared hosts answer HEAD 200 for a path that GET
  # 404s, which is exactly the case this script exists to catch. curl's own
  # %{http_code} is the authoritative status — parsing the header dump picks up
  # a proxy's "200 Connection established" line instead.
  status="$(curl -sS -o /dev/null -w '%{http_code}' --retry 1 --max-time 15 "$SITE$path" 2>/dev/null)"
  header="$(curl -sS -o /dev/null -D - "$SITE$path" 2>/dev/null \
    | grep -i '^cache-control:' | tail -1 | tr -d '\r' | cut -d' ' -f2-)"
  printf '  %-52s %s  %s\n' "${path:0:52}" "${status:-???}" "${header:-(bez Cache-Control)}"
done

echo
echo "Ak index.html nemá 'no-cache' alebo 'max-age=0', nahraj .htaccess z mobile/dist"
echo "— FTP ho skrýva, lebo sa začína bodkou."
echo
echo "Pusti to až po vlastnom builde: porovnáva sa s tým, čo máš v mobile/dist."
