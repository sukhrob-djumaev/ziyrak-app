# Ziyrak AI

Ziyrak is a multi-tenant customer-support application. Businesses create private workspaces, add knowledge and supported channels, and use AI managed by Ziyrak. A separate worker processes inbound messages, knowledge indexing and scheduled actions. The platform console, scoped workspace access, managed AI/allowances, verified accounts, recovery and invitations are implemented.

**Current status: launch preparation, not ready for unrestricted paid production.** Checkout, subscriptions and configurable paid add-ons are not implemented. The owner has requested a refreshed self-service launch plan: register, verify, choose a package, pay, configure and start work. [PLAN](PLAN.md) owns the live board; the [October 25 review](docs/project-review-2026-10-25.md) records open security, test-quality and operational findings.

Web Chat and Meta WhatsApp Cloud are the current channel priorities. Email/Phone cards do not establish production delivery support; WhatsApp Web QR is demo-only. New channels and broader enterprise work remain deferred.

## Current roadmap and guides

- [Launch roadmap and release gates](docs/launch-roadmap-2026-10-25.md): L0 documentation reset; next is L1.1 safe verification harness, then safety, operations, dashboard/access, catalog and sandbox payments, release rehearsal and a separately authorized paid pilot.
- [Flexible billing and entitlements](docs/billing-and-entitlements-spec.md): target contract for no-code packaging/prices of implemented capabilities; not shipped functionality or a final price list.
- [Dashboard and role review](docs/dashboard-and-access-review-2026-10-25.md): permission-aware navigation, clear account/workspace settings and honest feature readiness.
- [Current customer guide](docs/guides/customer-workspace.md) and [developer/operator setup](docs/guides/operator-setup.md).
- [Documentation index](docs/README.md), [security policy](SECURITY.md), [contributing](CONTRIBUTING.md).

Historical tags and test runs remain evidence for their own builds, not new release acceptance. The October 25 review ran an isolated lockfile install, Prisma generation, typecheck, lint and 53 focused tests successfully; the build was environment-blocked and the full DB/browser/provider suite was not rerun. Historical R5 recorded 30 browser scripts and 1812 passed tests/1 skipped. See the review for exact boundaries.

## Local development

Use an isolated checkout and separate disposable development/test databases. CI uses Node 22, PostgreSQL 16 and Redis 7. Never install dependencies or rebuild underneath a running worker. [package.json](package.json), the lockfile and [CI](.github/workflows/ci.yml) define actual versions and commands.

Follow the [setup guide](docs/guides/operator-setup.md): copy [.env.example](.env.example) into an ignored local file without overwriting existing configuration; set both DB URLs to the intended target, independent JWT/encryption keys and the local app URL. Configure platform mail for account flows and managed AI through the secured platform console. Customers do not supply AI provider keys. After verifying the isolated DB target, use `npm ci`, `npx prisma generate` and `npx prisma migrate deploy`. Start `npm run dev` and `npm run worker` separately with consistent configuration and available ports.

Do not use a valuable database for test cleanup. L1.1 addresses currently unsafe test/load assumptions. Choose checks from the [verification policy](PLAN.md#verification-selection-and-external-blockers); commands include focused `npx vitest run <test-paths>`, `npm run test`, `npm run test:signup-seeded`, `npx tsc --noEmit`, `npm run lint -- --max-warnings 0` and `npm run build`. Repository/isolation tests need real isolated Postgres. Redis/provider suites have separate prerequisites; skipped is not passed.

For browser acceptance, inspect [run-all.sh](scripts/acceptance/run-all.sh), [start-all.sh](scripts/acceptance/start-all.sh) and [runtime.cjs](scripts/acceptance/runtime.cjs) before execution. The current runner schedules 30 scripts; real Meta J16 is separate. Use an isolated identified build, fresh acceptance DB, explicit paired `ACC_DB`/`DATABASE_URL`/`DIRECT_DATABASE_URL`, and a fresh absolute `ACC_WORK_DIR`. `ACC_PSQL` is unsupported. Use a trusted browser executable if the verified cache is absent; automatic browser downloads are disabled. Keep ordinary cleanup tests off the acceptance DB. Stand-in AI/captured mail do not prove real model quality or delivered messages.

## Continue development

The owner explicitly approved launch preparation through L6. Say **`continue`** or **`continue current Ziyrak task`** in this repository; use the [start/resume guide](docs/guides/agent-continuation.md) for either client. [AGENTS](AGENTS.md) and [CLAUDE](CLAUDE.md) route to PLAN, [CURRENT](.agent/CURRENT.md) and [HANDOFF](.agent/HANDOFF.md). Resume the first eligible launch-preparation task, currently **L1.1**, without restarting old phases. Commercial decisions and external-action boundaries remain explicit; this is not permission to deploy or charge customers.

## Deployment and provenance

[Compose](docker-compose.yml) and [Helm](helm/ziyrak) describe deployment topology but have open configuration, readiness and image-verification findings. The launch roadmap requires a rehearsal with real web/worker behavior, sender/callback setup, backups/restore, rollback, alerts and required provider acceptance. A health 200 or historical tag is insufficient.

Naming is documented in [branding notes](docs/branding-compat.md). Historical wiki material is archived; its old URLs now point to current guides. The license is in [LICENSE](LICENSE).
