# Latest handoff — L1.1-L1.3 merged, 2026-10-26

- Merged: L1.1 (#36), L1.2 (#37), L1.3 (#38). Each had exact-head CI green; L1.2 and L1.3 also a 30/30 combined-build browser run (on the exact head, AC power).
- L1.3 delivered: atomic reset, key discovery/rotation, log redaction, same-origin JSON policy (cookie writes + /api/auth), signup ceilings, platform TOTP MFA (optional by default) with super-admin setup code (owner decision A), audited reset.
- Harness lessons: run on AC power; J19 single-use per DB and needs REDIS_URL; J20 needs synthetic platform proofs (ACC_PLATFORM_* and the SHA256 hashes in web/worker env) from the start; system Chrome via CHROMIUM_PATH.
- Local full test runs are slow/flaky while the Mac sleeps; GitHub CI is the verifier. Always use the isolated Postgres on 55433, never the default env.
- Do next: L1.4 deterministic scorer regressions (real-model eval may block on credentials), then L2.1 runtime/readiness contract (TRUSTED_PROXY_HOPS, health, worker heartbeat, Helm).
