# Latest session handoff (2026-10-23)

- Merged operator invitations (`fae51d8`, CI green on exact head). Pushed main.
- R2 implemented on `feat/r2-decision-quality` (PR #31): rule-based escalation, case set (40 dev / 60 eval), scorer, live runner.
  Real-model results: dev run 3 and evaluation run 4 meet all thresholds. Evaluation runs 1 and 3 failed because of scorer/case-pattern
  defects (not product); disclosed in the record. A fresh evaluation set is needed for an unbiased claim.
- Not done: browser suite on the combined build (machine load was 21+ in the morning), a journey for operator invitations, J11 handoff
  check for R2, real mail check, R2 merge, P3 tag.
- Continue: wait for a quiet machine, merge main into R2 branch, build, run `scripts/acceptance` per `run-all.sh` on a fresh DB.
