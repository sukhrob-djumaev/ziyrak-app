#!/bin/sh
# Isolated acceptance topology only. Build with NEXT_PUBLIC_APP_URL=http://localhost:3100,
# use runtime.cjs build (it records the source/build identity). ACC_DB must name a fresh ziyrak_acceptance_<run> DB.
set -eu
: "${ACC_DB:?set ACC_DB to the fresh acceptance database URL}"
[ "${DATABASE_URL:-$ACC_DB}" = "$ACC_DB" ] || { echo "DATABASE_URL disagrees with ACC_DB" >&2; exit 1; }
[ "${DIRECT_DATABASE_URL:-$ACC_DB}" = "$ACC_DB" ] || { echo "DIRECT_DATABASE_URL disagrees with ACC_DB" >&2; exit 1; }
export DATABASE_URL="$ACC_DB" DIRECT_DATABASE_URL="$ACC_DB"
here="$(cd "$(dirname "$0")" && pwd)"
exec node "$here/runtime.cjs" start "${1:-all}"
