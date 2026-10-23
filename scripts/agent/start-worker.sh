#!/usr/bin/env bash
# Start the long-running Ziyrak dispatcher session. It auto-compacts at 200k tokens, so it needs no manual
# restarts. Run it in its own terminal tab from anywhere; stop it with `touch .agent/STOP` or /exit.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
rm -f .agent/STOP
mkdir -p .agent/progress
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000
exec claude --settings '{"enabledPlugins":{"dart-flutter@dart-flutter":false}}' "/loop /ziyrak continue"
