#!/bin/sh
# L2.2 / F12: tests the exact container image that would be released - not the source tree.
#   scripts/release/image-smoke.sh <image-ref> <expected-build-sha>
# Starts a throwaway Postgres and the image's web and worker on a private Docker network, under the STRICT production
# configuration contract (no relaxed profile), and checks: the worker refuses to start on a bad configuration, web
# liveness/readiness, the worker heartbeat (via the operator-detail health endpoint), the reported build identity,
# and that development/demo weight is not shipped. Everything it creates is named ziyraksmoke-<id> and removed on exit.
set -eu

image="${1:?usage: image-smoke.sh <image-ref> <expected-build-sha>}"
expected_sha="${2:?usage: image-smoke.sh <image-ref> <expected-build-sha>}"
id="$$-$(date +%s)"
net="ziyraksmoke-$id"
db="$net-db"
web="$net-web"
worker="$net-worker"
token="smoke-health-token-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
cleanup() {
  for c in "$web" "$worker" "$db" "$net-bad"; do docker rm -f -v "$c" >/dev/null 2>&1 || true; done
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

dburl="postgresql://postgres:smoke@$db:5432/ziyrak_smoke?schema=public"
common_env="-e NODE_ENV=production -e DATABASE_URL=$dburl -e DIRECT_DATABASE_URL=$dburl \
  -e JWT_SECRET=smoke-jwt-secret-0123456789abcdefghij -e SECRET_KEY_V1=smoke-encryption-key-0123456789abcdefghij \
  -e NEXT_PUBLIC_APP_URL=https://smoke.example.test -e TRUSTED_PROXY_HOPS=1 \
  -e PLATFORM_SMTP_HOST=smtp.example.test -e PLATFORM_SMTP_FROM=smoke@example.test \
  -e HEALTH_DETAIL_TOKEN=$token"

echo "== image contents"
docker image inspect "$image" --format 'size: {{.Size}} bytes' || fail "image not found: $image"
docker run --rm -e WITH_BROWSER_EXPECTED="${WITH_BROWSER_EXPECTED:-false}" --entrypoint sh "$image" -c '
  test -f dist/worker.cjs || { echo "dist/worker.cjs is missing"; exit 1; }
  test ! -d src || { echo "TypeScript source (src/) is shipped"; exit 1; }
  # (typescript is a runtime dependency of the Prisma packages, so it is not on this list.)
  for p in tsx vitest eslint @playwright; do test ! -d node_modules/$p || { echo "development package shipped: $p"; exit 1; }; done
  test ! -e /usr/local/bin/npm || { echo "npm is shipped in the runtime image"; exit 1; }
  test -f node_modules/prisma/package.json || { echo "prisma CLI missing (migrations need it)"; exit 1; }
  if [ "${WITH_BROWSER_EXPECTED:-false}" != "true" ]; then test ! -x /usr/bin/chromium || { echo "chromium shipped in the default image"; exit 1; }; fi
' || fail "image contents"

echo "== worker refuses an incomplete production configuration"
if out="$(docker run --rm --name "$net-bad" -e NODE_ENV=production "$image" node --enable-source-maps dist/worker.cjs 2>&1)"; then
  fail "worker started with no configuration"
fi
printf '%s' "$out" | grep -q "Invalid runtime configuration" || fail "worker did not report the configuration contract: $out"
printf '%s' "$out" | grep -q "SECRET_KEY_V<n>" || fail "contract output missing expected keys"

echo "== infrastructure"
docker network create "$net" >/dev/null
docker run -d --name "$db" --network "$net" --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=ziyrak_smoke postgres:16-alpine >/dev/null
i=0; until docker exec "$db" pg_isready -U postgres -d ziyrak_smoke >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && fail "postgres did not start"; sleep 1; done

echo "== web (migrations + server under the strict contract)"
# shellcheck disable=SC2086
docker run -d --name "$web" --network "$net" -p 127.0.0.1::3000 $common_env "$image" >/dev/null
port="$(docker port "$web" 3000/tcp | head -1 | sed 's/.*://')"
base="http://127.0.0.1:$port"
i=0; until curl -fsS "$base/api/health/live" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 180 ] && { docker logs "$web" 2>&1 | tail -30 >&2; fail "web never became live"; }
  [ "$(docker inspect -f '{{.State.Running}}' "$web")" = "true" ] || { docker logs "$web" 2>&1 | tail -30 >&2; fail "web container exited"; }
  sleep 1
done
curl -fsS "$base/api/health/ready" | grep -q '"status":"ready"' || fail "web is live but not ready"

echo "== worker"
# shellcheck disable=SC2086
docker run -d --name "$worker" --network "$net" $common_env "$image" node --enable-source-maps dist/worker.cjs >/dev/null
i=0; until detail="$(curl -fsS -H "x-health-token: $token" "$base/api/health")" && printf '%s' "$detail" | grep -q '"worker":"ok"'; do
  i=$((i+1)); [ $i -gt 120 ] && { docker logs "$worker" 2>&1 | tail -30 >&2; echo "$detail" >&2; fail "worker heartbeat never became ok"; }
  sleep 1
done
printf '%s' "$detail" | grep -q "\"sha\":\"$expected_sha\"" || fail "build identity mismatch (expected $expected_sha): $detail"
docker exec "$worker" node -e "const f=process.env.WORKER_HEARTBEAT_FILE||require('os').tmpdir()+'/ziyrak-worker-heartbeat';process.exit(Date.now()-require('fs').statSync(f).mtimeMs<60000?0:1)" || fail "worker heartbeat file probe failed"
# The public (no token) answer must not carry fingerprinting detail.
pub="$(curl -fsS "$base/api/health")" || fail "public health unreachable"
printf '%s' "$pub" | grep -q '"status"' || fail "public health answer is not the expected shape: $pub"
for k in build sha queue memory uptime; do
  printf '%s' "$pub" | grep -q "\"$k\"" && fail "public health leaks \"$k\": $pub"
done

echo "== graceful stop"
docker stop -t 45 "$worker" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$worker")" = "0" ] || fail "worker did not exit cleanly on SIGTERM"
echo "SMOKE OK: $image ($(docker image inspect "$image" --format '{{.Id}}'))"
