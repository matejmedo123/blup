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

if ! command -v supabase >/dev/null 2>&1; then
  echo "✖ The Supabase CLI is not installed."
  echo "  npm install -g supabase   (or: brew install supabase/tap/supabase)"
  exit 1
fi

# name:verify_jwt
FUNCTIONS=(
  "checkout-create:true"
  "organizer-connect:true"
  "payout-request:true"
  "iap-apple-verify:true"
  "ai-recommendations:true"
  "stripe-webhook:false"
  "iap-apple-notifications:false"
  "push-dispatch:false"
  "config-status:false"
)

deploy() {
  local name="$1" verify="$2"
  if [ "$verify" = "false" ]; then
    echo "→ $name (no JWT — authenticated by signature/service key)"
    supabase functions deploy "$name" --no-verify-jwt
  else
    echo "→ $name"
    supabase functions deploy "$name"
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
echo "   supabase secrets set --env-file supabase/.env"
