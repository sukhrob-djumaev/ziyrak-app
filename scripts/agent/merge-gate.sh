#!/usr/bin/env bash
# CI gate only. Never merges. Pin any separately authorized merge with --match-head-commit.
set -u
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$script_dir/ci-status.py" merge "${1:?PR number}"
