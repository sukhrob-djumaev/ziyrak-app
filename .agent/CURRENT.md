# Current task

Updated: 2026-10-13 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** 9 — Enterprise Infrastructure Overrides (§46.9), authorized by the owner on 2026-10-13 and built **synthetically** (no customer; throwaway databases only). Phases 0–8 are complete and tagged (`phase-0-complete` … `phase-8-complete`; the latter pushed).
- **Objective:** Policy + provider allowlists, dedicated database provisioning/verified migration/routing, identity-bound RLS, operator CLI (`npm run infra`). Implementation record, deviations, review and limits: `PLAN.md` §46.9 "Implementation record (Phase 9)". **Task 3 (dedicated `StorageProfile`) deliberately deferred**: `ObjectStorage` has no implementation to override.
- **Branch / baseline:** `claude/phase9-enterprise-overrides` — PR #8 (draft until the owner is ready to merge). Latest `0781590` (review fixes); CI green on it. `main` includes the worker heartbeat (PR #7) and the CI test-timing fix (PR #9).

## Status

- Verification (2026-10-13, against `owly_test`): `tsc`, lint clean; `npm run test` 1035 passed / 23 skipped; `npm run test:signup-seeded` 600 passed. Independent read-only security review done; confirmed findings fixed (see PLAN record).
- Not run: a real customer migration, a live dedicated database outside the test server, a real Kubernetes cluster, Meta smoke suites.

## Next actions

1. Owner merges PR #8 (mark ready first) — not before reading the PLAN record's known limits (no write freeze: quiesce a business for before and ~1 min after `migrate`).
2. Apply migration `20261013140000_phase9_infrastructure_policy` to the live `owly` database before deploying Phase 9 code (live DB is untouched so far).
3. Phase 10 does not exist; further enterprise work (dedicated storage, region deployment) only against a real requirement.

## Environment notes

- Live stack on `main` code (built 2026-10-13): worker as launchd service `com.ziyrak.meta.worker` (not persistent across reboot); web started by the owner on `127.0.0.1:3000` in a prompt session. **Port 7700 and its cloudflared tunnel belong to the owner's remote-control service — never use or touch them.** No tunnel points at port 3000, so Meta cannot reach the web app. A dead `com.ziyrak.meta.web` launchd job may remain loaded (it failed with EADDRINUSE on 7700).
- Tests must use `DATABASE_URL=…/owly_test` — `.env` points at the live `owly` database. Docker Desktop and `owly-db-1` are running. Test Redis container was removed.

## Prohibited

Pushing/merging/deploying without the owner's say-so, merging without checking CI first, changing product architecture without the rule 11 decision, touching Business A's or B's Meta connections, using port 7700.
