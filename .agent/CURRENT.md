# Current task

Updated: 2026-10-11 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** 8 — Scalability and Shared Infrastructure (§46.8), authorized by the owner on 2026-10-11 ("lets proceed"). Phase 7 closed earlier (`phase-7-complete`, local only).
- **Objective:** Redis rate limit/cache/`RealtimeBus`, PgBouncer, multi-replica validation, HPA, placement cache. Implemented and verified; pending the phase-completion decision (see Next actions).
- **Branch / code baseline:** `claude/phase8-redis-scalability` (from `claude/phase7-openai-acceptance` @ `0ff11cb`); commits `24a8b6e` (adapters), `594635a` (compose/Helm/load test), plus the record/review commit. Recheck Git at every resume.

## Status

- Implementation record, evidence and known limits are in `PLAN.md` §46.8 "Implementation record (Phase 8)". Acceptance criteria met: rate limit aggregated across replicas, ordering with competing workers (in-process and multi-process), full suite unchanged with Redis selected (1017 pass), HPA enabled on load-test evidence (rendered/linted; no cluster here).
- Load test: `scripts/loadtest/run.sh [redis|no-redis|both|up|down]` (needs Docker, image `owly:local`, ports 3201/3202/55432/4010). 8/8 expectations in both modes on 2026-10-11.
- Independent security review of the Phase 8 diff: see HANDOFF for result and what was fixed.

## Next actions

1. Owner decides whether Phase 8 is complete and should be tagged `phase-8-complete` (nothing tagged yet), and whether to push/merge anything (nothing pushed).
2. Optional: decide on bounding the stall when a worker dies without draining (heartbeat / shorter `expireInSeconds`) — changes retry semantics, so not done.
3. Phase 9 only with explicit authorization.

## Environment notes

- Live Meta stack unchanged this session: web :3100 / worker / tunnel run under launchd from the earlier build (`.next` was NOT rebuilt locally; Phase 8 was built only inside Docker). Restarting or rebuilding it picks up the Redis-aware code; with `REDIS_URL` unset behavior is unchanged.
- Test Redis container `owly-redis-test` on :6390 (`REDIS_TEST_URL`/`REDIS_URL=redis://localhost:6390`); remove with `docker rm -f owly-redis-test` when done. Live Postgres `owly-db-1` untouched; the load test uses its own compose project `owlyload` (torn down).

## Prohibited

Starting Phase 9, tagging `phase-8-complete` or pushing/merging/deploying without the owner's say-so, changing product architecture without the rule 11 decision, touching Business A's or B's Meta connections.
