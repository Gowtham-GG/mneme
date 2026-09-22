#!/usr/bin/env bash
# Long-running local stack (Postgres + migrations + PostgREST + /rest/v1 proxy) for browser checks.
# Usage: bash tests/integration/stack.sh   (Ctrl+C to stop; then: podman rm -f mneme-e2e-rest; pg_ctl -D $MNEME_STACK_DIR/e2e-pg stop)
set -euo pipefail
T="${MNEME_STACK_DIR:-${TMPDIR:-/tmp}/mneme-stack}"; mkdir -p "$T"; R="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf $T/e2e-pg; initdb -D $T/e2e-pg -U postgres -E UTF8 --locale=C.UTF-8 --auth=trust >/dev/null
pg_ctl -D $T/e2e-pg -o "-p 54329 -k $T -c listen_addresses=127.0.0.1 -c fsync=off" -l $T/e2e-pg.log -w start >/dev/null
P="psql -h 127.0.0.1 -p 54329 -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
$P -f "$R/supabase/tests/supabase_shim.sql"
for f in $(ls $R/supabase/migrations/*.sql | grep -v -e trigram -e related_notes -e reminders_cron); do $P -f $f 2>&1 | grep -v NOTICE || true; done
podman rm -f mneme-e2e-rest >/dev/null 2>&1 || true
podman run -d --rm --name mneme-e2e-rest --network host -e PGRST_DB_URI=postgres://postgres@127.0.0.1:54329/postgres -e PGRST_DB_SCHEMAS=mneme -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long -e PGRST_SERVER_PORT=54330 docker.io/postgrest/postgrest:latest >/dev/null
for i in $(seq 1 40); do curl -sf http://127.0.0.1:54330/ >/dev/null 2>&1 && break || sleep 0.5; done
echo STACK-READY
exec node $R/tests/integration/rest-proxy.mjs 54331 54330
