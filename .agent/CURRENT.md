# Current task (reconciled 2026-10-22)

Keep this file under ~60 lines: status, next action, blockers, prohibitions. Older updates are
archived by `scripts/agent/archive-state.sh` into `docs/state-archive/`; full history before the
2026-10-22 compaction is in `docs/state-archive/current-through-2026-10-22.md`.

## Status
- Phase: managed-service readiness milestone (see PLAN.md live board).
- Done and merged on main: R1, R3, P1 (tag `phase-p1-complete`), P2 (merge 53f2738; main CI green on 09ab7f5).
- P2 completion tag `phase-p2-complete`: NOT created, needs the owner's decision.
- P3 (accounts and customer onboarding): not started; needs explicit owner go-ahead.
- Workflow change in review: branch `chore/token-diet` (PLAN.md split into live plan + docs/architecture-reference.md,
  compact state files, SessionStart hook, state archiver). Docs/tooling only; awaiting merge approval.

## Next action
1. Owner: approve merging `chore/token-diet`; decide the P2 tag; say go for P3.
2. Then P3: read PLAN.md P3 criteria and the P1 invitations/access and P2 managed-AI records; tests first.

## Retained resources (do not delete without approval)
- Test/acceptance DBs: ziyrak_test_p2_20261022*, ziyrak_acceptance_p2_managed_20261022[b], ziyrak_test_p2_baseline_d.
- Worktrees under /Users/sukhrob/.codex/worktrees/ (p2-managed-ai, p3-onboarding, token-diet and older finished branches).

## Prohibited without approval
Push/merge/deploy/tag, starting P3, deleting DBs or worktrees, touching live port 7700 or the live worker checkout.
