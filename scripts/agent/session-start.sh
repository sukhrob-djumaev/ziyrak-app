#!/usr/bin/env bash
# Read-only Claude hook; Codex invokes the same preflight from AGENTS.md.
# Return hook success so STOP/missing-context findings remain in model context.
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 0
python3 "$script_dir/continue-preflight.py"
rc=$?
if [ "$rc" -ne 0 ]; then
  printf 'Startup did not clear continuation (preflight exit %s). Resolve the message above before implementation.\n' "$rc"
fi
exit 0
