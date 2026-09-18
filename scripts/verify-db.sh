#!/usr/bin/env bash
# ============================================================================
# Verifies every migration + the SQL test-suite against a real PostgreSQL 16
# instance, using a throwaway cluster. No Supabase project required.
#
#   ./scripts/verify-db.sh
#
# What it proves: the migrations apply cleanly from an empty database, the
# constraints/triggers/RLS behave as designed, and the ranking + ticketing
# functions return what the app expects.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORKDIR="${BLUP_PG_WORKDIR:-/tmp/blup-pgtest}"
PGDATA="$WORKDIR/data"
SOCKET="$WORKDIR/socket"
DB="blup_verify"

export PATH="$PGBIN:$PATH"

cleanup() {
  if [ -d "$PGDATA" ]; then
    pg_ctl -D "$PGDATA" -s -m immediate stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> Preparing throwaway cluster in $WORKDIR"
rm -rf "$WORKDIR"
mkdir -p "$PGDATA" "$SOCKET"

if [ "$(id -u)" = "0" ]; then
  # postgres refuses to run as root; use the 'postgres' system user if present.
  RUNAS="${BLUP_PG_USER:-postgres}"
  if ! id "$RUNAS" >/dev/null 2>&1; then
    echo "ERROR: running as root and no '$RUNAS' user exists." >&2
    exit 1
  fi
  chown -R "$RUNAS" "$WORKDIR"
  RUN() { su "$RUNAS" -s /bin/bash -c "PATH=$PATH $*"; }
else
  RUN() { bash -c "$*"; }
fi

RUN "initdb -D '$PGDATA' -U postgres --auth=trust >/dev/null"
RUN "pg_ctl -D '$PGDATA' -o \"-k '$SOCKET' -h ''\" -w -l '$WORKDIR/pg.log' start >/dev/null"

PSQL="psql -h $SOCKET -U postgres -v ON_ERROR_STOP=1 --quiet"
if [ "$(id -u)" = "0" ]; then
  PSQL="su ${BLUP_PG_USER:-postgres} -s /bin/bash -c \"PATH=$PATH psql -h $SOCKET -U postgres -v ON_ERROR_STOP=1 --quiet"
fi

run_sql() {
  if [ "$(id -u)" = "0" ]; then
    su "${BLUP_PG_USER:-postgres}" -s /bin/bash -c \
      "PATH=$PATH psql -h '$SOCKET' -U postgres -v ON_ERROR_STOP=1 --quiet $*"
  else
    psql -h "$SOCKET" -U postgres -v ON_ERROR_STOP=1 --quiet $*
  fi
}

run_sql "-d postgres -c \"create database $DB\""

echo "==> Applying local auth shim (Supabase-only objects)"
run_sql "-d $DB -f '$ROOT/supabase/tests/_local_auth_shim.sql'"

echo "==> Applying migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "    - $(basename "$f")"
  run_sql "-d $DB -f '$f'"
done

echo "==> Running SQL test suite"
for f in "$ROOT"/supabase/tests/test_*.sql; do
  [ -e "$f" ] || continue
  echo "    - $(basename "$f")"
  run_sql "-d $DB -f '$f'"
done

echo "==> Auditing indexes"
run_sql "-d $DB -f '$ROOT/supabase/tests/_index_audit.sql'"

echo ""
echo "✅ Database verified: migrations applied cleanly and all assertions passed."
