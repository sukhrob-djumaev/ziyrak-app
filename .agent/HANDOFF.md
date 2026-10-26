# Latest handoff — L1.1-L1.4 (deterministic) and L2.1 merged, 2026-10-26

- Merged: L1.1 #36, L1.2 #37, L1.3 #38, L1.4 #49 (test/doc only), L2.1 #50. Each had exact-head CI green; L1.2, L1.3, L2.1 also 30/30 combined-build browser runs on a build of the exact head (AC power).
- L2.1: `/api/health/live` vs `/ready` (DB-gated only), worker heartbeat table+file, queue age/failure signals and build identity behind HEALTH_DETAIL_TOKEN, production startup contract (`npm run config:check`), Helm chart renders the contract (tested with real helm via Docker; CI runners have helm), Compose worker healthcheck.
- Blocked/open: L1.4 real-model evaluation + human review (no OPENAI_API_KEY here); MFA stays optional until an enrollment UI + journey exist (then `ZIYRAK_PLATFORM_MFA=required`); live DB/Redis outage drill; cluster probe behaviour.
- Harness lessons: do NOT commit in a worktree while its browser run is going (build identity goes stale); J19 single-use per DB and needs REDIS_URL; J20 needs the synthetic platform proofs (ACC_PLATFORM_* and the SHA256 hashes in web/worker env) from the start; run on AC power.
- Do next: L2.2 (immutable image promotion, migration/rollback compatibility, restore drill, retention, alerts, capacity), then L3.1 dashboard/access coherence.
