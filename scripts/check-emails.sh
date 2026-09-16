#!/usr/bin/env bash
# ============================================================================
# Are ticket e-mails actually going out?
#
#   ./scripts/check-emails.sh https://<project-ref>.supabase.co <service-role-key>
#
# Queueing a ticket e-mail and sending one are different things. The queue is
# drained by the `ticket-email` Edge Function on a cron; if that was never
# deployed, or the schedule was never created, or RESEND_API_KEY is missing,
# the rows sit in the table and nobody finds out — the buyer has the ticket in
# the app and the only copy they can show at the door never arrives.
#
# This asks the queue directly and says which of those it is.
# ============================================================================
set -uo pipefail

URL="${1:-}"
KEY="${2:-}"

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "Použitie: ./scripts/check-emails.sh https://<project-ref>.supabase.co <service-role-key>"
  echo "  Service role key: Supabase → Project Settings → API → service_role."
  echo "  Nikdy ho nedávaj do frontendu ani do gitu."
  exit 1
fi
URL="${URL%/}"

say() { printf '%s\n' "$1"; }

# --- the queue --------------------------------------------------------------
queue="$(curl -sS -X POST "$URL/rest/v1/rpc/email_queue_stats" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{}' 2>/dev/null)"

if [ -z "$queue" ] || printf '%s' "$queue" | grep -q '"code"'; then
  say "✖ Na frontu sa nedá opýtať."
  say "  $queue"
  say "  Ak hlási, že funkcia neexistuje: chýba migrácia — npx supabase db push"
  exit 1
fi

pending=$(printf '%s' "$queue" | grep -o '"pending":[0-9]*' | cut -d: -f2)
sent=$(printf '%s' "$queue" | grep -o '"sent":[0-9]*' | cut -d: -f2)
failed=$(printf '%s' "$queue" | grep -o '"failed":[0-9]*' | cut -d: -f2)
skipped=$(printf '%s' "$queue" | grep -o '"skipped":[0-9]*' | cut -d: -f2)
oldest=$(printf '%s' "$queue" | grep -o '"oldest_pending_minutes":[0-9]*' | cut -d: -f2)

say "čaká:    ${pending:-0}   (najstarší ${oldest:-0} min)"
say "odoslané: ${sent:-0}"
say "zlyhané:  ${failed:-0}"
say "preskočené: ${skipped:-0}   (bez RESEND_API_KEY sa zapisujú sem)"
say ""

# --- is the worker deployed at all? -----------------------------------------
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL/functions/v1/ticket-email" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"limit":1}' --max-time 30 2>/dev/null)"

case "$code" in
  200) say "✓ funkcia ticket-email beží a prijala požiadavku" ;;
  404) say "✖ funkcia ticket-email NIE JE nasadená  →  ./scripts/deploy-functions.sh" ;;
  401|403) say "✖ funkcia odmietla kľúč — použil si service_role key?" ;;
  *)   say "✖ funkcia odpovedala $code" ;;
esac

# --- and is anything calling it? --------------------------------------------
say ""
if [ "${oldest:-0}" -gt 10 ] && [ "${pending:-0}" -gt 0 ]; then
  say "✖ Najstarší e-mail čaká ${oldest} minút. Frontu nikto nevyprázdňuje."
  say "  Chýba cron. V SQL Editore:"
  say "    select jobname, schedule from cron.job;"
  say "  Ak tam 'blup-tickets' nie je, doplň ho podľa Fázy 8 návodu."
elif [ "${pending:-0}" -gt 0 ]; then
  say "• ${pending} čaká, najstarší ${oldest} min — to je v poriadku, cron beží raz za minútu."
else
  say "✓ Fronta je prázdna."
fi

if [ "${skipped:-0}" -gt 0 ]; then
  say ""
  say "⚠ ${skipped} preskočených: chýba RESEND_API_KEY, alebo EMAIL_FROM nie je"
  say "  na doméne overenej v Resende. Vstupenky existujú, e-mail neodišiel."
fi
