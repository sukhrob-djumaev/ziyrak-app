# Current task (reconciled 2026-10-24)

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

- R4: MERGED (PR #33, `14e09ce`, exact-head CI green). Local/stand-in verification passed: vitest 1807, browser 30/30 on build `7043d16`. R1 Meta reply check WAIVED by owner; smoke suites not run; not deployed.

## Next action
1. NONE eligible in the approved milestone. R5 MERGED (PR #34, `905b4ca`), tagged `phase-r5-complete` (pushed, 2026-10-25); logo PR #35 merged
   (`3d5d15e`, CI green). R5 evidence: `npm test` 1812 passed/1 skipped, build/tsc/lint pass, security review clean, browser 30/30 on build
   `0b9a1a2` (stand-in AI, captured mail; local layer). Not deployed. No milestone tag (R1 Meta B waived, no deploy, smoke suites not run).
2. Awaiting owner: next milestone/task, deploy decision, `test:smoke:meta`, Business B visible delivery, npm audit zod/@vitest/mocker,
   docs screenshots, vector/high-res logo. Record: `.agent/progress/r5.md`; PLAN.md R5 section; HANDOFF (Meta Business A manual check).

## Retained resources
- Owner cleaned up (2026-10-25): all R2/R3/R5/opinv/meta-A throwaway DBs and the five task worktrees were dropped. Kept: DBs `owly` (real
  Business A/B connections), `owly_test`, `ziyrak_acceptance`, `ziyrak_real_acc`, four `ziyrak_phase7_real_closure_*`. Local task branches kept.
- `/Users/sukhrob/.codex/worktrees/*` are empty folders (no `.git`); removal not yet approved.

## Worker start command (owner terminal; auto-compacts at 200k, stop with `touch .agent/STOP`)
`cd ~/Development/Repos/JS/owly && CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 claude --model sonnet --settings '{"enabledPlugins":{"dart-flutter@dart-flutter":false}}'`
then type `/loop /ziyrak continue`.

## Standing authorization (owner, 2026-10-23)
Within the approved milestone, merge a PR to main without asking when CI is green on its exact head AND the plan's required
browser run is green on the combined build; then push main and re-check CI on the new head. Never merge on red/pending/skipped.
Continue to the next eligible task. Still stop for: tags, deploys, releases, force-push, deleting DBs/worktrees/branches, new
milestone/phase, real credentials or mail, port 7700.

## Prohibited without approval
Push tags, deploy, delete DBs or worktrees, touch live port 7700 or the live
worker checkout.
