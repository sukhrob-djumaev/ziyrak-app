#!/bin/sh
# Runs the full MVP Browser Acceptance Suite in its real dependency order and
# exits non-zero the moment any journey's own assertions fail (see lib.cjs's
# assert()/finish()) or a journey process itself crashes.
#
# The suite's journeys are NUMBERED in narrative/UI order (J01 signup, J02
# auth, J03 isolation, J04 knowledge, ...), but J03/J03b's own attack surface
# — a ticket, a conversation, a customer, a knowledge entry/category, a
# webchat connection, and (for J03b) an ESCALATED conversation — does not
# exist until J04/J05/J06b/J08/J11 have created it. Running strictly in
# numeric order crashes J03/J03b on a fresh database (confirmed by this
# harness's own fresh-database acceptance run) even though the numbering
# suggests J03 runs third. This script is the corrected, real run order; use
# it instead of invoking run.sh jNN.cjs in numeric order.
#
# Requires: ACC_DB (the throwaway acceptance database's URL — the same one
# start-all.sh was pointed at) and the topology already running
# (`ACC_DB=... scripts/acceptance/start-all.sh`).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
: "${ACC_DB:?set ACC_DB to the throwaway acceptance database URL (same one start-all.sh used)}"

JOURNEYS="j01-signup j02-auth-session j04-knowledge j05-webchat-setup j06a-webchat-visitor-a j06b-webchat-visitor-b-and-cross-probes j08-tool-create-ticket j09-j10-followup-and-worker-restart j11-handoff j03-tenant-isolation j03b-tenant-isolation-followup j12-widget-security j13-approval j14-automation j15-runtime"

fail=""
for j in $JOURNEYS; do
  echo "=== running $j ==="
  start=$(date +%s)
  if "$here/run.sh" "$j.cjs"; then
    echo "=== $j PASSED ($(( $(date +%s) - start ))s) ==="
  else
    echo "=== $j FAILED ($(( $(date +%s) - start ))s) ==="
    fail="$j"
    break
  fi
done

if [ -n "$fail" ]; then
  echo "\nMVP Browser Acceptance Suite: FAILED at $fail"
  exit 1
fi
echo "\nMVP Browser Acceptance Suite: all journeys passed."
