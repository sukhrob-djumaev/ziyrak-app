# Current task (reconciled 2026-10-22)

Keep this file under ~60 lines: status, next action, blockers, prohibitions. Older updates are
archived by `scripts/agent/archive-state.sh` into `docs/state-archive/`; full history before the
2026-10-22 compaction is in `docs/state-archive/current-through-2026-10-22.md`.

## Status
- Phase: managed-service readiness milestone (see PLAN.md live board).
- Done and merged on main: R1, R3, P1 (tag `phase-p1-complete`), P2 (complete 2026-10-22; tag `phase-p2-complete`).
- P3 (accounts and customer onboarding): implemented and verified in development on branch `p3-onboarding`
  (candidate `01d9b59`: unit 1748 passed/23 skipped, agent security review fixed, all 28 browser journeys passed).
  NOT merged. Docs: `docs/p3-accounts-onboarding-implementation-2026-10-22.md`, PLAN P3 result.
- P3 open items (owner decisions 2026-10-22): operator invitations deferred to a follow-up (new account-creation
  surface; needs its own tests-first work and security review; super admins still create operators with a chosen
  password). Real mail delivery check NOT RUN (no email-delivery-ready claim); needs SMTP sender settings.

## Next action
1. Owner: approve merging `p3-onboarding` (merge commit, then CI on the exact head); decide when to run the real mail check.
2. After merge: decide the next package (operator invitations follow-up, R2/R4, or the real mail check).

## Retained resources (do not delete without approval)
- Test/acceptance DBs: ziyrak_test_p2_*, ziyrak_acceptance_p2_*, ziyrak_test_p3_20261022, ziyrak_acceptance_p3_20261022[b-f], ziyrak_test_p2_baseline_d.
- Worktrees under /Users/sukhrob/.codex/worktrees/ (p2-managed-ai, p3-onboarding, token-diet and older finished branches).

## Prohibited without approval
Push/merge/deploy/tag, starting another package, deleting DBs or worktrees, touching live port 7700 or the live worker checkout.
