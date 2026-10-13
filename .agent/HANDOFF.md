# Latest session handoff

Session: 2026-10-13 (Asia/Kuala_Lumpur) — Phase 8 close-out, worker-stall fix, Phase 9 (synthetic).

## Changes

- PR #5/#6 (Phase 8 + state) and PR #7 (30 s pg-boss heartbeat on `process-inbound-message`, applied to existing queues via `updateQueue`; SIGKILL child-worker test) merged to `main`. `phase-8-complete` pushed.
- PR #9: CI on `main` went red after #7 (cross-conversation concurrency test gave B1 only 500 ms vs pg-boss's 2 s poll interval; passed locally, failed 3× in CI). Test now holds A1 for 3.5 s and prints a timeline on failure; CI green. Root cause treated as timing, not proven; watch `main` runs. **I merged #7 without checking CI — always check first.**
- PR #8 (draft): Phase 9 — `InfrastructurePolicy` + allowlists, dedicated DB (`dedicated-database.ts`), `dedicated:<profile>` placement, identity-bound RLS, `scripts/infra.ts`, `PLAN.md` §46.9 record.

## Findings

- `Membership`, `ApiKey`, `ChannelConnection` are control-plane (§7.4) but were tenant-scoped; `getScopedPrisma` now serves them from the shared connection for dedicated tenants (`CONTROL_PLANE_RESIDENT_MODELS`). Found in part by me (Membership), the rest by the independent review.
- Independent review fixes: per-business row locks in cutover, allowlist on `/api/knowledge/test`, profile-secret changes reach running processes, RLS refuses mismatched business/profile/database, `REVOKE CREATE`, error redaction, CLI provider validation. Dedicated `StorageProfile` deferred (no `ObjectStorage` implementation exists).
- A red-phase test once ran `enableRowLevelSecurity` against `owly_test` (guard didn't exist yet); cleaned up (policies, roles). The live `owly` DB was never touched.

## Verification

`tsc`, lint clean; `npm run test` 1035 / 23 skipped; `test:signup-seeded` 600; CI green on PR #8 at `0781590`. Real-Postgres tests only against `owly_test` and throwaway databases.

## Continuation point

PR #8 awaits the owner (merge, then apply the Phase 9 migration to the live DB before deploying). Live Meta reachability needs a tunnel to port 3000 (owner's call; port 7700 is the remote-control service). Nothing else is waiting on the owner.
