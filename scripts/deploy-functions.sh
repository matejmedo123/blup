#!/usr/bin/env bash
# Deploys every BLUP Edge Function with the correct JWT settings.
#
#   ./scripts/deploy-functions.sh                 # deploy all
#   ./scripts/deploy-functions.sh stripe-webhook  # deploy one
#
# Webhooks are deployed with --no-verify-jwt because Stripe and Apple cannot
# present a Supabase JWT; they authenticate by signature instead (see
# supabase/functions/_shared/stripe.ts and iap-apple-notifications).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Prefer a native install; fall back to npx (the CLI cannot be installed as a
# global npm module).
if command -v supabase >/dev/null 2>&1; then
  SUPABASE="supabase"
elif command -v npx >/dev/null 2>&1; then
  SUPABASE="npx --yes supabase"
else
  echo "✖ Neither the Supabase CLI nor npx is available."
  echo "  Install Node.js, or: brew install supabase/tap/supabase"
  exit 1
fi

# name:verify_jwt
FUNCTIONS=(
  "checkout-create:true"
  "boost-create:true"
  "organizer-connect:true"
  "payout-request:true"
  "accounting-export:true"
  "ticket-email:true"
  "web-checkout:true"
  "iap-apple-verify:true"
  "ai-recommendations:true"
  "stripe-webhook:false"
  "iap-apple-notifications:false"
  "push-dispatch:false"
  "weekly-digest:false"
  "cart-sweep:false"
  "config-status:false"
)

deploy() {
  local name="$1" verify="$2"
  if [ "$verify" = "false" ]; then
    echo "→ $name (no JWT — authenticated by signature/service key)"
    $SUPABASE functions deploy "$name" --no-verify-jwt
  else
    echo "→ $name"
    $SUPABASE functions deploy "$name"
  fi
}

if [ $# -gt 0 ]; then
  for target in "$@"; do
    found=false
    for entry in "${FUNCTIONS[@]}"; do
      if [ "${entry%%:*}" = "$target" ]; then
        deploy "${entry%%:*}" "${entry##*:}"
        found=true
      fi
    done
    if [ "$found" = false ]; then
      echo "✖ Unknown function: $target"
      exit 1
    fi
  done
else
  for entry in "${FUNCTIONS[@]}"; do
    deploy "${entry%%:*}" "${entry##*:}"
  done
fi

echo ""
echo "✅ Done. Remember to set the secrets once:"
echo "   $SUPABASE secrets set --env-file supabase/.env"
