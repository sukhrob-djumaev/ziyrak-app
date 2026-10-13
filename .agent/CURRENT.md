# Current task

Updated: 2026-10-13 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** 8 — Scalability and Shared Infrastructure (§46.8), authorized by the owner on 2026-10-11 ("lets proceed"). Phase 7 closed earlier (`phase-7-complete`, local only).
- **Objective:** Redis rate limit/cache/`RealtimeBus`, PgBouncer, multi-replica validation, HPA, placement cache. Complete; `phase-8-complete` tagged on the owner's delegation and pushed 2026-10-13.
- **Branch / code baseline:** `claude/phase8-redis-scalability` (from `claude/phase7-openai-acceptance` @ `0ff11cb`); commits `24a8b6e` (adapters), `594635a` (compose/Helm/load test), `fa564b9` (review fixes + record), `c209a80` (trusted-proxy client IP). Pushed to `origin/claude/phase8-redis-scalability` on 2026-10-11 ; PR #5 merged into `main` on 2026-10-13 (merge commit `944f911`). Recheck Git at every resume.

## Status

- Implementation record, evidence and known limits are in `PLAN.md` §46.8 "Implementation record (Phase 8)". Acceptance criteria met: rate limit aggregated across replicas, ordering with competing workers (in-process and multi-process), full suite unchanged with Redis selected (1017 pass), HPA enabled on load-test evidence (rendered/linted; no cluster here).
- Load test: `scripts/loadtest/run.sh [redis|no-redis|both|up|down]` (needs Docker, image `owly:local`, ports 3201/3202/55432/4010). 8/8 expectations in both modes on 2026-10-11.
- Independent security review of the Phase 8 diff: see HANDOFF for result and what was fixed.

## Next actions

1. Done: PR #5 merged. `phase-8-complete` pushed to origin on 2026-10-13. `gh` is installed and authenticated as `sukhrob-djumaev`.
2. Optional: decide on bounding the stall when a worker dies without draining (heartbeat / shorter `expireInSeconds`) — changes retry semantics, so not done.
3. Phase 9 only with explicit authorization.

## Environment notes

- Live Meta stack restarted on the Phase 8 build on 2026-10-11 (host `npm run build` passed). `com.ziyrak.meta.web` and `.worker` now run as `ProcessType=Interactive` launchd services (plists in the session scratchpad, bootstrapped; not persistent across reboot) running `node` directly; plain `launchctl submit` + `npx`/`npm` jobs took 40s+ to start and hung under this Mac's memory thrash. Tunnel untouched. `REDIS_URL` unset, so behavior is the in-memory default.
- Test Redis container `owly-redis-test` on :6390 (`REDIS_TEST_URL`/`REDIS_URL=redis://localhost:6390`); remove with `docker rm -f owly-redis-test` when done. Live Postgres `owly-db-1` untouched; the load test uses its own compose project `owlyload` (torn down).

## Prohibited

Starting Phase 9, pushing/merging/deploying without the owner's say-so, changing product architecture without the rule 11 decision, touching Business A's or B's Meta connections.
