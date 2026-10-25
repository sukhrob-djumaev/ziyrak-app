# Developer and operator setup

Source-checked 2026-10-25; not a deployment rehearsal. This supersedes the historical wiki install/setup instructions. Read [PLAN](../../PLAN.md), [AGENTS](../../AGENTS.md) and the [launch roadmap](../launch-roadmap-2026-10-25.md) before implementation. The October 25 [review](../project-review-2026-10-25.md) records open deployment/test-harness defects.

## Isolated local setup

CI currently uses Node 22, PostgreSQL 16 and Redis 7. Use the lockfile with `npm ci`, not an unreviewed dependency upgrade. Next.js is pinned to 16.4.3; read relevant installed guides under `node_modules/next/dist/docs/` before changing Next code. Do not install/build in a checkout serving a worker. On this host, main may serve one; use an isolated checkout and distinct ports/dependencies.

Create a disposable local development database and a separate disposable test database. Do not target an existing user, acceptance or production DB. Set **DATABASE_URL and DIRECT_DATABASE_URL together** and verify both name the intended database; DIRECT may bypass a pooler but must not select another environment. Migrations/pg-boss can use DIRECT. Current scripts do not yet enforce all these safeguards; L1.1 must fix that before broad cleanup/load tests.

Copy `.env.example` into an ignored local environment file and configure the local DB pair, independent JWT/encryption keys and correct app URL. Do not copy production secrets. Once the target is verified, the local preparation commands are:

```sh
npm ci
npx prisma generate
npx prisma migrate deploy
```

`migrate deploy` applies existing migrations; schema development/migration creation is a separate reviewed step. Do not use `db:push`, reset or test cleanup as a shortcut against valuable data. In two terminals with the same intended runtime configuration, run `npm run dev` and `npm run worker`. The web server alone does not establish durable background processing. For production-build testing in isolation, build then use `npm run start` alongside the separately supervised worker. Select unused ports explicitly.

## Platform configuration

| Boundary | Configuration / proof |
| --- | --- |
| Identity and encryption | Independent `JWT_SECRET`, `SECRET_KEY_V1`; secure backup/access controls. Existing key resolver has a retirement defect (F09): do not remove V1 or assume sparse versions work until repaired/rehearsed. |
| Privileged enrollment/recovery | `PLATFORM_BOOTSTRAP_PROOF_SHA256` and `PLATFORM_RECOVERY_PROOF_SHA256` hold separate SHA-256 hashes of high-entropy owner-held proofs, never raw proofs. Use secured enrollment/recovery, never public signup privileges. |
| Public origin | Correct `NEXT_PUBLIC_APP_URL`; public values are build-time. Verify callback/widget URLs and HTTPS/cookie behavior on the actual built deployment. |
| Account mail | `MAIL_TRANSPORT=smtp`, `PLATFORM_SMTP_HOST`, `PLATFORM_SMTP_PORT`, `PLATFORM_SMTP_FROM` and provider-required USER/PASSWORD. Default port 587; 465 uses implicit TLS. Missing configuration is an error, not sent mail. Verify actual verify/reset/invitation delivery on the chosen sender domain. |
| Local mail tests | `MAIL_TRANSPORT=capture`, optional `MAIL_CAPTURE_FILE`, only in isolated tests/acceptance. Captures contain private one-time links: keep outside Git, restrict access and clean up deliberately. Never production delivery. |
| Managed AI | Configure encrypted credentials/models/policy through the platform AI service console after authorized enrollment; customer Settings is not the managed credential path. OPENAI/ANTHROPIC env examples are test tools, not runtime tenant configuration. |
| Meta | Platform `META_WEBHOOK_VERIFY_TOKEN`; each connection owns encrypted phone number/token/business account/App Secret. Verify the configured Graph version against current Meta support before deployment. Real recipient-visible delivery is separate from API acceptance. |
| Shared infrastructure | `REDIS_URL` for shared adapters across replicas, direct DB access for jobs/migrations, private networks and explicit connection capacity. Rehearse Redis outage and rate-limit/realtime behavior; don't assume process-local fallback preserves distributed guarantees. |
| Edge and worker | Configure trusted proxy hop/header behavior for the actual topology; bound request sizes/timeouts, supervise web/worker separately, verify readiness/heartbeat/queue alarms. Current `/api/health` 200 alone is insufficient. |

Helm/Compose/Docker files exist but have open findings F04–F06/F11–F12. Do not treat their defaults or current `existingSecret` option as a complete managed-service production recipe. L2 must reconcile config and image/probe behavior and rehearse the selected topology.

## Verification

Read actual scripts and CI before each run. Select checks by changed boundary; use explicit disposable DB URLs for anything that imports test setup. Repository/isolation tests use real PostgreSQL. Redis and provider suites have distinct prerequisites; skip is not pass.

```sh
npx vitest run <test-paths>
npm run test
npm run test:signup-seeded
npx tsc --noEmit
npm run lint -- --max-warnings 0
npm run build
```

These are command references, not a safe copy/paste cleanup sequence. Full tests require prepared isolated infrastructure. CI runs tests with Redis contract coverage and again with Redis-backed adapters selected. `test:coverage` exists but its coverage provider is not installed in the current manifest; it is not a verified coverage workflow. Test count is not a coverage/adequacy claim.

The browser orchestrator is `scripts/acceptance/run-all.sh`; inspect it and its setup scripts before running. It currently schedules 30 browser scripts, with dependency order. Stand-in AI and captured mail prove local workflows, not provider delivery or model quality. J01 uses controlled legacy-BYOK fixtures after signup; J27/J28/J30 cover managed behavior. J13 still uses API/SQL where approval/policy UI now exists; L3 must close that acceptance gap. `test:smoke:meta`, `test:smoke:anthropic`, `test:smoke:openai-embedding` and `test:eval:r2` are separate credential-gated suites; the AI scorer currently needs F07 repair. Never run the old loadtest script unchanged (F08).

## Release operations still to establish

L2/L6 require a tested immutable image/digest, least necessary runtime dependencies, migration/rollback strategy, DB restore drill, truthful readiness and worker monitoring, stable callbacks, real sender verification, capacity measurement, customer retention/export/deletion policy and incident/support owner. L4/L5 add the commercial catalog and payment lifecycle. No live deployment, email/provider account change, secret rotation or paid transaction is implied by this guide. Preserve protected port 7700 and the host's live worker/tunnel; use exact owned-process identity, never name-based process killing.
