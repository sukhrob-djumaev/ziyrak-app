#!/usr/bin/env bash
# Merge gate for a PR: prints MERGE_OK <head-sha> only when every check on the exact head is green and the PR is clean.
# Usage: merge-gate.sh <pr-number>. It never merges; the caller runs: gh pr merge <n> --merge --match-head-commit <sha>
set -u
pr="${1:?pr number}"
info="$(gh pr view "$pr" --json state,headRefOid,mergeStateStatus,baseRefName -q '[.state,.headRefOid,.mergeStateStatus,.baseRefName]|@tsv')" || { echo "GATE_ERROR cannot read PR $pr"; exit 2; }
IFS=$'\t' read -r state sha merge base <<<"$info"
[ "$state" = OPEN ] || { echo "GATE_BLOCKED pr $pr state $state"; exit 1; }
[ "$base" = main ] || { echo "GATE_BLOCKED base is $base"; exit 1; }
checks="$(gh pr checks "$pr" 2>&1)"; rc=$?
[ $rc -eq 0 ] || { echo "GATE_BLOCKED checks not green (rc $rc): $(printf '%s\n' "$checks" | grep -vE 'pass' | head -3 | tr '\n' ';')"; exit 1; }
[ "$merge" = CLEAN ] || { echo "GATE_BLOCKED mergeState $merge"; exit 1; }
echo "MERGE_OK $sha"
