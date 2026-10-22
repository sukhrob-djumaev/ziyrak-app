# Current task (reconciled 2026-10-22)

Keep this file under ~60 lines: status, next action, blockers, prohibitions. Older updates are archived by
`scripts/agent/archive-state.py` into `docs/state-archive/`. Finished-package detail: `docs/milestone-archive.md`;
docs index: `docs/README.md`.

## Status
- Milestone: managed-service readiness (PLAN.md live board).
- Done and merged on main: R1, R3, P1 (`phase-p1-complete`), P2 (`phase-p2-complete`, local tag), P3 (merge `470073b`, exact-head CI green).
- P3 verified: unit 1748 passed/23 skipped, agent security review fixed, browser 28/28 on build `01d9b59`
  (stand-in AI, captured mail). No completion tag; not deployed.
- P3 open items (owner decisions 2026-10-22): operator invitations deferred to a follow-up (own tests-first work and
  security review); real mail delivery check NOT RUN (needs `PLATFORM_SMTP_*` sender settings and a real mailbox).
- Workflow: token diet merged (`ede8031`); `chore/plan-slim` archives finished packages out of PLAN.md.

## Next action
1. Owner: decide the P3 completion tag; push tag `phase-p2-complete` if wanted; approve `chore/plan-slim` merge.
2. Next eligible work per the board: R2 (AI decision quality) needs explicit owner go-ahead and policy/threshold decisions;
   R4 final acceptance after R1–R3 and P1–P3 (real mail and the R1 provider boundary are inputs to it).

## Retained resources (do not delete without approval)
- Test/acceptance DBs for P2/P3 runs and worktrees under /Users/sukhrob/.codex/worktrees/ (finished branches listed
  for cleanup review, not yet approved).

## Prohibited without approval
Push tags, deploy, start R2/R4/R5, build operator invitations, delete DBs or worktrees, touch live port 7700 or the live
worker checkout.
