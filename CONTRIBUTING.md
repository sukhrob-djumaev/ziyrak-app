# Contributing to Ziyrak

Current repository: [sukhrob-djumaev/ziyrak-app](https://github.com/sukhrob-djumaev/ziyrak-app). See [LICENSE](LICENSE) for the license terms. Report security issues according to [SECURITY](SECURITY.md), not a public issue containing exploit details or secrets.

Read [AGENTS](AGENTS.md), the selected task in [PLAN](PLAN.md), [CURRENT](.agent/CURRENT.md) and [HANDOFF](.agent/HANDOFF.md). The current roadmap is [self-service launch preparation](docs/launch-roadmap-2026-10-25.md). Archived phases and wiki pages are not current implementation instructions.

## Develop and verify safely

Use the [developer/operator guide](docs/guides/operator-setup.md) for the single maintained setup procedure. Use Node 22 and `npm ci`; web and worker are separate processes. Dependencies/builds must be isolated from any live worker. Pair and verify `DATABASE_URL`/`DIRECT_DATABASE_URL` for a disposable target before migrations or tests. Repository/tenant tests use real Postgres; the current test/load harness has open safety work, so do not run its broad cleanup against a valuable DB.

Before code, state the module's contract, dependencies, exact acceptance criteria and verification path. Tenant/security/contract regressions require a failing test first. Read relevant Next.js guides in `node_modules/next/dist/docs/` before changing Next code. Keep provider-specific code behind adapters and tenant access behind scoped repositories. Source locations include `src/lib/observability/logger.ts`, `src/lib/observability/errors.ts`, `src/lib/customers/customer-resolver.ts` and `src/lib/integrations/webhook-delivery.ts`; do not copy obsolete wiki paths.

Run focused tests, typecheck and lint, then the broader DB/Redis/security/browser checks required by the changed boundary. Scripts are in [package.json](package.json) and [CI](.github/workflows/ci.yml); browser orchestration is `scripts/acceptance/run-all.sh`. Provider tests/evaluations are separate credential-gated commands. A skip, compile or earlier build is not acceptance. `test:coverage` exists but its provider dependency is currently absent; do not claim a verified coverage percentage/workflow.

Auth/authz, secrets, webhooks, user-controlled input and billing changes require independent security review when delegation is available. Use real UI for user-facing acceptance and record code/build identity, topology, provider/test layer, outcomes and open criteria. No live mail, provider account change, deployment or charge follows automatically from contributing.

## Submit coherent work

Keep edits scoped, preserve other working-tree changes, and use Conventional Commits. Review status and staged diff before committing. Follow PLAN's exact-head CI/browser merge and phase gates; no unsolicited push/release/tag or history rewrite. Update current docs and small state files when behavior changes. Preserve dated evidence as history rather than rewriting it to imply new results. Future catalog edits should be data changes; new capabilities still require contracts, enforcement and tests.
