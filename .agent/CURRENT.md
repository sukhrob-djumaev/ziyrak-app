# Current task (reconciled 2026-10-22)

Keep this file under ~60 lines: status, next action, blockers, prohibitions. Older updates are archived by
`scripts/agent/archive-state.py` into `docs/state-archive/`. Finished-package detail: `docs/milestone-archive.md`;
docs index: `docs/README.md`.

## Status
- Milestone: managed-service readiness (PLAN.md live board).
- Done and merged on main: R1, R3, P1 (`phase-p1-complete`), P2 (`phase-p2-complete`, pushed), P3 (merge `470073b`, exact-head CI green).
- P3 verified: unit 1748 passed/23 skipped, agent security review fixed, browser 28/28 on build `01d9b59`
  (stand-in AI, captured mail). No completion tag; not deployed.
- P3 open items (owner decisions 2026-10-22): operator invitations deferred to a follow-up (own tests-first work and
  security review); real mail delivery check NOT RUN (needs `PLATFORM_SMTP_*` sender settings and a real mailbox).
- Workflow: token diet merged (`ede8031`); `chore/plan-slim` archives finished packages out of PLAN.md.

## In flight
- Operator invitations: MERGED to main (`fae51d8`, PR #30, exact-head CI green `cbe71f2`). Post-merge full browser suite and a
  journey for the new flow NOT run yet (plan rerun trigger: auth/routing change). Real mail NOT run.
- R2: branch `feat/r2-decision-quality` (PR #31, worktree `../owly-wt-r2`), implemented and live-evaluated: all approved thresholds met in
  run 4 (`gpt-4o-mini`), with disclosed scorer fixes after evaluation exposure. Record `docs/r2-ai-decision-quality-implementation-2026-10-23.md`.
  NOT merged: needs CI on exact head and the browser handoff journey (J11) on the combined build.
- Isolated DBs/worktrees in use: `ziyrak_opinv_test_20261022`, `../owly-wt-operator-invitations`, `../owly-wt-r2`.

## Next action
1. Run the full browser suite on a build of main + R2 (quiet machine, short foreground runs); then merge R2 if green. Owner: decide the P3 tag (blocked on real mail). `phase-p2-complete` is pushed and `chore/plan-slim`
   is merged (`c538d98`); main equals origin/main.
2. Next eligible work per the board: R2 (AI decision quality) needs explicit owner go-ahead and policy/threshold decisions;
   R4 final acceptance after R1–R3 and P1–P3 (real mail and the R1 provider boundary are inputs to it).

## Retained resources (do not delete without approval)
- Test/acceptance DBs for P2/P3 runs (not checked: `psql` could not list them from this shell).
- `/Users/sukhrob/.codex/worktrees/*` (10 dirs, e.g. p3-onboarding) are empty (0B, no `.git`) and no longer git
  worktrees; leftover empty folders, safe to remove once approved.

## Standing authorization (owner, 2026-10-23)
Within the approved milestone, merge a PR to main without asking when CI is green on its exact head AND the plan's required
browser run is green on the combined build; then push main and re-check CI on the new head. Never merge on red/pending/skipped.
Continue to the next eligible task. Still stop for: tags, deploys, releases, force-push, deleting DBs/worktrees/branches, new
milestone/phase, real credentials or mail, port 7700.

## Prohibited without approval
Push tags, deploy, start R4/R5, delete DBs or worktrees, touch live port 7700 or the live
worker checkout.
