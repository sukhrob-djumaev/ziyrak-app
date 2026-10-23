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
- P3: COMPLETE, tag `phase-p3-complete` on `2b64578` (2026-10-23): real mail passed (Gmail SMTP, owner confirmed receipt), browser 28/28 incl. J11 on combined build, J29 merged (PR #32), exact-head CI green. Not deployed.
- R2: MERGED (`6225d00`). Live evaluation: all approved thresholds met (dev run 3, eval run 4, `gpt-4o-mini`) with disclosed scorer fixes; browser
  28/28 incl. J11 on the combined build. Record `docs/r2-ai-decision-quality-implementation-2026-10-23.md`.
- Isolated DBs/worktrees in use: `ziyrak_opinv_test_20261022`, `ziyrak_acceptance_r2_20261023{a,b,c}`, `../owly-wt-operator-invitations`, `../owly-wt-r2`.

## Next action
1. R1 targeted Meta recipient-visible reply check (may be blocked by Meta test-account lock 131031; owner decides waiver), then R4 per standing authorization.
2. R4 final acceptance needs real mail and the R1 provider boundary as inputs; a fresh unbiased R2 evaluation set is optional.

## Retained resources (do not delete without approval)
- Test/acceptance DBs for P2/P3 runs (not checked: `psql` could not list them from this shell).
- `/Users/sukhrob/.codex/worktrees/*` (10 dirs, e.g. p3-onboarding) are empty (0B, no `.git`) and no longer git
  worktrees; leftover empty folders, safe to remove once approved.

## Worker start command (owner terminal; auto-compacts at 200k, stop with `touch .agent/STOP`)
`cd ~/Development/Repos/JS/owly && CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 claude --model sonnet --settings '{"enabledPlugins":{"dart-flutter@dart-flutter":false}}'`
then type `/loop /ziyrak continue`.

## Standing authorization (owner, 2026-10-23)
Within the approved milestone, merge a PR to main without asking when CI is green on its exact head AND the plan's required
browser run is green on the combined build; then push main and re-check CI on the new head. Never merge on red/pending/skipped.
Continue to the next eligible task. Still stop for: tags, deploys, releases, force-push, deleting DBs/worktrees/branches, new
milestone/phase, real credentials or mail, port 7700.

## Prohibited without approval
Push tags, deploy, start R4/R5, delete DBs or worktrees, touch live port 7700 or the live
worker checkout.
