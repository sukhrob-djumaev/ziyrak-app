#!/bin/sh
# L2.2: rehearse a database restore, end to end, without touching the source.
#   SOURCE_DATABASE_URL=postgresql://user:pass@host:5432/db scripts/ops/restore-drill.sh
# 1. pg_dump (custom format) of the SOURCE, read-only.   2. Restore into a throwaway Postgres container.
# 3. Compare the row count of every table between source and restore.   4. Report the restored migration state
#    (_prisma_migrations) against the migrations in this checkout, and the elapsed time (your RTO evidence).
# The source is only read. The throwaway container and dump are removed on exit. Use a host Docker can reach
# (on Docker Desktop, localhost works as host.docker.internal; the script rewrites it for you).
set -eu

src="${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL to the database to rehearse restoring}"
case "$src" in postgres://*|postgresql://*) ;; *) echo "SOURCE_DATABASE_URL must be a postgres URL" >&2; exit 2;; esac
id="$$-$(date +%s)"
box="ziyrakrestore-$id"
dump="$(mktemp -d)/drill.dump"
cleanup() { docker rm -f "$box" >/dev/null 2>&1 || true; rm -rf "$(dirname "$dump")"; }
trap cleanup EXIT INT TERM
fail() { echo "RESTORE DRILL FAIL: $*" >&2; exit 1; }

# Containers reach the host's published ports through host.docker.internal.
dockerhost_url="$(printf '%s' "$src" | sed -E 's#@(localhost|127\.0\.0\.1)#@host.docker.internal#')"
t0="$(date +%s)"

echo "== dump (read-only)"
docker run --rm --add-host=host.docker.internal:host-gateway -v "$(dirname "$dump")":/out postgres:16-alpine \
  pg_dump --format=custom --no-owner --no-privileges --dbname="$dockerhost_url" --file=/out/drill.dump || fail "pg_dump"
[ -s "$dump" ] || fail "empty dump"

echo "== restore into a throwaway database"
docker run -d --name "$box" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=restored -v "$(dirname "$dump")":/in:ro postgres:16-alpine >/dev/null
i=0; until docker exec "$box" pg_isready -U postgres -d restored >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && fail "scratch postgres did not start"; sleep 1; done
docker exec "$box" pg_restore --no-owner --no-privileges --exit-on-error -U postgres -d restored /in/drill.dump || fail "pg_restore"
t1="$(date +%s)"

echo "== row counts (source vs restored)"
tables="$(docker run --rm --add-host=host.docker.internal:host-gateway postgres:16-alpine psql "$dockerhost_url" -Atc \
  "select quote_ident(schemaname)||'.'||quote_ident(tablename) from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1")"
[ -n "$tables" ] || fail "no tables found in the source"
bad=0; n=0
for t in $tables; do
  a="$(docker run --rm --add-host=host.docker.internal:host-gateway postgres:16-alpine psql "$dockerhost_url" -Atc "select count(*) from $t")"
  b="$(docker exec "$box" psql -U postgres -d restored -Atc "select count(*) from $t")"
  n=$((n+1))
  if [ "$a" != "$b" ]; then echo "  MISMATCH $t: source=$a restored=$b"; bad=$((bad+1)); fi
done
echo "  compared $n tables, $bad mismatch(es)"
[ "$bad" = "0" ] || echo "  (a live source can change between dump and count; rerun against a quiet database or a snapshot)"

echo "== migration state of the restored database"
applied="$(docker exec "$box" psql -U postgres -d restored -Atc "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null" 2>/dev/null || echo 0)"
here="$(ls prisma/migrations 2>/dev/null | grep -c '^[0-9]' || true)"
echo "  restored database has $applied applied migration(s); this checkout has $here"
[ "$applied" -le "$here" ] || echo "  WARNING: the backup is NEWER than this checkout (rolled-back code?)"

echo "RESTORE DRILL: dump+restore took $((t1 - t0)) s; $n tables; mismatches: $bad"
[ "$bad" = "0" ] || exit 1
