#!/bin/sh
# PLAN.md §46.8 task 5 — real multi-replica load test: 2 app replicas + 2 worker
# replicas in containers (the production image) behind PgBouncer, with shared
# Redis and Postgres, in an isolated compose project (owlyload). Usage:
#   scripts/loadtest/run.sh [redis|no-redis|both|up|down]     (default: both)
#   `up` leaves the Redis-on topology running (for debugging; the stand-in LLM
#   keeps running too); `down` tears it down.
# `redis` must pass; `no-redis` is the control run that reproduces the
# single-replica-only behavior Redis replaces (rate limit × replicas, no
# cross-process realtime) — it passes when it shows exactly that.
# Needs: Docker, the image (built here if missing), ports 3201/3202/55432/4010 free.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
mode="${1:-both}"
P=owlyload
COMPOSE="docker compose -p $P -f docker-compose.yml -f scripts/loadtest/compose.override.yml --profile scale"
export SECRET_KEY_V1=loadtest-secret-key-v1-not-a-real-secret
export JWT_SECRET=loadtest-jwt-secret-not-a-real-secret
DB_DIRECT="postgresql://postgres:postgres@localhost:55432/owly_load?schema=public"
work="$here/.work"; mkdir -p "$work"
llm_pid=""

cleanup() {
  [ -n "$llm_pid" ] && kill "$llm_pid" 2>/dev/null || true
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
}
if [ "$mode" = down ]; then pkill -f scripts/acceptance/llm-standin.cjs 2>/dev/null || true; cleanup; exit 0; fi
[ "$mode" = up ] || trap cleanup EXIT INT TERM

if [ -z "$(docker images -q owly:local)" ]; then
  echo "Building owly:local ..."; $COMPOSE build app
fi

echo "Starting Postgres ..."
$COMPOSE up -d db
until docker compose -p $P exec -T db pg_isready -U postgres -d owly_load >/dev/null 2>&1; do sleep 1; done
DATABASE_URL="$DB_DIRECT" npx prisma migrate deploy >/dev/null

echo "Starting the LLM stand-in (300 ms latency) ..."
ACC_WORK_DIR="$work" LLM_DELAY_MS=300 node scripts/acceptance/llm-standin.cjs >"$work/llm.log" 2>&1 &
llm_pid=$!

up_stack() {
  redis_url="$1"
  LOADTEST_REDIS_URL="$redis_url" $COMPOSE up -d --no-build --force-recreate pgbouncer redis app app-2 worker worker-2
  for port in 3201 3202; do
    n=0; until curl -fs "http://localhost:$port/api/health" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 90 ] && { echo "replica on :$port never became healthy"; $COMPOSE logs --tail 40 app app-2; exit 1; }; sleep 2; done
  done
  sleep 8 # let both workers register their pollers
  DATABASE_URL="$DB_DIRECT" DIRECT_DATABASE_URL="$DB_DIRECT" npx tsx scripts/loadtest/seed.ts >"$work/seed.json"
}

run_mode() {
  expect="$1"; redis_url="$2"; rc=0
  echo; echo "=== replicas up, Redis $([ "$expect" = 1 ] && echo ON || echo OFF) ==="
  up_stack "$redis_url"
  seed="$(tail -1 "$work/seed.json")"
  REPLICAS=http://localhost:3201,http://localhost:3202 DB_URL="$DB_DIRECT" SEED_JSON="$seed" \
    LOG_CMD="$COMPOSE logs --no-color" WORKER_SERVICES=worker,worker-2 STOP_WORKER_CMD="$COMPOSE stop worker-2" EXPECT_REDIS="$expect" \
    npx tsx scripts/loadtest/check.ts || rc=$?
  pgbouncer_report || rc=1
  return $rc
}

# The runtime traffic above went through PgBouncer in transaction-pooling mode:
# prove it from the pooler's own counters, and show how few Postgres
# connections it took (app + worker replicas all share DEFAULT_POOL_SIZE).
pgbouncer_report() {
  psql_admin() { $COMPOSE exec -T -e PGPASSWORD=postgres db psql -h pgbouncer -U postgres -d pgbouncer -At -F ' ' -c "$1"; }
  pools="$(psql_admin 'SHOW POOLS;' | grep '^owly_load ' || true)"
  xacts="$(psql_admin 'SHOW STATS;' | grep '^owly_load ' | awk '{print $2}' | head -1)"
  server_conns="$($COMPOSE exec -T -e PGPASSWORD=postgres db psql -U postgres -d owly_load -At -c "SELECT count(*) FROM pg_stat_activity WHERE datname='owly_load' AND application_name <> 'psql'")"
  echo "PgBouncer pools: $pools"
  echo "PgBouncer transactions served: ${xacts:-0}; Postgres backend connections now: $server_conns (2 app + 2 worker replicas, DEFAULT_POOL_SIZE=20)"
  if echo "$pools" | grep -q ' transaction' && [ "${xacts:-0}" -gt 0 ]; then echo "PASS  runtime traffic went through PgBouncer in transaction-pooling mode"; else echo "FAIL  PgBouncer saw no transaction-pooled traffic"; return 1; fi
}

status=0
case "$mode" in
  up) up_stack "redis://:owly-local-redis@redis:6379"; echo "Replicas on :3201/:3202; seed: $(tail -1 "$work/seed.json"); tear down with: $0 down" ;;
  redis) run_mode 1 "redis://:owly-local-redis@redis:6379" || status=1 ;;
  no-redis) run_mode 0 "" || status=1 ;;
  both) run_mode 1 "redis://:owly-local-redis@redis:6379" || status=1; run_mode 0 "" || status=1 ;;
  *) echo "usage: $0 [redis|no-redis|both]"; exit 2 ;;
esac
exit $status
