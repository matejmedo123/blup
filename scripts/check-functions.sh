#!/usr/bin/env bash
# ============================================================================
# Which Edge Functions are actually live?
#
#   ./scripts/check-functions.sh
#
# "Failed to send a request to the Edge Function" in the browser means the
# request never completed: the function is not deployed (its preflight 404s
# without CORS headers, so the browser blocks it) or the app is pointed at a
# different project. Both look identical from inside the app, and neither shows
# up in the Supabase dashboard's function list if you are looking at the wrong
# project.
#
# This asks the project the app is configured to use, function by function.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/mobile/.env"

URL="${EXPO_PUBLIC_SUPABASE_URL:-}"
if [ -z "$URL" ] && [ -f "$ENV_FILE" ]; then
  URL="$(grep -E '^EXPO_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi

if [ -z "$URL" ]; then
  echo "✖ Nenašiel som EXPO_PUBLIC_SUPABASE_URL — ani v prostredí, ani v mobile/.env."
  exit 1
fi

URL="${URL%/}"
echo "Projekt: $URL"
echo

FUNCTIONS=(
  checkout-create boost-create organizer-connect payout-request accounting-export
  ticket-email web-checkout iap-apple-verify ai-recommendations stripe-webhook
  iap-apple-notifications push-dispatch weekly-digest cart-sweep config-status og unsubscribe
)

missing=0
for name in "${FUNCTIONS[@]}"; do
  # OPTIONS is the browser's own first request and needs no credentials. A
  # deployed function answers it; a missing one 404s.
  code="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
    -H 'Origin: https://blup.sk' \
    -H 'Access-Control-Request-Method: POST' \
    --max-time 12 "$URL/functions/v1/$name")"

  case "$code" in
    200|204) printf '  ✓ %-24s %s\n' "$name" "$code" ;;
    404)     printf '  ✗ %-24s %s — nie je nasadená\n' "$name" "$code"; missing=$((missing + 1)) ;;
    000)     printf '  ✗ %-24s bez odpovede — zlá adresa projektu alebo sieť\n' "$name"; missing=$((missing + 1)) ;;
    *)       printf '  ? %-24s %s\n' "$name" "$code" ;;
  esac
done

echo
if [ "$missing" -eq 0 ]; then
  echo "Všetky funkcie odpovedajú."
else
  echo "$missing nefunguje. Nasadenie: ./scripts/deploy-functions.sh"
  echo "Ak ich nasadené máš, over, či je $URL naozaj ten projekt, do ktorého si ich nasadil."
fi
