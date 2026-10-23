#!/usr/bin/env bash
# Compact verification: runs the static checks (and optionally unit tests) and prints one line per step plus the
# tail of any failure. Full logs go to $LOGDIR (default: .agent/progress/logs, git-ignored) for log-triage/grep.
# Usage: verify.sh [--tests <vitest paths...>]   (tests need an isolated Postgres: DATABASE_URL + DIRECT_DATABASE_URL)
set -u
LOGDIR="${LOGDIR:-.agent/progress/logs}"; mkdir -p "$LOGDIR"; rc=0
step() { name="$1"; shift; if "$@" >"$LOGDIR/$name.log" 2>&1; then echo "PASS $name"; else rc=1; echo "FAIL $name (log: $LOGDIR/$name.log)"; tail -n 8 "$LOGDIR/$name.log"; fi; }
step tsc npx tsc --noEmit
step lint npm run lint -- --max-warnings 0
if [ "${1:-}" = "--tests" ]; then shift; step vitest npx vitest run "$@"; grep -E "Test Files|Tests " "$LOGDIR/vitest.log" | tail -2; fi
exit $rc
