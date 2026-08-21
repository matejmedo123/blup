#!/usr/bin/env bash
# ============================================================================
# BLUP · security probes
#
#   ./scripts/probe-security.sh [api-url] [anon-key] [email] [password]
#
# Attacks the deployment with nothing but the anon key that ships inside every
# browser bundle, from a signed-in session — which is the interesting attacker,
# because anyone can have an account.
#
# Two halves, and both matter:
#   · things that must be refused (issuing tickets, reading other people's QR
#     secrets, granting yourself Premium, rewriting the fee schedule)
#   · things that must still work (browsing without an account, your own basket)
#
# A test suite that only checks the first half will happily pass on a database
# that has been locked down so hard the app cannot run.
# ============================================================================
set -uo pipefail

API="${1:-http://localhost:54321}"
ANON="${2:-}"
EMAIL="${3:-mia@blup.test}"
PASS_WORD="${4:-blup12345}"

if [ -z "$ANON" ]; then
  echo "Použitie: $0 <api-url> <anon-key> [email] [heslo]" >&2
  exit 2
fi

pass=0; fail=0

TOKEN=$(curl -s "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS_WORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Nepodarilo sa prihlásiť ako $EMAIL — bez toho sa nedá testovať." >&2
  exit 2
fi
echo "· prihlásený ako $EMAIL"

UID_SELF=$(python3 -c "
import base64,json,sys
p='$TOKEN'.split('.')[1]; p+='='*(-len(p)%4)
print(json.loads(base64.urlsafe_b64decode(p))['sub'])")

auth() { curl -s -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

# --- must be refused --------------------------------------------------------
blocked() {
  local name="$1"; shift
  local body; body=$(auth "$@")
  if echo "$body" | grep -qiE '"code":"(42501|PGRST[0-9]+|403)"|permission denied|does not exist|NOT_AUTHORIZED|AUTH_REQUIRED|violates row-level'; then
    printf '  ✓ %-50s odmietnuté\n' "$name"; pass=$((pass+1))
  else
    printf '  ✗ %-50s PRESLO → %s\n' "$name" "$(echo "$body" | head -c 100)"; fail=$((fail+1))
  fi
}

echo
echo "--- prihlásený používateľ NESMIE ---"
blocked "vydať si vstupenku (fulfill_order)" -X POST "$API/rest/v1/rpc/fulfill_order" \
  -d '{"p_order_id":"00000000-0000-0000-0000-000000000001","p_provider":"manual","p_provider_reference":"x","p_amount_cents":0}'
blocked "prečítať cudzí QR secret (ticket_email_payload)" -X POST "$API/rest/v1/rpc/ticket_email_payload" \
  -d '{"p_order_id":"00000000-0000-0000-0000-000000000001"}'
blocked "objednať v cudzom mene (create_order)" -X POST "$API/rest/v1/rpc/create_order" \
  -d '{"p_buyer_id":"00000000-0000-0000-0000-000000000009","p_ticket_type_id":"00000000-0000-0000-0000-000000000009","p_quantity":1}'
blocked "refundovať (refund_order)" -X POST "$API/rest/v1/rpc/refund_order" \
  -d '{"p_order_id":"00000000-0000-0000-0000-000000000001"}'
blocked "dať si Premium (upsert_premium_subscription)" -X POST "$API/rest/v1/rpc/upsert_premium_subscription" \
  -d '{"p_user_id":"'"$UID_SELF"'","p_platform":"stripe","p_product_id":"x","p_status":"active","p_original_tx":"x","p_latest_tx":"x","p_purchased_at":"2026-01-01T00:00:00Z","p_expires_at":"2030-01-01T00:00:00Z","p_auto_renew":true,"p_environment":"production","p_raw":{}}'
blocked "poslať komukoľvek notifikáciu (notify_user)" -X POST "$API/rest/v1/rpc/notify_user" \
  -d '{"p_user_id":"00000000-0000-0000-0000-000000000009","p_type":"system","p_title":"x","p_body":"x"}'
blocked "zapísať objednávku priamo" -X POST "$API/rest/v1/orders" \
  -d '{"event_id":"00000000-0000-0000-0000-000000000009","quantity":1,"total_cents":0,"currency":"EUR","unit_price_cents":0,"subtotal_cents":0,"ticket_type_id":"00000000-0000-0000-0000-000000000009","buyer_id":"'"$UID_SELF"'"}'
blocked "zapísať vstupenku priamo" -X POST "$API/rest/v1/tickets" \
  -d '{"event_id":"00000000-0000-0000-0000-000000000009","code":"HACK","qr_secret":"x","price_cents":0,"currency":"EUR"}'
blocked "prepísať sadzby platformy" -X PATCH "$API/rest/v1/platform_settings?id=eq.true" \
  -d '{"platform_fee_bps":0}'

# app_role is protected by a trigger, not by a refusal: the update succeeds and
# the field is silently put back. So the check has to read the value afterwards.
auth -X PATCH "$API/rest/v1/profiles?id=eq.$UID_SELF" -d '{"app_role":"admin"}' > /dev/null
ROLE=$(auth "$API/rest/v1/profiles?id=eq.$UID_SELF&select=app_role" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["app_role"] if d else "?")' 2>/dev/null)
if [ "$ROLE" = "admin" ]; then
  printf '  ✗ %-50s ROLA JE ADMIN\n' "povýšiť sa na admina"; fail=$((fail+1))
else
  printf '  ✓ %-50s rola ostala "%s"\n' "povýšiť sa na admina" "$ROLE"; pass=$((pass+1))
fi

# --- must not leak ----------------------------------------------------------
echo
echo "--- cudzie riadky nesmú byť vidieť ---"
own_only() { # table  own-count-query
  local table="$1"; local own="$2"
  local seen; seen=$(auth "$API/rest/v1/$table?select=*" \
    | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else -1)
except Exception: print(-1)')
  if [ "$seen" -le "$own" ] 2>/dev/null; then
    printf '  ✓ %-50s vidí %s (vlastných %s)\n' "$table" "$seen" "$own"; pass=$((pass+1))
  else
    printf '  ✗ %-50s VIDÍ %s, vlastných je %s\n' "$table" "$seen" "$own"; fail=$((fail+1))
  fi
}
for t in ledger_entries payouts webhook_events admin_audit_log; do own_only "$t" 0; done

# --- must still work --------------------------------------------------------
echo
echo "--- a toto musí fungovať ---"
works() {
  local name="$1"; shift
  local body; body=$(curl -s -H "apikey: $ANON" -H 'Content-Type: application/json' "$@")
  if echo "$body" | grep -qE '^\[|^\{' && ! echo "$body" | grep -qiE '"(message|hint|code)":|permission denied'; then
    printf '  ✓ %-50s ide\n' "$name"; pass=$((pass+1))
  else
    printf '  ✗ %-50s ZLYHALO → %s\n' "$name" "$(echo "$body" | head -c 100)"; fail=$((fail+1))
  fi
}
works "hosť vidí eventy" "$API/rest/v1/events?select=title&limit=3"
works "hosť vie hľadať" -X POST "$API/rest/v1/rpc/search_events" -d '{"p_limit":3}'
works "hosť vidí dostupnosť vstupeniek" -X POST "$API/rest/v1/rpc/cart_limits" -d '{}'
works "hosť dostane marketingové značky" -X POST "$API/rest/v1/rpc/marketing_tags" -d '{}'

CART=$(auth -X POST "$API/rest/v1/rpc/cart_view" -d '{}')
if echo "$CART" | grep -q '"quantity"'; then
  printf '  ✓ %-50s ide\n' "prihlásený vidí svoj košík"; pass=$((pass+1))
else
  printf '  ✗ %-50s ZLYHALO → %s\n' "prihlásený vidí svoj košík" "$(echo "$CART" | head -c 100)"; fail=$((fail+1))
fi

echo
echo "$pass prešlo, $fail zlyhalo"
[ "$fail" -eq 0 ]
