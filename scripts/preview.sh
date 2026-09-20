#!/usr/bin/env bash
# ============================================================================
# Postaví lokálnu databázu s migráciami + náhľadové dáta a spustí backend,
# proti ktorému sa dá web otvoriť a POZRIEŤ si obrazovky.
#
#   ./scripts/preview.sh
#
# Nie je to Supabase a nie je to na testovanie bezpečnosti — beží ako jeden
# prihlásený človek. Je to na to, aby sa appka dala vidieť s dátami.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORKDIR="${BLUP_PREVIEW_WORKDIR:-/tmp/blup-preview}"
PGDATA="$WORKDIR/data"
SOCKET="$WORKDIR/socket"
DB="${BLUP_PREVIEW_DB:-blup_preview}"
export PATH="$PGBIN:$PATH"

if [ "${1:-}" != "--keep" ]; then
  echo "==> Čistá databáza v $WORKDIR"
  pg_ctl -D "$PGDATA" -s -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  mkdir -p "$PGDATA" "$SOCKET"

  RUNAS="${BLUP_PG_USER:-postgres}"
  if [ "$(id -u)" = "0" ]; then
    chown -R "$RUNAS" "$WORKDIR"
    RUN() { su "$RUNAS" -s /bin/bash -c "PATH=$PATH $*"; }
  else
    RUN() { bash -c "$*"; }
  fi

  RUN "initdb -D '$PGDATA' -U postgres --auth=trust >/dev/null"
  RUN "pg_ctl -D '$PGDATA' -o \"-k '$SOCKET' -h ''\" -w -l '$WORKDIR/pg.log' start >/dev/null"
  RUN "psql -h '$SOCKET' -U postgres -v ON_ERROR_STOP=1 --quiet -d postgres -c 'create database $DB'"

  echo "==> Migrácie a náhľadové dáta"
  RUN "psql -h '$SOCKET' -U postgres -v ON_ERROR_STOP=1 --quiet -d $DB -f '$ROOT/supabase/tests/_local_auth_shim.sql'" >/dev/null
  for f in "$ROOT"/supabase/migrations/*.sql; do
    RUN "psql -h '$SOCKET' -U postgres -v ON_ERROR_STOP=1 --quiet -d $DB -f '$f'" >/dev/null
  done
  RUN "psql -h '$SOCKET' -U postgres -v ON_ERROR_STOP=1 --quiet -d $DB -f '$ROOT/supabase/seed/preview.sql'" >/dev/null
fi

echo "==> Backend"
BLUP_PG_SOCKET="$SOCKET" BLUP_PREVIEW_DB="$DB" \
BLUP_PREVIEW_USER="${BLUP_PREVIEW_USER:-11111111-1111-1111-1111-111111111111}" \
  node "$ROOT/scripts/preview-server.mjs"
