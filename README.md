# Ziyrak AI

Ziyrak is a multi-tenant customer-support application developed from Owly. Its approved
product direction is a managed AI service: businesses create private workspaces,
configure their knowledge and channels, and use AI managed by Ziyrak. A separate
worker handles queued inbound messages, knowledge indexing and scheduled actions.

The target access model separates a platform super admin, Ziyrak operators assigned
to specific workspaces, and each customer's owner/admin/team roles. Customers will
not configure AI provider keys or raw models. These additions are planned; the
current implementation and remaining work are distinguished below.

Built with Next.js, TypeScript, PostgreSQL, Prisma and pg-boss; Redis supports shared
rate limiting, cache and realtime across replicas. See [package.json](package.json)
and [CI](.github/workflows/ci.yml) for the actual versions and checks.

## Current status

The core tenant, conversation, knowledge, channel and worker foundations are
implemented. **Managed-service readiness is the active milestone**, combining quality
recovery with the approved accounts, access and managed-AI additions. Existing signup
creates a private business and owner; it still asks for AI configuration. The platform
console, channel-scoped users, verified account lifecycle and managed usage caps are
upcoming. Implementation is not a blanket production-readiness claim.

**One live roadmap:** [finished foundations and upcoming work](PLAN.md#live-plan--finished-foundations-and-upcoming-work).
It owns task order, implementation status and verification limits. See also the
[approved product direction](PLAN.md#approved-product-direction--managed-service)
and each task's acceptance criteria. Phone and additional enterprise capabilities
remain outside this milestone; current channel priorities are Web Chat and Meta WhatsApp.

Evidence: [October 14 review](docs/status-review-2026-10-14.md) and
[implementation history](docs/implementation-history.md). These are dated records;
recheck changed code, provider state and deployment before relying on old results.

## Continue development with Codex or Claude

Open this repository and say **`continue`** or **`continue current Ziyrak task`**.

Both agents follow [AGENTS.md](AGENTS.md); [CLAUDE.md](CLAUDE.md) imports it.
The agent reads the approved plan, [current task](.agent/CURRENT.md) and
[latest handoff](.agent/HANDOFF.md), checks Git, and resumes the first eligible
unfinished task in the live board order. It records verification and the next action
before stopping.
A completed task permits the next task within the authorized milestone; a new
phase, architecture change or external action still follows its approval boundary.

Do not copy old chat transcripts into prompts or treat historical phase tags as
proof that current acceptance passed. Product contracts stay in the plan; state
files contain only operational status and continuation information.

## Local setup

Use Node.js 22 (the CI version), npm, and PostgreSQL 16 or newer. Redis is needed
for the Redis-selected checks and shared multi-replica behavior. Use a separate
checkout/worktree and databases for development and testing when another checkout
is serving a live worker. Never replace its dependencies or build underneath it.

For a **new isolated checkout**, install and configure:

```sh
npm ci
cp .env.example .env
```

Edit `.env` before running anything. The template's database is named `owly`;
replace it with a database provisioned for this development checkout. Set
`JWT_SECRET` and `SECRET_KEY_V1` to separately generated strong random values,
and set `NEXT_PUBLIC_APP_URL` to this checkout's available web URL. Do not overwrite
an existing `.env`, publish secrets, or copy live credentials into test fixtures.
See [.env.example](.env.example) for all settings. If `DIRECT_DATABASE_URL` is set,
it must refer to the same intended database: migrations and pg-boss may use it.

After checking the database target, apply the existing migrations:

```sh
npx prisma generate
npx prisma migrate deploy
```

Start web and worker in separate terminals, with the same isolated database and
secret configuration. Example for an available port 3001 and
`NEXT_PUBLIC_APP_URL=http://localhost:3001`:

```sh
npm run dev -- --port 3001
```

```sh
npm run worker
```

**Current implementation:** use the signup UI to create a business, then configure
its AI provider/key, knowledge and channel through the application. Provider
credentials are stored per business; `.env` AI keys are primarily for test/load
tooling, not a substitute for business configuration. Seeding the legacy Default
Business is not required for signup acceptance. P2/P3 replace this customer AI setup
with platform-managed service provisioning; update these instructions when that
behavior is implemented and verified, not before.

For production-equivalent local verification, build and start the web process
with the intended `NEXT_PUBLIC_APP_URL`; keep the worker separate:

```sh
npm run build
npm run start -- --port 3001
```

Public `NEXT_PUBLIC_*` values are embedded at build time. A successful health
response does not establish worker processing or customer-visible delivery.

## Testing

Choose checks according to the [verification policy](PLAN.md#verification-selection-and-external-blockers).
Routine development uses deterministic mocks, real isolated persistence where
needed, and Web Chat/browser flows. Real-provider checks are separate and targeted.

Before database-backed commands, point **both** database variables at an existing,
disposable test database. This example matches CI's local test credentials:

```sh
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/owly_test?schema=public'
export DIRECT_DATABASE_URL="$DATABASE_URL"
npx prisma migrate deploy
npx vitest run tests/unit/meta-whatsapp-adapter.test.ts
npm run test
npm run test:signup-seeded
npx tsc --noEmit
npm run lint -- --max-warnings 0
npm run build
```

The tests write and delete data. Never run them against the live database or an
acceptance database whose evidence must be retained. Check shell/environment-file
overrides before starting. For the Redis-selected run, use a separate test Redis
with `REDIS_URL`; CI also uses `REDIS_TEST_URL` for adapter tests. A skipped check
is not a pass.

### Browser acceptance

Read [start-all.sh](scripts/acceptance/start-all.sh), [run-all.sh](scripts/acceptance/run-all.sh)
and the [journey requirements](PLAN.md#mvp-browser-acceptance-suite) before running.
The harness uses production web on port 3100, a separate worker, a local LLM stand-in
on 4010 and customer sites on 4020–4022. It requires a fresh throwaway acceptance
database, migrations, independent secrets and a build with
`NEXT_PUBLIC_APP_URL=http://localhost:3100`.

Set `ACC_DB`, `DATABASE_URL` and `DIRECT_DATABASE_URL` to that same acceptance
DB in the isolated acceptance shell; keep unit/repository test runs separate.
Set `ACC_WORK_DIR` to a fresh evidence directory. If the DB is not the compose
Postgres, configure `ACC_PSQL` for the same isolated DB; the harness's SQL helper
does not infer every connection topology from `ACC_DB`. Then build and start:

```sh
NEXT_PUBLIC_APP_URL=http://localhost:3100 npm run build
scripts/acceptance/start-all.sh all
scripts/acceptance/run-all.sh
```

The runner supplies the dependency order for all 16 scripts; live Meta J16 is
separate. J09/J10 currently needs a fresh database per complete run. Record only
and stop only this run's PIDs; never use process-name kills. One browser window per
role avoids background-tab throttling. New fixes must be verified on the resulting
candidate; passing an earlier build is not sufficient.

`ACC_REAL_AI=1` plus the script's documented provider/model/key variables selects
real-model acceptance. Inspect journey assumptions before choosing targeted cases;
a stand-in assertion is not automatically a valid real-model quality evaluation.

### Live providers

Available credential-gated suites:

- `npm run test:smoke:meta`
- `npm run test:smoke:anthropic`
- `npm run test:smoke:openai-embedding`

Read each suite and its environment requirements before using authorized test
accounts/recipients and an isolated database. Default CI excludes these suites.
The Meta smoke checks credential ownership and Graph acceptance; it does **not**
prove real inbound receipt or recipient-visible delivery. The plan defines when
those additional observations are required. Never send test messages to arbitrary
customers or change working account connections to unblock unrelated work.

A provider/account blocker leaves its required acceptance item open. Record the
cause and next action, then continue independent work in the approved milestone.
Do not keep repeating the same failing setup or mark a mock run as live acceptance.

## Deployment and operations

[docker-compose.yml](docker-compose.yml) and [helm/owly](helm/owly) describe web,
worker, Postgres/connection pooling and Redis topology. Their presence is not proof
of deployment readiness; review environment, secrets, database targets and public
URL before use. Package, image and chart names retain some upstream `owly` naming.

Merges require checking CI for the exact commit. Deployment/restarts/migrations
follow the plan and applicable owner authorization, including backup/restore
requirements. Record the running build, verify web and worker separately, and
exercise the relevant visible workflow. Never use a live environment for destructive
test cleanup. Host-specific process details and protected ports are in CURRENT.

## Documentation and license

- [Architecture, live product plan and acceptance criteria](PLAN.md)
- [Agent workflow](AGENTS.md), [current task](.agent/CURRENT.md), [handoff](.agent/HANDOFF.md)
- [Status review](docs/status-review-2026-10-14.md), [historical implementation evidence](docs/implementation-history.md)
- [Approvals and tool policies](docs/wiki/Approvals-and-Tool-Policies.md)
- [Wiki](docs/wiki/Home.md): some pages describe upstream Owly and need rechecking against current source and PLAN.

Derived from Owly. MIT attribution and terms remain in [LICENSE](LICENSE).
