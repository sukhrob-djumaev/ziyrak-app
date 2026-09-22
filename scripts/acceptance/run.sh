#!/bin/sh
# Run one journey script after clearing stale automation browsers (only 'Chrome for Testing', never a personal Chrome).
# For the full suite in its real dependency order (not raw numeric order — see run-all.sh's own comment), use run-all.sh.
here="$(cd "$(dirname "$0")" && pwd)"; work="${ACC_WORK_DIR:-$here/.work}"
pkill -f "Google Chrome for Testing" 2>/dev/null; sleep 1
find "$work/profiles" -name "Singleton*" -delete 2>/dev/null
cd "$here" && node "$@"
