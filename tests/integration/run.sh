#!/usr/bin/env bash
# Integration tests: the REAL client code (src/api/*, src/lib/sync.ts) against the REAL migrations,
# served by PostgREST (the same component Supabase uses). Everything runs locally, in a throwaway
# database. It never touches your Supabase project.
#
# Needs: postgres server binaries (initdb/pg_ctl), psql, podman (or docker), node.
#   npm run test:int
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="${MNEME_INT_DIR:-$(mktemp -d)}"
PGPORT=54329; REST=54330; PROXY=54331
CT="${CONTAINER_CLI:-podman}"
cleanup() {
  $CT rm -f mneme-int-rest >/dev/null 2>&1 || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
  pg_ctl -D "$WORK/pgdata" stop -m fast >/dev/null 2>&1 || true
}
trap cleanup EXIT

initdb -D "$WORK/pgdata" -U postgres -E UTF8 --locale=C.UTF-8 --auth=trust >/dev/null
pg_ctl -D "$WORK/pgdata" -o "-p $PGPORT -k $WORK -c listen_addresses=127.0.0.1 -c fsync=off" -l "$WORK/pg.log" -w start >/dev/null
PSQL="psql -h 127.0.0.1 -p $PGPORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
$PSQL -f supabase/tests/supabase_shim.sql
# trigram (05) and related_notes (11, which calls extensions.similarity) need
# pg_trgm, not installed locally; reminders_cron (15) needs pg_cron and is a
# manual one-time production step anyway (see its own header comment).
for f in $(ls supabase/migrations/*.sql | grep -v -e trigram -e related_notes -e reminders_cron); do $PSQL -f "$f" 2>&1 | grep -v NOTICE || true; done

JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
$CT run -d --rm --name mneme-int-rest --network host \
  -e PGRST_DB_URI="postgres://postgres@127.0.0.1:$PGPORT/postgres" -e PGRST_DB_SCHEMAS=mneme \
  -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" -e PGRST_SERVER_PORT=$REST \
  docker.io/postgrest/postgrest:latest >/dev/null
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$REST/" >/dev/null 2>&1 && break || sleep 0.5; done
node tests/integration/rest-proxy.mjs $PROXY $REST & PROXY_PID=$!
sleep 0.5

MNEME_INT_URL="http://127.0.0.1:$PROXY" MNEME_INT_JWT_SECRET="$JWT_SECRET" MNEME_INT_PG="127.0.0.1:$PGPORT" \
  npx vitest run --config vitest.int.config.ts "$@"
