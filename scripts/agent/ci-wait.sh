#!/usr/bin/env bash
# Read-only CI wait. No merge/push or acceptance claim. Optional wait budget in minutes.
set -u
kind="${1:?pr|sha}"; ref="${2:?PR number or full SHA}"; minutes="${3:-20}"
case "$kind" in pr|sha) ;; *) echo "CI_UNAVAILABLE expected pr or sha"; exit 2;; esac
case "$minutes" in ''|*[!0-9]*) echo "CI_UNAVAILABLE minutes must be a nonnegative integer"; exit 2;; esac
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
deadline=$(( $(date +%s) + 10#$minutes * 60 ))
while :; do
  result="$(python3 "$script_dir/ci-status.py" "$kind" "$ref")"; rc=$?
  if [ "$rc" -ne 3 ]; then printf '%s\n' "$result"; exit "$rc"; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    printf 'CI_TIMEOUT %s %s after %sm; %s\n' "$kind" "$ref" "$minutes" "$result"
    exit 2
  fi
  sleep 30
done
