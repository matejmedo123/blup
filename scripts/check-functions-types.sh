#!/usr/bin/env bash
# =============================================================================
# Type-check every Edge Function.
#
# Supabase deploys Edge Functions WITHOUT type-checking them, and nothing in
# this repository ever ran `deno check` either — so for a long time the
# functions carried 131 type errors nobody could see. Almost all of them were
# the same thing (supabase-js cannot infer an RPC's return shape without a
# generated `Database` type, so every field read off one was an error against
# the empty object), which is exactly the noise a real mistake hides in.
#
# This is the check that stops that happening again. It needs Deno; where there
# is none it says so and passes, because a missing local tool is not a broken
# build.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if command -v deno >/dev/null 2>&1; then
  DENO="deno"
elif command -v npx >/dev/null 2>&1; then
  DENO="npx --yes deno@2"
else
  echo "• Deno nie je k dispozícii — preskakujem kontrolu typov Edge Functions."
  echo "  Nainštaluj: https://deno.land  (alebo maj po ruke npx)"
  exit 0
fi

cd supabase/functions

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# --node-modules-dir=auto: supabase-js pulls npm dependencies that Deno will not
# resolve from the JSR specifier alone. On a cold cache that prints a page of
# Download/Initialize lines, which carry ANSI colour — so the colour is stripped
# before anything is filtered, or the filter silently matches nothing and every
# progress line looks like an error.
set +e
$DENO check --node-modules-dir=auto ./*/index.ts > "$OUT" 2>&1
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  sed 's/\x1b\[[0-9;]*m//g' "$OUT" | grep -vE "^(Download|Initialize|Check) " || true
  echo
  echo "✖ Edge Functions majú chyby typov (hore)."
  exit 1
fi

echo "✓ Všetkých $(ls ./*/index.ts | wc -l | tr -d ' ') Edge Functions prešlo kontrolou typov."
