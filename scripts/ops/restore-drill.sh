#!/bin/sh
# L2.2: rehearse a database restore, end to end, without touching the source.
#   SOURCE_DATABASE_URL=postgresql://user:pass@host:5432/db scripts/ops/restore-drill.sh
# 1. pg_dump (custom format) of the SOURCE, read-only.   2. Restore into a throwaway Postgres container whose data
# lives in tmpfs (nothing is written to a Docker volume or to disk, and everything vanishes with the container).
# 3. Compare the row count of every application table (schema public).   4. Check the restored migration history
# against the migrations in this checkout, and print the elapsed time (RTO evidence).
# The source is only read. Its URL (with the password) is passed to Docker through the environment, never as an
# argument, so it does not show in process listings. Use a pg_dump no older than the server (this uses Postgres 16).
# The dump file is a temporary file in the system temp directory, removed on exit; use an encrypted disk for real data.
set -eu

src="${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL to the database to rehearse restoring}"
case "$src" in postgres://*|postgresql://*) ;; *) echo "SOURCE_DATABASE_URL must be a postgres URL" >&2; exit 2;; esac
id="$$-$(date +%s)"
box="ziyrakrestore-$id"
client="ziyrakrestore-$id-client"
dumpdir="$(mktemp -d)"
cleanup() {
  docker rm -f -v "$box" "$client" >/dev/null 2>&1 || true
  rm -rf "$dumpdir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { echo "RESTORE DRILL FAIL: $*" >&2; exit 1; }

# Containers reach the host's published ports through host.docker.internal.
# Prisma's ?schema=... parameter is not a libpq option; drop it.
SRC_URL="$(printf '%s' "$src" | sed -E 's#([?&])schema=[^&]*&?#\1#; s#[?&]$##' | sed -E 's#@(localhost|127\.0\.0\.1)#@host.docker.internal#')"
export SRC_URL
t0="$(date +%s)"

# One long-lived client container holds the source URL in its environment (value not on any command line).
docker run -d --name "$client" --add-host=host.docker.internal:host-gateway -e SRC_URL -v "$dumpdir":/out postgres:16-alpine sleep 3600 >/dev/null
q_src() { docker exec "$client" sh -c 'psql "$SRC_URL" -Atc "$1"' _ "$1"; }

echo "== dump (read-only)"
docker exec "$client" sh -c 'pg_dump --format=custom --no-owner --no-privileges --dbname="$SRC_URL" --file=/out/drill.dump' || fail "pg_dump"
[ -s "$dumpdir/drill.dump" ] || fail "empty dump"

echo "== restore into a throwaway database (tmpfs, no volume)"
docker run -d --name "$box" --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=restored -v "$dumpdir":/in:ro postgres:16-alpine >/dev/null
i=0; until docker exec "$box" pg_isready -U postgres -d restored >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && fail "scratch postgres did not start"; sleep 1; done
docker exec "$box" pg_restore --no-owner --no-privileges --exit-on-error -U postgres -d restored /in/drill.dump || fail "pg_restore"
t1="$(date +%s)"

echo "== row counts of application tables (schema public; queue/transient schemas are not compared)"
tables="$(q_src "select quote_ident(tablename) from pg_tables where schemaname = 'public' order by 1")"
[ -n "$tables" ] || fail "no tables found in the source"
bad=0; n=0
for t in $tables; do
  a="$(q_src "select count(*) from public.$t")"
  b="$(docker exec "$box" psql -U postgres -d restored -Atc "select count(*) from public.$t")"
  n=$((n+1))
  if [ "$a" != "$b" ]; then echo "  MISMATCH $t: source=$a restored=$b"; bad=$((bad+1)); fi
done
echo "  compared $n tables, $bad mismatch(es)"
[ "$bad" = "0" ] || echo "  (a live source can change between dump and count; rerun against a quiet database or a snapshot)"

echo "== migration history of the restored database"
docker exec "$box" psql -U postgres -d restored -Atc "select to_regclass('public._prisma_migrations') is not null" | grep -q t || fail "restored database has no _prisma_migrations table (not an application backup?)"
restored_file="$dumpdir/restored.txt"; checkout_file="$dumpdir/checkout.txt"
docker exec "$box" psql -U postgres -d restored -Atc "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null" | sort > "$restored_file"
ls prisma/migrations 2>/dev/null | grep '^[0-9]' | sort > "$checkout_file"
echo "  restored: $(grep -c . "$restored_file") migration(s); this checkout: $(grep -c . "$checkout_file")"
only_in_restore="$(comm -23 "$restored_file" "$checkout_file")"
if [ -n "$only_in_restore" ]; then echo "  WARNING: the backup holds migrations this checkout does not have (backup is NEWER than this code):"; echo "$only_in_restore" | sed 's/^/    /'; fi

echo "RESTORE DRILL: dump+restore took $((t1 - t0)) s; $n tables; mismatches: $bad"
[ "$bad" = "0" ] || exit 1
