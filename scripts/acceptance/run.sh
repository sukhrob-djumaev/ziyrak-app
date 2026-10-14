#!/bin/sh
# Journey execution never kills unrelated browsers or deletes active profile locks.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
node "$here/runtime.cjs" verify
journey="${1:?provide a journey filename}"
shift
exec node "$here/$journey" "$@"
