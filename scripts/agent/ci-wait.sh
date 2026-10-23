#!/usr/bin/env bash
# Wait for CI and print ONE verdict line, so no model has to poll. Usage: ci-wait.sh pr <number> | sha <commit> [max-minutes]
# Exit 0 = green, 1 = failed, 2 = timed out / not found.
set -u
kind="${1:?pr|sha}"; ref="${2:?number or sha}"; max="${3:-20}"
end=$(( $(date +%s) + max * 60 ))
while :; do
  if [ "$kind" = pr ]; then
    out="$(gh pr checks "$ref" 2>&1)"; rc=$?
    case $rc in
      0) echo "CI_GREEN pr $ref head $(gh pr view "$ref" --json headRefOid -q .headRefOid)"; exit 0;;
      1) echo "CI_FAILED pr $ref: $(printf '%s\n' "$out" | grep -E 'fail' | head -3 | tr '\n' ';')"; exit 1;;
    esac
  else
    out="$(gh run list --commit "$ref" --json status,conclusion,workflowName -q '.[] | "\(.workflowName) \(.status) \(.conclusion)"' 2>&1)"
    if [ -n "$out" ] && ! printf '%s\n' "$out" | grep -qE 'in_progress|queued'; then
      if printf '%s\n' "$out" | grep -qE 'failure|cancelled|timed_out'; then echo "CI_FAILED sha $ref: $(printf '%s' "$out" | head -3 | tr '\n' ';')"; exit 1; fi
      echo "CI_GREEN sha $ref"; exit 0
    fi
  fi
  [ "$(date +%s)" -ge "$end" ] && { echo "CI_TIMEOUT $kind $ref after ${max}m"; exit 2; }
  sleep 30
done
