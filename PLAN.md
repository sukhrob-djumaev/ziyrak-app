# Ziyrak AI — Migration Plan (from Owly)

**Status:** Draft, revised after a second architectural review. No application code has been modified to produce this document. This is planning and documentation only, per the engagement scope.

**Revision note (this pass):** This is a second-pass architectural review of the original plan, performed against the same repository and against 25 specific review concerns (external review, reproduced in intent throughout this document as "the review"). Every concern was evaluated against the actual codebase and the originally-proposed architecture; agreed-with concerns are folded consistently into every affected section — data model, diagrams, contracts, security, testing, and the phase roadmap — not appended as a disconnected addendum. Where a proposed correction was not adopted as literally stated, the reasoning is given inline at the relevant section, and the technically stronger approach is used instead. A consolidated summary of what changed and why is given in §0 immediately below, for a reader who has already read the first version of this plan.

**How to read this document:** Sections 1–44 describe the target architecture and the reasoning behind it, grounded in a source-level inspection of the current repository (not its READMEs). Section 45 lays out the migration roadmap — now **10 phases (0–9)**, down from 11, per §0.11. Sections 46.0–46.9 give one detailed, independently-actionable phase each. The Final Section names the first task to hand to an engineering agent.

Every factual claim about "what the code currently does" in this document was verified against the working tree on 2026-09-14 (including uncommitted changes), not copied from `AUDIT.md`/`ARCHITECTURE.md`. Where this document's findings differ from those two files, the difference is called out explicitly in §2.11. None of the second-pass review concerns required re-verifying the current-state findings in §2 — they are architecture-forward concerns, and §2 is unchanged from the first pass.

---

## 0. Summary of Second-Pass Revisions

This section exists only for a reader comparing against the prior version of this plan. It is not itself part of the architecture — it is an index into what changed and where.

| # | Review concern | Verdict | Where it landed |
|---|---|---|---|
| 1 | Composite tenant-aware FKs as a DB-level isolation layer | **Adopted.** Isolation is now a five-layer stack, with Postgres composite foreign keys as an independent, structural layer between the Prisma extension and application validation. | §8 (rewritten), §12 (data model), §13, §33, Phase 1 (§46.1), Phase 2 (§46.2) |
| 2 | Don't make `TenantContext` invisible everywhere | **Adopted.** Application-service boundaries take `ctx: TenantContext` explicitly; `AsyncLocalStorage` is narrowed to logging/correlation and a defense-in-depth backstop inside the Prisma extension, not the primary plumbing mechanism. | §8.2, §16, §18 |
| 3 | Dedicated-database bootstrap problem | **Adopted.** Introduced an explicit control-plane / data-plane split with a `TenantPlacement` resolution step that always runs against a well-known control-plane connection before any tenant data connection is opened. | §7 (new §7.4–7.6), §11, §28, Phase 1, Phase 9 (§46.9) |
| 4 | Don't store raw infrastructure credentials in tenant policy | **Adopted.** `TenantPlacement`/`InfrastructurePolicy` hold symbolic profile IDs (`databaseProfileId`, `storageProfileId`), never connection strings; real credentials resolve through a platform-controlled `SecretResolver` boundary. | §10, §11, §28, §16 |
| 5 | AI agent authorization ≠ human RBAC | **Adopted.** Introduced an explicit `ExecutionPrincipal` distinction (`ai_agent` / `system_job` alongside `user` / `api_key` / `channel_credential` / `platform_admin`) and a per-tenant `ToolPolicy` model, decoupling what the AI may invoke from what a human role may invoke. | §9 (new §9.5), §15, §23 (rewritten), §24 |
| 6 | Separate durable domain events from ephemeral realtime notifications | **Adopted.** Renamed the pub/sub abstraction `RealtimeBus` and documented explicitly that it is best-effort/ephemeral; durable business-event handling runs through Postgres persistence + the job queue, never through pub/sub as the reliability mechanism. | §17, §26 (rewritten), diagrams in §5 |
| 7 | Durable inbound-event deduplication | **Adopted.** New `InboundEventReceipt` model with a `(businessId, source, externalEventId)` uniqueness constraint; documented fallback for providers without stable event IDs. Treated as a correctness requirement for production channels, not an optimization. | §17, §19, §31, §12, Phase 5 (§46.5), tests in §33 |
| 8 | Webhooks should acknowledge quickly; same service, sync or async | **Adopted.** Inbound webhook flow revised to verify → resolve → dedupe → persist → enqueue → ack; `processInboundMessage(ctx, event)` is invoked either synchronously (internal chat API, tests) or from a job handler (real channels), never architecturally forced one way. | §5.3, §18, §19, Phase 5/Phase 7 (§46.5/§46.7) |
| 9 | Conversation ordering / concurrency across workers | **Adopted.** Per-conversation serialization via a pg-boss singleton key (`businessId:conversationId`), with an advisory-lock fallback documented; different conversations remain fully concurrent. | §25 (new §25.5), Phase 6 (§46.6) |
| 10 | Idempotency key should identify an attempt, not "similar inputs" | **Adopted.** `ActionExecution.idempotencyKey` is now derived from `(businessId, correlationId, toolCallId)` or an explicit client-supplied key for API-triggered actions — never a hash of arguments. | §24.4 (rewritten), §31.2 |
| 11 | Don't claim `scheduled` before a real queue exists | **Adopted.** The original Phase 6 (tools/actions) and Phase 7 (job queue) are merged into one phase — §46.6 — sequenced internally as separate PRs, with async tools simply not exposed to the AI until the queue half lands within that same phase. This drops the phase count from 11 to 10. | §45 (renumbered), §46.6 |
| 12 | pg-boss as shared platform infrastructure, even with dedicated-DB tenants | **Adopted, clarified.** The job queue is explicitly platform/control-plane infrastructure; a job resolves its tenant's data placement the same way a request does, rather than needing one queue per tenant database. | §25.1, §25.6, Phase 9 (§46.9) |
| 13 | Embeddings need their own provider boundary | **Adopted.** Split `EmbeddingProvider` out from `AIProvider` (generation); `OpenAIEmbeddingProvider` is the only implementation for now, but knowledge retrieval never hardcodes OpenAI directly. | §21 (new §21.5), §22 |
| 14 | Support multiple connections of the same channel type | **Adopted.** Replaced the one-row-per-type `Channel` model with `ChannelConnection` (many per business per type, e.g. "WhatsApp Sales" / "WhatsApp Support"). | §12, §19, §20, Phase 1, Phase 5 |
| 15 | API keys must not be recoverable plaintext | **Adopted.** `ApiKey` stores `keyPrefix` + `keyHash` only; the full secret is shown once at creation and never again. | §9.4 (rewritten), §12, §32 |
| 16 | Credential encryption must be rotation-ready | **Adopted.** `ChannelCredential`/profile secrets carry `keyVersion` + envelope metadata; typed per-provider credential schemas (Zod discriminated union) replace "trust arbitrary encrypted JSON." | §10.3 (rewritten), §16.5 |
| 17 | Correct the migration-rollback language | **Adopted.** Removed language implying `prisma migrate resolve` is a data-safe downgrade path; rollback strategy is explicitly backup+restore, rehearsed against staging, with forward-compensating migrations where applicable. | §13.3 (rewritten) |
| 18 | Phase 1 must not be presented as externally multi-tenant-safe | **Adopted, stated strongly.** Explicit statement in the executive summary, §45, and Phase 1/2 acceptance criteria that Phase 1 alone must never be exposed to real external multi-business onboarding; Phases 1 and 2 ship to any externally-reachable environment together. | §1 (risk table), §45, §46.1, §46.2 |
| 19 | SSRF protection needs to cover DNS/redirects/IPv6, not literal IP strings | **Adopted.** Shared outbound HTTP dispatcher resolves DNS itself and validates the *resolved* address (not just the input string) before connecting, rejects redirects to disallowed targets, and covers IPv6 private/link-local ranges and cloud metadata endpoints. | §32 (rewritten), Phase 6 (§46.6) |
| 20 | Add specific mandatory test cases | **Adopted.** All seven named cases (duplicate webhook, concurrent messages, DB-level composite-FK rejection, raw-Prisma-escape lint failure, API-key-hash irrecoverability, worker-retry-exactly-once, SSRF redirect/DNS) are now explicit entries in §33/§34 and the relevant phases. | §33, §34, §46.1, §46.2, §46.5, §46.6 |
| 21 | Reconsider web chat as an MVP channel | **Adopted.** MVP now ships **Web Chat + Meta WhatsApp**, not WhatsApp alone, with an explicit publishable-widget-token auth model distinct from admin credentials. | §19, §20 (renamed), §44, Phase 5/Phase 7 (§46.5/§46.7) |
| 22 | Don't freeze Phase 3 interfaces prematurely | **Adopted.** Phase 3's scope is now explicitly "module ownership, dependency direction, and minimal contract shape," with exact method signatures finalized in each contract's implementation phase, not upfront. | §46.3 (rewritten) |
| 23 | Whole-document consistency pass | Performed as part of writing this revision — the document was regenerated as a coherent whole rather than patched section-by-section, specifically to satisfy this concern. | This entire document |
| 24 | Preserve what's already approved | Preserved throughout; nothing in §24's list was reopened except where a numbered concern above required a **localized** adjustment to it (e.g., pg-boss is kept, but its role is clarified per #12). | Throughout |

---

## 1. Executive Summary

**Is the current Owly repository a good foundation for Ziyrak?**

Yes, conditionally. Owly already solves several genuinely hard problems well — customer identity resolution across channels (`src/lib/customer-resolver.ts`), webhook delivery with real retry/backoff/HMAC signing (`src/lib/webhook-delivery.ts`), a clean additive RBAC model (`src/lib/rbac.ts`), consistent Zod validation (`src/lib/validations.ts`), and a working (if disconnected) semantic-search implementation (`src/lib/ai/semantic-search.ts`). The Next.js/Prisma/Postgres stack, the channel-per-module layout, and the dashboard-mirrors-API structure are all reasonable starting points. Rewriting these from zero would waste real, working engineering.

However, Owly's foundational assumption — **one running instance = one business** — is incompatible with Ziyrak's core requirement (one platform serving many independent businesses with hard data isolation). This assumption is load-bearing throughout the codebase: a single `Settings` singleton row (`id: "default"`), a single `Admin` table with no tenant concept, a single `Channel` row per channel *type* (not per tenant), API keys that resolve to global admin access, and module-level singleton state for WhatsApp/IMAP sessions. None of this is a surface-level fix; it is the central assumption the rest of the schema and runtime are built on.

**Which major architectural assumptions must change?**

1. **Single-tenant data model → multi-tenant with structural isolation, enforced at three independent layers.** Every business-owned table needs a tenant-owning relationship; the query layer must make it hard to forget the tenant filter; and — per this revision — the database's own foreign-key constraints must make a cross-tenant reference physically impossible to write, not merely application-validated (§8).
2. **Global `Settings` singleton → configuration hierarchy, split from infrastructure placement.** Platform defaults, per-business overrides, and (later) per-business infrastructure overrides — resolved through a control-plane placement lookup, never a raw connection string stored on tenant config (§10–§11).
3. **Admin-only identity → platform/business/membership identity, plus a distinct AI/system execution-principal dimension.** `Admin.role` is currently a free string with no tenant scope at all, and today's model has no way to represent "the AI acted on the customer's behalf" as anything other than a fake employee role (§9).
4. **AI provider "selection" is cosmetic → must become real, and generation must be separated from embeddings.** `engine.ts` never reads `config.provider`; only OpenAI is ever called, regardless of what a business picks in Settings; and knowledge retrieval must not be allowed to hardcode OpenAI embeddings so deeply that a business requiring "no third-party AI" is silently violated (§21, verified in §2.3).
5. **In-memory-everything → shared state where multi-instance operation is required, and ephemeral notification → distinct from durable event handling.** Rate limiting, cache, and realtime pub/sub are all per-process `Map`s today; and the target architecture must not treat Redis Pub/Sub as sufficient for anything a business is relying on actually happening (§2.7, §17, §26, §30).
6. **A pile of orphaned "features" → either wired-in or removed.** Automation rules, the plugin/hook system, the flow-builder runtime, SLA breach detection, and GDPR retention all have full data models, CRUD APIs, and dashboard pages, but **zero runtime callers** — verified directly in §2.4, not merely inherited from `AUDIT.md`.
7. **Ad hoc channel integrations → a real adapter boundary, with fast acknowledgment and deduplication as first-class concerns.** Every channel file (`src/lib/channels/*.ts`) independently duplicates "resolve customer → find/create conversation → call `chat()`"; there is no shared contract, no protection against a provider redelivering the same webhook, and no split between "acknowledge the provider" and "actually process the message" (§19).

**What should remain, largely as-is (behind new seams, not rewritten)?**

- `customer-resolver.ts`'s four-step resolution algorithm — becomes tenant-scoped but the algorithm itself is sound.
- `webhook-delivery.ts`'s retry/backoff/HMAC design — becomes tenant-scoped and moves off `setTimeout` onto the durable job queue, but the delivery logic itself does not need to be redesigned.
- `rbac.ts`'s additive-role model — extended with a tenant-membership dimension and a separate AI-tool-policy dimension, not replaced.
- Zod-based validation, pagination (`pagination.ts`), and the general REST-route-per-resource shape.
- Next.js App Router + Prisma + Postgres as the core stack. Modular monolith, not microservices.
- **pg-boss** as the job-queue technology (confirmed again after review, §25.1) — the review's only note was to clarify its role as shared platform infrastructure, not to reconsider the choice.

**What is the recommended overall migration strategy?**

Incremental, across **10 phases (0 through 9)**, down from the originally-proposed 11 after merging tool/action work with job-queue work (see risk row below and §45): **(0)** stop the bleeding — fix the live authentication bypass and characterize current behavior with tests; **(1)** introduce Business/Tenant, membership, the control-plane/data-plane split, and composite-FK-protected tenant ownership as first-class concepts; **(2)** make authentication/authorization/tenant-context resolution secure-by-default and prove isolation with tests, including database-level bypass attempts; **(3)** carve out stable module boundaries and *minimally-specified* contracts before adding more logic behind them; **(4)** fix the AI/knowledge layer (provider + embedding-provider abstraction, actually wiring semantic search into `chat()`); **(5)** turn channels into real adapters behind a normalized, deduplicated event model with fast webhook acknowledgment, adding Web Chat alongside WhatsApp; **(6)** replace the tool switch-statement with a registry that distinguishes human RBAC from AI tool policy, stand up the durable job queue in the same phase, and make actions genuinely durable — including per-conversation ordering; **(7)** ship the production WhatsApp + Web Chat MVP; **(8)** move shared state to Redis and validate horizontal scaling; **(9)** build the tenant-infrastructure-override seams, including a real dedicated-database bootstrap path, for compliance-driven customers. Full detail in §45–§46.

**What are the highest risks?**

| Risk | Why it matters | Mitigation |
|---|---|---|
| Tenant isolation implemented "by convention" (`where: { businessId }` sprinkled by hand) | This is explicitly what Ziyrak must not do — one missed clause is a cross-tenant data breach | Three independent, structural layers: `AsyncLocalStorage`-backstopped `TenantContext` + Prisma Client Extension + **Postgres composite foreign keys** that make a cross-tenant reference physically unwritable, plus a lint rule banning the raw client in domain code (§8) |
| The live, unauthenticated `/api/chat` and `/api/realtime` bypass (§2.2) | Exploitable *today*, burns AI budget, exposes every conversation's live event stream to anyone | Fixed in Phase 0, before any tenant work begins — see §46.0 |
| **Phase 1 being mistaken for "done" and exposed to real multiple businesses before Phase 2's enforcement lands** | Phase 1 only makes the schema multi-tenant-*shaped*; the raw, unscoped Prisma client is still in use throughout Phase 1 — treating it as externally safe would be the exact "isolation by convention" failure this plan exists to prevent | Stated explicitly and repeatedly (§45, §46.1, §46.2): **no external business may be onboarded until Phase 2 is complete**; Phases 1 and 2 are released to any externally-reachable environment together, even though they remain two separately-reviewable internal milestones |
| Migrating existing single-tenant data without a default tenant | Losing seed/dev/demo data, or leaving orphaned rows with `businessId: null` | Explicit "Default Business" backfill migration with verification queries, backed by a rehearsed backup/restore procedure rather than an assumption that migrations are reversible (§13, §46.1) |
| Treating `whatsapp-web.js` as production-multi-tenant-capable | It is a single global Puppeteer session; it cannot cheaply become "one session per tenant" | Structurally confine it to a `WhatsAppWebAdapter` usable only by a designated dev/demo tenant; Meta Cloud API (plus Web Chat) is the only supported production path (§20) |
| A provider redelivers a webhook and the same customer message triggers the AI twice | Duplicate tickets, duplicate replies, real customer-facing confusion — this is a correctness bug, not an edge case, for any provider-webhook-based channel | `InboundEventReceipt` deduplication is a Phase 5 requirement, not a later optimization (§17, §31, §46.5) |
| An AI-initiated tool call is authorized using a human RBAC role, forcing an awkward fake role for "the AI" or "a customer" | Conflates two genuinely different trust boundaries and makes it impossible to express "AI may create tickets automatically but must ask a human before issuing a refund" | Explicit `ExecutionPrincipal` + tenant-configurable `ToolPolicy`, independent of `Membership`/RBAC (§9.5, §23) |
| Building too much abstraction before there's a second implementation to justify it | Wastes effort, adds indirection with no payoff (explicit anti-goal) | Every abstraction introduced in this plan is justified against a concrete second implementation or a named future requirement — none are "just in case"; Phase 3 specifically avoids freezing exact interface signatures before an implementation exists to validate them (§46.3) |
| Silent "success" from AI-driven actions (`schedule_followup` today reports success without persisting anything — verified §2.3) | Erodes trust in an AI platform that businesses pay for the AI to *act* on their behalf | Durable `ActionExecution` status model; an LLM's own text is never the source of truth for whether something happened — and the plan no longer allows a phase boundary to leave `ActionExecution.status = "scheduled"` sitting in front of a job queue that doesn't exist yet (§24, §46.6) |

---

## 2. Verified Current State

This section is unchanged from the first pass — none of the second-pass review concerns disputed a current-state finding; they are all forward-looking architecture concerns. It is carried forward here for completeness so this document remains self-contained.

This section documents what the application **actually does**, based on direct source inspection of the working tree (including uncommitted changes) on 2026-09-14, not the READMEs or prior audit documents. Where useful, exact file:line references are given.

### 2.1 Stack, as verified from `package.json` / `prisma/schema.prisma` / `next.config.ts`

- Next.js 16.2.2 (App Router), React 19.2.4, TypeScript, Tailwind 4. `next.config.ts` sets `serverExternalPackages: ["whatsapp-web.js", "puppeteer"]` and disables the `X-Powered-By` header — nothing exotic.
- Prisma 7 with the new `PrismaPg` driver adapter (`@prisma/adapter-pg`), generated client output redirected to `src/generated/prisma` (`prisma/schema.prisma:1-8`). One global `PrismaClient` singleton cached on `globalThis` (`src/lib/prisma.ts`) — no per-tenant or pooled-connection logic exists yet.
- 27 Prisma models, **zero** tenant/business/organization concept anywhere in the schema (`prisma/schema.prisma`, full read). `Settings` and `BusinessHours` are singletons keyed by the literal string `"default"`.
- No job queue package in `package.json` (no BullMQ, Agenda, Bull, pg-boss, node-cron, node-schedule). No queue infrastructure in `docker-compose.yml` or the Helm chart.
- `node_modules` is **not installed** in this working tree — `npm ci` has not been run here, so the AGENTS.md instruction to consult `node_modules/next/dist/docs/` before writing Next.js-specific code cannot be followed until dependencies are installed (tracked as a Phase 0 setup task, §46.0).
- Redis is optional everywhere it appears (`src/lib/cache.ts` dynamically imports `redis` only if `REDIS_URL` is set) — it is not a dependency in `package.json` at all, meaning even the "Redis path" in `cache.ts` would fail at runtime today unless a consumer separately installs the `redis` package.
- Helm chart (`helm/owly/templates/hpa.yaml`) defines a `HorizontalPodAutoscaler` gated on `autoscaling.enabled` — **the deployment tooling already advertises horizontal scaling that the runtime cannot currently support safely** (see §2.7). This inconsistency is a concrete artifact of the single-instance assumption not being enforced anywhere; Phase 8 (§46.8, scalability) is what actually earns the HPA.

### 2.2 Security — the authentication bypass is real and still present

`src/middleware.ts:164-166` performs only a **structural** check on the JWT cookie:

```ts
const parts = (token || "").split(".");
if (parts.length !== 3) { /* reject */ }
return addHeaders(NextResponse.next(), requestId, apiRateInfo);
```

It never calls `verifyToken()` (which lives in `src/lib/auth.ts:35-43` and does real `jsonwebtoken.verify`). Real verification only happens inside `requireAuth()` (`src/lib/route-auth.ts:45-114`), which each route handler must remember to call. Verified by direct inspection, the following route handlers **do not call `requireAuth` at all**:

| Route | File | Verified impact |
|---|---|---|
| `POST /api/chat` | `src/app/api/chat/route.ts` | Calls `chat()` directly with attacker-controlled `message`/`conversationId`/`channel`. Any request with a cookie of the form `owly-token=a.b.c` (any garbage — signature is never checked) reaches the full AI agent, including all six tool-calling actions in `src/lib/ai/tools.ts` (create tickets, send internal email via configured SMTP, trigger configured webhooks). |
| `GET /api/realtime` | `src/app/api/realtime/route.ts` | No auth check of any kind — `subscribe(channel, ...)` is called directly off `?channel=` query param. Anyone can open an SSE stream to `global` or any guessed `conversation:<id>` channel and watch live messages. |
| `POST /api/channels/whatsapp` | `src/app/api/channels/whatsapp/route.ts` | `{action:"disconnect"}` kills the WhatsApp session; `{action:"connect"}` can be spammed to churn Puppeteer instances. No auth check. |
| `POST /api/channels/email` | `src/app/api/channels/email/route.ts` | Same pattern for the IMAP listener. No auth check. |
| `POST /api/webhooks/test` | `src/app/api/webhooks/test/route.ts` | Fetches an existing `Webhook.url` with a synthetic payload. No auth check — combined with the fact that `webhook.url` is fully admin-controlled at creation time (not attacker-controlled), this is "authentication bypass" more than "SSRF," but it does let anyone anonymously trigger outbound requests from the server to any URL a legitimate admin previously configured, and read back the response body preview. |

This exactly matches `AUDIT.md §1`'s findings — **confirmed still live in the current working tree**, not fixed by any of the uncommitted changes (which touch `Dockerfile`, `docker-compose.yml`, `whatsapp.ts`, and several dashboard `page.tsx` i18n/UX tweaks — none touch auth). This is addressed as the first task of Phase 0 (§46.0), independent of and before any tenant-model work, because it is exploitable today and cheap to fix.

The large majority of the other ~63 route files (of 68 total) do correctly call `requireAuth(request, permission)` with an explicit `rbac.ts` permission.

### 2.3 AI engine — verified against `src/lib/ai/engine.ts` and `src/lib/ai/tools.ts`

- **Knowledge base is fully dumped into every prompt, unbounded.** `getKnowledgeBase()` (`engine.ts:64-77`) does `prisma.knowledgeEntry.findMany({ where: { isActive: true }, include: { category: true }, orderBy: { priority: "desc" } })` — no `take`, no relevance filter. `chat()` (`engine.ts:124`) calls this on *every* turn and injects the entire result into the system prompt via `buildSystemPrompt()` (`engine.ts:13-62`). Confirmed: cost/latency/context-window risk scales with total KB size on every single message, not just when relevant.
- **`searchKnowledgeBase()` (the working embeddings+cosine-similarity implementation in `semantic-search.ts`) has zero callers outside its own file** — verified by grepping the whole `src/` tree. It is reachable only via the manual debug page `/knowledge/test` → `/api/knowledge/test`. The real chat path never calls it.
- **Multi-provider AI selection is UI-only.** `getAIConfig()` (`engine.ts:79-101`) reads `settings.aiProvider` into `config.provider`, but `callAI()` (`engine.ts:209-280`) never reads `config.provider` anywhere — it unconditionally does `new OpenAI({ apiKey: config.apiKey })` (`engine.ts:219`) and calls OpenAI's chat-completions endpoint. The setup wizard (`src/app/(auth)/setup/page.tsx:21-25`) offers `openai` / `claude` / `ollama` with distinct model lists (verified: `PROVIDER_OPTIONS` array present exactly as described), but picking `claude` or `ollama` silently sends that provider's key/non-key to OpenAI's API, which fails and falls through to the generic error string at `engine.ts:231`.
- **`schedule_followup` does not schedule anything.** `scheduleFollowup()` (`src/lib/ai/tools.ts:321-333`) computes a `scheduledFor` timestamp and returns a JSON success message — it performs **no database write and no queue enqueue of any kind**. The AI will tell a customer "I've scheduled a follow-up," and nothing happens. Confirmed by reading the full function body — there is no `prisma.*.create` call in it at all.
- **`estimateConfidence` is called with `hasToolCalls` hardcoded to `false`** (`engine.ts:196`), even on turns where tool calls were used earlier in the same recursive `callAI()` chain — the +0.1 confidence bonus for successful tool use can never actually apply, because the boolean is never threaded back up from the recursive call.
- **Guardrails are keyword `string.includes()` checks** (`src/lib/ai/guardrails.ts`), not classifiers. `checkBlockedTopics`, `enforceResponseLength`, `generateSummaryPrompt`, and `generateSuggestedRepliesPrompt` all exist with correct logic but **have zero callers anywhere in `src/`** (verified by grep) — only `requiresHumanApproval`, `analyzeSentiment`, `detectIntent`, and `estimateConfidence` are actually invoked from `engine.ts`. `Conversation.summary` is consequently never populated by AI, and `Settings`-configured `maxResponseLength` is decorative.
- **`Settings` singleton race** confirmed at `engine.ts:80-83`: `findFirst()` → if null, `create({ id: "default" })`, with no `upsert`. Two concurrent cold-start requests can both observe `null` and both attempt the create, and the loser throws an unhandled Prisma `P2002` unique-violation → 500. (Note: `src/app/api/settings/route.ts:17-21` has the *same* race in its `GET` handler despite the `PUT` handler correctly using `upsert` at line 50-54 — inconsistent within the same file.)

### 2.4 Dead / orphaned runtime paths — independently re-verified, not inherited from `AUDIT.md`

Grepping every exported "runner" function against the rest of `src/` (excluding each function's own defining file) confirms **zero callers** for all of the following:

| Function | Defined in | Callers found outside its own file |
|---|---|---|
| `evaluateRules()` | `src/lib/automation.ts:103` | **none** |
| `executeFlowNode()` | `src/lib/flow-builder.ts:58` | **none** |
| `checkSLABreaches()` | `src/lib/conversation-engine.ts:217` | **none** — no cron, no route, no worker |
| `applyRetentionPolicy()` | `src/lib/gdpr.ts:172` | **none** |
| `registerPlugin()` / `executeHooks()` | `src/lib/plugins.ts` | **none** — no plugin is ever registered at boot or anywhere else |
| `searchKnowledgeBase()` | `src/lib/ai/semantic-search.ts:91` | only from `/api/knowledge/test` (manual debug endpoint) |
| `checkBlockedTopics`, `enforceResponseLength`, `generateSummaryPrompt`, `generateSuggestedRepliesPrompt` | `src/lib/ai/guardrails.ts` | **none** |

Also confirmed: there is no cron, no `node-cron`/`setInterval`-based scheduler anywhere in `src/` except the SSE heartbeat inside `/api/realtime/route.ts` (which is a keep-alive ping, not a job scheduler), and `src/instrumentation.ts` registers only graceful-shutdown signal handlers (`src/lib/shutdown.ts`) — no background job runner is ever started. **There is no mechanism in this codebase, at all, that runs code on a delay or a schedule.** This is the root cause behind `schedule_followup`, SLA breach detection, and retention all being decorative — even if each of those functions were wired into a caller, there is still no infrastructure to run them later. This directly motivates a real job queue as part of Phase 6 (§46.6), not just "call the function from somewhere."

**One additional finding beyond what `AUDIT.md` documents:** `POST /api/campaigns/[id]/execute` (`src/app/api/campaigns/[id]/execute/route.ts`) calls `findTargetCustomers()` and returns only `{ campaignId, targetCount }` — it **never calls `sendProactiveMessage()`** (defined in `src/lib/campaigns.ts:91-130`) or any channel adapter's send function. "Executing" a campaign today only counts how many customers would match; it does not send anything to any of them. This is a second, independently-discovered instance of the same "UI implies an action that never happens" pattern documented in §2.4 and `AUDIT.md §2`.

**Another new finding:** `POST /api/admin/users` (`src/app/api/admin/users/route.ts:75`) hardcodes `const validRoles = ["admin", "editor", "viewer"]`, but `src/lib/rbac.ts:8` defines `ROLES = ["viewer", "agent", "supervisor", "admin"]`. `"editor"` is accepted by the user-creation endpoint but matches **no** entry in any `PERMISSIONS` array in `rbac.ts` — an admin who creates a user with role `"editor"` creates an account that can authenticate but is denied every single permission check (`hasPermission()` returns `false` for every permission, since `"editor"` appears in no allowed-roles array). Conversely, `"agent"` and `"supervisor"` — two of the four real RBAC roles — **cannot be assigned through this endpoint at all**. This is a live, independent bug (not previously documented in `AUDIT.md`) that should be captured as a regression test in Phase 0 and fixed as part of the identity-model rework in Phase 1/2, since the endpoint itself is being redesigned for tenant-scoped membership anyway.

### 2.5 Channels — verified per-file

- **WhatsApp** (`src/lib/channels/whatsapp.ts`, including the uncommitted diff): module-level singletons `whatsappClient`, `initPromise`, `currentQR`, `connectionStatus`, `readySince`. The uncommitted fix adds an `initPromise` guard against concurrent `initWhatsApp()` calls and a `readySince` timestamp to ignore WhatsApp's backlog replay of unread messages on reconnect — both confirmed present and correctly implemented. **The residual race `AUDIT.md §4` flagged is still present**: `connectionStatus` is set to `"connected"` inside the `"ready"` event handler (line ~60-65), but `whatsappClient` (the variable `sendWhatsAppMessage()` checks) is only assigned after `client.initialize()`'s promise resolves, inside the `initPromise` IIFE (line ~167-170). Per `whatsapp-web.js`'s internal event sequencing, `"ready"` commonly fires before `initialize()` resolves, leaving a window where `getWhatsAppStatus()` reports `"connected"` while `sendWhatsAppMessage()` silently no-ops (`if (!whatsappClient || ...) return false`, line ~198). Fix direction: assign `whatsappClient = client` inside the `"ready"` handler instead of after `initialize()` resolves.
- **Email** (`src/lib/channels/email.ts`): single module-level `imapConnection` + `isListening` flag — single-instance by construction. CRLF-injection-safe subject sanitization (`sanitizeEmailSubject`) confirmed used at send time.
- **SMS** (`src/lib/channels/sms.ts`) and **Telegram** (`src/lib/channels/telegram.ts`): stateless webhook handlers, each independently reimplementing "resolve customer → find/create conversation → `chat()` → send reply" — verified near-identical in structure across both files and WhatsApp/email, with zero shared abstraction between them.
- **Phone** (`src/lib/channels/phone.ts`): Twilio TwiML gather/say flow, Whisper STT (`transcribeAudio`) and ElevenLabs TTS (`synthesizeSpeech`) both implemented as plain fetch/SDK calls. `getPhoneStatus()` (line 213-218) is hardcoded to always return `{ configured: false, status: "disconnected" }` regardless of actual Twilio configuration — a minor but real UI-facing bug (dashboard will show phone as permanently disconnected even when correctly configured).
- **No channel has any shared TypeScript interface.** Confirmed: no `ChannelAdapter`/`Channel` type is imported or implemented across these five files; each independently defines its own config-fetching function (`getSmsConfig`, `getPhoneConfig`, `getEmailConfig`, etc.) with overlapping but not identical shapes.
- **No media/attachment storage exists at all.** In `whatsapp.ts`, `message.downloadMedia()`'s result is only used to build a text description (`[${mediaType} attachment: ${media.filename}] ...`) — the actual media buffer is discarded, never persisted anywhere. There is no object-storage code, no upload endpoint for arbitrary files, and no `metadata`/`mediaUrl` value is ever actually populated with a real stored location (`Message.mediaUrl` exists in the schema but is never written to by any code path found). This means Ziyrak's storage boundary (§27) is a **net-new capability**, not a migration of an existing local-disk system — the only real "local disk as source of truth" concern in the current app is the `.wwebjs_auth` session directory, which is WhatsApp-Web-specific session state, not tenant file storage.
- **No inbound webhook deduplication of any kind exists.** Confirmed across all five channel files: none checks for a provider-supplied message/event ID before processing. A redelivered Twilio/Meta/Telegram webhook today would re-trigger `chat()` a second time for the same customer message. This is treated as a correctness gap in this revision, not previously called out as sharply in the first pass (§17, §31).

### 2.6 What's genuinely solid (retained, extended rather than replaced)

- **RBAC** (`src/lib/rbac.ts`): clean additive 4-role model, single `PERMISSIONS` source of truth, consistently invoked. Extended in Phase 2 with a tenant-membership dimension; the permission model itself does not need a redesign.
- **Customer identity resolution** (`src/lib/customer-resolver.ts`): the 4-step match/normalize/backfill/create flow, verified in full, is well-reasoned — phone normalization strips WhatsApp suffixes and non-digits, cross-field fallback, backfilling empty fields. Becomes tenant-scoped in Phase 1/2 without changing the algorithm.
- **Webhook delivery** (`src/lib/webhook-delivery.ts`): real HMAC-SHA256 signing (`generateSignature`), `AbortController`-based timeout, genuine 3-attempt retry with 5s/30s/5min backoff via `setTimeout`. The retry mechanism moves onto the durable job queue in Phase 6 (a `setTimeout` retry is lost on process restart/redeploy — verified there is no persistence of "a retry is pending" beyond the `nextRetryAt` column, which nothing currently sweeps if the in-memory timer is lost), but the delivery/signing logic is otherwise sound and retained.
- **Validation** (`src/lib/validations.ts`): thorough Zod schemas, `.strict()` used appropriately on secret-bearing schemas.
- **Pagination** (`src/lib/pagination.ts`): consistent `{ data, pagination }` shape, `MAX_LIMIT = 100` cap enforced server-side. (Note: the uncommitted diff to `onboarding-checklist.tsx` fixes a client bug where two dashboard fetches forgot to unwrap `.data` from this shape — a UI-side consistency bug, not a `pagination.ts` bug.)
- TypeScript strict mode, ESLint + Prettier + CI (`.github/workflows/ci.yml`: typecheck → lint → test → build, against a real Postgres service container) are all correctly configured today and should remain the quality gate baseline (extended in §36).

### 2.7 Scalability — verified process-local state inventory

| Component | File | Verified behavior | Multi-replica impact |
|---|---|---|---|
| Rate limiter | `src/lib/rate-limit.ts` | Plain module-level `Map`, per-process, with a lazy 5-minute sweep (`cleanup()`) | Effective limit becomes `configured × replica_count`; protection weakens exactly when scaling out |
| Cache | `src/lib/cache.ts` | In-memory `Map` unless `REDIS_URL` is set, in which case it dynamically `import("redis")` (package not in `package.json` — would throw at runtime today if `REDIS_URL` were set without separately installing `redis`) | Embedding cache and any future cached reads are per-replica until Redis is a real, installed dependency |
| Realtime pub/sub | `src/lib/realtime.ts` | Module-level `Map<string, Set<EventCallback>>`, in-process only, no broker | A dashboard client connected to replica A never sees an event published by replica B — this is a hard correctness blocker for >1 replica, not just a cost concern |
| WhatsApp | `src/lib/channels/whatsapp.ts` | Single Puppeteer + `LocalAuth` session per process, session persisted to a Docker volume | Fundamentally single-instance; cannot run >1 replica with WhatsApp enabled without session conflicts |
| Email/IMAP | `src/lib/channels/email.ts` | Single `Imap` connection per process, `isListening` boolean | Same single-instance assumption |
| DB connections | `src/lib/prisma.ts` | One `PrismaPg` adapter, default pool sizing, no `connection_limit` tuning, no PgBouncer anywhere in `docker-compose.yml`/Helm | Connection exhaustion is the likely first bottleneck once replica count > 1, with zero current mitigation |
| Campaign targeting | `src/lib/campaigns.ts:62-86` | `findTargetCustomers()` fetches `take: 1000` and filters segments in Node, not SQL | Past 1000 customers, campaigns silently target only the first 1000 fetched; filtering does not use any index |

Deployment reality check: `docker-compose.yml` ships exactly one `app` + one `db` container. The **Helm chart already defines an HPA** (`helm/owly/templates/hpa.yaml`) gated on `autoscaling.enabled` — meaning the deployment tooling is already prepared to run multiple replicas, but every stateful piece above would silently misbehave (not error — misbehave) if that HPA were ever turned on today. This is flagged prominently because it's the kind of gap that causes a real incident: someone enables autoscaling because the chart supports it, and rate limiting/realtime/WhatsApp silently break with no error message pointing at the cause.

### 2.8 Data model inconsistencies confirmed directly against `prisma/schema.prisma`

- `Schedule.teamMemberId` (line 235) is a plain indexed `String`, not a `@relation` — no FK, no cascade; deleting a `TeamMember` leaves orphaned schedule rows silently.
- `CallLog` (lines 206-217) has no FK to `Conversation` or `Customer` at all — correlation only possible by matching phone number/time at query time.
- `Customer.tags` (line 335) is a comma-separated `String`, while `Conversation` tags use a real `Tag`/`ConversationTag` join table (lines 186-202) — the same "tagging" concept modeled two different ways in the same schema.
- `ActivityLog.entity`/`entityId` (lines 283-284) is a polymorphic pointer with no FK — audit correctness depends entirely on every caller passing the right `entity` string by convention.
- Every `Json` column (`AutomationRule.conditions/actions`, `Campaign.segments`, `Flow.nodes`, `Webhook.headers`, `Channel.config`, `KnowledgeEntry.metadata` (which is where OpenAI embeddings are stored as a plain JSON array, not `pgvector`), `Conversation.metadata`, `Message.toolCalls`) has its shape enforced only by TypeScript interfaces in `src/lib/`, never by Postgres/Prisma. This is an acceptable simplicity trade-off for an MVP and is not something this plan proposes to eliminate everywhere — but it does mean Zod validation at the API boundary is the *only* thing protecting these columns, and that validation must be preserved (and extended, not weakened) as these models become tenant-scoped. (This revision does tighten one class of `Json` usage specifically — provider credentials — per §10.3/review concern 16, because the compliance cost of an untyped credential blob is materially higher than for, say, `Webhook.headers`.)

### 2.9 Auth/identity model as it exists today

- `Admin` (`prisma/schema.prisma:48-56`): `id, username (unique), password (bcrypt), name, role (free string, default "admin")`. No tenant/organization reference of any kind.
- `ApiKey` (`prisma/schema.prisma:396-406`): `id, name, key (unique), isActive, lastUsed`. `route-auth.ts:31-37` — **every** valid API key resolves to `role: "admin"` (full admin permissions), unconditionally. There is no concept of a scoped or lower-privilege API key, and the key itself is stored as recoverable plaintext (verified: the `key` column is a plain `String`, compared with a direct `findUnique({ where: { key: apiKey } })` — a database read discloses a reusable secret).
- JWT (`src/lib/auth.ts`): `generateToken(userId, role)` signs `{ userId, role }` with `JWT_SECRET`, 7-day expiry, HS256. `getJwtSecret()` correctly throws at import time in non-test environments if `JWT_SECRET` is unset — a good fail-closed default, worth preserving.
- First-run bootstrap: `isSetupComplete()` (`auth.ts:61-64`) gates `/setup` purely on `prisma.admin.count() > 0` — i.e., **the entire installation supports exactly one bootstrap event, ever**, consistent with the single-tenant assumption. This must become "does *this business* have an owner yet" in the target model (§9, §13).

### 2.10 Existing tests — verified inventory

```
tests/api/          6 files  (auth, chat, conversations, export, health, settings, tickets — 7 total incl. tickets)
tests/security/     3 files  (auth-security, injection, middleware)
tests/unit/         19 files (ai-engine, ai-tools, auth, automation, campaigns, conversation-engine,
                               customer-resolver, errors, flow-builder, gdpr, guardrails, pagination,
                               rate-limit, rbac, realtime, security, twilio-verify, validations, webhook-delivery)
tests/helpers/      fixtures.ts, request.ts
tests/setup.ts
```
No test currently exercises: tenant isolation (no tenant concept exists yet, so this is expected — see §33), the actual auth-bypass routes identified in §2.2 (there is a `middleware.test.ts` but it does not appear to assert on `/api/chat`/`/api/realtime` specifically — verify and close this gap in Phase 0), `plugins.ts`, `semantic-search.ts`, `activity.ts`, `custom-fields.ts`, `cache.ts`, `route-auth.ts` directly, or the large majority of API routes beyond the seven listed above (customers, knowledge, sla, team, webhooks, automation, flows, campaigns, channels, admin, analytics, activity, business-hours, canned-responses all currently lack route-level tests).

### 2.11 Where this document's findings differ from `AUDIT.md` / `ARCHITECTURE.md`

Both documents are accurate as of their own write time (2026-09-14, same day) and every major claim in `AUDIT.md` was independently re-verified above and found still true in the current working tree. The differences are additive, not corrective:

1. **Campaign execution is more broken than documented.** `AUDIT.md` describes `findTargetCustomers()`'s in-memory-filtering/1000-row-cap limitation but does not note that `POST /api/campaigns/[id]/execute` never actually sends anything at all (§2.4 above) — "execute" only counts targets today.
2. **A second, independent RBAC bug** was found in `admin/users/route.ts`'s hardcoded `validRoles` list not matching `rbac.ts`'s real role set (§2.4) — not previously documented.
3. **`getPhoneStatus()` is hardcoded** to always report disconnected (§2.5) — a minor UI-correctness bug not previously documented.
4. **The Helm chart's HPA vs. in-memory-state contradiction** (§2.7) is called out explicitly here as a concrete deployment-tooling risk, not just a general "in-memory state doesn't scale" statement.
5. **`node_modules` is not installed** in this working tree, meaning `AGENTS.md`'s "read `node_modules/next/dist/docs/` before writing Next.js code" instruction cannot be followed yet — flagged as a Phase 0 setup prerequisite (§46.0), not a design concern.
6. `AUDIT.md`'s uncommitted-diff review (its §4) refers to a whatsapp.ts fix that is confirmed still present and unchanged in the current tree, along with several additional uncommitted UI/i18n/Docker touch-ups (`git diff --stat` shows 20 files) that are cosmetic and do not change any of `AUDIT.md`'s architectural findings — verified via full `git diff` inspection, not assumed.
7. **API keys are stored as recoverable plaintext** (§2.9) — a security-architecture gap identified during this second-pass review (review concern 15) that was implicit in the first pass's "every key resolves to admin" finding but not called out as its own distinct issue until now.
8. **No inbound webhook deduplication exists on any channel** (§2.5) — identified during this second-pass review (review concern 7); elevated from an unstated assumption to an explicit, verified gap.

No claim in `AUDIT.md` was found to be stale or contradicted by the current tree.

---

## 3. Ziyrak Product/Architecture Goals

Translating the product vision into concrete technical requirements:

| Product requirement | Technical requirement |
|---|---|
| Many businesses, one platform | First-class `Business` entity; every business-owned row traces to exactly one `Business` |
| Businesses never see each other's data, even by guessing IDs | Structural tenant isolation enforced at three independent layers — application context, query layer, and the database's own foreign-key constraints (§8) |
| A business can have multiple users with different roles | `Membership` join model between `User` and `Business`, carrying a role (§9) |
| A business can authenticate multiple ways (dashboard login, API key, channel webhook, service credential) | All authentication paths resolve to the same `TenantContext` shape before touching business data (§14) |
| **The AI itself, and background jobs, also need to act on a business's behalf — without being modeled as a fake employee** | A distinct `ExecutionPrincipal` dimension (`ai_agent`, `system_job`) with its own tenant-configurable `ToolPolicy`, independent of human RBAC roles (§9.5, §23) |
| Most businesses share infrastructure; a few need dedicated infrastructure later, including a real placement/bootstrap story | A control-plane `TenantPlacement` lookup resolves where a business's data lives *before* any tenant connection is opened, backed by symbolic profile references rather than raw credentials (§7.4–7.6, §11) |
| Ziyrak reacts to more than chat over time (orders, payments, calendars, forms) | A normalized event envelope that is not chat-shaped (§17), even though the only producers implemented now are channel adapters; durably persisted and deduplicated, not merely published to a best-effort bus |
| The AI must be able to *act*, not just answer, and never lie about it | Durable `ActionExecution` records with attempt-scoped idempotency; tool execution goes through a registry with permission/tenant/AI-policy checks and a status lifecycle that is never claimed ahead of the infrastructure that makes it true (§23–§24) |
| The platform must eventually attribute cost/usage per business | Every AI call, job execution, and channel send is tagged with `businessId` from day one, even before billing exists (§39) |
| The product may expand beyond chat to a general "Business AI" | Core orchestration consumes normalized events and knowledge/tool abstractions, not "conversation" specifically — conversations are the first, not the only, event source (§18) |
| A provider (WhatsApp, Twilio, a future CRM webhook) may redeliver the same event | Inbound events are deduplicated durably before processing, using the provider's own external event ID where available (§17, §31) |

---

## 4. Architectural Principles

These are the standing rules the rest of this plan (and future phases) must follow:

1. **Tenant isolation is structural, not conventional — and defended at more than one independent layer.** If a developer can write a working query that leaks cross-tenant data without deliberately bypassing a safeguard, the safeguard has failed; and if one layer (say, an application-level check) has a bug, a second, independent layer (the database's own constraints) should still catch it. See §8.
2. **Boundaries are justified by a real second implementation or a named future requirement, not by aesthetics — and are not frozen before an implementation exists to validate them.** Every interface introduced in this plan (`AIProvider`, `EmbeddingProvider`, `ChannelAdapter`, `KnowledgeRetriever`, `ObjectStorage`, `JobQueue`, `RealtimeBus`) has at least one concrete alternate implementation named in this document, or replaces something that already has two implementations today. Where a contract's *exact* method signature is likely to be taught to us by its first real implementation rather than known in advance, this plan establishes the module boundary and dependency direction first and finalizes the signature during that implementation phase, not earlier (§46.3).
3. **Modular monolith, not microservices**, until a subsystem has a proven, specific reason to run as a separate service (independent scaling curve, independent deploy cadence, or a hard language/runtime requirement). None of Ziyrak's current requirements meet that bar. See §34. The job queue/worker is the one deliberate exception to "one deployable" — it is a separate *process*, not a separate *service* with its own API, and it remains platform-shared infrastructure even once individual tenants get dedicated data placement (§25.6).
4. **An LLM's own text output is never the source of truth for whether a business action happened — and a status is never reported before the infrastructure backing it exists.** Durable state (`ActionExecution`, job records) is the source of truth; the AI reports what the durable state says, not the other way around; and this plan does not sequence a phase boundary that would leave a "scheduled" status resting on a job queue that hasn't shipped yet (§24, §46.6).
5. **Secure by default.** A new route should have to opt *out* of authentication (explicit, reviewable), not opt *in*. See §14.
6. **Shared infrastructure by default; dedicated infrastructure by override, resolved through a control-plane placement lookup, never by fork and never by storing raw credentials in tenant-facing config.** A business that needs a dedicated database or storage bucket should get one by configuration, not by the platform maintaining a second code path — and that configuration is a symbolic reference a platform-controlled resolver looks up, not a connection string sitting in the same table a tenant admin can read. See §7, §11.
7. **No dead runtime paths.** If a feature has a UI and a data model, it must have a real caller, or it must be removed/clearly labeled experimental. §2.4's findings are treated as defects, not backlog.
8. **Local development must stay easy.** Every production infrastructure dependency introduced by this plan has a local-equivalent story (filesystem instead of S3, in-memory/pg-boss instead of managed queue, etc.) — see §40.
9. **Tests characterize behavior before it is changed**, and tenant-isolation tests are treated as security tests, not feature tests — they gate merges, not just document intent, and they explicitly include attempts to bypass application-level checks and confirm the database itself refuses the write. See §33, §35.
10. **Every phase leaves the application in a runnable, coherent state — and "runnable" for any phase touching tenant boundaries means safe to expose to more than one real business, not merely compiling.** No phase depends on a "big bang" cutover; the plan is sequenced so each step is independently mergeable and deployable; but Phase 1 specifically is *not* considered safe to expose to external multi-business use on its own — see the risk table in §1 and §45.
11. **Ephemeral notification and durable business events are different mechanisms, not the same abstraction wearing two names.** A realtime pub/sub bus may silently lose an event under load, a restart, or a network blip, and that is an acceptable property for "the dashboard didn't get a live update" — it is never an acceptable property for "the customer's message was never processed." See §17, §26.
12. **A human's role and the AI's permission to act are independent questions.** RBAC answers "what can this signed-in person do"; a separate, tenant-configurable tool policy answers "what may the AI do automatically, what must it ask a human before doing, and what is it never allowed to do" — collapsing these two into one role system produces either an over-privileged AI or an under-capable one. See §9.5, §23.

---

## 5. Target High-Level Architecture

### 5.1 Platform architecture (end state after Phase 8, scalability)

```
                              ┌─────────────────────────────────────────┐
                              │            External Channels             │
                              │  WhatsApp(Meta Cloud)  Web Chat  Email   │
                              │  SMS/Twilio  Telegram   Phone/Twilio     │
                              └───────────────────┬───────────────────────┘
                                                  │ webhooks / widget API calls
                                                  ▼
                              ┌─────────────────────────────────────────┐
                              │        Next.js App (N replicas)          │
                              │  ┌─────────────────────────────────┐    │
                              │  │ middleware.ts (secure-by-default) │   │
                              │  └───────────────┬───────────────────┘   │
                              │                  ▼                       │
                              │  ┌─────────────────────────────────┐    │
                              │  │ Identity → TenantPlacement →      │   │
                              │  │ TenantContext resolution          │   │
                              │  │ (explicit at service boundaries,  │   │
                              │  │  AsyncLocalStorage as backstop)   │   │
                              │  └───────────────┬───────────────────┘   │
                              │                  ▼                       │
                              │  ┌─────────────────────────────────┐    │
                              │  │  Application / Domain Modules     │   │
                              │  │  (tenants, customers, conv.,      │   │
                              │  │   tickets, ai, knowledge, tools,  │   │
                              │  │   automations, campaigns...)      │   │
                              │  └──┬──────────┬──────────┬──────────┘   │
                              │     ▼          ▼          ▼              │
                              │  Channel    AIProvider/  Object          │
                              │  Adapters   Embedding    Storage         │
                              │  (contracts)Adapters     (contract)      │
                              └──┬──────────┬──────────┬─────────────────┘
                                 │          │          │
                 ┌───────────────┘          │          └───────────────┐
                 ▼                          ▼                          ▼
        ┌─────────────────┐      ┌───────────────────┐      ┌──────────────────┐
        │  Worker process   │      │  Control-plane DB   │      │  S3-compatible    │
        │  (M replicas,      │◄────►  (Business, User,   │      │  object storage    │
        │  shared platform   │      │  Membership,        │      │  (tenant-prefixed) │
        │  pg-boss queue,    │      │  TenantPlacement,    │      └──────────────────┘
        │  per-conversation   │      │  DatabaseProfile,    │
        │  singleton lock)    │      │  StorageProfile)      │
        └─────────┬──────────┘      └──────────┬───────────┘
                  │                             │ resolves connection for
                  │                             ▼
                  │                 ┌───────────────────┐
                  │                 │  Tenant data plane   │   default: same physical
                  │                 │  (Customer, Conv.,    │◄──Postgres as control plane,
                  │                 │  Message, Ticket,     │   shared schema; dedicated
                  │                 │  Knowledge, Action     │   DB/schema per business
                  │                 │  Execution, Inbound     │   only where placed there
                  │                 │  EventReceipt...)       │   (Phase 9, §46.9)
                  │                 └───────────────────┘
                  ▼
        ┌─────────────────┐      ┌───────────────────┐
        │      Redis         │◄────►  RealtimeBus (Redis  │  best-effort, ephemeral —
        │ (cache, rate-limit, │      │  pub/sub) → SSE/WS    │  see §17/§26 for why this
        │  pg-boss backing*)  │      │  dashboard notifications│ is NOT the durable path
        └─────────────────┘      └───────────────────┘
```
\* pg-boss itself is backed by Postgres, not Redis; Redis is shown adjacent because it becomes mandatory in Phase 8 for cache/rate-limit/realtime regardless of queue choice. The **control plane** (`Business`, `User`, `Membership`, `TenantPlacement`, `DatabaseProfile`, `StorageProfile`) and the **data plane** (everything tenant-owned) are an *architectural* distinction from day one (Phase 1) — both live in the same physical Postgres database and schema until a specific business is placed onto dedicated infrastructure in Phase 9; see §7.4–7.6.

### 5.2 Tenant/request resolution flow

```
Inbound HTTP request
   │
   ▼
middleware.ts ── security headers, CORS, rate limit (per-IP today, per-tenant-aware later)
   │  reject unauthenticated protected paths by DEFAULT (allowlist, not denylist, of public paths)
   ▼
resolveIdentity(request)                                            [control-plane lookup]
   │  cookie JWT → verifyToken() (REAL verification, in middleware AND route)
   │  or X-API-Key → hash it, look up ApiKey by keyHash → scoped to ONE business, not global admin
   │  or channel signature (Twilio/Telegram/Meta/widget token) → maps to the ChannelConnection's business
   ▼
resolveMembership(identity)                                          [control-plane lookup]
   │  which Business does this identity belong to, and with what role?
   │  platform admins are a distinct identity kind, not a business role (§9)
   │  AI/system-job callers resolve to an ExecutionPrincipal, not a Membership role (§9.5)
   ▼
resolveTenantPlacement(businessId)                                   [control-plane lookup, §7.5]
   │  which data-plane connection (databaseProfileId) serves this business? default for ~100% of businesses
   ▼
TenantContext { businessId, role | executionPrincipal, actor, dataConnection }
   │  passed explicitly into application-service calls; AsyncLocalStorage carries it only as a
   │  logging/correlation convenience and a defense-in-depth backstop inside the Prisma extension (§8.2)
   ▼
hasPermission(role, permission)  OR  toolPolicy check for AI/system actors  +  membership/placement check
   │
   ▼
service.execute(ctx, input) → getScopedPrisma(ctx) → every query filtered/stamped with businessId,
   │  AND protected by composite foreign keys at the database level (§8)
   ▼
Response
```

### 5.3 Inbound event processing flow (e.g., a WhatsApp message) — fast-ack, dedup, then process

```
WhatsApp (Meta Cloud webhook) ──► POST /api/channels/whatsapp/webhook
   │
   ▼
MetaCloudWhatsAppAdapter.validateInbound(req)
   │  verifies Meta's signature, maps phone-number-ID → businessId via ChannelConnection lookup
   ▼
resolveTenantPlacement(businessId) → TenantContext
   ▼
InboundEventReceipt: INSERT ... ON CONFLICT (businessId, source, externalEventId) DO NOTHING
   │
   ├─ duplicate (0 rows inserted) ──────────────────────────────► ACK 200 immediately, stop — do NOT reprocess
   │
   └─ new (1 row inserted)
        │
        ▼
     persist raw inbound message + normalized ZiyrakEvent<MessageReceived>
        │
        ▼
     JobQueue.enqueue("process-inbound-message", { businessId, eventId, conversationId? },
                       { singletonKey: `${businessId}:${conversationId ?? contact}` })   ◄── per-conversation ordering, §25.5
        │
        ▼
     ACK 200 to Meta — the webhook has now done its ONE job: verify, dedupe, persist, enqueue, acknowledge.
        Everything below runs in the worker, off the webhook's response-time budget.

   ═══════════════════════════ worker (async) ═══════════════════════════

   Worker picks up "process-inbound-message" job
        │
        ▼
   processInboundMessage(ctx, event)        ◄── the SAME function POST /api/chat calls synchronously (§18.2)
        │
        ├─► resolveCustomer(ctx, channel, contact, name)              (existing algorithm, tenant-scoped)
        ├─► find-or-create Conversation                                (tenant-scoped)
        ├─► KnowledgeRetriever.retrieve(ctx, query, limit)             (replaces unbounded dump)
        ├─► GuardrailPipeline.preCheck(message)                        (blocked topics, human-approval keywords)
        ├─► AIOrchestrator.respond(ctx, conversation, message) ─┐
        │        │                                              │ may call...
        │        ▼                                              │
        │   AIProvider.complete(...)  ── OpenAI / Anthropic     │
        │        │                                              │
        │        ▼ (if tool call requested)                     │
        │   ToolRegistry.execute(ctx, toolName, args) ──────────┘   ◄── checked against ToolPolicy for the
        │        │  every execution creates a durable ActionExecution row FIRST    "ai_agent" principal (§9.5/§23)
        │        ▼
        ├─► GuardrailPipeline.postCheck(response)                     (length cap, confidence, escalation)
        ├─► persist Message(s), update Conversation
        ├─► publish on RealtimeBus (best-effort dashboard notification, §17/§26)
        └─► ChannelAdapter.sendMessage(ctx, to, response)              (reply back out via the same channel)
```

### 5.4 AI + knowledge + tool execution flow (detail)

```
processInboundMessage(ctx, event)
   │
   ▼
AIOrchestrator.respond(ctx, conversation, userMessage)
   │
   ├── buildSystemPrompt(ctx, businessConfig, knowledge, toneGuide)
   ├── loadRecentMessages(conversation)   (existing behavior, take: 50, preserved)
   ├── provider = AIProviderRegistry.get(businessConfig.aiProvider)
   ├── embedder = EmbeddingProviderRegistry.get(businessConfig.embeddingProvider ?? businessConfig.aiProvider)   ◄── §21.5
   ├── tools = ToolRegistry.getAvailableTools(ctx)   ◄── tenant + ToolPolicy(AI) filtered, NOT a hardcoded array
   │
   ├── result = provider.complete({ messages, tools, maxTokens, temperature })
   │        │
   │        ├── result.type === "text"        → return to caller
   │        └── result.type === "tool_calls"  → for each call (toolCallId from the provider):
   │                 │
   │                 ├── idempotencyKey = (ctx.businessId, event.correlationId, toolCallId)     ◄── §24.4
   │                 ├── ActionExecution.create({ status: "requested", tool, input, idempotencyKey, ... })
   │                 ├── ToolRegistry.execute(ctx, name, args)
   │                 │        │
   │                 │        ├── requiresHumanApproval(tool, ctx) → ActionExecution → "pending_approval", STOP
   │                 │        ├── synchronous tool (e.g. create_ticket) → runs now, ActionExecution → "succeeded"/"failed"
   │                 │        └── async-by-nature tool (e.g. schedule_followup) → enqueues a Job,
   │                 │                 ActionExecution → "scheduled" (never fabricated "succeeded",
   │                 │                 and never returned unless the job queue actually exists — §46.6)
   │                 ├── append tool result message
   │                 └── recurse into provider.complete(...) with updated messages (depth-limited, unchanged behavior)
   ▼
return final text response
```

### 5.5 Asynchronous job flow

```
Enqueue side (webhook adapter, tool execution, webhook delivery, SLA sweep, retention sweep)
   │
   ▼
JobQueue.enqueue(jobType, payload, { businessId, runAt?, idempotencyKey?, singletonKey? })
   │  payload always carries businessId — no tenant-less jobs
   ▼
pg-boss (Postgres-backed queue; SKIP LOCKED under the hood; shared PLATFORM infrastructure — §25.6)
   │
   ▼
Worker process (separate from web replicas, horizontally scalable independently)
   │
   ├── resolveTenantPlacement(job.payload.businessId) → TenantContext (control-plane lookup, same as a request)
   ├── run handler (e.g. sendScheduledFollowup, deliverWebhookAttempt, checkSLABreaches, applyRetentionPolicy)
   ├── on success  → ActionExecution/Job → "succeeded", side effects committed
   ├── on failure  → retry per policy (bounded attempts, backoff) → "failed" + dead-letter after exhaustion
   │                 (retry re-executes the SAME idempotency key → exactly-once effect, §24.4/§31.2)
   └── publish on RealtimeBus so the dashboard can reflect job outcomes live (best-effort — §17/§26)
```

### 5.6 Multi-tenant data/config/infrastructure hierarchy

```
Platform (control plane)
 │  platform defaults: default AI provider, default embedding provider, default DB profile,
 │  default object storage profile, default retention
 │
 ├── Business A (shared everything)
 │      TenantPlacement  = { databaseProfileId: "shared-default", storageProfileId: "shared-default" }
 │      config           = platform defaults, no overrides
 │      data plane       = shared Postgres, shared schema, businessId-filtered + composite-FK-protected rows
 │
 ├── Business B (partial override)
 │      TenantPlacement  = { databaseProfileId: "shared-default", storageProfileId: "shared-default" }
 │      config           = platform defaults + { aiProvider: "anthropic", aiModel: "..." }
 │      data plane       = shared Postgres, shared schema (unchanged)
 │
 └── Business C (compliance / dedicated infrastructure — Phase 9, §46.9)
        TenantPlacement  = { databaseProfileId: "dedicated-eu-42", storageProfileId: "dedicated-eu-42" }
        InfrastructurePolicy = { dataRegion: "eu", permittedAiProviders: ["private-endpoint"] }
        data plane       = dedicated database (real connection string lives ONLY in DatabaseProfile,
                            a control-plane table resolved by profile ID — never in InfrastructurePolicy
                            itself, per review concern 4, §7.6)
```

### 5.7 Suggested module dependency direction

```
        ┌───────────────────────────────────────────────────────────┐
        │                     app/api/** (routes)                    │
        │        depends on → application modules only                │
        └───────────────────────────┬───────────────────────────────┘
                                     ▼
        ┌───────────────────────────────────────────────────────────┐
        │                  Application / Domain modules                │
        │  tenants · identity · customers · conversations · tickets   │
        │  ai-orchestration · knowledge · tools · automations · jobs   │
        │        depends on → contracts (interfaces) only, for infra    │
        └───────┬───────────────┬───────────────┬───────────────┬─────┘
                ▼               ▼               ▼               ▼
        ┌───────────┐   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
        │ AIProvider │   │ ChannelAdapter│  │ObjectStorage │  │  JobQueue   │
        │ Embedding  │   │   contract    │  │  contract    │  │  contract   │
        │  Provider  │   │               │  │              │  │             │
        └─────┬─────┘   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
              ▼                ▼                 ▼                 ▼
        OpenAI/Anthropic  WhatsApp(Meta)/    S3/MinIO/Local    pg-boss adapter
        /Ollama adapters  WebChat/Twilio/    adapters
        + OpenAIEmbedding Telegram adapters
        provider
```

**Rule:** arrows only point downward/rightward here. Application/domain modules may depend on infrastructure *contracts* (interfaces defined alongside the domain, e.g. `src/lib/ai/providers/types.ts`), never on concrete SDKs (`openai`, `whatsapp-web.js`, `@aws-sdk/client-s3`) directly. Infrastructure adapters may depend on shared low-level utilities (`logger`, `errors`) but never on application/domain modules — a `ChannelAdapter` implementation must not import from `src/lib/ai/*` or call `prisma` for tenant tables directly; it emits normalized events and lets the application layer decide what to do with them. Full enforcement mechanics in §37.

### 5.8 Deployment topology — initial vs. scaled

```
INITIAL (Phase 7, first paying customers)          SCALED (Phase 8+)
┌─────────────────────┐                            ┌───────────────────────────────┐
│ 1x App container      │                            │ N x App containers (behind LB)  │
│ 1x Worker container   │                            │ M x Worker containers            │
│ 1x Postgres            │                            │ Postgres (managed, pooled via    │
│ (control + data plane, │                            │   PgBouncer or managed pooler)   │
│  no Redis required     │                            │ Redis (cache + rate-limit +      │
│  yet — rate limit/     │                            │   pub/sub for realtime)          │
│  cache/RealtimeBus are │                            │ S3-compatible object storage     │
│  fine in-memory at     │                            │ (dedicated DB/storage per        │
│  N=1)                  │                            │  compliance tenant, Phase 9)     │
│ Local/S3-compatible     │                            └───────────────────────────────┘
│  object storage         │
└─────────────────────┘
```

Both topologies use the same application code; the difference is purely which adapter implementation is selected per contract (in-memory vs. Redis cache, single Postgres connection string vs. `TenantPlacement`-resolved) — this is the entire point of building the contracts in Phase 3-4 before Phase 8's scaling work, so scaling is a configuration change, not a rewrite.

---

## 6. Module Architecture

Current `src/lib/` is flat — roughly two dozen top-level files plus `ai/` and `channels/` subfolders (verified via `find src/lib -maxdepth 2`). The target reorganizes by domain ownership. This is a **structural regrouping to be done gradually in Phase 3**, not a big-bang rename — files move module-by-module as each module's contracts are introduced, so the app keeps building and running throughout (Principle 10, §4).

| Target module | Owns | Current code it absorbs/wraps | Depends on (contracts only, for infra) |
|---|---|---|---|
| `platform/` | `Business`, `User`, `Membership`, platform-admin identity, and — per this revision — the **control-plane** models: `TenantPlacement`, `DatabaseProfile`, `StorageProfile` | *(new)* | — |
| `tenancy/` | `TenantContext` construction/propagation, config hierarchy resolution | *(new)* | `platform/` |
| `identity/` | User accounts, sessions, JWT, hashed API keys, channel-credential auth, and the distinct `ExecutionPrincipal` resolution for AI/system callers | `auth.ts`, `route-auth.ts` (rewritten) | `tenancy/` |
| `rbac/` | Human roles/permissions, platform-vs-tenant authorization | `rbac.ts` (extended) | `tenancy/` |
| `customers/` | Customer identity resolution, GDPR export/delete for customers | `customer-resolver.ts`, customer parts of `gdpr.ts` | `tenancy/` |
| `conversations/` | Conversation lifecycle, routing, transfer/merge/snooze, SLA | `conversation-engine.ts` | `tenancy/`, `events/` |
| `tickets/`, `team/` | Ticket + department/team-member CRUD and assignment | current `tickets`/`team` API logic (mostly unchanged) | `tenancy/` |
| `channels/` | `ChannelAdapter` contract + adapter implementations, `ChannelConnection` management | `channels/*.ts` (refactored behind the contract) | `events/`, `identity/` (credential lookup) |
| `events/` | Normalized event envelope, `InboundEventReceipt` deduplication, event dispatch | *(new)* | — |
| `realtime/` | `RealtimeBus` contract (ephemeral notification only — §17, §26), distinct from `events/` | absorbs `realtime.ts`'s pub/sub role, renamed | — |
| `ai/` | `AIProvider`/`EmbeddingProvider` contracts + providers, orchestration, guardrails | `ai/engine.ts`, `ai/guardrails.ts` (rewired), `ai/types.ts` | `knowledge/`, `tools/`, `events/` |
| `knowledge/` | `KnowledgeRetriever` contract, ingestion boundary | `ai/semantic-search.ts` (promoted out of `ai/`) | `tenancy/`, `ai/` (for `EmbeddingProvider`) |
| `tools/` | Tool/action registry, built-in tools, `ActionExecution`, `ToolPolicy` | `ai/tools.ts` (replaced), `custom-fields.ts` where relevant | `tenancy/`, `jobs/` |
| `jobs/` | `JobQueue` contract, workers, scheduling, per-conversation ordering | *(new)*, absorbs the "should exist but doesn't" scheduling role from `automation.ts`/`gdpr.ts`/`conversation-engine.ts` | — |
| `automations/` | Automation rule matching (reconnected — decision in §46.6) | `automation.ts` | `jobs/`, `tools/` |
| `flows/` | Flow-builder runtime (deprecated from the tenant surface — decision in §46.6) | `flow-builder.ts` | `ai/`, `tools/` |
| `integrations/` | Webhooks (outbound) + future CRM/payment integrations | `webhook-delivery.ts` (moved onto `jobs/`) | `jobs/` |
| `storage/` | `ObjectStorage` contract + adapters | *(new)* | — |
| `observability/` | Logging, request context, activity/audit log | `logger.ts`, `activity.ts`, `errors.ts` | — |
| `campaigns/` | Segmentation + proactive send (fixed to actually send) | `campaigns.ts` | `channels/`, `jobs/` |
| `billing/` (scaffolding only) | Usage-event recording, no billing engine | *(new, minimal)* | `tenancy/` |

`plugins.ts` and its hook system are explicitly **not** carried forward as-is: it is a fully-general, never-invoked extension point that duplicates what the `events/` + `tools/` modules will provide with tenant awareness and real callers. §46.6 makes the explicit call to deprecate it rather than wire it in as-is, and explains why.

Note on `platform/` vs. the rest of this table: this revision moves the control-plane models (`TenantPlacement`, `DatabaseProfile`, `StorageProfile`) into `platform/` rather than `tenancy/`, because they are read by the *platform* to decide where a tenant's data lives — they are not themselves tenant-owned data, and they must remain resolvable even for a business whose data-plane connection is currently unreachable (§7.5's bootstrap requirement). `platform/` is kept deliberately thin beyond this — it does not grow into a full platform-admin product surface in this plan (§44, MVP boundary).

---

## 7. Business/Tenant Architecture

### 7.1 Core entities (target, introduced in Phase 1)

```prisma
model Business {
  id           String   @id @default(uuid())
  slug         String   @unique          // for future subdomain/URL routing
  name         String
  status       String   @default("active")   // active, suspended, deleted
  planId       String?                        // FK to a future Plan model; nullable now
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  memberships       Membership[]
  config             BusinessConfig?
  channelConnections ChannelConnection[]      // §7.7 / §12 — replaces the old one-per-type Channel model
  apiKeys            ApiKey[]                 // ApiKey gains businessId (see §9)
  placement          TenantPlacement?         // control-plane row, §7.5 — where this business's data actually lives
  // ...every tenant-owned model in §12 gains a businessId relation back to Business,
  // and every tenant-owned model that is itself referenced by another gains @@unique([businessId, id])
  // so children can hold a composite foreign key into it (§8)
}

model Membership {
  id         String   @id @default(uuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  role       String   // owner | admin | supervisor | agent | viewer (§9)
  createdAt  DateTime @default(now())

  @@unique([businessId, userId])
  @@index([userId])
}
```

`User` replaces `Admin` as the identity model (renamed, not just relabeled — `Admin.role` today is a single global string; `User` has no role of its own, roles live entirely on `Membership`, because the same person may hold different roles in different businesses, and a platform administrator may hold no business membership at all). See §9 for the full identity model and §13 for the migration path from `Admin`.

### 7.2 Why a `Business` row is not "the API key" (per the mandate in the prompt)

An API key is one of several ways to *authenticate as* a business; it is never the business itself. Concretely: `ApiKey` gains a required `businessId` and, per this revision, is stored as a `keyPrefix` + `keyHash` pair rather than a recoverable secret (§9.4); a business can have zero, one, or many API keys, each independently revocable, and each can (in a later iteration, not required for MVP) be scoped to a subset of permissions narrower than full admin — closing the current `route-auth.ts:31-37` gap where every API key resolves to unconditional admin access. Channel credentials are modeled via `ChannelConnection` (§7.7): each connection (e.g., "WhatsApp Sales," "WhatsApp Support," a specific inbox) is owned by exactly one `Business`, never a global `Settings` field, and a business may have **multiple** connections of the same channel type — a deliberate change from the first pass, driven by review concern 14 (§0).

### 7.3 What stays global (platform-level, not tenant-owned)

- Platform administrator accounts (a distinct `User` with no `Membership` rows, or a separate `PlatformAdmin` flag — decided in §9).
- Platform default configuration (§10): default AI/embedding provider, default database/storage profile, default retention policy — these are code/env constants plus the control-plane `DatabaseProfile`/`StorageProfile` rows (§7.6), never a business-editable singleton, avoiding a repeat of the `Settings`-singleton pattern at the platform level.
- The `Plan`/quota model (scaffolded only, §39/§43), since plans are a platform product decision, not a per-tenant one.
- **The control-plane placement/profile models introduced in this revision** (`TenantPlacement`, `DatabaseProfile`, `StorageProfile`) — these are read by platform infrastructure to route a request or job to the right tenant data connection; they are not tenant-owned data and a tenant admin never edits them directly (§7.4–7.6).

Everything else currently modeled as global (`Settings`, `BusinessHours`, `Channel`, `Category`/`KnowledgeEntry`, `Department`/`TeamMember`, `Customer`, `Conversation`, `Message`, `Ticket`, `Tag`, `CallLog`, `AutomationRule`, `Campaign`, `Flow`, `Webhook`, `ApiKey`, `ActivityLog`, `SLARule`, `CannedResponse`) becomes tenant-owned. Full per-model treatment in §12.

### 7.4 The control-plane / data-plane split — why it exists (review concern 3)

The first pass of this plan proposed `getPrismaForTenant(businessId)` reading `InfrastructurePolicy.dedicatedDatabaseUrl` to decide which database connection to use for that business. On review, this has a real bootstrap problem: if `InfrastructurePolicy` is itself a tenant-owned row living in the *tenant's* database, resolving "which database does this tenant use" would require already being connected to that tenant's database — a circular dependency. The fix is not a new physical database on day one; it is an explicit **architectural** distinction, present from Phase 1, between:

- **Control plane** — data the platform needs to route a request *before* it knows where a specific business's data lives: `Business`, `User`, `Membership`, `ApiKey` (metadata only), `ChannelConnection` (routing metadata + a credential reference, not the raw secret), `TenantPlacement`, `DatabaseProfile`, `StorageProfile`, and (Phase 9) `InfrastructurePolicy`. The control plane always lives on one well-known, platform-managed connection — it is never itself relocated per-tenant.
- **Data plane** — everything a business actually owns and operates on: `Customer`, `Conversation`, `Message`, `Ticket`, `KnowledgeEntry`, `ActionExecution`, `InboundEventReceipt`, and the rest of §12's table.

**Until Phase 9, both planes live in the same physical Postgres database and the same schema.** This is a deliberate, load-bearing decision, not a placeholder: it means Phase 1 through Phase 8 pay *zero* operational cost for this distinction (one Postgres instance, one connection, one migration set) while still giving Phase 9 a real, already-proven resolution path to a genuinely separate data-plane database for a specific business, because the *code* has been asking "where does this business's data live" via `TenantPlacement` since Phase 1, not assuming a single answer.

### 7.5 `TenantPlacement` and the bootstrap resolution order

```prisma
model TenantPlacement {
  businessId       String  @id
  business         Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  databaseProfileId String  @default("shared-default")
  storageProfileId  String  @default("shared-default")
  updatedAt        DateTime @updatedAt
}
```

Resolution always runs in this order, and the first step is what removes the circularity:

```
1. Connect to the CONTROL-PLANE database (one well-known connection string, env-configured,
   never resolved dynamically — this is the one connection every process always has).
2. Look up TenantPlacement for businessId → { databaseProfileId, storageProfileId }.
3. Look up DatabaseProfile[databaseProfileId] → the actual data-plane connection string (§7.6).
4. Open/reuse a cached PrismaClient for that connection string.
5. All subsequent queries for this request/job run against the resolved data-plane connection,
   through the same tenant-scoping Prisma extension (§8) regardless of which physical database it is.
```

For every business without a Phase-9 override, `databaseProfileId`/`storageProfileId` are the literal string `"shared-default"`, which resolves (step 3) to the same connection string the control plane itself uses — so steps 1 and 4 resolve to the identical Postgres instance, and the "control plane vs. data plane" distinction costs nothing beyond one indexed lookup by primary key. This directly answers the review's bootstrap concern: the platform can **always** resolve `businessId → placement` without first connecting to an unknown tenant database, because that resolution never leaves the control-plane connection.

### 7.6 Why placement never stores a raw connection string (review concern 4)

`DatabaseProfile` and `StorageProfile` — not `TenantPlacement` or the future `InfrastructurePolicy` — are the only two places a real connection string or storage credential is ever stored, and both are control-plane tables with no tenant-facing read/write path (no API route returns their contents to a business admin, even a business owner):

```prisma
model DatabaseProfile {
  id                String  @id                 // e.g. "shared-default", "dedicated-eu-42"
  connectionSecretRef String                     // opaque reference into the SecretResolver boundary (§10.3) — never the DSN itself in this table
  region            String  @default("us")
  createdAt         DateTime @default(now())
}

model StorageProfile {
  id                String  @id
  credentialSecretRef String
  bucket            String
  region            String  @default("us")
  createdAt         DateTime @default(now())
}
```

`TenantPlacement.databaseProfileId` is a symbolic reference (`"dedicated-eu-42"`), never a DSN. Resolving the *actual* secret happens one more hop down, through the same `SecretResolver` boundary described in §10.3/§16.5 for channel credentials — so there is exactly one place in the codebase that ever touches a raw database or storage credential, and it is swappable (env-file-backed today, a real secrets manager later) without touching `TenantPlacement`, `DatabaseProfile`, or any application code that calls `resolveTenantPlacement()`. This is the concrete mechanism satisfying "a business may eventually have infrastructure choices, but the platform, not the tenant config table, controls what those choices resolve to."

### 7.7 `ChannelConnection` replaces the one-row-per-type `Channel` model (review concern 14)

The first pass modeled channels as one `Channel` row per `(businessId, type)` — meaning a business could have exactly one WhatsApp connection, one email inbox, and so on. On review this is too restrictive: a real business may run "WhatsApp Sales" and "WhatsApp Support" as separate numbers, or multiple regional inboxes. The target model:

```prisma
model ChannelConnection {
  id              String   @id @default(uuid())
  businessId      String
  business        Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  type            String                          // "whatsapp", "email", "sms", "telegram", "phone", "webchat"
  name            String                          // "WhatsApp Sales", "Support Inbox EU", ...
  isActive        Boolean  @default(false)
  isDefault       Boolean  @default(false)        // used when an inbound event doesn't disambiguate further
  status          String   @default("disconnected")
  config          Json     @default("{}")         // non-secret, typed per provider (§10.3/§16.5)
  credentialRef   String?                          // opaque SecretResolver reference — never the raw secret in this row
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([businessId, id])                       // enables composite FKs from children (§8)
  @@index([businessId, type])
}
```

A business now has **zero-to-many** `ChannelConnection` rows per type. Inbound provider identifiers — a Meta `phone_number_id`, a Twilio number, a Telegram bot ID, an IMAP account, a Web Chat widget ID — map to a **specific `ChannelConnection`**, and therefore to a specific business, via a lookup keyed on that provider identifier (stored in `config` or a dedicated indexed column per channel type, decided per-adapter at Phase 5 implementation time). `ChannelAdapter` methods that previously took `(ctx: TenantContext, ...)` alone now take `(ctx: TenantContext, connectionId: string, ...)` where a business has more than one connection of that type — see §19.1's revised contract.

---

## 8. Tenant Data Isolation

This is the section the rest of the plan's credibility rests on. The mandate is explicit: **do not** rely on developers remembering `where: { businessId }`. Following the second-pass review, isolation is no longer a two-layer story (application context + query extension) — it is a **five-layer stack**, with the fourth-listed layer new in this revision: the database's own foreign-key constraints make a cross-tenant reference physically impossible to write, independent of whether the application code that would have caught it has a bug.

```
1. TenantContext            — who is asking, resolved once per request/job, explicit at service boundaries
2. Scoped Prisma extension  — every query for a tenant model is filtered/stamped with businessId
3. Composite foreign keys   — Postgres itself refuses a row whose FK points at another tenant's parent  ◄── NEW
4. assertSameTenant()       — early, friendly application-level check (404 before the DB ever sees the write)
5. Isolation tests          — including tests that deliberately skip layer 4 to prove layer 3 alone holds  ◄── NEW
```

The ordering matters: layers 1-2 are where correct behavior is *produced*; layer 3 is where incorrect behavior is *refused* even if 1-2 have a bug; layer 4 exists purely so a caught mistake fails as a clean 404 instead of a raw Postgres constraint-violation error bubbling up; layer 5 proves all of the above, including layer 3 in isolation.

### 8.1 Why "just add `businessId` and remember to filter" is rejected

`src/lib/prisma.ts` today exports one raw `PrismaClient` singleton, imported directly by ~50+ files across `src/lib/**` and `src/app/api/**` (verified: every module read in §2 imports `{ prisma } from "@/lib/prisma"` directly). If `businessId` were simply added as a column and every existing `prisma.conversation.findMany(...)` call-site were hand-edited to add a `where: { businessId }` clause, the very next PR that adds a new query — written by someone who has not read this document — has better-than-even odds of forgetting it, because **nothing stops the unscoped query from compiling, running, and returning another tenant's rows.** This is precisely the "catastrophic cross-tenant leak" failure mode the product brief calls out, and it is not hypothetical: `AUDIT.md` and §2 both show this codebase already has a pattern of "the safe path exists, but nothing enforces taking it" (see the `requireAuth` bypass in §2.2 — same failure shape, different layer).

### 8.2 Layer 1 — `TenantContext`: explicit at service boundaries, `AsyncLocalStorage` as a backstop (review concern 2)

The first pass of this plan leaned on `AsyncLocalStorage` as the primary way `TenantContext` reached every function, reasoning that today's functions (`chat()`, `resolveCustomer()`, every tool executor in `tools.ts`) take no context parameter at all, and retrofitting one everywhere at once would be large and error-prone. On review, this goes too far: a function whose signature gives no hint that it is tenant-specific is harder to read, harder to unit-test in isolation (a test must remember to wrap every call in `runWithTenantContext`, with no compiler help if it forgets), and easier to accidentally call from a context where no tenant is active. The revised rule:

- **Application-service functions take `ctx: TenantContext` as an explicit first parameter.** `service.execute(ctx, input)`, `processInboundMessage(ctx, event)`, `getScopedPrisma(ctx)` — every boundary a route handler, worker, or one module crosses into another is explicit. This is the shape used everywhere in §16 and §18's revised flows.
- **`AsyncLocalStorage` is retained, but narrowed to three specific, cross-cutting jobs**, none of which is "be the primary way business logic learns its own tenant": (a) attaching `businessId`/`correlationId` to structured log lines without threading a logger parameter through every call (§37); (b) a convenience accessor for a small number of genuinely infrastructural entry points (e.g., middleware constructing the context in the first place, before any explicit parameter exists to pass it through); and (c) a **defense-in-depth backstop inside the Prisma extension itself** — if `getScopedPrisma()` is ever called without an explicit `ctx` (a bug), the extension falls back to `AsyncLocalStorage.getStore()` and, if that too is empty, throws immediately rather than running unscoped (this backstop is what makes an accidentally-context-less call fail loudly instead of silently returning unfiltered data — it is a safety net, not the intended call path).

```ts
// src/lib/tenancy/context.ts
export interface TenantContext {
  businessId: string;
  role: string | null;                 // resolved membership role for a human actor; null for AI/system actors
  actor: ExecutionPrincipal;            // §9.5 — user | api_key | channel_credential | ai_agent | system_job | platform_admin
  dataConnection: string;               // resolved data-plane connection key, from TenantPlacement (§7.5) — opaque to callers
}

const storage = new AsyncLocalStorage<TenantContext>();

// Called once, at the true edge (middleware, worker job-pickup) — NOT sprinkled through business logic.
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

// Backstop only — application code should already have `ctx` explicitly in scope and should not need this.
function getBackstopTenantContext(): TenantContext | undefined {
  return storage.getStore();
}
```

### 8.3 Layer 2 — a tenant-scoped Prisma client built with `prisma.$extends`

Rather than a bespoke repository class per model (which the codebase does not have today and which would be a large surface to build and keep in sync with 15+ tenant-owned models), a single Prisma Client Extension intercepts query operations for a declared list of tenant-owned models and:

- injects `businessId: ctx.businessId` into every `where` clause (`findMany`, `findFirst`, `count`, `updateMany`, `deleteMany`);
- rewrites `findUnique({ where: { id } })` into `findFirst({ where: { id, businessId } })` — this is the specific fix for the "IDOR via a guessed/known UUID" class of bug the prompt's §25 example describes, because it makes "look up by ID alone" structurally impossible for tenant-owned models, not just discouraged;
- injects `businessId: ctx.businessId` into every `create`'s `data`, and rejects (throws) a `create` that already specifies a *different* `businessId`;
- **takes `ctx` as an explicit constructor argument (`getScopedPrisma(ctx)`), never reading it implicitly** — per §8.2's revised rule — and falls back to the `AsyncLocalStorage` backstop, then throws, only if `ctx` genuinely was not passed (fail closed, not fail open).

```ts
// src/lib/tenancy/scoped-prisma.ts
const TENANT_SCOPED_MODELS = [
  "customer", "conversation", "message", "ticket", "tag", "conversationTag",
  "internalNote", "callLog", "channelConnection", "schedule",
  "webhook", "webhookDelivery", "activityLog", "sLARule", "cannedResponse",
  "automationRule", "campaign", "flow", "apiKey", "category", "knowledgeEntry",
  "department", "teamMember", "actionExecution", "businessConfig",
  "inboundEventReceipt",
] as const;

export function getScopedPrisma(ctx: TenantContext) {
  const client = getDataPlaneClient(ctx.dataConnection);   // §7.5 — resolved connection, cached
  return client.$extends({
    query: {
      $allModels: {
        async findUnique({ model, args, query }) {
          if (!isTenantScoped(model)) return query(args);
          return client[uncap(model)].findFirst({ ...args, where: { ...args.where, businessId: ctx.businessId } });
        },
        async findMany({ model, args, query }) { return query(withTenantWhere(model, args, ctx)); },
        async create({ model, args, query }) { return query(withTenantData(model, args, ctx)); },
        async update({ model, args, query }) { return query(withTenantWhere(model, args, ctx)); },
        async updateMany({ model, args, query }) { return query(withTenantWhere(model, args, ctx)); },
        async delete({ model, args, query }) { return query(withTenantWhere(model, args, ctx)); },
        async deleteMany({ model, args, query }) { return query(withTenantWhere(model, args, ctx)); },
        async count({ model, args, query }) { return query(withTenantWhere(model, args, ctx)); },
      },
    },
  });
}
```

(This is illustrative pseudocode for the plan; the exact Prisma 7 extension API surface — `query.$allModels` context shape — must be validated against installed `@prisma/client` types once `node_modules` exists, Phase 0 task. Per Principle 2/§4's guidance on not over-specifying an interface before implementation, this is the one place in this plan where the pseudocode is explicitly a sketch, not a signature to build against verbatim.)

**Layer 2's escape-hatch closure (unchanged from the first pass):** the raw `prisma` export from `src/lib/prisma.ts` must become unimportable from application/domain code — renamed to `src/lib/prisma/raw-client.ts` (infrastructure-only), with an ESLint rule (`no-restricted-imports` or a small custom rule) forbidding its import outside a narrow allowlist (the extension factory itself, migration/seed scripts, genuinely platform-scoped queries). This turns "forgot the tenant filter" from a silent runtime bug into a **build-time lint failure**.

### 8.4 Layer 3 — composite tenant-aware foreign keys, enforced by Postgres itself (review concern 1, new in this revision)

Layers 1-2 are application code. Application code can have bugs. The review's core concern — cross-tenant *reference* creation (e.g., `Ticket.assignedToId` pointing at a `TeamMember` row owned by a different business) — was originally caught only by an application-level `assertSameTenant()` helper (now layer 4, §8.5). That is a real and useful check, but it is not a **structural** guarantee in the sense the rest of this section insists on: a new code path that constructs a `Ticket` without calling `assertSameTenant()` first (a forgotten call, exactly the failure mode §8.1 describes) would still write a cross-tenant reference successfully, because nothing at the database level would refuse it.

The fix adopted in this revision: every tenant-owned model that is *referenced* by another tenant-owned model as a foreign key gets a **composite unique constraint on `(businessId, id)`**, and every child referencing it uses a **composite foreign key on `(businessId, <fkId>)`** instead of a bare `id` foreign key:

```prisma
model TeamMember {
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  departmentId String
  department   Department @relation(fields: [businessId, departmentId], references: [businessId, id])
  // ...
  @@unique([businessId, id])   // ← lets children hold a composite FK into THIS row
}

model Ticket {
  id             String   @id @default(uuid())
  businessId     String
  business       Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  assignedToId   String?
  assignedTo     TeamMember? @relation(fields: [businessId, assignedToId], references: [businessId, id])
  departmentId   String?
  department     Department? @relation(fields: [businessId, departmentId], references: [businessId, id])
  conversationId String?
  conversation   Conversation? @relation(fields: [businessId, conversationId], references: [businessId, id])
  // ...
}
```

With this shape, **it is not merely discouraged but physically impossible** for a `Ticket` row belonging to Business A to reference a `TeamMember` belonging to Business B: Postgres's own foreign-key constraint requires the referenced `(businessId, id)` pair to exist, and Business B's `TeamMember` row has Business B's `businessId`, not Business A's. A write that tries this fails with a standard Postgres foreign-key-violation error, regardless of whether the code that produced it went through the Prisma extension correctly, forgot `assertSameTenant()`, or was a raw SQL statement run by mistake during an incident.

**Every relation in §12's data model that is both (a) tenant-owned and (b) referenced by another tenant-owned model gets this treatment**, specifically:

| Parent gets `@@unique([businessId, id])` | Children hold a composite FK `(businessId, <fk>)` into it |
|---|---|
| `TeamMember` | `Ticket.assignedToId`, `Schedule.teamMemberId` |
| `Department` | `TeamMember.departmentId`, `Ticket.departmentId` |
| `Category` | `KnowledgeEntry.categoryId` |
| `Conversation` | `Message.conversationId`, `Ticket.conversationId`, `InternalNote.conversationId`, `ConversationTag.conversationId` |
| `Customer` | `Conversation.customerId`, `CustomerNote.customerId` |
| `Tag` | `ConversationTag.tagId` |
| `Webhook` | `WebhookDelivery.webhookId` |
| `ChannelConnection` | (future) any model that records "which connection did this arrive through" |

This is not a universal rule applied to every table indiscriminately — `ActivityLog.entity`/`entityId` remains intentionally polymorphic (§2.8) precisely because it must reference many different model types by design, and a composite FK cannot express "references one of N different tables"; that relation stays protected by layers 1-2-4-5 only, which is an explicit, reasoned exception, not an oversight. `Business` itself, `User`, and platform/control-plane tables are outside this scheme entirely, since they are not tenant-owned data being isolated from other tenants.

### 8.5 Layer 4 — `assertSameTenant()`: early, friendly validation (retained, now explicitly non-primary)

The application-level check from the first pass is retained, but its role is now explicitly secondary to layer 3, not a substitute for it:

```ts
// domain-layer helper — called before any create/update that sets a tenant-owned FK,
// so a cross-tenant reference fails as a clean 404 in application code, before it would
// otherwise reach Postgres and fail as a raw foreign-key-violation error (layer 3 still
// catches it either way — this layer exists for a better failure experience, not as the
// last line of defense)
async function assertSameTenant(db: ScopedPrisma, model: TenantModel, id: string): Promise<void> {
  const row = await db[model].findUnique({ where: { id } }); // already tenant-filtered by the extension
  if (!row) throw new NotFoundError(model, id);               // cross-tenant reference → indistinguishable from "not found"
}
```

Every application-service function that accepts a foreign-key ID from a client request (assign ticket → `assignedToId`, create ticket → `departmentId`, transfer conversation → `toMemberId`, tag conversation → `tagId`, trigger webhook → `webhookId`) still calls this before writing, for the better error experience — but Phase 2's acceptance criteria (§46.2) now also requires a **direct test that skips this helper on purpose** and confirms Postgres's own constraint (layer 3) rejects the write regardless, closing the gap the review identified: application validation is useful, but it is explicitly not treated as the final barrier.

### 8.6 Layer 5 — isolation tests, including deliberate layer-4 bypass (extended, see also §33)

§33 gives the full test matrix. The addition specific to this section: for every relation in §8.4's table, the isolation suite includes one test that constructs the cross-tenant write **directly against `getScopedPrisma(ctx)`**, bypassing the service-layer function (and therefore `assertSameTenant()`) entirely, and asserts the write fails with a database constraint violation — this is the literal "deliberately bypass application helpers and prove PostgreSQL itself rejects cross-tenant references" test the review calls for.

### 8.7 Example request/query flow with all layers applied

```
GET /api/customers/{id}
   │
   ▼
requireAuth() + resolveIdentity() + resolveMembership() + resolveTenantPlacement()
   →  TenantContext { businessId: "biz_A", role: "agent", actor: {...}, dataConnection: "shared-default" }
   │
   ▼
customersService.getById(ctx, id)                          ◄── ctx explicit, §8.2
   │
   ▼
const db = getScopedPrisma(ctx);
return db.customer.findUnique({ where: { id } });   // ← extension rewrites to findFirst({ where: { id, businessId: "biz_A" } })
   │
   ▼
If the customer belongs to biz_B: Prisma returns null (not an error, not the row) → route returns 404
   │
   ▼
Business A can never distinguish "wrong ID" from "someone else's ID" — both are 404.
This is intentional: a 403 would confirm the ID exists, leaking existence across tenants (§33.3).
```

### 8.8 Row-Level Security (Postgres RLS) — evaluated, deferred to Phase 9 as defense-in-depth only

RLS was seriously considered as an additional layer now, not only as the primary mechanism. It remains not recommended as a layer used by every tenant today, for reasons specific to this codebase:

- Prisma's `PrismaPg` driver adapter (already in use) pools connections; RLS session variables (`SET LOCAL app.tenant_id = ...`) must be set **per logical request inside a transaction** to be safe under a pooled/shared connection, which means wrapping every single request in an explicit `$transaction` purely to set a session variable — a meaningful throughput cost for the ~100% of businesses sharing the default database, on top of the four layers already described above.
- With composite foreign keys now providing a genuine, independent, database-enforced layer (§8.4) at effectively zero runtime cost (it is a standard constraint check Postgres already does for every FK), the marginal safety RLS would add for shared-schema tenants is small relative to its cost — a materially different calculus than in the first pass, where the extension was the *only* database-adjacent layer.
- RLS remains genuinely valuable as an **additional layer for tenants on dedicated database connections** (Phase 9, §46.9), where the per-tenant connection is already distinct and the `SET`-per-transaction cost is not a shared-pool concern, and where a business may specifically want to be able to tell auditors "even a compromised application server cannot cross-tenant-read at the database level" for a database that holds only their data.

**Recommendation (updated):** `TenantContext` + Prisma Client Extension + **composite foreign keys** + `assertSameTenant()` + isolation tests for all tenants, from Phase 1-2 onward (four of the five layers active for every business, including shared-schema ones); Postgres RLS as a fifth, opt-in layer for dedicated-database tenants in Phase 9. This still matches Principle 2 (§4): the four-layer baseline solves the actual, present problem for 100% of tenants at negligible cost; RLS solves an additional, narrower problem for a small future subset at a cost that is only justified once that subset has its own dedicated connection anyway.

### 8.9 What this does *not* solve, and how those gaps are closed elsewhere

- **Realtime/SSE subscriptions** are not Prisma queries — tenant scoping there is a separate mechanism (channel-name namespacing, §26).
- **Object storage keys** are not Prisma queries — tenant scoping there is prefix-based, enforced in the `ObjectStorage` adapter itself (§27).
- **Job queue payloads** are not Prisma queries — every job payload carries `businessId` and the worker resolves `TenantContext` from it before running the handler (§25), so job handlers get the same five-layer protection as request handlers, including the composite-FK layer, since the worker uses the identical `getScopedPrisma(ctx)` path.
- **Raw `$queryRaw`/`$executeRaw` calls**, if any are ever introduced (none exist today — verified, no raw SQL in the current codebase), bypass layers 1-2 entirely but are **still caught by layer 3** if they attempt to write a cross-tenant reference into a composite-FK-protected relation — a concrete illustration of why the database-level layer matters independently. The lint rule in §8.3 must also flag raw-SQL usage in domain code for manual review; this plan does not recommend banning raw SQL outright since it is sometimes necessary for performance (e.g., future pgvector queries, §22), but every such call site must manually include the tenant filter and is called out for extra scrutiny in code review (§46.2 acceptance criteria).

---

## 9. User / Membership / Role Architecture

### 9.1 Identity kinds (distinct from each other, not layered as one hierarchy)

| Identity kind | Represents | Has a `Membership`? | Example |
|---|---|---|---|
| Platform administrator | Ziyrak's own staff operating the platform | No — platform admins are marked on `User` (e.g., `User.isPlatformAdmin: Boolean`) or via a separate `PlatformRole` table if platform roles need to be more than binary later | Suspend a business, view platform-wide health |
| Business owner | The user who created/owns the business | Yes — `Membership.role = "owner"` | Sole ability to delete the business, transfer ownership, manage billing |
| Business admin | Full operational control within one business | Yes — `Membership.role = "admin"` | Manage settings, users, channels, knowledge |
| Business supervisor | Operational oversight, no destructive/billing power | Yes — `Membership.role = "supervisor"` | Manage team, view analytics, resolve escalations |
| Business agent | Day-to-day conversation handling | Yes — `Membership.role = "agent"` | Reply to customers, create tickets |
| Business viewer | Read-only | Yes — `Membership.role = "viewer"` | Reporting-only access |
| API/service identity | Programmatic access on behalf of a business | No `Membership` — `ApiKey.businessId` directly, with an optional `ApiKey.role` narrower than full admin | Integrations, scripts |
| Channel credential | The business's own channel account acting as itself (inbound webhook auth) | No `Membership` — `ChannelConnection.businessId` directly | Meta/Twilio/Telegram/widget signature → resolves to a business, not a person |
| **AI agent** *(new, §9.5)* | Ziyrak's own AI acting within a conversation, on the business's behalf | No `Membership` — governed by `ToolPolicy`, not RBAC | The AI calls `create_ticket` during a customer conversation |
| **System job** *(new, §9.5)* | A background worker executing scheduled/durable work | No `Membership` — resolves a `TenantContext` from the job payload's `businessId` | The retention sweep, a scheduled follow-up send |

This directly preserves the four-role additive model already proven out in `rbac.ts` (`viewer < agent < supervisor < admin`), adding **`owner`** as a fifth, business-scoped-only role above `admin` for the handful of operations that must have exactly one accountable party per business (deleting the business, transferring ownership, eventually managing billing/plan). `owner` inherits all `admin` permissions (extends the existing additive `ROLES` array) and adds a small set of owner-only permissions (`business:delete`, `business:transfer-ownership`, `business:billing`). Platform administration is **not** a business role at all — it is not "super-admin across all businesses" as a `Membership` row, precisely because the prompt requires platform administration to be conceptually and structurally separate from tenant administration (a platform admin who wants to act *as* a specific business for support purposes should do so through an explicit, audited impersonation flow — out of scope for the MVP, noted as a deferred item in §46.1).

**AI agent and system job are new, first-class rows in this table, not omissions fixed elsewhere.** The first pass of this plan resolved an AI-initiated tool call's authorization using `ctx.role`, which forced an uncomfortable choice: either give "the AI" a fake `admin`/`agent` `Membership` (over-privileging it, and misattributing its actions to a human role in the audit log), or leave the question unanswered. §9.5 below resolves this properly.

### 9.2 Why `Admin.role` (today) cannot simply gain a `businessId` column

`Admin` today has exactly one `role` string, period. A person cannot be an `admin` at Business A and a `viewer` at Business B under that model — but that is exactly the kind of scenario Ziyrak needs (e.g., a consultant helping multiple client businesses, or a Ziyrak support engineer with a supervisor-level membership in several businesses for onboarding help). This is why the role must live on `Membership`, not on `User`/`Admin` — this is a genuine data-model change, not a relabeling.

### 9.3 Authorization check shape (target)

```ts
// current shape (route-auth.ts) — role is global, permission-only
if (permission && !hasPermission(payload.role, permission)) { ... }

// target shape — role is resolved FOR the tenant in context, permission AND membership both checked
const membership = await getMembership(ctx.actor.userId, ctx.businessId); // or derived from ApiKey/ChannelConnection directly
if (!membership) return Errors.forbidden(); // no relationship to this business at all
if (permission && !hasPermission(membership.role, permission)) return Errors.forbidden();
```

`hasPermission()` itself (`rbac.ts:107-111`) requires no change — it already takes a role string and a permission and does an array-includes check. The change is entirely in *where the role comes from* (a resolved membership instead of a bare JWT claim) and the addition of the "no membership at all" branch, which has no equivalent in the current single-tenant code (today, having a valid JWT for *any* admin implies access to *the* business, because there is only one). This check applies to **human actors** (`user`, `api_key`); AI/system actors are authorized through the separate mechanism in §9.5, never through `hasPermission()`.

### 9.4 API key scoping and secure storage (fixes `route-auth.ts:31-37` and the plaintext-key finding, §2.9)

Target `ApiKey` model, revised per review concern 15:

```prisma
model ApiKey {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  name        String
  keyPrefix   String                          // e.g. "zy_live_a1b2c3d4" — safe to display/search by, not secret
  keyHash     String                          // SHA-256 (or stronger) hash of the full secret — never the secret itself
  role        String   @default("agent")      // capped below "owner", §9.1
  isActive    Boolean  @default(true)
  lastUsedAt  DateTime?
  expiresAt   DateTime?
  revokedAt   DateTime?
  createdAt   DateTime @default(now())

  @@unique([businessId, id])
  @@index([keyPrefix])
}
```

Key generation produces a secret of the shape `zy_live_<random>`; the **full** secret is shown to the user exactly once, at creation time, and never again — matching the now-standard pattern used by Stripe, GitHub, and similar platforms. `authenticateApiKey(presentedKey)` extracts the prefix (a fast, non-secret lookup to narrow the candidate row), hashes the full presented key, and compares against `keyHash` — a database compromise discloses only hashes, not reusable secrets, directly closing the finding in §2.9. `authenticateApiKey()` then resolves `{ businessId: key.businessId, role: key.role, actor: { kind: "api_key", id: key.id } }` instead of hardcoding `role: "admin"`. An API key can never be assigned `role: "owner"` (enforced at creation time), since owner-only actions (deleting the business) should never be reachable by a leaked long-lived key. `revokedAt`/`expiresAt` give immediate, first-class revocation and optional time-boxing without needing to delete the row (preserving its audit trail) — neither existed in the first pass or in current Owly.

### 9.5 `ExecutionPrincipal` and AI/system authorization — decoupled from human RBAC (review concern 5, new in this revision)

**The problem this solves:** an inbound WhatsApp customer is not a business employee with a role such as `agent` or `admin`, yet their conversation can cause the AI to request tools — `create_ticket`, `send_internal_email`, and eventually higher-stakes actions like issuing a refund or updating a CRM record. Authorizing these calls with `hasPermission(ctx.role, permission)` requires inventing a fake role for "the AI acting in this conversation," which either over-privileges the AI (if it inherits an `admin`-equivalent role for convenience) or under-capable's it (if pinned to `viewer`, it can do nothing useful). Neither is correct, because **"what a signed-in human may do" and "what the AI may do automatically on a customer's behalf" are different questions with different answers**, per Architectural Principle 12 (§4).

**The fix:** `TenantContext.actor` is a discriminated `ExecutionPrincipal`:

```ts
export type ExecutionPrincipal =
  | { kind: "user"; userId: string }
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "channel_credential"; channelConnectionId: string }
  | { kind: "ai_agent"; conversationId: string; model: string }   // the AI, acting within a specific conversation
  | { kind: "system_job"; jobId: string; jobType: string }        // a worker executing background/scheduled work
  | { kind: "platform_admin"; userId: string };
```

Authorization branches on `actor.kind`, not on trying to force every kind through `hasPermission()`:

- **`user` / `api_key`** → RBAC as described in §9.3: `Membership.role` (or `ApiKey.role`) checked against `hasPermission()`.
- **`ai_agent`** → a new, tenant-configurable **`ToolPolicy`** (one row per business per tool, §23.4) is checked instead of RBAC entirely. A tool the AI is not policy-permitted to call is simply not offered to the model (`ToolRegistry.getAvailableTools()` filters on `ToolPolicy.allowedForAI`, not on any `Membership` role) — there is no `Membership` row for the AI to have a role on, so RBAC does not apply to it at all, by design.
- **`system_job`** → background jobs run with the tenant's data access (via `TenantPlacement`, §7.5) but do not go through `hasPermission()` either; a job handler is trusted to perform exactly the operation its job type implies (e.g., `sweep-retention` deletes old conversations because that is what that job type *is*, not because some role permits it) — the safety boundary for jobs is "which job types exist and what each one is coded to do," reviewed at code-review time, not a runtime permission check.
- **`platform_admin`** → per §15.2, granted no tenant-resource permission implicitly; must act through an explicit, logged support-access grant (deferred past MVP).

`ToolPolicy` is introduced fully in §23.4; it is named here because it is the direct analog, for AI actors, of what `Membership.role` is for human actors — and the two are deliberately **independent** data: a tool can be `allowedForAI: true` while also being restricted to `["supervisor", "admin"]` for human-initiated use, or vice versa (a tool only the AI is trusted to call automatically because it is narrow and well-defined, but which no human role needs direct UI access to).

---

## 10. Configuration Architecture

### 10.1 The problem with the current `Settings` singleton

`Settings` (`prisma/schema.prisma:12-44`) is one row holding business identity fields (name/description/tone/language), AI provider/model/key, and every channel's credentials (SMTP, IMAP, Twilio, ElevenLabs, WhatsApp, Telegram) in one flat table. This conflates three genuinely different concerns that need different lifecycles and different access control: (a) business-facing configuration (tone, language, business description), (b) provider selection/tuning (model, temperature, token limits), and (c) *secrets* (every `*Key`/`*Pass`/`*Token` field). Today all three are masked identically by `maskSettingsSecrets()` (`security.ts`) and updated through one `PUT /api/settings` gated by one `settings:update` permission — fine for one business, not workable once secrets need per-channel rotation and per-business isolation.

### 10.2 Target shape

```
PlatformDefaults (code/env constants, not a DB table)
   { defaultAiProvider: "openai", defaultAiModel: "gpt-4o-mini", defaultEmbeddingProvider: "openai",
     defaultRetentionDays: 365, defaultDatabaseProfileId: "shared-default",
     defaultStorageProfileId: "shared-default" }
        │
        ▼  merged under
BusinessConfig (one row per Business — the direct successor to today's non-secret Settings fields)
   { businessId, businessName, businessDesc, welcomeMessage, tone, language,
     aiProvider?, aiModel?, embeddingProvider?, maxTokens?, temperature?  }   // all optional = "inherit platform default"
        │
        ▼  secrets and per-connection config split out entirely
ChannelConnection.config (non-secret) + credentialRef → SecretResolver (§10.3)
        │
        ▼  Phase 9 only, and NEVER a raw connection string (§7.6)
InfrastructurePolicy (one row per Business, nullable — absent = fully shared infra)
   { businessId, dataRegion?, permittedAiProviders?: string[], privateModelEndpointRef?: string }
        │  (the actual dedicated database/storage connection lives in TenantPlacement → DatabaseProfile/
        │   StorageProfile, control-plane tables — §7.5/§7.6 — not in InfrastructurePolicy itself)
```

`resolveConfig(businessId)` merges `PlatformDefaults` ← `BusinessConfig` (only defined fields override) ← `InfrastructurePolicy` (only for the constrained subset: which providers/regions are even *selectable*, not typical per-message config). This mirrors the exact example given in the product brief (Business A = all defaults, Business B = overrides `aiModel`, Business C = dedicated infrastructure) and is deliberately a small, fixed set of tables, not a generic key-value config-override engine — a generic override engine was considered and rejected as unjustified complexity (Principle 2, §4) since the set of overridable fields is small and known.

### 10.3 Secret handling — typed schemas, envelope encryption, rotation-ready (revised per review concerns 4 and 16)

Two changes from the first pass, both driven by the review:

**(a) Typed, per-provider credential schemas, not "trust arbitrary encrypted JSON."** A `ChannelConnection.credentialRef` resolves (through the `SecretResolver` below) to a payload validated against a discriminated Zod union keyed by channel type — `MetaWhatsAppCredentialSchema`, `TwilioCredentialSchema`, `TelegramCredentialSchema`, `EmailCredentialSchema`, `WebChatWidgetCredentialSchema` — so that encryption is never used as a substitute for validation. A credential blob is decrypted *and* schema-validated before a channel adapter is allowed to use it; a malformed or tampered payload fails closed with a clear error, not a runtime `undefined` deep inside an adapter.

**(b) A `SecretResolver` boundary with rotation metadata, not one eternal environment key.** Instead of storing an encrypted blob with no record of which key encrypted it:

```ts
interface EncryptedSecret {
  ciphertext: string;
  keyVersion: number;          // which platform key encrypted this payload
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
}

interface SecretResolver {
  encrypt(plaintext: string): Promise<EncryptedSecret>;   // always encrypts with the CURRENT key version
  decrypt(secret: EncryptedSecret): Promise<string>;       // looks up the key for secret.keyVersion, decrypts
  rotate(secret: EncryptedSecret): Promise<EncryptedSecret>;  // re-encrypts under the current key version
}
```

The default implementation (`EnvKeySecretResolver`) resolves keys by version from environment variables (`SECRET_KEY_V1`, `SECRET_KEY_V2`, ...), decrypts with whichever version a given payload was encrypted under, and re-encrypts under the newest version when `rotate()` is called — giving a real, if manual, key-rotation path from day one (Phase 1) without operating a key-management service. The `SecretResolver` interface is the seam a future swap to AWS KMS / GCP KMS / Azure Key Vault / HashiCorp Vault would implement, per the review's explicit "create the boundary, don't build all of those now" instruction — none of those integrations are built in this plan; only the interface and the env-backed default are. `DatabaseProfile.connectionSecretRef` and `StorageProfile.credentialSecretRef` (§7.6) resolve through the same boundary, so there is exactly one encryption/rotation mechanism in the platform, not one for channel credentials and a different one for infrastructure credentials.

This replaces today's pattern where `Settings` fields are stored in plaintext in Postgres and only masked at the API-response boundary (`maskSettingsSecrets`) — masking-at-response-time protects against accidental UI exposure but does nothing against a database-level compromise, which matters more once the database holds many businesses' credentials at once. `maskSettingsSecrets`'s masking-for-display behavior is preserved for `BusinessConfig`'s non-secret fields and for showing *that* a channel connection is configured (e.g., "WhatsApp Sales: connected, configured 3 days ago") without ever round-tripping the decrypted value to the browser.

### 10.4 Migration from `Settings`

Existing `Settings` singleton row's non-secret fields map directly onto the new default business's `BusinessConfig` row; its secret fields map onto per-channel-type `ChannelConnection` rows (one default connection per configured channel) for that same default business, encrypted via `SecretResolver` at migration time (key version 1). Detailed column-by-column mapping and rollback plan in §13 and §46.1.

---

## 11. Tenant Infrastructure Overrides

### 11.1 What "override" means concretely, per boundary

| Boundary | Default (shared) | Override mechanism (Phase 9, §46.9) |
|---|---|---|
| AI provider | Platform default (`AIProviderRegistry.get(businessConfig.aiProvider ?? platformDefault)`) | `BusinessConfig.aiProvider` already supports this from Phase 4 on — no Phase 9 work needed here, this override exists from day one of the provider abstraction |
| Embedding provider | Platform default (`EmbeddingProviderRegistry.get(...)`, §21.5) | Same mechanism as AI provider — `BusinessConfig.embeddingProvider`, available from Phase 4 |
| Database | `TenantPlacement.databaseProfileId = "shared-default"` (§7.5) | A new `DatabaseProfile` row is provisioned, and `TenantPlacement.databaseProfileId` is updated to point at it — the connection secret lives only in `DatabaseProfile.connectionSecretRef`, resolved through `SecretResolver` (§7.6, §10.3), never copied into tenant-facing config |
| Object storage | `TenantPlacement.storageProfileId = "shared-default"` | Same pattern — a new `StorageProfile` row, referenced by ID |
| Region | Not enforced (single deployment region) | `InfrastructurePolicy.dataRegion` gates which region a business's `DatabaseProfile`/`StorageProfile` are provisioned in — this plan does not implement multi-region deployment itself (out of scope), only the config field and the provisioning contract a future multi-region rollout would read |
| Redis/cache | Shared Redis (Phase 8) | Not planned as a per-tenant override — cache/rate-limit are not compliance-sensitive in the same way; a business needing full infra isolation would get a dedicated deployment stamp entirely (out of scope for this plan, noted as a future "single-tenant deployment" product tier if ever needed) |

### 11.2 How this stays cheap until it's needed

Every override in §11.1 is resolved through the **same two-hop lookup every business already uses** — `TenantPlacement` (or `InfrastructurePolicy` for provider/region constraints) → a profile ID → a resolved connection/credential — not a parallel code path that only exists for special tenants. `resolveTenantPlacement(businessId)`, `getObjectStorageForTenant(businessId)`, and `getAIProviderForTenant(businessConfig)` are the only functions that ever branch on "does this tenant have an override," and for ~100% of businesses pre-Phase-9 they resolve to the literal string `"shared-default"` and the platform's own connection — application/domain code never branches on tenant-infra-policy itself. This means Phase 1-8 ship with `InfrastructurePolicy` not existing at all (deferred to Phase 9, §46.9) with zero rework required later: the resolvers are written from Phase 1 onward (via `TenantPlacement`, introduced in the same phase as `Business` itself — see §7.4) to *already* take a `businessId` and resolve "the shared default" in every case, so adding the override branch in Phase 9 is additive — provisioning new `DatabaseProfile`/`StorageProfile`/`InfrastructurePolicy` rows for one business — not a refactor of call sites.

---

## 12. Target Data Model

Legend: **[new]** net-new model · **[split]** replaces part of an existing model · **[+businessId]** existing model gains a required tenant-owning FK · **[relation via parent]** tenant ownership is inherited through an existing required parent relation (denormalized `businessId` still added, per the rule below) · **[CP]** control-plane model, not tenant-owned data (§7.4) · **[composite FK target]** other tenant-owned models hold a composite `(businessId, thisId)` foreign key into this model (§8.4).

| Model | Change | Tenant ownership | Notes |
|---|---|---|---|
| `Business` | **[new]** | is the tenant | §7 |
| `User` | **[new]**, replaces `Admin` | not tenant-owned (belongs to 0..N businesses via `Membership`) | §9, §13 |
| `Membership` | **[new]** | owned by `Business` (join) | §9 |
| `TenantPlacement` | **[new] [CP]** | control-plane, one row per business | §7.5 |
| `DatabaseProfile` | **[new] [CP]** | control-plane, not tenant-owned | §7.6 |
| `StorageProfile` | **[new] [CP]** | control-plane, not tenant-owned | §7.6 |
| `InfrastructurePolicy` | **[new] [CP]**, Phase 9 only | control-plane, 1:1 with `Business`, nullable | §11 — holds constraints/region, never raw credentials |
| `ApiKey` | **[+businessId]**, secret storage rewritten | direct | gains `businessId`, `role`, `keyPrefix`+`keyHash` (replaces plaintext `key`), `revokedAt`/`expiresAt` — §9.4 |
| `ChannelConnection` | **[new]**, replaces the old one-row-per-type `Channel` model entirely | direct **[composite FK target]** | §7.7 — many per business per type; absorbs `Channel` |
| `BusinessConfig` | **[new]**, absorbs non-secret fields out of `Settings` | direct (1:1 with `Business`) | §10 |
| `Customer` | **[+businessId]** | direct **[composite FK target]** | index `(businessId, phone)`, `(businessId, email)`, `(businessId, whatsapp)`; `@@unique([businessId, id])` |
| `CustomerNote` | **[relation via parent]** | inherited via `Customer`, denormalized `businessId`, composite FK `(businessId, customerId) → Customer` | §8.4 |
| `Conversation` | **[+businessId]** | direct **[composite FK target]** | `@@unique([businessId, id])`, composite FK to `Customer` |
| `Message` | **[+businessId]** (denormalized) | direct + inherited, composite FK `(businessId, conversationId) → Conversation` | |
| `Ticket` | **[+businessId]** | direct, composite FKs to `Conversation`, `Department`, `TeamMember` | §8.4's worked example |
| `Tag` | **[+businessId]** | direct **[composite FK target]** | `@@unique([businessId, name])`, `@@unique([businessId, id])` |
| `ConversationTag` | **[+businessId]** | direct, composite FKs to `Conversation` and `Tag` | |
| `InternalNote` | **[+businessId]** | inherited via `Conversation`, denormalized, composite FK | |
| `CallLog` | **[+businessId]**, gains a real (composite) FK to `Conversation` (fixing §2.8's missing-relation finding) | direct | schema-quality fix bundled with the tenant migration |
| `Schedule` | **[+businessId]**, gains a real composite FK to `TeamMember` (fixing §2.8) | direct | bundled schema-quality fix |
| `Webhook` | **[+businessId]** | direct **[composite FK target]** | `@@unique([businessId, id])` |
| `WebhookDelivery` | **[+businessId]** | inherited via `Webhook`, denormalized, composite FK | |
| `ActivityLog` | **[+businessId]** | direct | remains polymorphic (`entity`/`entityId`) by design — explicitly excluded from composite-FK treatment (§8.4) since it must reference many different model types; protected by layers 1-2-4-5 only |
| `SLARule` | **[+businessId]** | direct | |
| `CannedResponse` | **[+businessId]** | direct | |
| `Category` | **[+businessId]** | direct **[composite FK target]** | `@@unique([businessId, id])` |
| `KnowledgeEntry` | **[+businessId]** (denormalized), embedding storage revisited §22 | direct + inherited, composite FK to `Category` | |
| `Department` | **[+businessId]** | direct **[composite FK target]** | `@@unique([businessId, id])` |
| `TeamMember` | **[+businessId]** | inherited via `Department`, denormalized, composite FK to `Department`, **[composite FK target]** itself for `Ticket`/`Schedule` | `@@unique([businessId, id])` |
| `AutomationRule` | **[+businessId]** | direct | |
| `Campaign` | **[+businessId]** | direct | |
| `Flow` | **[+businessId]** | direct | retained, disconnected from tenant UI (§44.2) |
| `BusinessHours` | **[split]** — singleton retired, one row per `Business` | direct | `@id @default("default")` → `@id @default(uuid())` + `@@unique([businessId])` |
| `ActionExecution` | **[new]** | direct | §23-24, gains `status: "pending_approval"` (§9.5/§24.3) and an attempt-scoped `idempotencyKey` (§24.4) |
| `InboundEventReceipt` | **[new]** | direct | §17, §31 — `@@unique([businessId, source, externalEventId])`, dedup gate for every channel adapter |
| `ToolPolicy` | **[new]** | direct | §23.4 — `{businessId, tool, enabledForTenant, allowedForAI, allowedForHumanRoles, requiresHumanApproval}` |

**Fields intentionally not carried forward as-is:** `Admin.role` (replaced by `Membership.role`, §9); `Settings` as a single model (split into `BusinessConfig` + `ChannelConnection`, §10); `ApiKey.key` as a plaintext-recoverable secret (replaced by `keyPrefix`+`keyHash`, §9.4); `Channel` as a one-row-per-type model (replaced by `ChannelConnection`, §7.7). All are additive/renaming migrations with a clear source→target column mapping (§13), not data loss.

---

## 13. Data Migration Strategy

### 13.1 Guiding rule

Every business currently using this single-tenant installation becomes exactly one row in `Business` — a **"Default Business"** — and every existing row in every table gets backfilled with that business's ID. Nothing is deleted. This directly satisfies the instruction not to discard existing data absent a strong reason, and keeps existing dev/seed/demo data (and, for a real self-hosted Owly deployment being migrated to Ziyrak, the operator's actual production data) intact and queryable exactly as before, just now tenant-scoped.

### 13.2 Migration sequence (expand → backfill → contract, applied per Prisma migration)

This is the standard safe pattern for adding a required column to populated tables, applied consistently across all tables in §12, **extended in this revision with an explicit composite-key step (2b) before the final contract**:

1. **Expand:** add `businessId` as **nullable** to every affected table (a schema migration that cannot fail on existing rows).
2. **Seed:** create the one `Business` row ("Default Business"), its `TenantPlacement` row (`databaseProfileId`/`storageProfileId = "shared-default"`, §7.5), plus a `User`+`Membership(role: "owner")` derived from the existing single `Admin` row with the lowest `createdAt` (i.e., whoever set up the instance first) — script, not manual SQL, so it is repeatable and testable.
2b. **Introduce control-plane tables:** create `DatabaseProfile`/`StorageProfile` with the single `"shared-default"` row each, pointing (via `SecretResolver`, §10.3) at the same connection string/bucket the application already uses — this is the step that makes §7.4-7.6's control-plane/data-plane distinction real in the schema from Phase 1, even though both planes remain the same physical database.
3. **Backfill:** `UPDATE <table> SET "businessId" = '<default-business-id>' WHERE "businessId" IS NULL` for every table, in dependency order (parents before children where denormalization requires reading a parent's already-backfilled `businessId`, e.g. `Message.businessId` copied from its `Conversation.businessId`).
4. **Verify:** a verification script asserts `SELECT count(*) FROM <table> WHERE "businessId" IS NULL` is zero for every table before proceeding — migration is refused (fails loudly) if any row was missed, rather than silently contracting the column to `NOT NULL` and having Postgres reject the migration mid-way (which would leave the schema in a partially-migrated state).
5. **Contract (non-composite):** alter `businessId` to `NOT NULL` and add the simple FK constraint + indexes for every table, once step 4 confirms zero nulls remain.
6. **Contract (composite, new in this revision):** for every relation named in §8.4's table, add `@@unique([businessId, id])` to the parent and replace the child's bare FK with a composite `(businessId, <fkId>) → Parent(businessId, id)` FK. Because every row in both tables now shares the same single `businessId` (the Default Business), this step is guaranteed to succeed against the just-backfilled data — there is no possible cross-tenant reference to violate the new constraint yet, since there is only one tenant. This is the ideal, lowest-risk moment to introduce the composite constraints: before a second business's data ever coexists in these tables.
7. **Split `Settings` → `BusinessConfig` + `ChannelConnection`:** read the singleton `Settings` row, write its non-secret fields into a new `BusinessConfig` row for the Default Business, write each configured channel's secret fields into a `ChannelConnection` row per channel type (encrypted via `SecretResolver`, key version 1 — skip channels with empty/default credentials — no need to create a row for a channel that was never configured). The old `Settings` table is **not dropped** in the same migration — it is kept, unused, for one full release cycle as a rollback safety net, then dropped in a follow-up migration once the new path has run in production without issue (explicit two-step removal, not immediate).
8. **Split `Admin` → `User` + `Membership`:** for each existing `Admin` row, create a `User` row (carrying username/password-hash/name) and a `Membership` row linking it to the Default Business with a role derived from `Admin.role` (`admin`→`admin`, the earliest-created admin additionally gets `owner`; any `Admin.role` value that is not one of the four real RBAC roles — e.g., the `"editor"` bug identified in §2.4 — is mapped to `viewer` as the safe default and flagged in the migration's output log for manual review, since `"editor"` today grants effectively zero permissions anyway per §2.4's analysis, so downgrading to `viewer` is not a privilege reduction in practice).
9. **`BusinessHours` singleton → per-business row:** analogous to `Settings`, the `id: "default"` row is copied into a new `businessId`-owned row for the Default Business; the primary key generation changes from `@default("default")` to `@default(uuid())`.
10. **`ApiKey` secret rewrite:** for each existing `ApiKey` row, the plaintext `key` **cannot** be migrated into `keyHash` (a hash is one-way by design) — existing API keys are therefore invalidated at migration time, and the migration output explicitly lists every invalidated key's `name`/`id` so an operator can issue replacement keys to whichever integrations were using them. This is a genuine, unavoidable breaking change for existing API key holders, called out prominently in the migration runbook rather than silently done.

### 13.3 Rollback considerations — corrected language (review concern 17)

The first pass of this plan described `prisma migrate resolve` as a way to "roll back" a failed migration step. **This is corrected in this revision: it is not accurate, and the language is removed.** `prisma migrate resolve` marks a migration as applied or rolled-back **in Prisma's own migration-history bookkeeping table** — it does not undo any data change the migration already made, and it does not restore dropped columns or reverse `UPDATE`/backfill statements. Treating it as a data-safe downgrade mechanism would be a dangerous misunderstanding for a migration sequence that touches every table in the schema.

The actual rollback strategy for this phase, stated without ambiguity:

1. **A full, verified database backup immediately before running the migration sequence is the primary rollback mechanism**, in any environment containing real data — not optional, and not satisfied by "the migrations are in separate files." If step N fails or produces unexpected results, the response is to restore from that backup, not to attempt a partial in-place undo.
2. **The restore procedure is rehearsed against staging (or the most realistic non-production copy of the data available) before it is ever needed against real data.** A backup that has never been restored is not a verified rollback plan — this phase's acceptance criteria (§46.1) requires a documented, executed restore rehearsal, not just the existence of a backup file.
3. Where a specific step is naturally reversible without a full restore — e.g., step 6's composite-FK addition, which can be dropped with a simple `ALTER TABLE ... DROP CONSTRAINT` if it turns out to be wrong, since it adds a constraint rather than transforming data — that step's own migration file includes the down-migration for that narrow case. This is the exception, not the general rollback strategy.
4. For any step that *cannot* be cleanly reversed by dropping what it added (the `Settings`→`BusinessConfig`/`ChannelConnection` split, the `Admin`→`User`/`Membership` split, the `ApiKey` secret rewrite), the plan explicitly relies on (1) and (2), plus the two-step, delayed-drop pattern already used for `Settings`/`BusinessHours` (step 7/9) so there is a real, tested "old data still exists" window before anything is irreversibly removed. A **forward-compensating migration** (a new migration that fixes a problem discovered after the fact, rather than an attempt to literally undo a prior one) is the documented path for issues found after this window has closed.

### 13.4 Validating migration correctness

A post-migration verification suite (new, part of Phase 1's test-first work, §46.1) asserts, for a snapshot of pre-migration data restored into a scratch database:
- row counts per table are identical before/after (no silent row loss);
- every row's new `businessId` equals the Default Business's ID (single-tenant invariant, checked exhaustively, not sampled);
- every `Admin`→`User`/`Membership` mapping preserves `username`+password hash bit-for-bit (login must keep working with the same password post-migration — verified by an integration test that logs in with a pre-migration seeded password after running the migration);
- `Settings`→`BusinessConfig`/`ChannelConnection` round-trips every non-empty field with no value loss (verified field-by-field, not just "the row exists");
- every composite `@@unique([businessId, id])` constraint and every composite foreign key introduced in step 6 exists on the resulting schema, verified by introspecting `information_schema` rather than trusting the migration file alone;
- the restore rehearsal required by §13.3(2) has been executed at least once against the staging environment, with its outcome recorded (this is a runbook checklist item, not something an automated test can assert on its own).

---

## 14. Authentication Architecture

### 14.1 Close the structural-vs-real verification gap at the source

`middleware.ts` (§2.2) must call the same real `verifyToken()` used by `route-auth.ts`, not a dot-count check. This alone does not make routes secure by default (a valid-but-irrelevant token would still pass), so it is paired with the second change below.

### 14.2 Secure-by-default routing (allowlist, not per-route opt-in)

Today, a route is protected only if its author remembers to call `requireAuth()` — an opt-in model, and §2.2 shows real routes that forgot. The target flips this: `middleware.ts` maintains an explicit, small **allowlist** of public paths (`/login`, `/setup`, `/api/auth`, `/api/health`, `/api/openapi.json`, plus channel webhook paths that authenticate via provider signature instead of JWT/API key, plus the Web Chat widget's own narrow public endpoint — §19/§20) and treats every other path — by default — as requiring a resolved identity *before the route handler runs*, not just a structurally-valid cookie. Concretely, middleware itself performs full JWT verification (or API-key presence-check) and attaches the resolved identity to the request (via a header or Next's request-scoped mechanism) so that route handlers receive an already-authenticated request; `requireAuth()` inside the route becomes responsible for **permission** checking (which requires DB access middleware cannot cheaply do) but no longer bears sole responsibility for **authentication**. This closes the exact bypass class in §2.2 structurally: a route handler that forgets to call anything is now still behind middleware's real check, because middleware itself rejects unauthenticated requests to any non-allowlisted path before the handler is invoked.

A CI-enforced test (§46.0/§46.2) walks every file under `src/app/api/**/route.ts`, checks it is either on the public allowlist or imports `requireAuth`/relies on middleware-attached identity, and fails the build if a new route matches neither — turning "a developer forgot" into a caught-at-CI-time defect rather than a production incident, mirroring the same lint-enforcement pattern used for tenant isolation (§8.3).

### 14.3 Channel webhook authentication (signature-based, mapped to a tenant via `ChannelConnection`)

Provider-signed webhooks (Meta/WhatsApp, Twilio, Telegram) and the Web Chat widget's publishable-token requests remain exempt from the JWT/API-key check (as today's provider webhooks are) but change in one important way: signature/token verification must resolve **which business** the inbound request belongs to (via the `ChannelConnection` that matches the webhook's phone-number-ID/account-SID/bot-token/widget-ID) *before* any business data is touched, and that resolution itself becomes part of `TenantContext` construction (§7, §8) rather than implicit "there is only one business" as today. An inbound webhook whose credentials don't match any `ChannelConnection` row is rejected at the adapter boundary — see §19. This resolution is also where `InboundEventReceipt` deduplication happens (§17, §31) — signature verification and dedup both run before any `Customer`/`Conversation` row is touched, in that order (a forged request should never even reach the dedup check).

### 14.4 Platform vs. business identity, and AI/system identity, at the auth layer

`generateToken(userId, role)` (`auth.ts:31-33`) signs a bare `{ userId, role }`. Target: `generateToken(userId)` signs only `{ userId }` — **no role in the token at all**, because role is now tenant-relative (§9) and must be resolved fresh per request against current `Membership` data, not cached in a 7-day-lived JWT (a role/membership change today — e.g., revoking someone's access — must take effect immediately, not after their token expires; embedding role in the JWT would reintroduce exactly the staleness problem multi-tenant membership is meant to avoid). Platform administrators are identified by a claim/flag resolved from the `User` record itself (`isPlatformAdmin`), still looked up fresh per request, not cached in the token either. AI-agent and system-job identities (§9.5) are never JWT-based at all — they are constructed directly by the orchestrator (`ai_agent`, scoped to one conversation and one AI turn) or the worker (`system_job`, scoped to one job execution) and never cross an HTTP boundary as a bearer credential.

### 14.5 Service/API identity

Unchanged in mechanism (`X-API-Key` header) but now resolves `{ businessId, role }` from the `ApiKey` row's hash-verified match (§9.4) instead of a hardcoded `role: "admin"` or a recoverable plaintext comparison.

---

## 15. Authorization Architecture

### 15.1 Two independent checks for human actors; a separate, ToolPolicy-based check for AI/system actors

```ts
export async function requireAuth(
  request: NextRequest,
  permission?: Permission
): Promise<TenantContext | NextResponse> {
  const identity = await resolveIdentity(request);              // §14: JWT / API key / channel signature
  if (!identity) return Errors.unauthorized();

  const membership = await resolveMembership(identity);          // which business, what role — §9
  if (!membership && identity.kind !== "platform_admin") return Errors.forbidden();

  const placement = await resolveTenantPlacement(membership?.businessId ?? identity.businessId); // §7.5

  const role = identity.kind === "platform_admin" ? "platform_admin" : membership!.role;
  if (permission && !hasPermission(role, permission)) return Errors.forbidden();

  return { businessId: membership?.businessId, role, actor: identity, dataConnection: placement.dataConnection }
    satisfies TenantContext;
}
```

This is a direct evolution of the existing `route-auth.ts` shape (same function name, same call-site contract at every route — `const ctx = await requireAuth(request, "resource:action"); if (!isAuthenticated(ctx)) return ctx;` is preserved verbatim as a pattern, minimizing churn across the ~63 already-correct call sites) with **membership resolution and placement resolution** inserted as new, mandatory steps. `hasPermission()` and the `PERMISSIONS` table in `rbac.ts` require no structural change — only the addition of an `owner` role above `admin` (§9.1) and a `platform_admin` pseudo-role used solely for platform-level endpoints, which is deliberately **not** granted any of the existing tenant-resource permissions by default. `requireAuth()` above is used exclusively for HTTP requests from **human/API-key actors**; `ai_agent` and `system_job` actors never call it — they are authorized through `ToolRegistry`'s `ToolPolicy` check (§9.5, §23.4), which is a structurally separate code path, not a variant branch inside `requireAuth()`.

### 15.2 Why platform admin is not "admin for every tenant"

If `platform_admin` inherited `admin`'s permissions for every business implicitly, tenant isolation would have a permanent, structural backdoor with no membership record to audit against. Any legitimate platform-support need to view a specific business's data must go through an explicit, logged action (e.g., a time-boxed support-access grant modeled as a temporary `Membership` row with a reason/expiry) rather than an implicit blanket permission — this mechanism is named here as the intended shape but is **explicitly deferred** past the MVP (§44), since Ziyrak's first customers do not require platform-support tooling; the important architectural commitment made now is that `platform_admin` gains no tenant-resource permission without an explicit `Membership`, so building the support-access-grant feature later is additive, not a security-model change.

### 15.3 Every mutating tenant-owned-FK reference is checked at two independent levels (ties back to §8.5 and §8.4)

Authorization answers "is this actor allowed to perform this kind of action," which is necessary but not sufficient — §8.5's `assertSameTenant` check answers the different question "does the *specific resource being referenced* belong to this tenant," and §8.4's composite foreign keys answer it a third, database-enforced way. All are required, and none substitutes for another: an authorization check alone ("can this agent assign tickets") does not stop the agent from assigning a ticket to a `TeamMember` ID belonging to a different business; an `assertSameTenant()` check alone does not protect a code path that forgets to call it; only the composite foreign key (§8.4) protects both cases unconditionally.

### 15.4 AI/system authorization is not a variant of §15.1 — it is `ToolPolicy` (§9.5, §23.4)

Stated once more here for emphasis, since it is the section most directly answering the review's concern 5: an `ai_agent` actor's ability to call `create_ticket` is never evaluated by asking "does role X have permission `tickets:create`" — there is no role. It is evaluated by asking "does this business's `ToolPolicy` for `create_ticket` have `allowedForAI = true`," a completely independent table with its own tenant-configurable values, detailed in §23.4.

---

## 16. Data Access Architecture

### 16.1 Layering — `ctx` explicit at every boundary (review concern 2)

```
API route handler (src/app/api/**)
   │  obtains TenantContext from requireAuth() — includes resolved dataConnection (§7.5)
   ▼
Application service function (src/lib/<module>/service.ts — new convention)
   │  signature: serviceFn(ctx: TenantContext, ...args) — ctx is an explicit parameter, always
   │  calls getScopedPrisma(ctx) internally — never imports the raw client, never reaches for
   │  AsyncLocalStorage to "find" ctx when it could simply have been passed in
   ▼
getScopedPrisma(ctx)  (§8.3)
   │  every query automatically businessId-filtered/stamped, against the resolved data-plane connection
   │  every write additionally protected by composite foreign keys at the database level (§8.4)
   ▼
Postgres (control-plane connection for control-plane models; resolved data-plane connection for the rest)
```

### 16.2 What changes for a typical existing route

Before (today, `src/app/api/customers/[id]/route.ts` pattern, verified representative of the ~63 correctly-authenticated routes):
```ts
const auth = await requireAuth(request, "customers:read");
if (!isAuthenticated(auth)) return auth;
const customer = await prisma.customer.findUnique({ where: { id } });
```

After:
```ts
const ctx = await requireAuth(request, "customers:read");   // now a TenantContext, not just {role, userId}
if (!isAuthenticated(ctx)) return ctx;
const customer = await customersService.getById(ctx, id);   // ctx passed explicitly into the service function
```

```ts
// src/lib/customers/service.ts
export async function getById(ctx: TenantContext, id: string) {
  const db = getScopedPrisma(ctx);                           // ctx passed explicitly here too
  return db.customer.findUnique({ where: { id } });          // extension enforces the tenant filter
}
```

The change at each of the ~68 route files is small and mechanical (call a service function with `ctx` instead of calling `prisma` directly), which is precisely why the extension approach (§8.3) was chosen over introducing a bespoke repository class per model — the latter would require hand-writing and testing ~20 repository classes before any route could be migrated, while the extension makes the *existing* Prisma call shape tenant-safe with a small, explicit-`ctx` change per call site, migrated incrementally module-by-module in Phase 3 without a flag day (Principle 10, §4).

### 16.3 Workers get the same treatment, with the same explicit-`ctx` rule

A job handler (§25) resolves its `TenantContext` from the job payload's `businessId` (via `resolveTenantPlacement`, the identical control-plane lookup a request uses, §7.5) and calls `handler(ctx, job.payload)` — the handler function itself takes `ctx` explicitly, exactly like an HTTP-triggered service function. There is exactly one tenant-safety mechanism to reason about, not two (one for HTTP, a different one for background work), and no handler needs `AsyncLocalStorage` to discover its own tenant — it already has `ctx` as a parameter.

### 16.4 Non-tenant-owned (control-plane) data access is unaffected

Control-plane tables (`Business`, `User` outside of `Membership`, `TenantPlacement`, `DatabaseProfile`, `StorageProfile`, future `Plan`) are deliberately **not** wrapped by the tenant-scoping extension (they have no `businessId` to filter by in the tenant-isolation sense — `TenantPlacement` has a `businessId` primary key, but it is looked up *to determine* tenant context, not filtered *by* an already-resolved one). Access to these is controlled purely by the `platform_admin`/ownership permission checks in §15, using the raw Prisma client directly from the small allowlisted `platform/` module — this is the one place in application code the raw client remains a legitimate import (§8.3's lint-rule allowlist).

### 16.5 Credential and connection-secret resolution follows the same explicit-parameter discipline

`SecretResolver.decrypt()` (§10.3) and the `DatabaseProfile`/`StorageProfile` connection resolution (§7.6) are called with an explicit reference (`credentialRef`, `connectionSecretRef`) — never implicitly discovered from ambient context — for the same reason application-service `ctx` is explicit: a function that resolves a secret should have that dependency visible in its signature, both for readability and so a test can supply a fake resolver without needing to simulate `AsyncLocalStorage` state.

---

## 17. Event Model

### 17.1 The envelope

```ts
export interface ZiyrakEvent<T = unknown> {
  id: string;                    // uuid, generated at creation
  type: string;                  // "message.received", "ticket.escalated", "followup.due", ...
  businessId: string;            // every event belongs to exactly one tenant
  source: { channel: string; connectionId: string; externalId?: string };  // externalId is the provider's own event/message ID — §17.4
  subjectCustomerId?: string;
  conversationId?: string;
  occurredAt: string;            // when it happened at the source (may lag receivedAt for e.g. delayed webhooks)
  receivedAt: string;            // when Ziyrak received it
  correlationId: string;         // ties together everything caused by one originating event (e.g. one inbound message)
  causationId?: string;          // the specific event that directly caused this one, for multi-hop chains
  payload: T;
  metadata?: Record<string, unknown>;
}
```

This is a pragmatic, typed envelope — a discriminated union of known `type` + `payload` pairs (`MessageReceivedPayload`, `TicketEscalatedPayload`, etc.), not a fully generic `Record<string, unknown>` blob, so that TypeScript can check payload shape against event type at every producer and consumer. New event types are added by extending the union, not by loosening the type.

### 17.2 Where events come from now vs. later

Today, the only real "event source" is a channel receiving a message. Channel adapters (§19) are the only producers implemented in this plan's scope; the envelope's generality (arbitrary `type`, not `message.*`-specific) is what lets future producers — a CRM webhook, an order-created hook, a calendar integration — plug into the same dispatcher and knowledge/tool/AI pipeline without changing the envelope or the dispatcher's shape, which is the concrete mechanism satisfying the product brief's requirement that Ziyrak "must not be architecturally limited to customer chat" without building any of those future integrations now.

### 17.3 Durable domain events vs. ephemeral realtime notifications — two mechanisms, not one (review concern 6, revised in this pass)

The first pass of this plan used a single `EventBus` abstraction for both "the dashboard should show a new message live" and, implicitly, for the domain-event handling that drives actual business processing. On review, this conflates two mechanisms with very different reliability requirements, and the fix is to name and separate them explicitly:

- **`RealtimeBus`** (renamed from `EventBus` — §26): purely for pushing live notifications to connected dashboard clients (new message arrived, conversation updated, job outcome changed). It is **explicitly best-effort**: a dropped connection, a missed Redis Pub/Sub message under load, or a restart between publish and subscribe is an acceptable, tolerable loss for this purpose — the dashboard will simply show the correct state on next poll/refresh. **`RealtimeBus` must never be the only mechanism by which something a business is relying on actually happens.**
- **Durable domain-event handling** (this section, plus §25/§31): every event that must reliably cause a real effect — an inbound message getting an AI reply, a webhook actually being delivered, a scheduled follow-up actually being sent — is **persisted to Postgres first** (as an `InboundEventReceipt` + the normalized event data, §17.4) and **processed via the durable job queue** (§25), never via pub/sub as the reliability mechanism. A worker that was down when an event "would have" been published on a bus simply picks up the durably-enqueued job when it comes back up; there is no window where the event is lost because nothing was listening at the moment it happened.

Concretely in this codebase: `resolveCustomer → find/create conversation → knowledge retrieval → AI → guardrails` (§18) is triggered by a durably-enqueued job (or a direct synchronous call for the internal chat API, §18.2), never by a `RealtimeBus` subscription; `webhook delivery`, `SLA breach sweeps`, `retention sweeps`, and `scheduled follow-ups` are jobs for the same reason. `RealtimeBus.publish()` is called *after* durable processing has already happened, purely to tell an already-connected dashboard about it sooner than a poll would — the dashboard remains correct even if that specific publish is lost, because the underlying data (the `Message` row, the `ActionExecution` status) was already durably written.

### 17.4 Durable inbound-event deduplication (review concern 7, new in this revision)

External providers may redeliver webhooks — Meta/WhatsApp, Twilio, Telegram, and any future CRM/payment integration all have documented at-least-once delivery semantics. Without deduplication, a redelivered webhook re-triggers the entire pipeline: the AI runs a second time, a second ticket may be created, and the customer receives two replies to one message. This is treated as a **correctness requirement for any production channel**, not a future optimization — no channel adapter is considered complete without it (§46.5's acceptance criteria).

```prisma
model InboundEventReceipt {
  id             String   @id @default(uuid())
  businessId     String
  business       Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  source         String                       // "whatsapp", "twilio-sms", "telegram", "webchat", ...
  externalEventId String                      // the provider's own message/event ID where one exists
  eventType      String
  receivedAt     DateTime @default(now())
  processingStatus String @default("received")  // received | enqueued | processed | failed
  correlationId  String

  @@unique([businessId, source, externalEventId])
}
```

Flow, matching §5.3's diagram exactly:

```
Webhook arrives
   → verify provider signature                       (§14.3, §19.1)
   → resolve business via ChannelConnection            (§7.7)
   → INSERT INTO InboundEventReceipt ... ON CONFLICT (businessId, source, externalEventId) DO NOTHING
   → 0 rows affected  → this externalEventId was already seen → ACK 200, stop, do NOT reprocess
   → 1 row affected   → genuinely new → persist the normalized event, enqueue the processing job, ACK 200
```

The `INSERT ... ON CONFLICT DO NOTHING` (or Prisma's equivalent `create` wrapped in a caught unique-constraint error) is what makes the check-and-mark atomic — a naive "check if it exists, then insert" has its own race window under concurrent redelivery, which this pattern avoids.

**Fallback for providers without a stable external event ID:** not every provider guarantees one on every payload shape (documented per-adapter at Phase 5 implementation time). Where none is available, the fallback key is a deterministic hash of `(businessId, channel, senderContact, normalized message content, a short time bucket — e.g., a 60-second window)`, accepting that this is a best-effort heuristic (a genuinely identical message sent twice by the same customer within the window would be incorrectly deduplicated) rather than the exact guarantee stable IDs provide — this tradeoff is documented explicitly in the adapter's own code comments, not left implicit, and each adapter's implementation phase records which strategy it uses.

### 17.5 Synchronous calls vs. jobs — explicit rule (revised: "events" reframed as durable jobs per §17.3)

**Use a direct, synchronous function call when:** the caller needs the result to proceed (customer is waiting for a reply *within this same invocation* — the internal `POST /api/chat` endpoint calling `processInboundMessage(ctx, event)` directly is one synchronous call chain, because that caller has no webhook-acknowledgment deadline to respect and nothing else needs to react to "the AI is about to be called").

**Enqueue a durable job when:** the action must survive a process restart, must not block a provider's webhook-acknowledgment deadline (§17.6), or more than one future subscriber might care about the outcome. This is why real provider channels (§19, §46.5) **always** enqueue rather than process inline — see §17.6.

**Publish on `RealtimeBus` when:** a connected dashboard client would benefit from finding out sooner than its next poll, and losing the notification is an acceptable, non-corrupting outcome (§17.3).

### 17.6 Fast webhook acknowledgment: the same service, invoked synchronously or via a job (review concern 8)

A production webhook handler's job is narrowly: verify → resolve business → deduplicate → persist → enqueue → acknowledge the provider quickly. It must **not** run the full knowledge-retrieval → AI → tool-execution pipeline inline before responding to the provider, because that pipeline's latency is dominated by an external LLM call, which is exactly the kind of unbounded, provider-uncontrolled delay that causes webhook timeouts, provider-side retries (compounding the deduplication problem in §17.4), and poor behavior under traffic spikes.

This does **not** mean every entry point must be asynchronous — the review is explicit that an internal/test/chat API may legitimately await a response, and this plan agrees: `POST /api/chat` (the dashboard-internal "test the AI" endpoint, and eventually a foundation for authenticated internal tooling) calls `processInboundMessage(ctx, event)` directly and awaits its result, because it has no external provider imposing an acknowledgment deadline. The design principle is that **`processInboundMessage(ctx, event)` itself does not know or care whether it was invoked synchronously by a route handler or asynchronously by a job handler** — it is one function, with one signature, called both ways depending on the caller's constraints:

```
Real provider channel (WhatsApp, Twilio, Telegram, Web Chat widget):
   webhook route → verify/resolve/dedupe/persist/enqueue → ACK fast
   worker        → processInboundMessage(ctx, event)      → reply sent asynchronously

Internal chat API (dashboard "test the AI", future authenticated tooling):
   route handler → processInboundMessage(ctx, event) awaited directly → response returned in the same HTTP response
```

§18.2 gives `processInboundMessage`'s exact signature and shows both call shapes concretely.

---

## 18. Core Processing / Orchestration

### 18.1 Responsibilities, split out of today's monolithic `chat()`

`engine.ts`'s `chat()` today does eleven things in one function body: load settings, load the entire knowledge base, build the system prompt, run guardrail pre-checks, persist the inbound message, call the AI (recursively, inline tool dispatch), persist the outbound message, update conversation timestamp, score confidence, maybe escalate, and emit a realtime event. The target keeps the same overall sequence (this is not a behavior change) but splits ownership so each concern can be tested, replaced, and reasoned about independently:

| Stage | Owning module | Replaces |
|---|---|---|
| Resolve customer + conversation | `conversations/` (calls `customers/`) | already mostly isolated (`customer-resolver.ts`), now tenant-scoped |
| Retrieve relevant knowledge | `knowledge/` via `KnowledgeRetriever` contract | `engine.ts`'s `getKnowledgeBase()` unbounded dump (§2.3, fixed in §46.4) |
| Build prompt | `ai/` (`buildSystemPrompt`, largely unchanged logic, now fed bounded knowledge) | `engine.ts:13-62` |
| Pre-response guardrails | `ai/guardrails/` pipeline | `requiresHumanApproval` (kept) + `checkBlockedTopics` (finally wired in, §46.4) |
| Call the model, manage tool loop | `ai/` `AIOrchestrator` via `AIProvider` contract | `engine.ts`'s `callAI()`, now provider-agnostic (§21) |
| Execute tools | `tools/` `ToolRegistry`, checked against `ToolPolicy` for AI/system actors (§9.5) | `ai/tools.ts`'s switch statement (§23) |
| Post-response guardrails | `ai/guardrails/` pipeline | `enforceResponseLength` (finally wired in) + `estimateConfidence` (fixed hasToolCalls bug, §2.3) |
| Persist + notify | `conversations/` + `events/`/`realtime/` | unchanged persistence, `realtime.ts` publish becomes a `RealtimeBus` publish (best-effort, §17.3) |
| Escalate if needed | `conversations/` `EscalationManager` | today's inline `status: "escalated"` update, unchanged trigger conditions, now a named responsibility instead of an inline side effect |

This is explicitly **not** "introduce a `ZiyrakService` god object" — each stage above is a small module with one narrow responsibility, composed by a single top-level orchestration function (§18.2), which is the anti-pattern the product brief specifically warns against.

### 18.2 The composition point — `ctx` explicit, callable synchronously or from a job handler

```ts
// src/lib/conversations/inbound.ts
export async function processInboundMessage(
  ctx: TenantContext,
  event: ZiyrakEvent<MessageReceivedPayload>
): Promise<OutboundResult> {
  const conversation = await resolveOrCreateConversation(ctx, event);
  const knowledge = await knowledgeRetriever.retrieve(ctx, event.payload.text, { conversationId: conversation.id });
  const guardrailPre = await guardrails.preCheck(event.payload.text);
  const aiResult = await aiOrchestrator.respond(ctx, { conversation, message: event.payload.text, knowledge, guardrailPre });
  await persistAndNotify(ctx, conversation, aiResult);
  return { conversationId: conversation.id, response: aiResult.text };
}

// Caller 1 — internal chat API, synchronous, awaited directly (§17.6):
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "conversations:create");
  if (!isAuthenticated(ctx)) return ctx;
  const event = buildEventFromChatRequest(ctx, await request.json());
  const result = await processInboundMessage(ctx, event);
  return NextResponse.json(result);
}

// Caller 2 — real provider channel, via the job queue (§17.6, §25):
jobQueue.registerHandler("process-inbound-message", async (payload: { businessId: string; eventId: string }) => {
  const ctx = await resolveTenantPlacement(payload.businessId);
  const event = await loadPersistedEvent(ctx, payload.eventId);
  await processInboundMessage(ctx, event);
});
```

Note `ctx` is an explicit parameter throughout (§8.2, §16.1) — `processInboundMessage` never reaches into `AsyncLocalStorage` to discover its own tenant. Every channel adapter's webhook route and `POST /api/chat` ultimately call this one function instead of each independently reimplementing "resolve customer → find/create conversation → call chat()" (§2.5's finding that this logic is duplicated near-identically across `whatsapp.ts`, `email.ts`, `sms.ts`, `telegram.ts`, `phone.ts`). This is the single biggest de-duplication this plan performs on the existing codebase, and it is what makes adding a sixth channel later a matter of implementing `ChannelAdapter.validateInbound()` to produce a `ZiyrakEvent` plus a thin webhook route that does §17.4's verify/dedupe/enqueue dance, not touching five unrelated files as it does today.

---

## 19. Channel Adapter Architecture

### 19.1 The contract

```ts
export interface ChannelCapabilities {
  supportsMedia: boolean;
  supportsTemplates: boolean;     // e.g. WhatsApp template messages required outside a 24h session window
  supportsTypingIndicator: boolean;
  supportsDeliveryReceipts: boolean;
  supportsMultipleConnections: boolean;   // §7.7 — can a business have >1 connection of this type?
}

export interface ChannelAdapter {
  readonly type: string;                          // "whatsapp", "email", "sms", "telegram", "phone", "webchat"
  readonly capabilities: ChannelCapabilities;

  // Verifies the request (signature/widget token), resolves the owning ChannelConnection/business,
  // performs InboundEventReceipt dedup (§17.4), and returns a normalized event — or null if the
  // request does not verify, or "duplicate" if it was already seen (the caller ACKs either way).
  validateInbound(request: NormalizedInboundRequest): Promise<
    { kind: "new"; ctx: TenantContext; connectionId: string; event: ZiyrakEvent<MessageReceivedPayload> }
    | { kind: "duplicate" }
    | { kind: "rejected" }
  >;
  sendMessage(ctx: TenantContext, connectionId: string, to: string, content: OutboundContent): Promise<SendResult>;
  getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus>;
  connect?(ctx: TenantContext, connectionId: string): Promise<void>;      // only for session-based channels (WhatsApp Web)
  disconnect?(ctx: TenantContext, connectionId: string): Promise<void>;
}
```

Every method now takes an explicit `connectionId` (§7.7) rather than assuming one connection per business per type — for channels that in practice only ever have one connection (e.g., Phone, for most businesses), the adapter still takes the parameter, and the calling code passes the business's single/default `ChannelConnection`. Per Principle 2 (§4)/review concern 22, this contract's *exact* shape (particularly `validateInbound`'s three-way return type, which folds in this revision's deduplication requirement) is expected to be refined once Phase 5 implements it against a real provider — what is fixed now is that dedup and business resolution happen inside `validateInbound`, before any business logic runs, and that the method signature carries a `connectionId`.

Not every channel implements `connect`/`disconnect` (Meta Cloud API, Twilio, Telegram, Web Chat are stateless HTTP — there is no "session" to connect; they are marked "always connected" once credentials exist) — this is the capability-aware design the product brief asks for rather than forcing every channel into an identical shape.

### 19.2 Migration path per existing channel, plus the new Web Chat adapter

- **WhatsApp:** split into `WhatsAppWebAdapter` (wraps today's `whatsapp-web.js` code near-verbatim, including the uncommitted `initPromise`/`readySince` fix — §19.3/§20) and `MetaCloudWhatsAppAdapter` (new, §20).
- **Email:** `EmailAdapter` wraps `email.ts`'s IMAP-poll/SMTP-send logic; `startEmailListener`/`stopEmailListener` become `connect`/`disconnect`; `processEmail` is trimmed down to "produce a `ZiyrakEvent`" and no longer calls `chat()` directly (that call moves to `processInboundMessage`, §18.2). Gains `InboundEventReceipt` dedup keyed on the email `Message-ID` header, which is a stable, provider-independent identifier.
- **SMS:** `SmsAdapter` wraps `sms.ts`; `handleIncomingSms` becomes `validateInbound` (folding in Twilio signature verification, currently done ad hoc in the route handler — verify and consolidate during Phase 5). Dedup keyed on Twilio's `MessageSid`.
- **Telegram:** `TelegramAdapter` wraps `telegram.ts` near-verbatim; secret-token verification is added at this point since Telegram's webhook has no built-in signature scheme beyond an optional shared secret header, which the current implementation does not check at all (a gap worth closing during this phase since the adapter boundary is being touched anyway). Dedup keyed on Telegram's `update_id`.
- **Phone:** `PhoneAdapter` wraps `phone.ts`'s TwiML/Whisper/ElevenLabs logic; `getPhoneStatus()`'s hardcoded-`false` bug (§2.5) is fixed as part of this migration. Dedup keyed on Twilio's `CallSid` per gather-turn.
- **Web Chat (new, review concern 21):** `WebChatAdapter` is a new adapter, not a migration of existing code — see §20.4 for its design, since it needs a public authentication model unlike every other channel here.

### 19.3 Adding a channel is a controlled operation, not a hunt across the repo

Once §19.1-19.2 land, adding a channel means: implement `ChannelAdapter` (including its dedup key strategy, per §17.4), register it in one `ChannelRegistry`, add one route under `src/app/api/channels/<type>/webhook/route.ts` that calls the registry's `validateInbound` + enqueues `process-inbound-message` (§17.6), and add the channel's credential schema (§10.3) to the settings UI. This is a bounded, mechanical checklist instead of the four-file hunt (`AUDIT.md §7`) the current architecture requires, and it's the concrete resolution of the product brief's "adding a future channel should not require modifying many unrelated parts of the system" requirement.

---

## 20. Production Channel Strategy: WhatsApp and Web Chat

*(Renamed from "WhatsApp Strategy" in this revision — review concern 21 makes Web Chat a second MVP-launch channel, not a WhatsApp-only story.)*

### 20.1 Why `whatsapp-web.js` cannot be Ziyrak's production multi-tenant WhatsApp path

`whatsapp-web.js` (`src/lib/channels/whatsapp.ts`, verified in full in §2.5) drives one real WhatsApp *personal/business app* session per Puppeteer browser instance, authenticated by QR-scanning a phone — there is exactly one `whatsappClient` module-level variable today. Making this multi-tenant would require one Puppeteer+Chromium process per business, each holding a persistent authenticated browser session that can be logged out by the phone at any time, with no official support or SLA from Meta — this is a fundamentally different (and far heavier, far less reliable) operational model than a stateless HTTPS webhook integration, and is explicitly unsuitable as *the* production path for a commercial multi-tenant platform, independent of any code quality concerns.

### 20.2 Target: two adapters behind one `WhatsAppChannel` contract (§19.1)

- **`MetaCloudWhatsAppAdapter` (production, the only supported path for real Ziyrak customers):** stateless HTTPS calls to the WhatsApp Business Cloud API using a per-`ChannelConnection` phone-number-ID + system-user access token. Inbound messages arrive via one shared Ziyrak-owned webhook URL registered with Meta; the payload's `phone_number_id` is the lookup key resolving to the owning `ChannelConnection`/`businessId` (§19.1's `validateInbound`), with Meta's own message ID (`wamid...`) as the `InboundEventReceipt` dedup key (§17.4). No Puppeteer, no browser session, no QR code, no per-tenant process — this is what actually satisfies "logical tenant isolation is sufficient for normal customers" for WhatsApp specifically, because the adapter itself is stateless and multi-tenant by construction, and now also supports a business running multiple WhatsApp numbers as separate `ChannelConnection`s (§7.7).
- **`WhatsAppWebAdapter` (development/demo/self-host only, explicitly and structurally not available to production tenants):** wraps today's `whatsapp-web.js` implementation, including the uncommitted `initPromise` concurrency guard and `readySince` backlog-skip fix (§2.5) — both are correct, targeted engineering worth keeping as-is for this narrower purpose. The residual `whatsappClient`-assignment race identified in §2.5 (assign inside `initPromise`'s IIFE after `initialize()` resolves, rather than inside the `"ready"` handler) is fixed as part of moving this code behind the adapter contract, since the file is already being touched. This adapter is gated so it can only be selected for a designated internal dev/demo `Business` (a feature flag or hard allowlist check inside the adapter registry, not a per-tenant UI toggle), preventing a real customer from ever being routed onto a single shared/fragile browser session.

### 20.3 Migration sequencing

Phase 5 (§46.5) introduces the `ChannelAdapter` contract and migrates `WhatsAppWebAdapter` behind it (low-risk, behavior-preserving refactor of existing working code) and builds `WebChatAdapter` (§20.4) as the first channel with no legacy code to migrate. Phase 7 (§46.7) implements `MetaCloudWhatsAppAdapter` as one of the two production MVP paths and requires a live Meta developer account/business verification to fully test end-to-end (external dependency, flagged as a risk in §46.7). Businesses are not required to choose at signup — the platform simply never offers `WhatsAppWebAdapter` as a selectable option in the tenant-facing product; it exists purely for the platform's own development and demo environments.

### 20.4 Web Chat as an MVP channel (review concern 21, new in this revision)

**Why this revision includes it, reversing the first pass's "defer to post-MVP" call:** the review's argument is adopted in full. Meta Business API access requires app review and business verification — an external, non-code-controllable timeline (already flagged as the single biggest scheduling risk in the first pass's Phase 8). Web Chat has none of that dependency, is trivial to demo, and — critically for this plan's own testing strategy (§34) — gives a fully-automatable, credential-free end-to-end integration test path for the entire `processInboundMessage` pipeline against a *real* channel adapter, not only a fake one. Shipping it alongside WhatsApp, rather than instead of or long after it, de-risks the MVP timeline rather than adding to it.

**The public-widget authentication problem, and its resolution:** every other channel in this plan authenticates an inbound request using a secret only the *business* holds (a webhook signature, a bot token). Web Chat is different by nature — the widget runs in an arbitrary visitor's browser, on the business's public website, so whatever credential it presents is, by construction, visible to anyone who opens their browser's developer tools. The design must assume the widget token **will** be exposed, and scope its capabilities accordingly rather than pretending otherwise:

```prisma
// stored as part of a ChannelConnection where type = "webchat"
// config: { allowedOrigins: string[], rateLimitPerMinute: number }
// credentialRef resolves to a PUBLISHABLE token — not a secret in the same sense as other channels' credentials,
// but still opaque and rotatable, and never the same value as any admin-facing API key
```

- The widget embed script sends only a **publishable channel token** (`zy_pub_<random>`, visually and semantically distinct from an `ApiKey`'s `zy_live_<random>` — §9.4) — a value explicitly designed to be public, resolved by `WebChatAdapter.validateInbound()` to a `ChannelConnection` and therefore a `businessId`, and to **nothing else**: it grants no access to any administrative API, no ability to read another visitor's conversation, no ability to list customers, and is checked against the connection's `allowedOrigins` (the `Origin`/`Referer` header must match a domain the business has configured for its widget) before being honored at all.
- Rate limiting is applied per-token and per-IP, more aggressively than the platform's general API rate limits (§30/§32), since this is the one endpoint in the entire platform designed to accept requests from an unauthenticated, unknown party by definition.
- The token is independently rotatable/revocable from its own `ChannelConnection` row, exactly like the credential for any other channel type, so a business that suspects abuse can invalidate and reissue it without affecting any other channel or any admin credential.
- **The widget never receives, stores, or transmits any admin-scoped `ApiKey` or JWT.** This is stated as an explicit, non-negotiable design constraint (directly per the review's instruction) precisely because reusing a secret admin key in browser-shipped code is a realistic mistake to make under time pressure, and this plan forecloses it architecturally by giving Web Chat its own token type that is structurally incapable of the escalation.

`WebChatAdapter` otherwise behaves like any other `ChannelAdapter`: `validateInbound` maps the publishable token + origin check to a `TenantContext`, applies `InboundEventReceipt` dedup keyed on a client-generated message ID (the widget is responsible for generating a stable ID per send, since there is no upstream provider assigning one), and `sendMessage` pushes the reply back to the connected client over the same `RealtimeBus`-backed mechanism used for dashboard live updates (§17.3, §26) — Web Chat is the one channel where the "outbound send" and "realtime notification" concerns naturally converge, since the customer *is* a realtime subscriber.

---

## 21. AI Provider Architecture

### 21.1 The generation contract

```ts
export interface AIMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: ToolCallRequest[]; }
export interface CompletionRequest { messages: AIMessage[]; tools?: ToolDefinition[]; maxTokens: number; temperature: number; model: string; }
export interface CompletionResult {
  type: "text" | "tool_calls";
  text?: string;
  toolCalls?: ToolCallRequest[];             // each carries the provider's own toolCallId — §24.4's idempotency key
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };  // required — this is what §39's cost attribution reads
}
export class AIProviderError extends Error {
  constructor(public code: "auth" | "rate_limit" | "timeout" | "invalid_request" | "provider_unavailable" | "unknown", message: string, public retryable: boolean) { super(message); }
}
export interface AIProvider {
  readonly name: string;
  readonly capabilities: { toolCalling: boolean; streaming: boolean; multimodal: boolean };
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
```

### 21.2 Migration from `engine.ts`'s hardcoded OpenAI call

Today (`engine.ts:219-232`): `new OpenAI({ apiKey: config.apiKey })` is constructed and called unconditionally inside `callAI()`, and `config.provider` is loaded but never read (§2.3 — this is the exact bug, independently verified). Target: `callAI()`'s model-calling portion is replaced by `const provider = aiProviderRegistry.get(config.provider); const result = await provider.complete({ messages, tools, maxTokens: config.maxTokens, temperature: config.temperature, model: config.model });`, with the tool-call-loop logic (recursion, depth limit, message-array bookkeeping) preserved exactly as it is today in `engine.ts:236-277` — that logic is provider-agnostic already, it just currently sits below a hardcoded OpenAI call instead of the `AIProvider` interface.

`OpenAIProvider` wraps the exact same `openai.chat.completions.create(...)` call that exists today, translating between the `CompletionRequest`/`CompletionResult` shapes and the OpenAI SDK's native types — behavior-preserving for the one provider that already works correctly. A second real implementation (`AnthropicProvider`, using Anthropic's Messages API with tool use) is built in the same phase specifically to prove the abstraction is not a single-implementation interface built on faith (Principle 2, §4) — Anthropic is chosen as the second provider because it is already advertised in the setup wizard's `PROVIDER_OPTIONS` (§2.3) and is a real, well-documented tool-calling API. `OllamaProvider` (OpenAI-compatible local endpoint) is stubbed with a clear "not yet implemented" error rather than silently mis-routed, replacing today's silent-failure behavior (§2.3) with an honest one — implementing it fully is not required for the MVP (§44) since it targets a self-hosted/local-LLM use case out of scope for the initial commercial product, but the stub prevents the setup wizard from lying about what's selectable.

### 21.3 Error handling, retries, timeouts

Every `AIProvider` implementation is responsible for translating its SDK's native errors into `AIProviderError` with an honest `retryable` flag (rate limits and timeouts are retryable; invalid API keys are not). `AIOrchestrator` (§18.1) catches `AIProviderError` and applies one bounded retry for `retryable: true` errors before falling back to today's existing user-facing message ("I'm temporarily unable to process your request...", `engine.ts:231`, preserved verbatim as the fallback copy) — this is a small behavior improvement (a transient rate-limit no longer immediately gives up) bundled into the abstraction work since the error-handling call site is being rewritten anyway. Note that a retried completion call is not itself a duplicate-effect risk (§24.4) — the risk only exists at the *tool-call* level, once a tool call from a retried completion is executed, which is why idempotency keys are scoped to `toolCallId`, not to the completion call itself.

### 21.4 Test doubles

A `FakeAIProvider` implementing the same interface (deterministic canned responses, optionally simulating tool calls with synthetic but stable `toolCallId`s) is the standard test double for every test that exercises `AIOrchestrator`/`processInboundMessage` without making real API calls — this directly replaces whatever ad hoc mocking `tests/unit/ai-engine.test.ts` currently does (to be reviewed and migrated onto the fake in Phase 4) and is what makes the tool-execution/guardrail/escalation logic testable without OpenAI credentials in CI.

### 21.5 `EmbeddingProvider` — a separate contract from generation (review concern 13, new in this revision)

The first pass's AI abstraction covered text/tool-call generation but left `KnowledgeRetriever`'s embedding step (§22) implicitly calling OpenAI's embeddings API directly, inside `semantic-search.ts`. On review, this is a real compliance gap waiting to happen: a business whose `InfrastructurePolicy` (§11) restricts it to `permittedAiProviders: ["private-endpoint"]` — "no data sent to OpenAI" — would have that constraint silently violated the moment a customer message is embedded for knowledge retrieval, even if every *generation* call correctly routes through the constrained provider. Generation and embedding are different capabilities with different data-exposure surfaces (an embedding call sends the raw customer message to whichever provider computes it, exactly like a generation call does), so they need independent provider selection:

```ts
export interface EmbeddingResult { vector: number[]; model: string; usage: { totalTokens: number } }
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<EmbeddingResult>;
}
```

`OpenAIEmbeddingProvider` (wrapping today's exact `text-embedding-3-small` call in `semantic-search.ts:26-48`) is the **only** implementation built in this plan — per Principle 2 (§4), this revision does not add a second embedding provider speculatively, since no concrete near-term requirement demands one. What matters architecturally is that `KnowledgeRetriever` depends on the `EmbeddingProvider` **interface**, resolved via `EmbeddingProviderRegistry.get(businessConfig.embeddingProvider ?? businessConfig.aiProvider ?? platformDefault)` (§22.2), not on the OpenAI SDK directly — so a future `PrivateEndpointEmbeddingProvider` (Phase 9, §46.9, alongside the equivalent generation-side provider named in §43) is a new adapter behind an unchanged interface, and `InfrastructurePolicy.permittedAiProviders` can be checked against *both* the generation and embedding provider selections independently once that enforcement is built (§46.9's task list).

---

## 22. Knowledge Architecture

### 22.1 The contract

```ts
export interface KnowledgeItem { id: string; title: string; content: string; category: string; priority: number; score: number; }
export interface KnowledgeRetriever {
  retrieve(ctx: TenantContext, query: string, options?: { limit?: number }): Promise<KnowledgeItem[]>;
}
```

`AIOrchestrator` calls `knowledgeRetriever.retrieve(ctx, userMessage, { limit: 8 })` and never knows or cares whether the implementation is keyword matching, embeddings-in-JSON cosine similarity, pgvector, or a future external engine — this is the literal "ask for relevant knowledge for this request" boundary the product brief specifies.

### 22.2 Migration — this is the single highest-leverage AI fix in the whole plan

`engine.ts`'s `getKnowledgeBase()` (§2.3) is deleted; `chat()`/`AIOrchestrator.respond()` calls `knowledgeRetriever.retrieve()` instead. The **default** `KnowledgeRetriever` implementation for the MVP is `searchKnowledgeBase()` (`semantic-search.ts`, verified fully working — cosine similarity, keyword fallback, Redis/in-memory caching already implemented) made tenant-scoped **and rewired onto the `EmbeddingProvider` contract (§21.5) instead of calling OpenAI's embeddings endpoint directly** — wiring in a component that has existed, unused, since before this plan (§2.3/§2.4) is finishing work that was already done, not new engineering, and is why it is sequenced early (Phase 4) rather than waiting for a more sophisticated retrieval engine; the `EmbeddingProvider` indirection is a small, contained addition to that same finishing work, not a separate effort.

### 22.3 Why not pgvector or an external vector DB yet

`searchKnowledgeBase()` itself still loads **every** active knowledge entry into Node and scores them all in JavaScript (`semantic-search.ts:95-98`, `entries.map(...)` over the full result set) — bounded by `.slice(0, limit)` at the end, not by a `LIMIT` in SQL. This is a real scalability ceiling, but not one that matters at MVP knowledge-base sizes (tens to low hundreds of entries per business) — per Principle 2 (§4), introducing pgvector (a Postgres extension requiring migration/index work) or an external engine like Qdrant now would be solving a problem the MVP does not have yet, at the cost of new operational surface. The `KnowledgeRetriever` interface is exactly what makes this deferrable without cost: swapping the JS-side implementation for a `PgVectorKnowledgeRetriever` later (recommended trigger: any single business's active knowledge-entry count exceeding roughly 500-1000, or aggregate retrieval latency becoming customer-visible) is a new adapter behind an unchanged interface, not a rewrite of `AIOrchestrator` or anything upstream of it. This is called out explicitly in §46.8 (scalability) as a candidate, not committed to a specific trigger threshold now.

### 22.4 Ingestion boundary

A `KnowledgeIngestor` boundary is named (not fully built) for future sources beyond manual dashboard entry: `ingestText(ctx, {title, content, categoryId})` (today's existing manual-entry path, unchanged), with `ingestUrl`, `ingestFile` (PDF/document), and `ingestStructured` (business-data feeds) as documented-but-unimplemented extension points. None of these are required for the MVP (§44) — naming the boundary now means a future PDF-upload feature adds one adapter and calls the existing `indexKnowledgeEntry()` embedding pipeline (`semantic-search.ts`, now via `EmbeddingProvider`, §21.5), rather than inventing a parallel ingestion path.

---

## 23. Tool / Action Architecture

### 23.1 The problem with today's shape

`owlyTools` (`tools.ts:5-158`) is a flat array shared by every business, and `executeToolCall()` (`tools.ts:160-181`) is a `switch` statement — both are described exactly by the product brief's warned-against anti-pattern. There is no per-tenant availability, no permission check before execution (any tool the AI decides to call runs, regardless of the current conversation's channel/business), and no audit trail beyond whatever log line `logger` happens to emit inside each handler. Additionally — the specific gap review concern 5 identifies — there is no way to express "the AI may do X automatically, but a human must approve Y" at all, since there is no policy dimension separate from a (today nonexistent) role check.

### 23.2 The registry

```ts
export interface ToolResult { success: boolean; message: string; data?: unknown; status: ActionStatus; }
export interface ToolDefinition {
  name: string;
  description: string;                 // exposed to the AI, same copy as today's owlyTools descriptions
  schema: z.ZodType;                    // replaces the hand-written JSON-schema `parameters` blocks with Zod (reuses validations.ts conventions)
  requiredPermission?: Permission;      // e.g. "tickets:create" — checked for HUMAN actors only (§9.5)
  execute(ctx: TenantContext, args: unknown, runtimeCtx: { conversationId?: string; toolCallId?: string }): Promise<ToolResult>;
}

export class ToolRegistry {
  register(tool: ToolDefinition): void { /* ... */ }

  async getAvailableTools(ctx: TenantContext): Promise<ToolDefinition[]> {
    // for ctx.actor.kind === "ai_agent": filter by ToolPolicy.enabledForTenant AND ToolPolicy.allowedForAI (§23.4)
    // for ctx.actor.kind === "user" | "api_key": filter by ToolPolicy.enabledForTenant AND
    //   (requiredPermission is unset OR hasPermission(ctx.role, requiredPermission)) AND
    //   ctx.role is in ToolPolicy.allowedForHumanRoles
  }

  async execute(ctx: TenantContext, name: string, args: unknown, runtimeCtx: { conversationId?: string; toolCallId?: string }): Promise<ToolResult> {
    // 1. look up the tool, 404-equivalent if unknown
    // 2. re-check availability for ctx.actor (never trust that getAvailableTools was called first)
    // 3. validate args against tool.schema (zod) — replaces today's untyped `args as string` casts throughout tools.ts
    // 4. compute the attempt-scoped idempotencyKey (§24.4) and short-circuit if an ActionExecution with
    //    that exact key already exists — return its recorded result instead of re-running
    // 5. if ToolPolicy.requiresApproval(ctx.actor, name) → ActionExecution.create({ status: "pending_approval" }), STOP
    // 6. otherwise: ActionExecution.create({ status: "requested" }) FIRST, then run tool.execute()
    // 7. update the ActionExecution with the final status/result
    // 8. return the ToolResult
  }
}
```

Each of today's six tools (`create_ticket`, `assign_to_person`, `send_internal_email`, `get_customer_history`, `schedule_followup`, `trigger_webhook`) becomes one small module under `src/lib/tools/builtin/*.ts` implementing `ToolDefinition`, registered at startup — this is a mechanical extraction of each `switch` branch's existing logic (which is otherwise correct and does not need behavioral changes, except `schedule_followup`, fixed in §24) into its own file, plus adding the Zod schema and `requiredPermission`.

### 23.3 Tenant availability for human actors

For `user`/`api_key` actors, availability is driven by permission + `ToolPolicy.allowedForHumanRoles` + simple config checks (e.g., `send_internal_email`'s effective availability is `false` if the tenant has no email `ChannelConnection`, replacing today's runtime "Email not configured" string response at call time, `tools.ts:248-253`, with the tool simply not being offered at all when it cannot succeed). Full third-party/marketplace tool extensibility (tenants defining their own custom tools) is out of scope for the MVP and noted as a natural future extension of this same registry.

### 23.4 `ToolPolicy` — the AI-authorization dimension, independent of RBAC (review concern 5)

```prisma
model ToolPolicy {
  id                 String   @id @default(uuid())
  businessId         String
  business           Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  tool               String                              // matches ToolDefinition.name
  enabledForTenant   Boolean  @default(true)              // off entirely for this business, regardless of actor
  allowedForAI       Boolean  @default(false)              // may the "ai_agent" ExecutionPrincipal call this automatically?
  allowedForHumanRoles Json   @default("[\"agent\",\"supervisor\",\"admin\",\"owner\"]")  // Role[] — human RBAC gate
  requiresHumanApproval Boolean @default(false)            // if true (and allowedForAI), an AI call PAUSES for approval
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@unique([businessId, tool])
}
```

Every built-in tool ships with a sensible **default** `ToolPolicy` row, seeded per business at signup, matching this example set (illustrative — the exact defaults are a Phase 6 implementation decision, not fixed by this document):

| Tool | `allowedForAI` | `requiresHumanApproval` | Rationale |
|---|---|---|---|
| `create_ticket` | `true` | `false` | Low-risk, reversible, exactly what the AI is for |
| `get_customer_history` | `true` | `false` | Read-only |
| `schedule_followup` | `true` | `false` | Reversible (a scheduled job can be cancelled), low-risk |
| `send_internal_email` | `true` | `false` | Internal-only notification, no external/financial effect |
| `trigger_webhook` | `true` | `false` | Business explicitly configured the webhook to be triggerable; SSRF-hardened regardless (§32) |
| `assign_to_person` | `true` | `false` | Routing decision, easily corrected by a human later |
| *(future, illustrative)* `issue_refund` | `true` | **`true`** | Financial effect — AI may prepare/request it, a human must confirm before it executes |
| *(future, illustrative)* `change_pricing` | `false` | — | Never AI-callable, regardless of approval — a business may simply disable this for the AI entirely |

A business can edit its own `ToolPolicy` rows (via the settings UI, tenant-scoped like every other resource) to tighten or loosen these defaults, independently of who has what RBAC role — this is the concrete mechanism satisfying the review's "enabled/disabled for tenant, allowed for AI, allowed for particular human roles, requires human approval" requirement, deliberately as a small, fixed-shape table rather than a general policy-rule engine (per the review's own "do not overbuild a generic policy engine now" instruction and Principle 2/§4).

**`requiresHumanApproval` in practice:** when the AI calls a tool with this flag set, `ToolRegistry.execute()` creates the `ActionExecution` as `pending_approval` (§24.3) and returns a `ToolResult` telling the AI (and therefore the customer, via the AI's own response) that the request has been forwarded for approval — the tool does **not** run. A human with the appropriate RBAC permission approves or rejects it from the dashboard, which is what actually transitions the `ActionExecution` to `requested`/`running` and lets it execute. This is the literal implementation of the review's `refund_payment` example.

---

## 24. Durable Action Model

### 24.1 The rule (restated from Principle 4, §4)

An LLM's own generated text is never the source of truth for whether a business action happened. The `ActionExecution` record is — and, per this revision, a status is never reported that the currently-deployed infrastructure cannot back (§46.6 resolves the specific phase-boundary version of this problem, see §24.3).

### 24.2 Schema

```prisma
model ActionExecution {
  id             String   @id @default(uuid())
  businessId     String
  tool           String                     // "schedule_followup", "create_ticket", ...
  status         String   @default("requested")  // requested | pending_approval | scheduled | running | succeeded | failed | cancelled
  input          Json
  result         Json?
  conversationId String?
  requestedBy    String                     // "ai" | userId | "system"
  idempotencyKey String                     // NOT NULL, per §24.4 — every execution attempt has one
  errorMessage   String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  completedAt    DateTime?

  @@index([businessId, status])
  @@index([businessId, conversationId])
  @@unique([businessId, idempotencyKey])
}
```

(Changed from the first pass: `idempotencyKey` is now `NOT NULL` — every execution attempt is required to have one, per §24.4's redesign, rather than being an optional field only some tools populate. `status` gains `pending_approval`, §23.4/§9.5.)

### 24.3 Status semantics, and the specific fix for `schedule_followup` — including the Phase 6/7 boundary problem (review concern 11)

- `requested`: the tool was called; no side effect has happened yet.
- `pending_approval`: an AI-initiated call to a `requiresHumanApproval` tool (§23.4/§9.5) — waiting on a human decision, no side effect yet.
- `scheduled`: for tools whose real work happens later (currently only `schedule_followup`), a durable job has been successfully enqueued — **this is returned to the AI/customer as the honest status**, replacing today's fabricated-but-accurate-sounding "Follow-up scheduled" string that corresponds to nothing durable (§2.3).
- `running`/`succeeded`/`failed`: for asynchronous tools, the worker updates the record when it actually processes the job; the dashboard's conversation view can show live status via `RealtimeBus` (best-effort, §17.3), so a business user watching a conversation can see "follow-up: scheduled → sent" rather than only ever seeing the AI's initial claim.
- `cancelled`: reserved for future use (e.g., a human cancels a pending scheduled follow-up before it fires, or rejects a `pending_approval` action) — modeled now, with a minimal UI for the `pending_approval` case required at MVP (§46.6), full cancellation UX for already-scheduled jobs not required at MVP.

**The Phase 6/7 boundary problem, and how this revision resolves it:** the first pass sequenced tool-registry work (making `schedule_followup` return `"scheduled"` and create an `ActionExecution`) in a phase *before* the job queue that would make `"scheduled"` durably true. That is exactly the failure Architectural Principle 4 (§4) exists to prevent: a status claimed ahead of the infrastructure that backs it. This revision's fix, per the review's preferred option, is to **merge tool/action-registry work and job-queue work into one phase — §46.6 — sequenced as separate, ordered PRs within it**: the `ToolRegistry`/`ActionExecution`/`ToolPolicy` foundation lands first, synchronous tools (`create_ticket`, `get_customer_history`, `assign_to_person`, `send_internal_email`, `trigger_webhook`) are wired and fully functional immediately, and `schedule_followup` is **simply not exposed to the AI at all** (excluded from `getAvailableTools()`, or its `ToolPolicy.enabledForTenant` defaults to `false`) until the job-queue PRs within that same phase land — at which point it is enabled and its `execute()` implementation, from day one, does the real thing: validate args → `jobQueue.schedule("send-followup", { businessId, conversationId, message, sendAt }, { runAt, idempotencyKey })` → on successful enqueue, `ActionExecution` → `scheduled` → return `{ success: true, status: "scheduled", message: "Follow-up scheduled for <time>" }`. There is no intermediate, externally-visible state where the tool exists and claims durability it does not have. If the enqueue call itself throws, the `ActionExecution` is `failed` and the tool honestly reports failure — the AI is never allowed to claim success on a code path where persistence didn't happen.

### 24.4 Idempotency — keyed to a specific attempt, not to "similar inputs" (review concern 10, redesigned in this revision)

The first pass derived `idempotencyKey` from `(conversationId, tool, a stable hash of args)`. On review, this is the wrong invariant: it deduplicates *any two calls with the same arguments*, which incorrectly collapses a customer legitimately creating the same type of ticket on two different occasions (e.g., "I have a billing question" twice in unrelated conversations a week apart could, depending on hash granularity, even collide within one conversation) into a single execution. The actual invariant this plan needs is narrower and more correct:

**Retrying the *same operation attempt* must not duplicate its effect. Two *different* legitimate attempts, even with identical-looking arguments, must not be conflated.**

The redesigned key reflects this — it identifies an attempt, not a payload shape:

```ts
function computeIdempotencyKey(ctx: TenantContext, runtimeCtx: { toolCallId?: string }, explicitKey?: string): string {
  if (explicitKey) return explicitKey;                                    // client-supplied, for API-triggered actions (below)
  if (runtimeCtx.toolCallId) return `${ctx.businessId}:${runtimeCtx.toolCallId}`;  // AI-initiated: the PROVIDER'S OWN tool-call ID
  throw new Error("No idempotency key available — every ActionExecution requires one");
}
```

- **AI-initiated tool calls** use the AI provider's own `toolCallId` (§21.1 — both OpenAI and Anthropic assign a unique ID to each tool call within a completion). This ID is stable across a retried `AIOrchestrator` completion call (§21.3) — if the *same* provider response is processed twice (e.g., due to a retry at the HTTP layer between Ziyrak and the provider), the same `toolCallId` recurs and `ToolRegistry.execute()` recognizes the duplicate attempt and returns the previously-recorded result. A **genuinely new** AI decision to call the same tool with the same arguments — a different turn, a different `toolCallId` — is correctly treated as a new, independent attempt, because the key differs.
- **API-triggered or manual actions** (a human clicking "create ticket" in the dashboard, an external API call) accept an explicit, client-supplied `idempotencyKey` — the standard pattern used by Stripe and similar APIs — so a client that wants retry-safety can provide one, and a client that doesn't is simply making independent, non-deduplicated calls each time (the field is required by the schema, §24.2, but the *caller* decides what "the same attempt" means for its own retry logic by choosing what value to send, or by having the platform generate a fresh one per call if the caller doesn't care about idempotency for that particular action).
- **Job-level retries** (a `send-followup` job failing transiently and being retried by pg-boss) reuse the exact `idempotencyKey` the tool call already established when it scheduled the job — so a job retry and a tool-call retry converge on the same "was this exact attempt already completed" check, rather than being two separate idempotency mechanisms layered on top of each other.

This directly satisfies the review's stated rule: **retrying the same operation does not duplicate the effect; similar operations are not artificially limited to happening only once.**

---

## 25. Job Queue / Worker Architecture

### 25.1 Technology recommendation: pg-boss (confirmed again after review)

| Option | Recommendation | Why |
|---|---|---|
| **pg-boss** (Postgres-backed queue, `SKIP LOCKED`) | **Recommended, confirmed** | No new infrastructure dependency — Postgres is already a hard requirement for this app; supports delayed/scheduled jobs, retries with backoff, dead-letter, concurrency control, per-key singleton/debounce semantics (§25.5), and cron-like recurring jobs (needed for the SLA/retention sweeps) natively. Local dev story is identical to today's (`docker-compose up db`) — no new container. The review's only note on this choice was to clarify its architectural role (§25.6), not to reconsider it. |
| BullMQ (Redis-backed) | Considered, deferred | More mature ecosystem/dashboarding (Bull Board), but requires Redis as a **hard** dependency starting now, when Redis is currently fully optional (§2.7) and not even an installed package. Phase 8 (scalability) makes Redis mandatory anyway (cache/rate-limit/realtime) — revisit BullMQ then if pg-boss's throughput ceiling (fine into the thousands of jobs/minute, per its own documented limits) becomes a real constraint. |
| Cloud-managed queue (SQS, Cloud Tasks) | Considered, rejected for now | Ties the architecture to one cloud provider prematurely, and self-hosted/Docker-Compose local development (§40) is an explicit requirement this plan must preserve. |

The `JobQueue` interface is written now so this choice is swappable later without touching call sites:

```ts
export interface JobQueue {
  enqueue<T>(jobType: string, payload: T & { businessId: string }, opts?: { idempotencyKey?: string; singletonKey?: string }): Promise<string>;
  schedule<T>(jobType: string, payload: T & { businessId: string }, opts: { runAt: Date; idempotencyKey?: string; singletonKey?: string }): Promise<string>;
  scheduleRecurring(jobType: string, cronExpression: string, payloadFactory: () => Promise<unknown>): Promise<void>;
  registerHandler<T>(jobType: string, handler: (ctx: TenantContext, payload: T) => Promise<void>): void;
  start(): Promise<void>;   // called once by the worker process
}
```

`PgBossJobQueue` is the Phase 6 implementation (§46.6); a `FakeJobQueue` (synchronous, in-memory, immediately invokes registered handlers, respecting `singletonKey` serialization in its own simplified way for concurrency tests — §25.5) is the test double used throughout the test suite so job-dependent behavior can be asserted without a real queue running in every test file. Note `registerHandler`'s signature now takes `ctx` as an explicit first parameter to the handler (§16.3, review concern 2), not an ambient value the handler must look up itself.

### 25.2 What moves onto the queue, and why each one specifically

| Today | Problem (verified in §2) | Target job |
|---|---|---|
| `schedule_followup` tool | Persists nothing (§2.3) | `send-followup` job, scheduled via `jobQueue.schedule()` at tool-call time (§24.3); not exposed to the AI until this half of Phase 6 lands (§24.3's revised sequencing) |
| Webhook retry (`webhook-delivery.ts`'s `setTimeout` chain) | Retry state lives only in the process's event loop — lost on restart/redeploy, even though `nextRetryAt` is persisted to the DB, nothing sweeps it back up if the timer is lost | `deliver-webhook` job with pg-boss's native retry/backoff policy; `attemptDelivery()`'s HTTP/signing logic is reused verbatim inside the job handler, routed through the SSRF-hardened dispatcher (§32) |
| `checkSLABreaches()` | Never called by anything (§2.4) | `sweep-sla-breaches` recurring job, iterating businesses via the control-plane `Business` table then resolving each one's `TenantPlacement` |
| `applyRetentionPolicy()` | Never called by anything (§2.4) | `sweep-retention` recurring job (e.g., daily), reading each business's retention setting from `BusinessConfig` |
| Campaign send (`sendProactiveMessage`, never actually invoked — §2.4) | `execute` route only counts targets | `execute-campaign` job, iterating matched customers and calling the appropriate `ChannelAdapter.sendMessage()` for each — this is what makes "execute campaign" actually send messages for the first time |
| Knowledge embedding indexing (`indexKnowledgeEntry`) | Currently called synchronously wherever it's invoked, blocking the request | `index-knowledge-entry` job — non-blocking, and naturally where future PDF/file ingestion (§22.4) would enqueue chunked-document indexing work |
| Inbound message processing (new, §17.6) | N/A — this pipeline didn't previously distinguish "acknowledge" from "process" | `process-inbound-message` job — every real channel's webhook enqueues this rather than running the AI pipeline inline |

### 25.3 Worker process

A new `worker` entrypoint (e.g., `src/worker.ts`, run via a separate `npm run worker` script and a separate container/process in `docker-compose.yml` and the Helm chart — not a `setInterval` inside the Next.js server, which today's codebase has zero precedent for and which would tie job execution to a web request's process lifecycle) calls `jobQueue.start()` after registering all handlers. This is deliberately a **separate deployable** from the web app from day one (even though Phase 6-7 may run both as a single container/replica for simplicity, per §40's local-dev-friendliness principle) specifically so Phase 8's "scale workers independently of web replicas" requires no architectural change — only a deployment-config change (separate replica counts).

### 25.4 Observability and tenant awareness

Every job payload requires `businessId` (typed, not optional) — enforced by the `JobQueue` interface's generic constraint (`T & { businessId: string }`). The worker resolves a `TenantContext` from it before invoking any handler (§16.3), via the same `resolveTenantPlacement()` control-plane lookup a request uses, so job handlers get the same five-layer tenant-isolation guarantee as request handlers (§8). Job outcomes (success/failure/retry count) are logged with `businessId`, `jobType`, and a `correlationId` tying back to the originating `ZiyrakEvent` where applicable (§17.1, §37).

### 25.5 Per-conversation ordering under concurrent workers (review concern 9, new in this revision)

**The problem:** with more than one worker process, two messages arriving in quick succession for the *same* conversation could be picked up by two different workers simultaneously. Each would load the conversation's history independently, and — depending on timing — could produce replies that interleave incorrectly or that both react to a stale view of the conversation (worker B's AI call doesn't see the message worker A is still processing). Different *conversations* should still process fully in parallel; only work for the *same* conversation needs to be serialized.

**The chosen mechanism:** pg-boss's per-job **singleton key** (`opts.singletonKey`, §25.1's interface). Every `process-inbound-message` job is enqueued with `singletonKey: `${businessId}:${conversationId}`` (or, before a conversation is resolved, `${businessId}:${channel}:${contact}` — the same identifier `resolveOrCreateConversation` would converge on). pg-boss guarantees at most one active job per singleton key at a time; a second message for the same conversation arriving while the first is still being processed either queues behind it (processed immediately after, in arrival order) rather than running concurrently. This gives **strict per-conversation ordering with full cross-conversation concurrency**, without any manual lock bookkeeping in application code.

**Documented fallback, if singleton-key semantics prove insufficient at implementation time:** a Postgres advisory lock (`pg_advisory_xact_lock(hashtext(businessId || ':' || conversationId))`) taken at the start of the `process-inbound-message` handler and held for the duration of the transaction/processing — released automatically at transaction end, requiring no explicit unlock bookkeeping, and providing the same per-conversation serialization directly against Postgres if the job-queue-level mechanism needs a second, lower-level backstop. This fallback is documented here as the considered alternative, not built preemptively (Principle 2, §4) — it is adopted only if Phase 6's implementation of the singleton-key approach reveals a gap.

**Interaction with retries and redelivery:** a redelivered webhook (§17.4) is deduplicated by `InboundEventReceipt` *before* a job is ever enqueued, so it never reaches the singleton-key mechanism at all — the two mechanisms guard different failure modes (duplicate delivery vs. concurrent processing of distinct, legitimate messages) and are deliberately independent rather than one being relied upon to cover the other.

### 25.6 The job queue is shared platform infrastructure, even for dedicated-database tenants (review concern 12, clarified in this revision)

**The question the review raised:** once a business is placed onto a dedicated database (Phase 9, §46.9), does the platform need a separate pg-boss instance polling that business's dedicated database? **No** — and this revision states explicitly why not, since the first pass left this only implicit.

pg-boss itself — the queue's own tables (job records, schedules) — lives in the **control-plane database** (§7.4), which is shared platform infrastructure exactly like `Business`/`TenantPlacement` are, regardless of where any individual tenant's *data* is placed. A job's payload carries `businessId`; when the worker picks up the job, it resolves that business's `TenantPlacement` (§7.5) — the same control-plane lookup a web request performs — to get a `TenantContext` pointed at the correct data-plane connection (shared or dedicated), and runs the handler against `getScopedPrisma(ctx)` exactly as always. **The queue does not need to know or care where a business's data lives — only the handler's data access does, at the point it actually reads or writes.** This is the concrete mechanism satisfying the review's "shared Ziyrak job system → job.businessId → TenantPlacement resolver → correct tenant datastore → execute" shape, and it means Phase 9 adds zero new job-queue infrastructure per dedicated tenant — a business moving to a dedicated database is purely a `TenantPlacement`/`DatabaseProfile` change, invisible to the job queue itself.

---

## 26. Realtime Architecture

### 26.1 `RealtimeBus` — renamed from `EventBus`, explicitly ephemeral (review concern 6)

`realtime.ts`'s in-memory `Map<string, Set<EventCallback>>` (§2.7) is correct and sufficient for exactly one replica. The target introduces a `RealtimeBus` contract — renamed from the first pass's `EventBus` specifically to stop implying it is the durable event-handling mechanism (§17.3 explains the split in full; this section covers only the renamed, narrowed-scope realtime piece):

```ts
export interface RealtimeBus {
  publish(channel: string, event: ZiyrakEvent): Promise<void>;   // best-effort — see §17.3 for what this guarantees and doesn't
  subscribe(channel: string, callback: (event: ZiyrakEvent) => void): () => void;
}
```

`InMemoryRealtimeBus` (today's `realtime.ts` logic, unchanged) remains the default for single-replica deployments (Phase 0-7, including the initial production topology, §5.8 — a genuine, justified case of "simple infrastructure today," Principle 2/§4, since the MVP does not require multiple web replicas). `RedisRealtimeBus` (Redis Pub/Sub) is introduced in Phase 8 when horizontal scaling is actually being validated, mirroring the exact optional-Redis pattern `cache.ts` already establishes elsewhere in this codebase (§2.1) — this plan extends an existing, familiar pattern rather than inventing a new one. Callers of `RealtimeBus.publish()` must never be on the critical path for a business action actually happening (§17.3) — it is called *after* the durable write, purely to speed up dashboard notification.

### 26.2 Tenant scoping of channel names (mandatory, not optional)

Today's channel keys are bare strings (`global`, `conversation:<id>`) with **no tenant namespace at all** — verified in `realtime.ts:97-140`, every `publish()` call site. Under multi-tenancy this is a direct cross-tenant leak vector: a `global` subscription today receives every event system-wide, and `conversation:<id>` requires only guessing a UUID (or, if this were reused unmodified with a "channel" query param, exactly the same unauthenticated-access issue as `/api/realtime` in §2.2). Target channel naming is mandatorily tenant-prefixed: `tenant:<businessId>:global` and `tenant:<businessId>:conversation:<id>` — never a bare `global`. `GET /api/realtime` (fixed for the auth bypass in Phase 0, §46.0) additionally validates, after authentication, that the requested `conversationId` belongs to the caller's `businessId` (via the same tenant-scoped Prisma lookup, §8) before subscribing — a client cannot subscribe to a channel for a conversation it is not authorized to read, closing the exact isolation failure mode named in the product brief's §25 example, applied to realtime specifically. For Web Chat (§20.4), the subscribing client is the widget itself, authenticated by its publishable connection token rather than a JWT — the same ownership check applies, scoped to "this token's `ChannelConnection`'s own conversations only."

---

## 27. Storage Architecture

### 27.1 The contract

```ts
export interface ObjectStorage {
  putObject(ctx: TenantContext, key: string, body: Buffer | Readable, opts?: { contentType?: string }): Promise<{ key: string; url?: string }>;
  getObject(ctx: TenantContext, key: string): Promise<Readable>;
  getSignedUrl(ctx: TenantContext, key: string, opts?: { expiresInSeconds?: number }): Promise<string>;
  deleteObject(ctx: TenantContext, key: string): Promise<void>;
}
```

Every key is prefixed by the adapter itself, not by callers: `tenants/<businessId>/<caller-provided-suffix>` — callers cannot construct a key that escapes their own tenant prefix, which is the storage-layer equivalent of §8's Prisma-extension approach (structural, not conventions-based). The bucket/credentials a given business's `ObjectStorage` instance actually talks to are resolved via `TenantPlacement.storageProfileId` → `StorageProfile` (§7.6) — for the shared-infrastructure majority this always resolves to the same platform bucket; for a Phase-9 dedicated-storage business it resolves to that business's own, without any change to the `ObjectStorage` interface or its callers.

### 27.2 Why this is net-new, not a migration

As established in §2.5, there is currently **no** file/media persistence anywhere in the codebase — WhatsApp media is described in text and discarded, and no upload endpoint exists. This means Phase 7 introduces `ObjectStorage` to support a genuinely new capability (persisting inbound WhatsApp media, knowledge-base file uploads for §22.4's future ingestion, exported GDPR data bundles) rather than migrating an existing local-disk dependency — the one real exception is `.wwebjs_auth` (WhatsApp Web session data), which is infrastructure/session state tied to the `WhatsAppWebAdapter`'s dev/demo-only role (§20.2), not tenant file storage, and is explicitly left on a Docker volume as-is (moving *session credentials* into S3-style object storage would add complexity with no product benefit, since that adapter is single-instance-only by design already).

### 27.3 Local vs. production adapters

`LocalFilesystemStorage` (writes under a gitignored `./storage/` directory, tenant-prefixed subfolders) is the local-development default — zero new infrastructure required to run the app locally (§40). `S3CompatibleStorage` (via the AWS SDK v3 S3 client, which speaks the S3 protocol against real AWS S3, MinIO, Cloudflare R2, Backblaze B2, or any S3-compatible target) is the production default, resolved per-business through `StorageProfile` (§7.6). `docker-compose.yml` gains an optional MinIO service for local integration testing of the S3 path specifically (not required for day-to-day development, where the filesystem adapter suffices) — mirroring the product brief's own example almost exactly.

---

## 28. Database Architecture

### 28.1 Shared database, shared schema, now — and why that's the right MVP choice

Every business shares one Postgres database and one schema, distinguished by `businessId` columns, the tenant-scoping extension, and composite foreign keys (§8). This is the correct default per the product brief's own framing ("most early Ziyrak customers can share infrastructure... logical tenant isolation is sufficient") and avoids the operational overhead of provisioning a schema or database per signup, which does not pay for itself until a specific customer requires it. Per §7.4, the **control plane and data plane are architecturally distinct from Phase 1 even though they are the same physical database until Phase 9** — this is what lets §28.2 below resolve cleanly rather than facing the bootstrap circularity the review identified.

### 28.2 The seam that makes dedicated-DB tenants possible later without a rewrite — resolved via `TenantPlacement`, not a policy row inside the tenant's own data

The first pass proposed `getPrismaForTenant(businessId)` reading `InfrastructurePolicy.dedicatedDatabaseUrl` directly. §7.4-7.6 supersede this: the actual resolution path is

```ts
// src/lib/platform/tenant-placement.ts — control-plane module (§6), always queries the control-plane connection
export async function resolveTenantPlacement(businessId: string): Promise<{ dataConnection: string }> {
  const placement = await controlPlaneDb.tenantPlacement.findUniqueOrThrow({ where: { businessId } });
  const profile = await controlPlaneDb.databaseProfile.findUniqueOrThrow({ where: { id: placement.databaseProfileId } });
  const connectionString = await secretResolver.decrypt(profile.connectionSecretRef);  // §10.3
  return { dataConnection: getOrCreateCachedClient(connectionString) };
}
```

`getScopedPrisma(ctx)` (§8.3) uses `ctx.dataConnection` (already resolved by the time `ctx` exists — §8.7's flow) rather than re-resolving anything itself. Until `InfrastructurePolicy`/non-default `DatabaseProfile` rows exist (pre-Phase-9), every business's `TenantPlacement.databaseProfileId` is the literal string `"shared-default"`, which resolves to the same connection string the control plane itself uses — **zero behavior change, zero performance cost** for the shared-tenant path beyond one indexed control-plane lookup, cached per business for the life of a request/job. This is the concrete mechanism satisfying "explain how your proposed architecture can later support dedicated schema/dedicated database, and what level of abstraction is required now" — the abstraction required now is `TenantPlacement` + the two profile tables, introduced in Phase 1 (§46.1) precisely because retrofitting the control-plane/data-plane distinction later, after application code had already assumed a single database, would be the expensive rework the review's bootstrap concern warned about.

### 28.3 Dedicated-schema as a middle ground

Between "shared schema" and "fully separate database," Postgres schemas offer a lighter-weight dedicated-namespace option (same physical database/connection, different Postgres `schema` per tenant) — noted here as a viable Phase 9 option for tenants wanting logical separation without the operational cost of a second database instance, selected the same way a dedicated database is (a `DatabaseProfile` row whose connection string is schema-qualified), evaluated concretely at Phase 9 implementation time based on which compliance requirements actually materialize (data residency typically requires a genuinely separate database/region, not just a separate schema in the same physical database — so this option is named, not committed to, until a real requirement clarifies which is needed).

### 28.4 Connection pooling

No pooling infrastructure exists today (§2.7). Recommendation: introduce PgBouncer (transaction-pooling mode) in front of Postgres starting in Phase 8 (scalability), when replica count > 1 makes connection exhaustion a real risk rather than a theoretical one — introducing it earlier would add operational complexity (an extra proxy to run and monitor) with no present benefit at N=1 replica. `PrismaPg`'s adapter connection-limit should be explicitly configured (not left at library default) at the same time, sized to `(postgres_max_connections / replica_count)` minus headroom for the worker process's own pool. Note that the control-plane lookup added by §28.2 (one extra indexed query per request/job) is a candidate for a short-TTL in-process cache once Redis is available (Phase 8) — not required before then, since a single indexed primary-key lookup against the same database the request was already going to hit is not a meaningful added cost at MVP scale.

---

## 29. Cache / Shared State

Redis's responsibilities, once it becomes mandatory in Phase 8 (scalability), are exactly three, all already-named seams in this codebase rather than new concepts:

1. **Rate limiting** — replaces `rate-limit.ts`'s in-memory `Map` (§2.7) with a Redis-backed sliding-window/token-bucket implementation behind the same `checkRateLimit(key, config)` call signature, so `middleware.ts` and any other call site require no change beyond the implementation swap. Rate-limit keys additionally gain tenant awareness where relevant (per-API-key limits should be per-business, not just per-IP, once API traffic volume makes that distinction matter — noted as a Phase 8 refinement, not required for the initial Redis migration itself). The Web Chat widget's own, more aggressive per-token rate limit (§20.4) uses this same mechanism once Redis is mandatory, and the in-memory limiter before then.
2. **Cache** — `cache.ts` already has a Redis code path (§2.1); Phase 8 makes it the default rather than the opportunistic fallback, and adds the `redis` package to `package.json` (currently absent despite being dynamically imported — a latent bug that would throw today if `REDIS_URL` were ever set without a separate manual install, §2.1).
3. **`RealtimeBus` pub/sub backing** — `RedisRealtimeBus` (§26.1).

Redis is explicitly **not** used as a primary datastore for anything (no session storage, no durable job state — pg-boss keeps job state in Postgres, §25.1) — its role stays scoped to these three well-understood, already-partially-implemented responsibilities, per Principle 2 (§4).

---

## 30. Scalability Strategy

### 30.1 Blocker inventory with urgency classification

Directly extending the verified inventory in §2.7, classified per the product brief's requested urgency scale (phase references updated for the 10-phase roadmap, §45):

| Blocker | Urgency | Resolved in |
|---|---|---|
| `/api/chat`, `/api/realtime` unauthenticated | **Must fix before serious development continues** — live exploit today | Phase 0 (§46.0) |
| No tenant isolation at all | **Must fix before serious development continues** — every subsequent phase depends on it existing | Phase 1-2 (§46.1-46.2) |
| `schedule_followup`/SLA/retention non-functional | **Must fix before first production customer** — a paying customer relying on these being real would be actively misled | Phase 6 (§46.6) |
| `whatsapp-web.js` as the only WhatsApp path | **Must fix before first production customer** (for any customer beyond the platform's own demo) | Phase 7 (§46.7) |
| No inbound webhook deduplication | **Must fix before first production customer** — a redelivered webhook duplicating a ticket/reply is a customer-visible correctness bug, not a scale concern | Phase 5 (§46.5) |
| In-memory rate limiter/cache | **Must fix before multiple app replicas** — correct at N=1, degrades gracefully (not silently wrong) below that | Phase 8 (§46.8) |
| In-memory `RealtimeBus` | **Must fix before multiple app replicas** — this one fails silently (missed notifications) rather than degrading, so it is a high-priority item within Phase 8, though per §17.3 it was never the durable-correctness mechanism to begin with | Phase 8 (§46.8) |
| No DB connection pooling | **Must fix before multiple app replicas** | Phase 8 (§46.8) |
| Campaign targeting's 1000-row in-memory filter cap | **Future optimization** — not a correctness risk at MVP customer-list sizes, revisit if a single business's customer count approaches the cap | Noted, not scheduled to a specific phase |
| JS-side knowledge-retrieval scoring (§22.3) | **Future optimization** | Candidate for Phase 8, trigger-based (§22.3) |

### 30.2 The general principle

Every "must fix before multiple app replicas" item in §30.1 is already behind a contract by the time Phase 8 starts (`RealtimeBus`, cache functions, `JobQueue`, `ObjectStorage`, `TenantPlacement`'s connection resolution) — because Phase 3-6 introduce those contracts for tenant-isolation and modularity reasons that are independently justified, before scaling is even the topic. Phase 8's job is therefore narrowly "swap the default adapter for the shared-state-aware one and validate with a real multi-replica test," not "redesign how any of these subsystems work." This sequencing — contracts before scale — is precisely why this plan's phase order (§45) puts scaling as late as Phase 8 rather than earlier: doing it earlier would mean building Redis-backed implementations before the interfaces they'd sit behind exist, guaranteeing rework.

---

## 31. Reliability Strategy

### 31.1 Retries

- **AI provider calls:** one bounded retry for retryable `AIProviderError`s (§21.3), then the existing graceful fallback message.
- **Webhook delivery:** unchanged 3-attempt/backoff *policy*, moved onto pg-boss's durable retry mechanism instead of `setTimeout` (§25.2) so a retry survives a process restart.
- **Channel sends:** `ChannelAdapter.sendMessage()` implementations should surface a typed `SendResult` (`{ success: boolean; retryable: boolean; error?: string }`) so callers (e.g., the campaign-send job, §25.2) can apply a bounded retry via the job queue's own retry policy rather than each adapter reinventing retry logic.

### 31.2 Idempotency — exactly-once effect under retry (revised per review concern 10, §24.4)

Covered in depth at §24.4 for tool/action execution — an attempt-scoped key (`toolCallId` for AI-initiated calls, a client-supplied key for API/manual actions), never a hash of arguments. The same principle extends to job handlers generally: every `JobQueue.enqueue`/`schedule` call that corresponds to a user-visible or business-visible effect (sending a message, creating a ticket) carries an `idempotencyKey`, and a job-queue-level retry (distinct from, and in addition to, the retries in §31.1) re-executing the same key must observe the already-recorded `ActionExecution` result rather than re-running the side effect — this is what makes §33/§34's mandatory "worker retry executes exactly once" test (review concern 20) a meaningful, checkable property rather than an aspiration.

### 31.3 Failure handling and graceful degradation

- **AI provider down/misconfigured:** existing fallback copy (`engine.ts:231`) preserved; conversation is not silently dropped, and (new) a low-confidence/failed-AI-response path is one of the `EscalationManager`'s (§18.1) triggers for human handoff, not just the existing confidence-score heuristic.
- **Job queue unavailable:** tool executions that depend on it (`schedule_followup`) fail honestly (§24.3) rather than falsely claiming success — this is the specific, load-bearing reliability guarantee this whole plan is designed to make possible, and it is now enforced structurally by §24.3's revised phase sequencing (the tool is not even offered to the AI until the queue exists), not merely by careful error handling in the tool itself.
- **A single channel adapter down** (e.g., Meta Cloud API returning 5xx) must not affect other channels or other businesses — enforced by each adapter's calls being isolated `try`/`catch` at the dispatcher level (§18.2), consistent with today's existing per-channel `try`/`catch` pattern (verified present in every channel file, e.g. `whatsapp.ts`'s message handler, `phone.ts`'s `handleSpeechInput`).
- **Database unavailable:** out of scope for application-level mitigation beyond existing Next.js/Prisma error surfacing and the `/api/health` check already used by Docker/Helm health probes (verified present, `docker-compose.yml`/`Dockerfile` `HEALTHCHECK` blocks) — no application-level read-replica fallback is proposed, as this is an infrastructure/ops concern better solved by managed Postgres failover than application code. Note: since control-plane and data-plane share one database until Phase 9, "database unavailable" affects both uniformly pre-Phase-9; post-Phase-9, a dedicated tenant's data-plane outage does not affect the control plane's ability to route *other* businesses' traffic, which is one of the concrete operational benefits of the split named in §7.4, realized once dedicated placements exist.
- **Redelivered/duplicate inbound events:** handled structurally, not as a failure-recovery afterthought — §17.4's `InboundEventReceipt` check runs before any processing, so a duplicate is a fast, cheap no-op ACK, not a partially-completed pipeline that needs cleanup.

---

## 32. Security Architecture

Re-auditing against the product brief's specific list, cross-referenced to where this plan addresses each (updated for this revision's findings and phase renumbering):

| Threat | Current state (verified) | Addressed in |
|---|---|---|
| Authentication bypass | Live, confirmed (§2.2) | Phase 0 (§46.0) |
| Authorization / cross-tenant access | No tenant concept exists to bypass yet — the risk is introduced *by* multi-tenancy and must be closed in the same phases that introduce it | Phase 1-2 (§46.1-46.2), enforced structurally per §8's five layers |
| Insecure direct object references (IDOR) | Currently moot (single tenant); becomes the central risk once tenant data coexists | Closed structurally by the `findUnique`→`findFirst`-with-tenant-filter rewrite (§8.3) **and** by composite foreign keys (§8.4) — two independent layers, not one |
| Tenant-scoped API keys, stored irrecoverably | Not scoped at all today — every key is global admin, and stored as recoverable plaintext (§2.9) | Phase 1-2 (§9.4) — `keyPrefix`+`keyHash`, never a recoverable secret |
| Secret storage | Plaintext in Postgres, masked only at API-response time (§2.6, `security.ts`) | Envelope-encrypted, rotation-versioned `SecretResolver` for `ChannelConnection` credentials **and** infrastructure profile credentials (§10.3, §7.6), Phase 1 |
| Channel webhook verification | Twilio: real (`twilio-verify.ts`, verified correct HMAC-SHA1 + `timingSafeEqual`). Telegram: **none verified today** (§19.2 — a genuine, newly-identified gap). Meta Cloud API / Web Chat: not yet implemented | Phase 5 adds Telegram secret-token verification and the Web Chat widget-token/origin model; Phase 7 implements Meta's `X-Hub-Signature-256` verification from day one of that adapter |
| Inbound event replay / duplicate processing | No deduplication on any channel today (§2.5, §2.11) | `InboundEventReceipt`, mandatory for every production channel from Phase 5 (§17.4, §46.5) |
| **SSRF via webhooks/integrations — strengthened in this revision (review concern 19)** | `trigger_webhook`/`webhook-delivery.ts`/`webhooks/test` all `fetch()` an admin-configured URL with **no** allowlist/deny-private-IP-range check of any kind, literal-string or otherwise — verified: no such check exists in any of the three call sites | See §32.1 below — a shared, hardened outbound HTTP dispatcher, built as part of Phase 6's tool-registry work |
| Prompt injection | Not mitigated at all today — knowledge-base content and customer messages are concatenated directly into the system/user prompt with no delimiter discipline beyond today's plain string interpolation | Out of full solution scope for this plan (an open, industry-wide problem), but the guardrail pipeline (§18.1) and the tool-permission model (§23) are the concrete mitigations available: even a successfully-injected instruction cannot call a tool outside `getAvailableTools(ctx)`'s tenant/`ToolPolicy`-filtered set (§9.5/§23.4), and a `requiresHumanApproval` tool cannot be pushed to actually execute by prompt injection alone — bounding the blast radius of a successful injection to "the AI said something wrong" or, at worst, "a request was queued for a human to reject," never "the AI took an unreviewable high-stakes action" |
| Tool abuse / AI privilege boundaries | No permission check before tool execution today (§23.1) | `ToolPolicy` (§23.4) gates AI-initiated calls independently of RBAC; `requiredPermission` gates human-initiated calls; both enforced identically at the registry, not per-caller |
| Rate limiting | Per-IP only, in-memory (§2.7) | Phase 8 adds Redis-backed limiting; per-business/per-API-key limiting and the Web Chat widget's stricter per-token limiting noted as Phase 8 refinements (§29) |
| File upload security | No upload path exists yet (§27.2) | `ObjectStorage` adapters (Phase 7/8) must validate content-type/size and never trust a client-supplied filename for the storage key (tenant-prefixed, adapter-generated keys per §27.1) |
| PII / GDPR | `redactPII`'s phone regex is a blunt over-matcher (verified, `gdpr.ts:14`, matches most digit runs of meaningful length — order numbers, ticket IDs); `exportCustomerData`/`deleteCustomerData` logic is otherwise sound and tenant-scopes cleanly (§12) | Regex refinement is a low-risk, low-priority follow-up (not blocking any phase); tenant-scoping the existing GDPR functions is required as part of Phase 1's model migration |
| Audit logs | `ActivityLog` exists and is populated from most (not all) mutating routes today, unscoped to tenant | Tenant-scoped in Phase 1 (§12); extended in §38 |
| Storage isolation | N/A today (no storage exists) | Enforced by construction in `ObjectStorage`'s key-prefixing (§27.1) |
| **A public, browser-embedded credential (Web Chat widget) being mistaken for or reused as an admin secret** | N/A today (no public-facing channel exists) | Structurally distinct token type/prefix, scoped capabilities, origin allowlist, dedicated rate limiting — §20.4, new in this revision |

### 32.1 SSRF hardening in depth (review concern 19)

The first pass's mitigation was a literal deny-list of IP-address *strings* (e.g., rejecting a URL whose hostname is literally `169.254.169.254`). On review, this is insufficient: an attacker-influenced or -adjacent URL (recall that `trigger_webhook`/`webhook-delivery.ts` dispatch to admin-configured URLs — the threat model here is a **compromised or malicious tenant admin**, or a URL that changes ownership/DNS after being configured, not an anonymous external attacker) can trivially bypass a literal-string check via a hostname that only *resolves* to a private/internal address, via an HTTP redirect to one, or via an IPv6 representation the check didn't anticipate. The tenant-admin threat model matters specifically because **tenant administrators are trusted to manage their own business's configuration, but they are explicitly not trusted with access to Ziyrak's own infrastructure network** — a webhook URL is exactly the kind of tenant-supplied value that must not be able to reach the platform's internal services or cloud metadata endpoint.

The revised, shared outbound HTTP dispatcher (`src/lib/integrations/http-dispatcher.ts`, used by both `trigger_webhook` and `webhook-delivery.ts` — consolidated per the first pass's original intent, now with a materially stronger check):

1. **Resolves DNS itself, before connecting**, using a custom `lookup` function passed to Node's `http`/`https` agent (or the `undici`/`fetch` equivalent) rather than letting the underlying HTTP client resolve DNS implicitly at connect time — this is what makes the *resolved* address, not the input hostname string, the thing that gets validated.
2. **Validates every resolved address** against: IPv4 RFC1918 private ranges, loopback (`127.0.0.0/8`), link-local (`169.254.0.0/16`, which covers the AWS/GCP/Azure metadata endpoint `169.254.169.254`), IPv6 equivalents (unique local `fc00::/7`, link-local `fe80::/10`, loopback `::1`), and any address the resolver returns that maps back to one of these via IPv4-mapped IPv6 notation (`::ffff:169.254.169.254`) — a class of bypass a naive string check misses entirely.
3. **Rejects the connection outright if any resolved address is disallowed**, before a TCP connection is ever opened — not merely after receiving a response.
4. **Does not follow redirects automatically.** A redirect response (3xx) is treated as a new outbound request, subject to the identical resolve-then-validate check — an allowed initial URL that redirects to a disallowed internal address is caught at the redirect hop, not silently followed (this is the "redirects to private/internal IPs" case the review names explicitly).
5. **Re-validates on every retry** (§25.2's `deliver-webhook` job retries) — DNS is not trusted to be stable between attempts (this is the practical mitigation for DNS-rebinding-style attacks within this plan's threat model: a URL that resolved safely on attempt 1 but rebinds to an internal address by attempt 3 is caught, because every attempt re-resolves and re-validates rather than trusting a cached result from the first check).

This dispatcher is built once, in Phase 6 (§46.6), and used by every outbound webhook-style call in the platform — `trigger_webhook` (the AI tool), `webhook-delivery.ts` (business-configured outbound webhooks), and any future integration that makes an outbound HTTP call to a tenant-supplied URL — closing the gap in one place rather than per-caller, and is covered by the specific redirect/DNS-resolution test cases required in §33/§34 (review concern 20).

---

## 33. Tenant Isolation Test Strategy

### 33.1 The standard test shape, applied to every tenant-owned resource in §12's table

For each resource `R` with a list endpoint, a get-by-ID endpoint, and (where applicable) update/delete/action endpoints:

```ts
describe(`tenant isolation: ${R}`, () => {
  it("Business A cannot list Business B's rows", async () => {
    const bCtx = await seedBusinessWithResource(R);
    const aAuth = await loginAs(businessA.owner);
    const res = await api.get(`/api/${R.plural}`, aAuth);
    expect(res.body.data.map(r => r.id)).not.toContain(bCtx.resourceId);
  });

  it("Business A cannot fetch Business B's row by known ID", async () => {
    const res = await api.get(`/api/${R.plural}/${bCtx.resourceId}`, aAuth);
    expect(res.status).toBe(404);   // not 403 — existence must not leak, §33.3
  });

  it("Business A cannot update/delete Business B's row by known ID", async () => { /* same pattern, expect 404 */ });

  it("Business A cannot create a resource referencing Business B's row as a foreign key (application layer)", async () => {
    // e.g., assign a ticket to Business B's TeamMember ID — caught by assertSameTenant, §8.5
    const res = await api.post(`/api/tickets`, { assignedToId: bCtx.teamMemberId }, aAuth);
    expect(res.status).toBe(404);
  });

  it("Postgres itself rejects the same cross-tenant reference, even bypassing assertSameTenant (§8.4, review concern 1/20)", async () => {
    // deliberately skip the service layer and assertSameTenant — write directly against getScopedPrisma
    const db = getScopedPrisma(businessAContext);
    await expect(
      db.ticket.create({ data: { title: "t", description: "d", assignedToId: bCtx.teamMemberId } })
    ).rejects.toThrow(/foreign key constraint/i);   // composite FK (businessId, assignedToId) → TeamMember(businessId, id)
  });
});
```

This exact matrix — now including the database-level bypass test, new in this revision — is run for: customers, conversations, messages, tickets, teams/departments, knowledge (categories + entries), business configuration, channel connections, API keys, webhooks (+ deliveries), activity log, automations, flows, campaigns, tools/action-executions, tool policies, and (once implemented) uploaded files. This is the literal, non-negotiable test list the product brief demands, and it is treated as a **security regression suite that blocks merges**, not an optional nice-to-have — new tenant-owned models added after Phase 2 must ship with their entry in this matrix before merge (enforced by code review checklist, §36).

### 33.2 Realtime, jobs, and files get the same treatment, adapted to their shape

- **Realtime:** Business A subscribes to `tenant:<A>:conversation:<id>` for a conversation belonging to Business B (by guessing/reusing a known ID) → subscription is rejected before any event is ever delivered (§26.2). For Web Chat, a widget token from one `ChannelConnection` cannot subscribe to or read another connection's (or another business's) conversations.
- **Jobs:** a job payload is (in a test double) crafted with a mismatched `businessId` vs. the resource it references (e.g., a `send-followup` job for Business A's conversation but Business B's `businessId`) → the handler's `getScopedPrisma`-based lookup returns not-found, and the job fails loudly (logged, not silently ignored) rather than operating on the wrong tenant's data.
- **Files:** once `ObjectStorage` exists (Phase 7+), Business A requesting a signed URL for a key outside its own `tenants/<A>/` prefix is rejected at the adapter level (§27.1), tested directly against each adapter implementation (local + S3-compatible).

### 33.3 Why 404, not 403, is the standard response for cross-tenant access attempts

Called out once here as a cross-cutting rule referenced by §8.7 and §33.1: returning 403 ("forbidden") for a cross-tenant ID access confirms the ID exists somewhere, which is itself a (minor but real) information leak across tenant boundaries. Every cross-tenant lookup in this architecture — reads, updates, deletes, and foreign-key references, at both the application and database layers — is designed to be indistinguishable from "this ID does not exist."

### 33.4 The seven mandatory test cases named by the review (review concern 20) — consolidated index

Each of these is a specific, named test this revision requires, cross-referenced to where it is detailed and which phase's acceptance criteria it gates:

1. **Duplicate inbound webhook** — same provider `externalEventId` delivered twice → exactly one processing chain, one AI turn, one side-effect set, and the second delivery is acknowledged safely without reprocessing. Detailed in §17.4/§31.3; gates Phase 5 (§46.5).
2. **Concurrent conversation messages** — two or three messages arrive in quick succession for the same conversation, across simulated concurrent workers → processing remains strictly ordered for that conversation (verified via the `singletonKey` mechanism, §25.5) while a simultaneously-arriving message for a *different* conversation is confirmed to process without waiting. Gates Phase 6 (§46.6).
3. **Database relational tenant protection** — §33.1's new bypass test: skip `assertSameTenant()` intentionally, write directly against the scoped client, and confirm Postgres's own foreign-key constraint rejects a cross-tenant reference. Gates Phase 1 (schema, §46.1) and Phase 2 (the test itself, §46.2).
4. **Raw Prisma escape** — deliberately add an import of the raw client from an application module in a scratch file → confirm the ESLint rule fails CI, then remove it. Detailed in §8.3; gates Phase 2 (§46.2).
5. **API-key database compromise** — seed an `ApiKey`, inspect the persisted row directly, and confirm the original reusable secret cannot be reconstructed from `keyHash` alone (i.e., only a hash is stored, and the test does not merely check "the field is named `keyHash`" but that authenticating with a *value derived from the stored hash* rather than the original secret fails). Detailed in §9.4; gates Phase 1 (§46.1).
6. **Worker retry executes exactly once** — a job handler that fails transiently and is retried by pg-boss produces the side effect (a sent message, a created ticket) exactly once, verified by asserting a count, not merely that the job eventually reaches `succeeded`. Detailed in §24.4/§31.2; gates Phase 6 (§46.6).
7. **SSRF redirect/private-resolution** — a webhook URL that resolves via DNS to a private/link-local/metadata address, and separately a URL that redirects to one, are both blocked before any connection is opened. Detailed in §32.1; gates Phase 6 (§46.6).

---

## 34. Overall Testing Strategy

### 34.1 The pyramid, mapped onto this codebase's actual modules

| Layer | What it covers | Example (existing or planned) | Mocking policy |
|---|---|---|---|
| Pure unit | Zod schemas, `rbac.ts` permission logic, guardrail keyword matching, pagination math, event-envelope construction, idempotency-key derivation (§24.4) | `tests/unit/rbac.test.ts`, `tests/unit/pagination.test.ts` (existing, retained) | No I/O of any kind |
| Domain tests | `customer-resolver.ts`'s matching algorithm, `automation.ts`'s condition evaluation, `ActionExecution` status transitions (including `pending_approval`, §24.3), `ToolPolicy` evaluation for both human and AI actors | `tests/unit/customer-resolver.test.ts` (existing, extended for tenant-scoping) | Mocked/test-double Prisma acceptable here specifically because the logic under test is pure decision-making, not the query layer itself |
| Provider contract tests | `AIProvider`, `EmbeddingProvider`, `ChannelAdapter`, `ObjectStorage`, `JobQueue` implementations each satisfy their interface's documented behavior | New: one shared contract-test suite per interface, run against every implementation (`OpenAIProvider`, `AnthropicProvider`, `FakeAIProvider` all pass the same `AIProvider` contract suite) | Real credentials only for an explicitly separate, optionally-skipped integration run (§34.2); the fake must also pass the same contract suite to prove it's a faithful double |
| Repository/data-access tests | The tenant-scoping Prisma extension **and the composite foreign keys** (§8) — this is the single most safety-critical piece of code in the whole plan | New: a dedicated suite that seeds two businesses' worth of every tenant-owned model and exhaustively asserts the extension's `findMany`/`findUnique`/`create`/`update`/`delete` behavior, **plus §33.4 item 3's direct database-bypass test for every composite-FK relation in §8.4's table** | **Real Postgres required, never mocked** — mocking Prisma here would test the mock's behavior, not the extension's or the database's actual behavior, which is exactly the class of bug (a subtly-wrong `where` merge, or a missing composite constraint) unit-testing-against-a-mock would miss |
| Integration tests | `processInboundMessage` end-to-end through a fake channel event, fake AI provider, and real (test) database — including duplicate-delivery and concurrent-message scenarios (§33.4 items 1-2) | New, replaces today's disconnected unit tests of individual pieces (`ai-engine.test.ts`, `conversation-engine.test.ts`) with at least one true end-to-end path per major flow | Real Postgres, `FakeAIProvider`, `FakeJobQueue`, `InMemoryRealtimeBus` |
| API tests | Route handler behavior including auth/permission/validation | `tests/api/*.test.ts` (existing, extended to the ~55 currently-untested routes, §2.10) | Real Postgres via `tests/helpers/request.ts`-style harness (existing pattern, extended) |
| Tenant isolation tests | §33's full matrix, including the database-bypass tests | New, largest net-new test investment in this plan | Real Postgres, two seeded businesses minimum |
| Security regression tests | The specific bypass routes from §2.2, closed and then permanently regression-tested; the SSRF dispatcher's redirect/DNS-resolution behavior (§32.1, §33.4 item 7); webhook signature verification per channel; API-key hash irreversibility (§33.4 item 5) | `tests/security/*.test.ts` (existing, extended) | Real HTTP-level request construction against the actual middleware/route stack; the SSRF tests use a local test HTTP server with controllable DNS/redirect behavior, not real external hosts |
| End-to-end business workflows | The workflows named in §34.3 below | New | Real Postgres, `FakeAIProvider`/`FakeJobQueue` unless explicitly run as a separate, credential-gated "real provider" smoke suite |

### 34.2 What is mocked vs. what uses real infrastructure — the rule, stated once

**Real Postgres, always**, for anything touching the tenant-scoping extension, composite foreign keys, repository-level behavior, or migrations — mocking the database is explicitly rejected here as a matter of policy (per the product brief's explicit instruction), because Prisma-mock-based tests have already been shown, in this exact class of bug, to pass while the real interaction is broken, and a mock cannot exercise a real database constraint at all. **Provider/channel SDKs are test-doubled by default** (`FakeAIProvider`, a fake `ChannelAdapter` that records sent messages instead of calling Twilio/Meta) so the default `npm run test` suite (and CI) never requires real OpenAI/Anthropic/Twilio/Meta credentials and never makes billed external calls. A **separate, optional integration suite** (not run on every CI push — run on a schedule or manually, gated behind env vars for real credentials) exercises each real provider/channel adapter against its actual external API, catching drift in third-party API contracts that fakes cannot catch by construction.

### 34.3 Named end-to-end workflows, mapped to concrete test scaffolding

1. **Invalid JWT → protected API → rejected.** `tests/security/auth-security.test.ts`, extended to specifically cover the Phase-0-fixed routes (§46.0).
2. **Tenant A → Tenant B resource → rejected, at both the application and database layers.** §33's matrix, including §33.4 item 3.
3. **Inbound WhatsApp event → normalized event → deduplication → customer resolution → conversation → AI → outbound action.** A new integration test using a fake `ChannelAdapter.validateInbound()` producing a synthetic `ZiyrakEvent`, run through the real `processInboundMessage()`, real tenant-scoped Prisma, `FakeAIProvider` configured to return a canned tool call (e.g. `create_ticket`), asserting the full chain: `InboundEventReceipt` created, customer created, conversation created, `ActionExecution` recorded, ticket created, reply "sent" (recorded by the fake adapter) — plus a second delivery of the identical `externalEventId` asserting no duplicate side effects (§33.4 item 1).
4. **Automation configured → relevant event occurs → actual runtime action executes.** This test **cannot be written honestly today** because the runtime wiring does not exist (§2.4) — it is the literal acceptance criterion for automation's reconnection, decided in §46.6.
5. **Schedule follow-up → durable job created → worker processes it → result recorded, exactly once even under retry.** New integration test using `FakeJobQueue` (or a real pg-boss instance against the test database for Phase 6's acceptance suite specifically) asserting an `ActionExecution` reaches `scheduled` synchronously and `succeeded` after the fake queue's handler runs, with the outbound message actually recorded as sent by the fake channel adapter, and — per §33.4 item 6 — a forced transient failure followed by a retry still produces exactly one sent message.
6. **AI requests a `requiresHumanApproval` tool → execution pauses → human approves → it executes.** New, specific to §9.5/§23.4's `ToolPolicy` model; asserts the tool's side effect does **not** happen until the approval step, closing the loop on the review's `refund_payment` example concretely, even though no real refund tool ships in this plan's scope.
7. **A widget-token request from an unconfigured origin is rejected; one from an allowed origin succeeds and cannot read another business's or another connection's conversation.** New, specific to §20.4's Web Chat design.

### 34.4 Coverage philosophy

No blanket percentage target. Coverage follows risk, per the product brief: 100% of the tenant-isolation matrix (§33, including the database-bypass tests) is non-negotiable; the tenant-scoping extension and composite foreign keys (§8), the `ToolRegistry`/`ActionExecution`/`ToolPolicy` status machine (§23-24), and the SSRF dispatcher (§32.1) warrant the same rigor, since a bug in any of these directly reproduces this plan's named worst-case failure modes (cross-tenant leak, fabricated action success, AI-privilege escalation, internal-network access via a tenant-supplied URL). Dashboard-only UI logic and read-only reporting endpoints warrant lighter coverage — a smoke test confirming the route returns 200 with the right shape is proportionate; exhaustive edge-case testing of, say, the analytics aggregation queries is not a priority commensurate with its risk.

---

## 35. Test Infrastructure

- **Database:** CI already runs a real Postgres service container (`.github/workflows/ci.yml`, verified — `postgres:16-alpine`, health-checked, migrations applied via `prisma migrate deploy` before tests run). This pattern is preserved and extended: the tenant-isolation suite and repository-level tests (§34.1) run against this same real database (serving as both control plane and data plane pre-Phase-9, §7.4), with each test file responsible for seeding its own two-(or-more)-business fixture data and cleaning up (transaction-wrapped-per-test or truncate-between-tests — decided at Phase 0 implementation time based on suite runtime; transaction-wrapping is preferred if pg-boss's `SKIP LOCKED` polling doesn't conflict with long-held test transactions, otherwise truncate-between-tests).
- **Redis:** not required until Phase 8's implementation lands; at that point, CI gains a `redis:alpine` service container analogous to the existing Postgres one, used only by the Redis-backed adapter's own contract tests (§34.1) — the default test suite continues using in-memory adapters and does not require Redis to run.
- **Job queue:** `FakeJobQueue` for the default suite; a real pg-boss instance against the CI Postgres container for Phase 6's specific acceptance tests (pg-boss needs no separate service — it uses the same Postgres connection).
- **Object storage:** `LocalFilesystemStorage` (writing to a temp directory) for the default suite; an optional MinIO CI service container (§27.3) for the S3-compatible adapter's contract test.
- **AI/embedding providers:** `FakeAIProvider`/a fake `EmbeddingProvider` (deterministic vectors) for the default suite (§34.2); a separate, manually-triggered or nightly-scheduled workflow for real-provider contract tests, credentials supplied via repository secrets, never required for a normal PR to pass.
- **SSRF test target:** a local, in-process test HTTP server whose DNS resolution and redirect behavior the test controls directly (§32.1, §33.4 item 7) — never a real external host, so the SSRF suite is deterministic and network-independent.
- **Fixtures:** `tests/helpers/fixtures.ts` (existing) is extended with `seedBusiness()`/`seedBusinessWithResource(type)` helpers that create a fully-formed `Business` + `TenantPlacement` (pointed at the shared-default profile) + `Membership` + owner `User` in one call, becoming the standard setup call for every new test written from Phase 1 onward.

---

## 36. CI / Quality Gates

Extending the existing, already-correct pipeline (`.github/workflows/ci.yml`: install → `prisma generate` → `prisma migrate deploy` → `tsc --noEmit` → lint → test → build) with the new checks this plan introduces:

```
1. npm ci
2. npx prisma generate
3. npx prisma migrate deploy         (against a real, ephemeral Postgres — unchanged)
4. npx prisma migrate diff --exit-code   (NEW: fails if schema.prisma and the last migration have drifted)
5. npx tsc --noEmit
6. npm run lint --max-warnings 0     (NEW: today's CI has `|| true`, silently ignoring lint failures —
                                       verified in ci.yml:58 — this must be removed; lint failures should
                                       block merges, not be decorative)
7. ESLint custom rules (NEW):
      - no raw `prisma` import outside the tenancy/platform allowlist (§8.3)
      - every src/app/api/**/route.ts is either allowlisted-public or auth-checked (§14.2)
8. npm run test                       (unit + domain + repository + integration + API + tenant-isolation +
                                        security — all in the default, no-real-credentials suite, including
                                        the composite-FK bypass tests, which require the real CI Postgres
                                        container but no external credentials)
9. npm run build
10. (NEW, separate scheduled workflow, not blocking PRs) real-provider/channel contract tests
```

Item 6 is flagged specifically because it is a **currently-existing, verified gap** (`ci.yml:58`'s `|| true` means lint has never actually gated anything) — closing it is included in Phase 0 as a cheap, high-value fix alongside the security items, since it is a one-line change that immediately raises the quality floor for everything that follows.

---

## 37. Observability

### 37.1 What must be traceable, end-to-end (product brief's own example, restated against this codebase's real shape)

```
customer WhatsApp message
  → ZiyrakEvent (id, correlationId)                            [events/]
  → InboundEventReceipt dedup check (hit/miss)                  [events/]
  → businessId resolved via ChannelConnection                    [channels/ + platform/]
  → TenantPlacement resolved (dataConnection)                     [platform/]
  → Conversation resolved/created                                  [conversations/]
  → KnowledgeRetriever.retrieve() — count + latency, embedding provider used  [knowledge/ + ai/]
  → AIProvider.complete() — provider, model, usage                             [ai/]
  → ToolRegistry.execute() — tool name, ToolPolicy decision, ActionExecution id, status  [tools/]
  → outbound ChannelAdapter.sendMessage() — success/failure                      [channels/]
```

Every log line emitted along this path carries the same `correlationId` (from the originating `ZiyrakEvent`, §17.1) plus `businessId`, `conversationId`, and `requestId` (the latter already generated today in `middleware.ts:17-19` — extended to also flow into job-processing logs via the job payload, not just HTTP requests). This is a **structured-logging discipline change**, not a new logging library: `logger.ts` (§2.6, retained as-is structurally — its `{level, message, timestamp, context}` shape is sound) simply gets called consistently with these fields present in `context` at every stage above, enforced by code review rather than new infrastructure, since introducing a full distributed-tracing stack (OpenTelemetry collector, Jaeger/Tempo) is not justified at this stage per Principle 2 (§4) — the correlation-ID-in-structured-logs approach gives 90% of the debugging value at near-zero operational cost, and is exactly what "practical observability architecture" calls for rather than a maximal one.

### 37.2 Metrics worth capturing from day one (cheap now, expensive to retrofit)

- AI usage: `provider`, `model`, `promptTokens`, `completionTokens`, `businessId`, `latencyMs` per `AIProvider.complete()` call, **and separately per `EmbeddingProvider.embed()` call** (§21.5) — this is the direct foundation for §39's cost attribution, and the `CompletionResult.usage`/`EmbeddingResult.usage` fields exist specifically so this is available from the very first provider implementation, not bolted on later.
- Job queue: enqueue-to-start latency, execution duration, failure rate per `jobType` — pg-boss exposes most of this natively; surfaced via structured logs initially, a dashboard is a later product concern, not an architecture requirement. Singleton-key contention (§25.5) is worth its own counter, since a consistently-backed-up conversation queue is a real operational signal.
- Channel send success/failure rate per channel type, per `ChannelConnection`, per business.
- Deduplication rate: how often `InboundEventReceipt` catches a genuine duplicate, per channel — a sudden spike indicates a provider redelivery storm worth investigating, not just noise to discard.
- Error monitoring: `errors.ts`'s existing `AppError`/`Errors` factory pattern (§2.6, retained) is the natural place to hook an error-tracking service (e.g., Sentry) later — not required for the MVP, but the centralized error-construction point means adding it later touches one file, not every route.

### 37.3 What must never appear in logs

Raw `ChannelConnection`/infrastructure-profile secret values (in any form — ciphertext is fine, plaintext or the `SecretResolver`-decrypted value is not), raw AI provider API keys, raw JWTs, raw API-key secrets (only `keyPrefix` is ever logged, never anything that could be compared against `keyHash`), and raw customer message content beyond what's needed for the specific log line's purpose (a "message received" log should carry length/channel/conversationId, not necessarily the full text, to limit PII surface in log aggregation systems that may have broader access than the application database itself) — extending `maskSettingsSecrets`'s existing masking discipline (§2.6) into the logging layer explicitly, since today nothing prevents an errant `logger.info("config", settings)` call from leaking a raw secret (verified: no log-scrubbing exists today beyond the API-response-specific `maskSettingsSecrets`).

---

## 38. Auditability

### 38.1 Durable audit records vs. ordinary logs — the line

`ActivityLog` (existing model, tenant-scoped in Phase 1 per §12) is the durable, queryable audit trail; application logs (§37) are for operational debugging and are not guaranteed to be retained or structured for compliance review. The dividing line: **anything a business owner might reasonably ask "who did this and when" about, months later**, is an `ActivityLog` row, not just a log line. This includes every item the product brief lists:

| Question | Answered by |
|---|---|
| What happened, when, for which tenant | `ActivityLog.action/entity/entityId/createdAt/businessId` |
| Which customer/context | `ActivityLog.entityId` (when entity is customer/conversation) or `ActionExecution.conversationId` |
| Which model/provider was used | `ActionExecution` doesn't carry this directly for AI *responses* (only for tool calls) — extend `Message` or a new lightweight `AIInteractionLog` to carry `{provider, model, embeddingProvider, usage}` per AI turn, tenant-scoped; decided at Phase 4 implementation time whether this is a new table or fields added to `Message.metadata`-equivalent, since `Message` does not currently have a `metadata` column (only `Conversation` and `KnowledgeEntry` do, per §2.8) |
| Which tool, what input, what result, **was it AI-initiated and did it require approval** | `ActionExecution` (§24.2) — this is its primary purpose beyond correctness; `requestedBy` + `status` history (including any `pending_approval` step) together answer this fully |
| Was a human involved | `ActionExecution.requestedBy` (`"ai"` vs. a `userId`), and for approval-gated tools, the approving `userId` recorded on the transition out of `pending_approval` |
| Was it retried | `ActionExecution` + the underlying job's attempt count (pg-boss tracks this natively; surfaced via a join or a denormalized `attempts` field updated by the worker) |
| Who initiated it | `ActivityLog.userId`/`userName` (existing fields, retained) or `ActionExecution.requestedBy` |
| Was an inbound event a duplicate delivery | `InboundEventReceipt.processingStatus` (§17.4) — durable evidence a redelivery was correctly recognized and not reprocessed |

### 38.2 What is explicitly not logged in `ActivityLog`

Raw secrets (per §37.3, same rule applied to durable storage, not just transient logs) and full AI prompt/response text by default (available via `Message` rows already, which is the correct place for conversation content — duplicating it into `ActivityLog` would be redundant storage with its own leak surface). `ActivityLog.metadata` (existing `Json` field) should carry structured, minimal context, not a full request/response dump.

---

## 39. Usage / Cost Attribution

### 39.1 What's captured now, without building billing

Every unit of work this plan already tags with `businessId` (Principle: tag from day one, bill later) becomes a queryable cost signal with zero additional schema beyond what §12/§21/§24/§25 already introduce:

| Cost driver | Captured via | Query shape (illustrative, not built now) |
|---|---|---|
| AI generation tokens | `CompletionResult.usage` logged per call (§37.2), or persisted to the `AIInteractionLog`/`Message.metadata` extension (§38.1) | `SUM(promptTokens+completionTokens) WHERE businessId = ? AND createdAt BETWEEN ...` |
| AI embedding tokens | `EmbeddingResult.usage` (§21.5), logged separately from generation | `SUM(totalTokens) WHERE businessId = ? AND provider = 'embedding' ...` |
| Job/worker execution | pg-boss job records, tagged `businessId` (§25.4) | `COUNT(*) GROUP BY jobType, businessId` |
| Channel sends | `ChannelAdapter.sendMessage()` call count per business per `ChannelConnection` (log-derived initially) | per-connection send volume per business per period |
| Storage | `ObjectStorage` adapter can expose per-tenant-prefix byte totals (S3 adapters support prefix-scoped `ListObjects`+size sum natively) | storage bytes per business |
| Voice minutes (phone channel) | `CallLog.duration` (existing field, already present in the schema) tenant-scoped | `SUM(duration) WHERE businessId = ?` |

### 39.2 What this plan deliberately does not build

No `Plan`/quota-enforcement engine, no invoice generation, no usage-based rate limiting tied to a subscription tier. Per the product brief's explicit instruction, this is architectural readiness only — the reason every phase insists on `businessId` being present on every cost-relevant record from the moment that record type is introduced (rather than added later) is that **retrofitting attribution onto historical data that was never tagged is often impossible** (you cannot attribute an AI call's cost to a business after the fact if the log line never recorded which business made it) — this is the one piece of "build for the future" this plan treats as mandatory now rather than deferred, specifically because deferring it is irreversible in a way deferring billing itself is not.

---

## 40. Local Development Architecture

| Concern | Production | Local |
|---|---|---|
| Database (control + data plane) | Managed/shared Postgres, pooled, control-plane and data-plane tables together until Phase 9 | `docker-compose up db` (existing, unchanged) — the control/data-plane distinction is architectural, not a second database, so local dev needs nothing new for it (§7.4) |
| Object storage | S3-compatible (§27.3) | `LocalFilesystemStorage` by default; optional MinIO container for testing the S3 path specifically |
| Job queue | pg-boss against production Postgres (shared platform infrastructure, §25.6) | pg-boss against the same local `db` container — **no new local infrastructure required**, since pg-boss's only dependency is Postgres, which local dev already has |
| Cache / rate-limit / `RealtimeBus` | Redis (Phase 8+) | In-memory adapters (default today, unchanged) remain the default for local dev even after Phase 8 ships Redis support in production — a developer should not need Redis running locally just to develop a feature unrelated to caching, unless they are specifically testing the Redis adapter itself (in which case `docker-compose`'s optional Redis service, added in Phase 8, covers it) |
| AI/embedding provider | Real OpenAI/Anthropic keys | `FakeAIProvider`/fake `EmbeddingProvider` are the default for `npm run dev` when no API key is configured (today's behavior is an error string, `engine.ts:110` — preserved as the "no key configured, not using the fake" path; the fake is specifically for automated tests and an explicit local "demo mode" toggle, not a silent dev-time substitution a developer might mistake for the real thing) |
| WhatsApp | Meta Cloud API | `WhatsAppWebAdapter` (§20.2) — this is precisely why that adapter is retained rather than deleted: it is the only channel that requires a genuinely interactive, human-in-the-loop local setup (QR scan), and remains the most convenient way to manually test the WhatsApp path end-to-end during development |
| Web Chat | Public widget on a business's real site | The same `WebChatAdapter` runs locally against a static test page shipped in the repo — no external dependency at all, making it, alongside the internal chat API, the easiest channel to develop and test locally (§20.4) |
| Worker | Separate container | Can run as a second `npm run worker` process alongside `npm run dev`, or be folded into a single local process for convenience — the interface (§25.3) doesn't care |
| Secrets (`SecretResolver`) | Versioned keys from a real secret store or env vars | `EnvKeySecretResolver` with a single dev key (§10.3) — the rotation machinery exists but is not exercised locally by default |

No phase in this plan introduces a production dependency without a same-phase local equivalent — this is checked explicitly as part of each phase's acceptance criteria (§46.x).

---

## 41. Deployment — Initial

For the first production customers (post-Phase-7), the topology in §5.8's "INITIAL" diagram applies: one app container, one worker container, one Postgres instance (serving as both control and data plane, §7.4), no Redis requirement yet (in-memory rate-limit/cache/`RealtimeBus` are correct at replica count 1 — not a compromise, a genuinely sufficient choice per Principle 2/§4), S3-compatible object storage (a managed one — R2/S3/B2 — rather than self-hosting MinIO in production, since object storage is the one piece where a managed service is strictly simpler than self-hosting from day one). `docker-compose.yml`/the Helm chart both gain a `worker` service definition alongside the existing `app`/`db` (Phase 6); the Helm chart's existing HPA (`autoscaling.enabled`, §2.1/§2.7) remains **disabled by explicit recommendation** until Phase 8 ships the shared-state adapters it depends on — this is called out as a concrete "do not turn this on yet" operational note, not just an architectural aside, since the chart currently makes it look available.

---

## 42. Deployment — Scaled

Post-Phase-8: N app replicas behind a load balancer, M worker replicas (scaled independently — worker load is driven by job volume, not HTTP request volume, so they should never be forced to share a replica count with the web tier), Redis (managed or self-hosted, sized for cache+rate-limit+pub/sub traffic), PgBouncer or a managed pooler in front of Postgres (§28.4), object storage unchanged (already horizontally-scale-agnostic since Phase 7). At this point the Helm chart's HPA can be safely enabled for the `app` deployment (CPU/memory-based, as already configured) and a separate HPA (job-queue-depth-based, ideally — pg-boss exposes queue-depth metrics; CPU-based as a simpler fallback) added for the `worker` deployment. This is purely a topology/config change on top of unchanged application code, per §30.2's central claim.

---

## 43. Compliance / Dedicated Infrastructure Readiness

Recapping §7.4-7.6/§10/§11/§28.2-28.3 as a single compliance-facing narrative: a business with a data-residency or dedicated-infrastructure requirement gets an `InfrastructurePolicy` row (§10.2) constraining `dataRegion` and `permittedAiProviders`/`permittedEmbeddingProviders`, plus a `TenantPlacement` row pointing at a dedicated `DatabaseProfile`/`StorageProfile` rather than the shared defaults (§7.5-7.6) — the actual dedicated connection secret lives only in those control-plane profile rows, resolved through `SecretResolver`, never in `InfrastructurePolicy` itself (§7.6, directly answering review concern 4). A business requiring "no third-party AI processing" can be constrained to a private-endpoint `AIProvider`/`EmbeddingProvider` implementation — the contracts in §21.1/§21.5 do not assume a public SaaS API, so a `PrivateEndpointProvider` implementing the same interfaces against a customer-hosted or VPC-internal model endpoint is a natural, contained addition. Postgres RLS (§8.8) is layered on for such tenants specifically because their dedicated-connection model removes the pooling concern that made RLS unattractive as a layer applied to every shared-schema tenant by default. None of this requires the shared-tenant majority's code path to change — every mechanism here is an override resolved by the same two-hop `TenantPlacement` → profile lookup every business already uses (§11.2), not a fork.

---

## 44. Ziyrak MVP

### 44.1 What "first real Ziyrak customer" requires, and nothing more

| Included in MVP | Excluded from MVP (exists in Owly today, retained but not required to be reconnected/hardened for v1) |
|---|---|
| `Business`/`Membership`/tenant isolation, all five layers (Phase 1-2) | Platform-admin support-impersonation tooling (§15.2, named but deferred) |
| Secure-by-default auth (Phase 0/2) | Plugin/hook system (§46.6 — deprecated, not shipped) |
| Customers, conversations, messages (tenant-scoped) | Flow builder (§46.6 — deprecated from the tenant UI, data model retained) |
| Knowledge base + real semantic retrieval, via `EmbeddingProvider` (Phase 4) | PDF/URL/structured-data knowledge ingestion (§22.4, boundary named only) |
| **Two production channels end-to-end: Web Chat and WhatsApp via Meta Cloud API** (Phase 5/7 — revised from WhatsApp-alone per review concern 21) | SMS/Telegram/Phone/Email as fully-hardened multi-tenant production channels — these are migrated behind the adapter contract (Phase 5, so they're *structurally* ready) but are not required to be feature-complete/marketed for v1; email in particular is a reasonable fast-follow given it needs no new external-provider integration work beyond tenant-scoping |
| One real AI provider (OpenAI) fully working; a second (Anthropic) proven to prove the abstraction (Phase 4); one embedding provider (OpenAI) | Ollama/local-LLM support (stubbed honestly, §21.2); private-endpoint providers (Phase 9) |
| Human handoff (existing escalation logic, tenant-scoped) | SLA rule dashboard *enforcement* automation — SLA rules can be viewed/configured, but auto-escalation-on-breach is a fast-follow, not a hard MVP blocker, since human agents can monitor manually at initial customer counts |
| A small, reliable built-in tool set with real `ToolPolicy` defaults: `create_ticket`, `assign_to_person`, `get_customer_history`, `schedule_followup` (now genuinely durable, §24), `trigger_webhook` (SSRF-hardened, §32.1) | Automation rules and campaign broadcast — see §44.2's decision |
| Activity/audit log (tenant-scoped) | Full usage-based billing (§39 — attribution only) |
| Inbound webhook deduplication for every production channel (§17.4) | `InfrastructurePolicy`/dedicated infra (Phase 9, post-MVP by definition) |
| Necessary configuration (`BusinessConfig`, `ChannelConnection`) | Third-party/tenant-defined custom tools |

### 44.2 The specific automation/flow/campaign decision, stated plainly here (detailed reasoning in §46.6)

Automation rules and the flow builder are **not** required for the MVP dashboard. Given they have zero runtime callers today (§2.4) and reconnecting either properly (tenant-scoped, tested, wired into `processInboundMessage`) is nontrivial net-new integration work rather than a bug fix, the recommendation is: **automation rules are reconnected** (their condition-matching logic is simple, already unit-tested, and genuinely useful even at MVP scale — "auto-tag messages containing 'urgent'"), while **the flow builder is deprecated** (removed from the tenant-facing dashboard, its data model kept in the schema unread rather than deleted, per the instruction not to discard functionality without a strong reason) because it substantially overlaps with what the AI-driven conversation flow already does better, and maintaining two parallel "decide what happens next" engines (the AI orchestrator and a separate node-graph interpreter) is exactly the kind of duplicated-concept complexity Principle 2 (§4) argues against. Campaigns are fixed to actually send, durably, via the job queue (§25.2) as part of Phase 6's combined tools-and-jobs work, since "broadcast a message to a customer segment" is a reasonable, commonly-requested feature and the gap (§2.4) is now cheap to close once the job queue exists.

### 44.3 MVP acceptance test (the concrete "are we done" check)

A new `Business` can sign up, its owner can log in, embed the Web Chat widget on a test page **and/or** connect a WhatsApp number via Meta Cloud API, configure a knowledge base, receive a real inbound message from either channel, get a real AI-generated reply grounded in that knowledge base, have the AI create a real ticket when asked (with the correct `ToolPolicy`-governed decision about whether that required human approval), have a human agent see and take over the conversation, and have every one of those actions show up correctly attributed to that business's `businessId` in the activity log — while a second `Business`, set up identically, cannot see any of the first business's data through any endpoint, subscription, guessed ID, or direct database write that skips application-level checks. This paragraph is the MVP.

---

## 45. Migration Roadmap

### 45.1 What changed in this revision, and why (review concern 11, primarily)

The roadmap is now **10 phases (0–9)**, down from the first pass's 11 (0–10). The substantive change is a **merge**, not a reordering: the first pass's Phase 6 (Tool/Action Registry) and Phase 7 (Job Queue/Workers) are combined into one phase — the new §46.6 — because sequencing them separately created exactly the failure mode Architectural Principle 4 (§4) forbids: an `ActionExecution.status = "scheduled"` that the first pass's Phase 6 could produce with no job queue yet existing to back it, live in the codebase until Phase 7 landed. Merging them removes that window entirely: within the single new Phase 6, the tool registry and `ActionExecution` model land first (as their own PR), synchronous tools work immediately, and `schedule_followup` (along with any other queue-dependent tool) is simply **not enabled** for the AI until the job-queue PRs within that same phase are also done — there is no externally-visible intermediate state where the claim exists without the infrastructure. Every phase after this merge point shifts down by one number relative to the first pass; the content of each is otherwise materially the same as its first-pass counterpart, with the specific revisions detailed in each phase's own section below.

Everything else about the phase *sequence* (tenant foundation → auth/isolation → modular boundaries → AI/knowledge → channels/events → actions+jobs → production MVP → scaling → enterprise infrastructure) is unchanged and re-confirmed after this review — none of the other 24 review concerns required reordering phases, only enriching what specific phases do.

### 45.2 One further, explicit sequencing rule new in this revision (review concern 18)

**Phase 1 alone is never exposed to real external multi-business use.** Phase 1 makes the schema multi-tenant-*shaped* (every table carries `businessId`, composite foreign keys exist) but Phase 2 is what makes the *query layer* actually enforce it (the Prisma extension, the lint rule closing the raw-client escape hatch, the isolation test matrix). Between the two, the application would still, in practice, run every query through the unscoped raw client — exposing it to a second real business during that window would be precisely the "isolation by convention" failure this entire plan exists to prevent, just relocated to a different layer. Concretely: **Phases 1 and 2 are always released to any externally-reachable environment together**, even though they remain two separate, separately-reviewable internal milestones/PRs with their own acceptance criteria (§46.1, §46.2). No business beyond the migrated Default Business may be onboarded — including in a staging environment used for anything beyond internal testing — until Phase 2's acceptance criteria are fully met.

```
Phase 0  ── Characterization & Critical Security Fixes                    (§46.0)
Phase 1  ── Business/Tenant Foundation                                     (§46.1)   ─┐ released together;
Phase 2  ── Authentication, Authorization, Tenant Isolation                 (§46.2)   ─┘ Phase 1 alone is unsafe externally (§45.2)
Phase 3  ── Modular Core Boundaries & Minimally-Specified Contracts          (§46.3)
Phase 4  ── AI/Embedding Provider Abstraction & Knowledge Retrieval          (§46.4)
Phase 5  ── Channel Adapters, Normalized Events & Inbound Deduplication      (§46.5)
Phase 6  ── Tools, Actions & Durable Execution (registry + queue, merged)    (§46.6)
Phase 7  ── Production Channels (WhatsApp + Web Chat) & MVP Hardening        (§46.7)
Phase 8  ── Scalability & Shared Infrastructure                             (§46.8)
Phase 9  ── Enterprise Infrastructure Overrides                             (§46.9)
```

Each phase below is independently mergeable and leaves the app running (Principle 10, §4), with Phase 1/Phase 2's paired-release exception stated explicitly above. Phases 4 and 5 could, in principle, be worked in parallel by two engineers/agents once Phase 3's module boundaries exist, since neither depends on the other's output — noted at the relevant phase's "Dependencies" field.

---

## 46.0 Phase 0 — Characterization, Safety, and Critical Security Fixes

*(Unchanged from the first pass — none of the 25 review concerns touched Phase 0's scope. Reproduced here in full so this document remains self-contained and each phase section is independently readable.)*

### Objective
Stop the live exploit, establish a real test-and-lint baseline, and characterize current behavior — without introducing the tenant model yet — so that every subsequent phase builds on a codebase that is both safe and well-understood.

### Why now
The auth bypass (§2.2) is exploitable today, independent of any architectural work; fixing it costs hours, not days, and must not wait behind the much larger Phase 1-2 effort. Establishing characterization tests before Phase 1 touches the schema is what makes Phase 1's "did the migration preserve behavior" verification (§13.4) possible at all — you cannot verify behavior is preserved if it was never pinned down first.

### Current code involved
- `src/app/api/chat/route.ts`, `src/app/api/realtime/route.ts`, `src/app/api/channels/whatsapp/route.ts`, `src/app/api/channels/email/route.ts`, `src/app/api/webhooks/test/route.ts` (§2.2 — missing `requireAuth`).
- `src/middleware.ts:164-166` (structural-only JWT check).
- `src/lib/ai/engine.ts:80-83` and `src/app/api/settings/route.ts:17-21` (Settings singleton race, §2.3).
- `src/app/api/admin/users/route.ts:75` (`validRoles` mismatch with `rbac.ts`, §2.4).
- `.github/workflows/ci.yml:58` (lint failures silently ignored via `|| true`).
- `package.json` (`npm ci` has never been run in this working tree — `node_modules` absent, §2.1).

### Target change
All five routes call `requireAuth()` with an appropriate permission (or, for `/api/chat`, are reconsidered as a route that may need a *different* public-facing shape entirely — see task detail below). `middleware.ts` performs real JWT verification. CI lint gate is real. A characterization test suite exists for the core conversation/AI/channel flows as they behave *today*, single-tenant, to be re-run after Phase 1's migration to prove behavior didn't silently change for the Default Business.

### Detailed tasks

1. **Fix `/api/realtime`:** add `requireAuth(request, "conversations:read")` (SSE streams conversation/message events — read-level access is the correct permission). Since this route is a `GET` returning a stream, confirm the auth check runs before the `ReadableStream` is constructed.
2. **Fix `/api/channels/whatsapp` and `/api/channels/email`:** add `requireAuth(request, "channels:update")` to both `POST` handlers (connect/disconnect are channel-config mutations) and `requireAuth(request, "channels:read")` to both `GET` handlers, matching the permission already used by `src/app/api/channels/route.ts` for consistency.
3. **Fix `/api/webhooks/test`:** add `requireAuth(request, "webhooks:update")` — matches the permission tier already required to create/edit webhooks in `rbac.ts`.
4. **Decide and fix `/api/chat`'s auth model deliberately, not just bolt on `requireAuth`:** this route is used both as an authenticated "test the AI from the dashboard" endpoint and is architecturally the ancestor of what §18/§20.4 formalize as `processInboundMessage`'s synchronous call path. For Phase 0, treat it as dashboard-internal: add `requireAuth(request, "conversations:create")`. Explicitly do **not** design the public Web Chat widget endpoint in Phase 0 — that is Phase 5/7 work (§20.4) with its own publishable-token/origin/rate-limit design, not a quick fix bolted onto today's route.
5. **Fix `middleware.ts`:** replace the `parts.length !== 3` structural check with a real `verifyToken(token)` call (import from `src/lib/auth.ts`, already exported); on failure, apply the same redirect/401 behavior the structural check uses today, so page vs. API behavior is unchanged.
6. **Fix the `Settings` singleton race:** change `engine.ts:80-83` and `src/app/api/settings/route.ts:17-21`'s `GET` handler to use `prisma.settings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } })`, matching the pattern the `PUT` handler already correctly uses.
7. **Fix `admin/users/route.ts`'s role list:** change `validRoles` to import `ROLES` from `rbac.ts` directly (`["viewer", "agent", "supervisor", "admin"]`) instead of the hardcoded, mismatched `["admin", "editor", "viewer"]`.
8. **Fix CI lint gate:** remove `|| true` from `ci.yml`'s lint step; run `npm run lint` locally first and fix (or explicitly, minimally suppress with inline comments) whatever it currently surfaces, so the gate doesn't immediately go red on unrelated pre-existing warnings.
9. **Install dependencies and establish a working baseline:** run `npm ci`, confirm `npx tsc --noEmit`, `npm run test`, and `npm run build` all pass on the current `main` before any further change, and consult `node_modules/next/dist/docs/` per `AGENTS.md` for any Next.js 16-specific API differences relevant to `middleware.ts`/route handlers before editing them (the instruction this document could not follow during planning, §2.1, must be followed before Phase 0's actual edits).

### Tests first
- A new `tests/security/auth-bypass-regression.test.ts`: for each of the five routes in §2.2, assert an unauthenticated request returns 401 (or an invalid-signature JWT returns 401 via the middleware fix), **written to fail against the current code first**, then made to pass by the fixes above — this is the literal "write a failing regression test first" instruction applied.
- A characterization suite (new `tests/characterization/` directory) exercising, against the current single-tenant schema: create a conversation via `/api/chat` → assert a `Message` row exists; send a WhatsApp-shaped inbound event through `whatsapp.ts`'s message handler (invoked directly, not through Puppeteer) → assert customer/conversation resolution and AI reply persistence; create a ticket via the `create_ticket` tool → assert the `Ticket` row. These are not new features — they pin down existing behavior so Phase 1's migration can be checked against them.
- A test asserting `admin/users` rejects role values outside `rbac.ts`'s `ROLES` and accepts all four real roles (regression test for finding §2.4).

### Migration/data considerations
None — no schema changes in this phase.

### Acceptance criteria
- All five previously-unauthenticated routes return 401/403 appropriately for unauthenticated/under-permissioned requests, verified by the new regression suite.
- `middleware.ts` rejects a JWT with a tampered signature (not just a malformed structure) — verified by a test that signs a token with the wrong secret and confirms rejection.
- `npm run lint` runs for real in CI with no `|| true` escape hatch, and passes.
- `npm ci && npx tsc --noEmit && npm run test && npm run build` all succeed.
- The characterization suite passes against current (pre-Phase-1) behavior and is retained (not deleted) to be re-run at the end of Phase 1.

### Risks
- Fixing `/api/chat`'s auth may break an existing manual/demo workflow that relied on it being open (e.g., a public demo page) — mitigated by checking `src/app/(dashboard)/**` and any public marketing pages for direct calls to `/api/chat` before deploying the fix, and communicating the change if such a workflow exists.
- Removing CI's `|| true` may surface a backlog of pre-existing lint warnings large enough to be a distraction — mitigated by fixing them as part of this phase (they are, by definition, small/mechanical if ESLint is already configured sanely) rather than deferring, since Phase 0 is exactly the phase meant to absorb this kind of cleanup cost before it compounds.

### Dependencies
None — this phase can start immediately.

### Explicitly deferred
Tenant model, membership, control-plane/data-plane split, composite foreign keys — Phase 1. The SSRF hardening (§32.1 — bundled into Phase 6 instead, since it shares infrastructure with the tool registry's webhook tool and the review's redirect/DNS-resolution requirements are substantial enough to deserve that phase's full attention). Telegram signature verification and Web Chat's widget-token design (§19.2/§20.4 — bundled into Phase 5). The `whatsappClient` assignment race and `getPhoneStatus()`'s hardcoded value (§2.5 — bundled into Phase 5's channel-adapter migration, since that code is being restructured there anyway).

---

## 46.1 Phase 1 — Business/Tenant Foundation

### Objective
Introduce `Business`, `Membership`, `User`, and — new in this revision — the **control-plane/data-plane split** (`TenantPlacement`, `DatabaseProfile`, `StorageProfile`, §7.4-7.6) as first-class models from the start, not retrofitted later; migrate every existing table to carry `businessId`; introduce **composite tenant-aware foreign keys** (§8.4) for every relation identified in that section; replace the one-row-per-type `Channel` model with `ChannelConnection` (§7.7); rewrite `ApiKey` for irrecoverable secret storage (§9.4); split `Settings`/`BusinessHours` singletons into tenant-owned configuration with rotation-ready encryption (§10.3). At the end of this phase, the schema is multi-tenant-shaped **and carries its own database-level isolation guarantee for every composite-FK relation**, even though the query-layer enforcement (the Prisma extension, the lint rule) is not yet built — that is Phase 2's explicit scope, and per §45.2, **this phase's output is never exposed to real external multi-business use until Phase 2 is also complete.**

### Why now
Nothing else in this plan can proceed without a tenant to scope to. This is the direct dependency root for Phases 2 through 9. Introducing the control-plane split, composite FKs, and the hardened `ApiKey`/`ChannelConnection` models now — rather than as later retrofits — is specifically what the review's concerns 1, 3, 4, 14, and 15 require: each of these is a schema-shape decision that becomes materially more expensive to change once real multi-tenant data exists, so this is the one, ideal, lowest-risk moment (§13.2 step 6's reasoning) to get them right.

### Current code involved
- `prisma/schema.prisma` (all 27 models, per §12's table).
- `src/lib/auth.ts` (`Admin`-based `getCurrentUser`, `isSetupComplete`).
- `src/lib/ai/engine.ts:79-101` (`getAIConfig()` reads `Settings` directly).
- `src/app/api/settings/route.ts`, `src/app/(auth)/setup/page.tsx`, `src/app/(auth)/login/page.tsx`.
- `src/app/api/admin/api-keys/route.ts` (plaintext key generation/storage, §2.9 — rewritten for hashed storage).
- `src/app/api/channels/route.ts` and every channel status route (migrated from `Channel` to `ChannelConnection`).
- Every route under `src/app/api/**` that does `prisma.<model>.findMany/findUnique/create/update/delete` without any tenant concept (i.e., all of them today) — not yet migrated to the scoped client in this phase (that's Phase 2), but every model they touch now has a `businessId` to eventually be scoped by.
- `prisma/seed.ts` (needs to seed a Default Business + owner + `TenantPlacement` + control-plane profile rows, not just an `Admin`).
- `scripts/backfill-customer-ids.ts` (existing precedent for a backfill script — the migration scripts in this phase follow the same style/conventions).

### Target change
`Business`, `Membership`, `User` (replacing `Admin`), `BusinessConfig`, `ChannelConnection` (replacing `Channel`), `TenantPlacement`, `DatabaseProfile`, `StorageProfile` exist. Every tenant-owned table in §12 carries `businessId` (`NOT NULL`, FK, indexed), and every relation in §8.4's table carries a **composite** `(businessId, id)`/`(businessId, fkId)` constraint pair, enforced by Postgres. `ApiKey` stores `keyPrefix`+`keyHash`, never a recoverable secret; existing keys are invalidated at migration time (§13.2 step 10) with the invalidation list surfaced to the operator. `Settings`/`BusinessHours` singletons are retired (kept, unused, for one release per §13.2.7). `ChannelConnection` secrets are encrypted via the rotation-ready `SecretResolver` (§10.3), not plaintext. No route yet enforces tenant isolation at the query layer (still using the raw `prisma` client) — that is Phase 2's explicit scope — but every row is correctly tagged and every composite-FK relation is already database-enforced, so Phase 2 can turn on query-layer enforcement without a second data migration, and the database-level protection (§8.4) is live from the moment this phase ships, independent of Phase 2's timeline.

### Detailed tasks

1. Write the new Prisma models: `Business`, `Membership`, `User`, `BusinessConfig`, `ChannelConnection`, `TenantPlacement`, `DatabaseProfile`, `StorageProfile` per §7's shapes.
2. Add `businessId` to every tenant-owned model in §12's table as **nullable** first (expand step, §13.2.1).
3. Write the seed/backfill script: create the Default Business, its `TenantPlacement`/control-plane profile rows (§13.2.2b), derive the owner `User`+`Membership` from the earliest `Admin` row (§13.2.2), backfill every table's `businessId` in dependency order (§13.2.3), including the denormalized `businessId` on child models reachable only via a parent (e.g., `Message.businessId` copied from its `Conversation`).
4. Write and run the verification script (§13.2.4) — refuse to proceed to the contract step if any row lacks a `businessId`.
5. Contract `businessId` to `NOT NULL` + simple FK + index for every table (§13.2.5); update `@@unique` constraints that were previously global to be tenant-scoped where semantically correct (`Tag.name` → `@@unique([businessId, name])`; the old `Channel.type` uniqueness is superseded entirely by `ChannelConnection`'s shape, which has no such constraint by design — §7.7).
6. **Add composite `@@unique([businessId, id])` to every parent named in §8.4's table, and replace the corresponding children's bare FKs with composite `(businessId, fkId)` FKs (§13.2.6)** — run immediately after step 5, while only the Default Business's data exists, so the new constraints are guaranteed satisfiable.
7. Implement `SecretResolver` (§10.3) with the `EnvKeySecretResolver` default implementation and `keyVersion`-tagged envelope encryption; implement the typed per-provider credential Zod schemas (§10.3(a)).
8. Split `Settings` → `BusinessConfig` + `ChannelConnection` (§13.2.7), encrypting secrets via `SecretResolver` at key version 1, with the two-step removal (old table kept unused for one release).
9. Split `Admin` → `User` + `Membership` (§13.2.8), preserving password hashes bit-for-bit.
10. Migrate `BusinessHours` singleton → per-business row (§13.2.9).
11. **Rewrite `ApiKey`** for `keyPrefix`+`keyHash` storage (§9.4); migrate existing keys per §13.2.10 (unavoidably invalidated — hashes cannot be derived from a plaintext value that itself needs to be discarded — with the invalidation list surfaced in migration output).
12. Bundle the schema-quality fixes noted in §2.8 while these specific tables are already being touched: `CallLog` gains a real composite FK to `Conversation`; `Schedule.teamMemberId` gains a real composite FK to `TeamMember` (both now naturally fall out of step 6's composite-FK work rather than being a separate task).
13. Update `auth.ts`'s `isSetupComplete()`/first-run bootstrap to mean "does the Default Business have an owner" conceptually (full multi-business signup flow is not required yet — Phase 1 only needs the *migrated* single business to keep working; a general "create a new Business" signup flow is Phase 2/7 scope, noted in "Explicitly deferred" below).
14. Update `prisma/seed.ts` to seed a `Business`+`TenantPlacement`+`Membership`+`User` for local dev, matching the migration's own approach so dev environments and migrated production environments end up structurally identical.

### Tests first
- The full verification suite from §13.4, written before running the migration against any environment with real data: row-count preservation, exhaustive `businessId` backfill correctness, password-hash round-trip, `Settings`→`BusinessConfig`/`ChannelConnection` field-by-field round-trip, and — new in this revision — `information_schema` introspection confirming every composite unique constraint and composite foreign key from step 6 exists on the resulting schema.
- Re-run Phase 0's characterization suite (§46.0) after migration and confirm identical results for the Default Business (proves the migration is behavior-preserving at the data level, even though no route yet uses `businessId` for filtering).
- A new unit test for the `Admin.role` → `Membership.role` mapping specifically covering the `"editor"`-role edge case (§2.4/§13.2.8) — asserts it downgrades to `viewer`, not an error, and logs a flagged-for-review entry.
- §33.4 item 5 (API-key database compromise): seed a new `ApiKey`, confirm `keyHash` is stored and the original secret is not recoverable from it.
- §33.4 item 3 (database relational tenant protection) — cannot be *meaningfully* exercised with only one business existing yet, but a version of it that seeds two businesses purely at the data layer (no query-layer enforcement required, since this test writes directly against a raw client scoped by hand to each business) and confirms a cross-business composite-FK write fails, proving the constraint itself works correctly before Phase 2's application-layer plumbing exists to exercise it end-to-end.

### Migration/data considerations
This is the highest-data-risk phase in the entire plan (§1's risk table). **A full, rehearsed backup/restore procedure — not `prisma migrate resolve` — is the rollback mechanism** (§13.3, review concern 17); this phase's runbook requires an executed restore rehearsal against staging before running the sequence against any environment with real data. The expand→backfill→verify→contract(simple)→contract(composite)→split sequence (§13.2) is followed exactly, with each step as its own migration file so a failure at any step is independently recoverable via restore.

### Acceptance criteria
- Every tenant-owned table in §12 has a `NOT NULL` `businessId` with a foreign-key constraint and an index; every relation in §8.4's table has both the composite `@@unique` and the composite FK; `prisma migrate diff` shows the schema matches the last migration exactly (no drift).
- The verification suite (§13.4) passes with zero row-count deltas and zero orphaned/null `businessId` values.
- Login with a pre-migration password succeeds post-migration (bit-for-bit hash preservation, verified by test).
- Phase 0's characterization suite passes unchanged post-migration.
- `Settings`/`BusinessHours` old tables still exist (not dropped) and are provably unread by any application code path.
- Existing `ApiKey` rows are invalidated with a clear, operator-visible list of what was invalidated; no `ApiKey.key` plaintext column remains anywhere in the schema after this phase.
- `SecretResolver` correctly encrypts/decrypts a round-tripped secret and reports the correct `keyVersion`.
- A second `Business` can be created (even via a direct script/seed call, not necessarily a polished signup UI yet), including its own `TenantPlacement` row resolving to the shared-default profile, and its data is visibly distinct from the Default Business's when queried directly (not yet isolated at the API layer — that's Phase 2 — but structurally separable at the data layer, and protected by the composite-FK layer already).
- **This phase's completion does NOT, by itself, authorize onboarding a second business anywhere externally reachable** — restated here per §45.2, since it is this phase's own acceptance criteria that could otherwise be mistaken for "safe to launch."

### Risks
- Denormalizing `businessId` onto child models (§12's "relation via parent" rows) is extra migration surface — mitigated by making the backfill script derive these values from the parent relation programmatically (never asking an operator to supply them), so there is no manual data-entry risk.
- The `Admin.role` mapping for non-standard role values (the `"editor"` bug, §2.4) is a judgment call (downgrade to `viewer`) that changes a real user's effective permissions — mitigated by logging every such downgrade explicitly so it can be manually reviewed and corrected post-migration if the business actually needs that person to have more access.
- `ApiKey` invalidation is a genuine breaking change for any existing integration — mitigated only by clear communication and an operator-visible list; there is no technical way to avoid it once a hashing scheme is adopted for previously-plaintext secrets, and this plan does not pretend otherwise.
- Composite-FK migration (step 6) failing partway through would leave some relations protected and others not — mitigated by running it as one transaction per relation (not one giant transaction for all relations at once), so a failure on relation N does not roll back relations 1..N-1 that already succeeded, and the verification test (`information_schema` introspection) catches any relation that didn't complete.
- Two-step `Settings` removal means two release cycles carry dead-but-present columns — acceptable, explicit tradeoff for safety, not an oversight.

### Dependencies
Phase 0 complete (clean security/lint/test baseline to migrate from).

### Explicitly deferred
Query-layer tenant enforcement (the Prisma extension, the raw-client lint rule) — Phase 2, and per §45.2 this phase's output must not be treated as externally safe until Phase 2 ships alongside it. A polished multi-business signup/onboarding flow — Phase 2/7 (this phase only needs the migration script's programmatic business creation to work, not a UI). `InfrastructurePolicy` and any non-default `DatabaseProfile`/`StorageProfile` — Phase 9 (this phase only introduces the control-plane *shape*, always resolving to the shared default).

### Implementation record (Phase 1 complete)

Phase 1 is implemented and complete. This is a record of concrete findings from that implementation, not a revision to the architecture above.

- Final schema carries mandatory tenant ownership (`businessId NOT NULL`, FK, index) on every table in §12, plus every composite `@@unique`/composite FK from §8.4's table.
- `src/lib/default-business.ts` is a **temporary compatibility layer**, introduced because the existing application still needs to operate against the Default Business until Phase 2 introduces real `TenantContext` resolution. It is transitional and **owned by Phase 2 for removal/replacement** — Phase 2 should delete it, not extend it, as each call site is converted to explicit `ctx`.
- API-key authentication (`route-auth.ts`'s `authenticateApiKey()`) currently fails closed, since the plaintext `key` column it used to query no longer exists. Phase 2 task 9 wires the real `keyPrefix`+`keyHash` authentication path.
- `Settings.aiApiKey` remains in the retained legacy `Settings` row — Phase 1 has no defined final destination for it. Phase 4 must migrate it once the AI provider configuration boundary (`AIProviderRegistry`) becomes real.
- Legacy `Channel` rows were migrated into `ChannelConnection` by combining each channel's existing status with its corresponding `Settings` credentials/configuration (not itself a named §13.2 step, but the only coherent reading of §7.7).
- `BusinessHours` was backfilled in place (same `"default"`-id row) rather than duplicated into a new row, since that is the implementation compatible with its final `NOT NULL` + `@@unique([businessId])` tenant ownership.
- `ToolPolicy`, `ActionExecution`, and `InboundEventReceipt` were intentionally not created in Phase 1 — despite appearing in §12's full target-model table, their implementation phases are Phase 6/5, not §46.1's own task list.
- Phase 1 remains explicitly **unsafe for real external multi-tenant onboarding** until Phase 2 completes authentication, tenant resolution, scoped Prisma access, and route-level enforcement.

---

## 46.2 Phase 2 — Authentication, Authorization, Tenant Isolation

### Objective
Build the enforcement mechanisms this plan has been building up to: real `TenantContext` resolution with **`ctx` explicit at service boundaries** (§8.2, review concern 2), the tenant-scoping Prisma Client Extension (§8.3), the lint rule closing the raw-client escape hatch, secure-by-default middleware (§14.2), and the full tenant-isolation test matrix (§33) — **including the new database-bypass tests that prove the composite foreign keys from Phase 1 work independently of the application-level checks built in this phase**. At the end of this phase, cross-tenant data access is structurally prevented at every one of §8's five layers, not just theoretically prevented by the schema change in Phase 1. **Per §45.2, this phase is released to any externally-reachable environment together with Phase 1 — the two are never shipped independently.**

### Why now
Phase 1 made the data multi-tenant-shaped and gave it a database-level composite-FK guarantee, but did not make the *query layer* multi-tenant-safe — every route still uses the raw, unscoped Prisma client, and no route resolves a real `TenantContext`. Shipping any tenant-facing feature (i.e., a second real business signing up, anywhere externally reachable) before this phase is complete would violate §45.2 directly. This phase must be the very next one after Phase 1, with no feature work in between.

### Current code involved
- `src/middleware.ts`, `src/lib/route-auth.ts`, `src/lib/auth.ts` (auth stack, rewritten per §14).
- `src/lib/prisma.ts` (split into raw client + scoped-client factory + `TenantPlacement`-aware resolver, §8.3, §28.2).
- `src/lib/rbac.ts` (add `owner` role, `platform_admin` pseudo-role, §9).
- Every one of the ~68 route files under `src/app/api/**` (mechanical swap to explicit-`ctx` service functions per §16.2, done module-by-module, not all at once — see task ordering below).
- `eslint.config.mjs` (new custom/`no-restricted-imports` rule, §8.3/§36).

### Target change
`requireAuth()` returns a `TenantContext` (with `dataConnection` already resolved via `TenantPlacement`), not just `{userId, role}`. A Prisma Client Extension enforces tenant filtering on every tenant-owned model, called with `ctx` explicit everywhere (§16.1). The raw client is unimportable from domain/route code except an explicit, narrow allowlist. The full isolation test matrix (§33) exists and passes for every resource migrated so far — **including the composite-FK bypass test for every relation from §8.4's table**, which this phase is what actually exercises end-to-end for the first time (Phase 1 could only verify the constraint existed; this phase verifies the whole stack, application layer included, behaves correctly around it).

### Detailed tasks

1. Implement `TenantContext` with explicit-`ctx`-at-boundaries as the primary pattern, `AsyncLocalStorage` as the narrowly-scoped backstop (§8.2).
2. Implement the Prisma Client Extension (`getScopedPrisma`) covering every model in §8.3's `TENANT_SCOPED_MODELS` list, resolving the data-plane connection via `resolveTenantPlacement()` (§28.2) — validate the exact Prisma 7 extension API against the now-installed `@prisma/client` types (Phase 0 installed `node_modules`; consult `node_modules/next/dist/docs/` and Prisma's own generated type definitions as needed, per `AGENTS.md`).
3. Rename the raw export (`src/lib/prisma.ts` → `src/lib/prisma/raw-client.ts` or equivalent), add the ESLint rule restricting its import, with the platform-module allowlist (§16.4).
4. Rewrite `route-auth.ts`'s `requireAuth()` to resolve full membership + placement (§15.1), including the `owner`/`platform_admin` role additions in `rbac.ts` and the `ExecutionPrincipal` type (§9.5) — noting that `ai_agent`/`system_job` actors never go through this HTTP-facing function at all (§15.4).
5. Rewrite `middleware.ts` for secure-by-default routing (§14.2) — explicit public-path allowlist (including a placeholder entry for the Web Chat widget endpoint, fully designed in Phase 5), real JWT verification performed here (building on Phase 0's fix), identity attached for route handlers to consume.
6. Convert application-service call sites to the explicit-`ctx` pattern (§16.2) as each module is migrated (task 7), rather than leaving them reaching for `AsyncLocalStorage`.
7. Add the `assertSameTenant` helper (§8.5) and apply it to every mutation identified as accepting a client-supplied foreign-key ID into a tenant-owned relation (ticket assignment, department assignment, conversation transfer, tag application, webhook trigger, campaign target — enumerate exhaustively by grepping for `Id: args.` / `Id: body.` patterns across route handlers as a starting checklist) — **and confirm, for each one, that the matching composite FK from Phase 1 exists**, closing the loop between the two layers.
8. Migrate every route handler's `prisma` import to a `ctx`-taking service function (§16.2) — mechanical, done in logical module batches (customers → conversations → tickets → knowledge → team → channels → webhooks → automation/campaigns/flows → admin/settings) so each batch can be reviewed and merged independently per Principle 10 (§4), rather than as one enormous PR.
9. `ApiKey` authentication rewritten to hash-compare (§9.4) — already stored correctly since Phase 1; this task wires `authenticateApiKey()` to use `keyPrefix` lookup + `keyHash` comparison, and to resolve the key's own `role`, not a hardcoded admin.
10. Fix realtime channel naming to be tenant-prefixed (§26.2) as part of this phase, since it is the other place bare, unscoped identifiers currently exist (`/api/realtime`'s `?channel=` param) — full `RealtimeBus` abstraction is Phase 3/8 scope, but the tenant-prefixing and the ownership check on subscribe must land now, alongside every other isolation fix, not wait for the later refactor.
11. Build the full isolation test matrix (§33.1/§33.2), **including the database-bypass test for every §8.4 relation** for every resource.

### Tests first
Per Principle 9 (§4) and the product brief's explicit non-negotiable instruction (§33): the isolation test matrix — application-layer *and* database-bypass tests together — is written **before** task 8's migration is considered complete for each module batch — i.e., for the "customers" batch, the isolation tests for customers (including any composite-FK relations customers participate in) are written and confirmed *failing* against the pre-migration (raw-client) code, then task 8's change for that batch is made, then the tests are confirmed passing. This is applied batch-by-batch, not as one final suite at the end, so isolation is verified incrementally alongside the incremental migration (Principle 10, §4) rather than in one large, hard-to-debug verification pass at the end.

### Migration/data considerations
No schema changes in this phase (Phase 1 already did the schema work, including the composite FKs this phase's tests exercise). This phase is pure application-code change over the Phase-1-migrated schema.

### Acceptance criteria
- Every item in §33.1's isolation matrix passes for every resource in §12's table, **including the database-bypass test (§33.4 item 3) for every relation in §8.4's table** — this is new, explicit, and non-negotiable acceptance criteria added by this revision.
- Grepping `src/app/api/**` and `src/lib/**` (excluding the explicit allowlist) for the raw client import returns zero results, and the ESLint rule fails the build if one is (re-)introduced — verified by §33.4 item 4's deliberate-violation test.
- The five routes fixed in Phase 0 (§46.0) are re-verified under the new middleware and continue to correctly reject unauthenticated requests.
- A new route added with no `requireAuth` call and not on the public allowlist fails CI (§14.2/§36) — verified by the same kind of deliberate-violation test as above.
- `ApiKey`s resolve to their own business and capped role via hash comparison, not global admin and not plaintext comparison — verified by §33.4 item 5's test, now exercised through the real authentication path (Phase 1 only tested storage; this phase tests authentication).
- Realtime subscriptions are rejected for conversations outside the caller's business (§33.2).
- **Only now, with this phase's acceptance criteria fully met, may a second business be onboarded anywhere externally reachable (§45.2).**

### Risks
- This phase touches nearly every route file — the largest single-phase code-change surface in the plan by file count (though each individual change is small and mechanical). Mitigated by the batch-by-batch task/test ordering above, each batch independently reviewable and revertable.
- A subtle bug in the Prisma extension itself (e.g., a merge-order issue where a caller-supplied `where.businessId` could override the injected one) would silently defeat isolation everywhere at once — mitigated by the extension's own dedicated, exhaustive repository-level test suite (§34.1) being the very first thing built and hardened in this phase, by the extension explicitly rejecting (not silently overriding) any caller-supplied `businessId` that conflicts with the context's own, **and, critically, by the composite foreign keys from Phase 1 providing a second, independent layer that a bug in this exact class would not defeat simultaneously** — this is the concrete payoff of review concern 1's adoption.
- Performance: every query now carries an extra `AND businessId = ?` predicate — mitigated by every tenant-owned table's `businessId` column being indexed (often as the leading column of a composite index, e.g. `(businessId, phone)`) as part of Phase 1's schema work, so this is not a new performance concern introduced late.

### Dependencies
Phase 1 complete (schema must already carry `businessId` and composite foreign keys everywhere).

### Explicitly deferred
Full `RealtimeBus`/`ObjectStorage`/`JobQueue`/`AIProvider`/`EmbeddingProvider` contracts (Phase 3-6) — this phase only does the minimum realtime-channel-naming fix (task 10) needed to close an isolation gap now; the full realtime abstraction is Phase 3/8. Postgres RLS (§8.8) — Phase 9, deliberately. A polished business-signup UI — still deferred to Phase 7 (this phase only needs programmatic multi-business creation to work for testing, per Phase 1's own deferral note). `ToolPolicy`/`ExecutionPrincipal`-based AI authorization (§9.5, §23.4) — Phase 6, since it depends on the tool registry existing; this phase's `requireAuth()` rewrite handles human/API-key actors only.

### Implementation record (Phase 2 complete)

Phase 2 is implemented and complete. This is a record of concrete findings from that implementation, not a revision to the architecture above.

- `TenantContext`/`ExecutionPrincipal` (§8.2/§9.5), the tenant-scoping Prisma Client Extension (§8.3), `assertSameTenant()` (§8.5), `resolveTenantPlacement()`/`getDataPlaneClient()` (§7.5/§28.2), and the raw-client ESLint restriction (§8.3/§16.4) are all implemented in `src/lib/tenancy/**`. The restriction covers both static and dynamic (`await import(...)`) raw-client imports — the latter was found, empirically, not to be caught by `no-restricted-imports` alone and needed a second `no-restricted-syntax` rule.
- `TENANT_SCOPED_MODELS` extends §8.3's own illustrative list with `membership`, `customerNote`, and `businessHours`, which §12's authoritative model table marks tenant-owned but that illustrative list omitted. `Membership` is deliberately tenant-scoped per §16.4's own wording ("`User` outside of `Membership`" is control-plane) — this is what let `/api/admin/users` be rebuilt on `Membership` instead of the legacy `Admin` table.
- `requireAuth()` now resolves a full `TenantContext` from either a JWT (→ `User` → earliest-created `Membership`, since this codebase has no business-switcher yet) or an `X-API-Key` header (→ `keyPrefix` lookup → `keyHash` compare → the key's own `businessId`/role). `/api/auth`'s setup/login actions were rewritten to create/authenticate against `Business`+`TenantPlacement`+`User`+`Membership` directly — Phase 1 had migrated the data but never cut the login path itself over from `Admin`, so this was a real gap Phase 2 had to close for login to work at all post-Phase-1. `generateToken()`/`verifyToken()` now carry only `{ userId }`, per §14.4.
- `src/middleware.ts` does not exist in this codebase — Phase 0 had already adopted this fork's `src/proxy.ts` convention (`node_modules/next/dist/docs/.../proxy.md` — Next 16 deprecated and renamed `middleware`). §46.2 task 5's rewrite target was `src/proxy.ts`; its secure-by-default allowlist logic now shares one list (`src/lib/public-api-paths.ts`) with the new route-auth-coverage static check so the two can't drift apart.
- All ~68 route files, plus their directly-called `src/lib/**` service modules, are migrated to the explicit-`ctx` service pattern (§16.2), organized as one `src/lib/<module>/service.ts` per resource. Batches followed the task list's order (customers → conversations → tickets → knowledge → team → channels → webhooks → automation/campaigns/flows → admin/settings), each with its own isolation test file written and run before moving to the next.
- **Scope boundary, not an oversight:** the AI chat/tool-execution pipeline (`src/lib/ai/engine.ts`, `ai/semantic-search.ts`, `ai/tools.ts`, `customer-resolver.ts`) and the channel-adapter integrations it's driven by (`channels/{email,phone,sms,telegram,whatsapp}.ts`, `twilio-verify.ts`) remain on the Phase 1 `getDefaultBusinessId()` shim. §46.2's own "Current code involved" list never named these files, and §46.2's "Explicitly deferred" section places `ToolPolicy`/`ExecutionPrincipal`-based AI authorization and full `ChannelAdapter` contracts at Phase 6/Phase 5 — constructing a real `ai_agent`/`channel_credential` `TenantContext` for inbound-channel-triggered code is that same not-yet-built seam. Each file is in the ESLint raw-client allowlist with this reasoning inline. **Consequence: `src/lib/default-business.ts` is not deleted** (PLAN.md's own "deleted, not extended" instruction for it is not yet fully satisfied) — it is still the only working tenant resolution for these deferred call sites. Whichever of Phase 5/Phase 6 lands first should delete it as part of converting its last remaining callers.
- `/api/settings` (the legacy `Settings` singleton) is also left unconverted, matching Phase 1's own implementation record ("`Settings.aiApiKey` remains in the retained legacy `Settings` row ... Phase 4 must migrate it"). Every *other* route that used to read/write `Settings` or the legacy `Channel` model (`/api/channels/**`, `/api/business-hours`) was cut over to its Phase-1-built replacement (`ChannelConnection`, per-business `BusinessHours`) in this phase — `/api/settings` itself is the one exception, deferred to Phase 4 by name.
- The dashboard homepage (`src/app/(dashboard)/page.tsx`, a React Server Component) queried conversation/ticket/message counts with no tenant filter at all — every business's stats and recent conversations were visible on every other business's dashboard. Not named in §46.2's task list (it predates the route-handler-focused "Current code involved" list), but treated as in-scope since it is exactly the class of leak this phase exists to close. Fixed via a new `getTenantContextFromCookies()` (`route-auth.ts`), the Server-Component equivalent of `requireAuth()`'s cookie branch.
- `ApiKey` role capping (§9.1/§9.4 — a key can never be `"owner"`) extends naturally to `Membership`-based team-member creation: `/api/admin/users` can grant any RBAC role except `"owner"` through its generic invite flow, matching the same "no privileged role through a generic/leakable path" reasoning.
- §33.4's seven named test cases: items 3 (database relational tenant protection) and 4 (raw Prisma escape) are this phase's own gates and are both covered (`tests/repository/composite-fk-bypass.test.ts`; `tests/security/raw-prisma-lint.test.ts`, extended to dynamic imports). Item 5 (API-key database compromise) was Phase 1's storage-only test; this phase adds `tests/security/api-key-authentication.test.ts`, exercising the real hash-compare authentication path end-to-end, including cross-business rejection. Items 1, 2, 6, 7 remain correctly gated to Phases 5/6 and are not claimed here.
- §14.2's CI-enforced "every route is public-allowlisted or calls `requireAuth`" check did not exist before this phase; added as `tests/security/route-auth-coverage.test.ts`, walking every `src/app/api/**/route.ts` file, with its own deliberate-violation pair.

---

## 46.3 Phase 3 — Modular Core Boundaries and Minimally-Specified Contracts

### Objective
Reorganize `src/lib/` into the target module layout (§6), introduce the `resolveTenantPlacement()`/`getPrismaForTenant()` connection-resolver seam (§28.2), and establish the module-dependency-direction lint rules (§5.7) — all *before* Phase 4-6 add significant new logic, so that new logic lands directly in its correct home rather than being written flat and reorganized later. **Revised per review concern 22: this phase establishes module ownership and dependency direction, and only a *minimal* contract shape for each interface — not a frozen, exact method signature — leaving each contract's fine detail to be finalized by its own implementation phase.**

### Why now
Phases 4-6 each introduce a real contract (`AIProvider`, `EmbeddingProvider`, `ChannelAdapter`, `ToolRegistry`, `JobQueue`). Doing the module reorganization first means each of those phases creates its new files in the right module directory from the start, rather than this plan needing a second reorganization pass after they exist. This phase is intentionally almost entirely mechanical (moving files, updating imports) — it is sequenced here specifically because it is *cheap now* and would be expensive to interleave later.

### Why this phase's interfaces are deliberately not fully frozen (review concern 22)

The first pass of this plan wrote out full method signatures for every contract in this phase, before any implementation existed to validate them against a real provider/channel/queue. On review, this risks exactly the failure Principle 2 (§4) warns against in the other direction: an interface designed in the abstract, then discovered to be subtly wrong once a real `AnthropicProvider` or `MetaCloudWhatsAppAdapter` is actually built against it, forcing an awkward retrofit or — worse — an implementation that silently works around a bad interface rather than fixing it. This revision's resolution: **Phase 3 fixes the module each contract lives in and which modules may depend on it (§5.7's dependency-direction diagram), and sketches a minimal, illustrative shape for each — enough to unblock Phase 4-6's implementation work — but each contract's *exact*, final method signatures are finalized during that contract's own implementation phase**, informed by the first real (non-fake) implementation, not fixed here in the abstract. Every contract shown elsewhere in this document (§19.1's `ChannelAdapter`, §21.1/§21.5's `AIProvider`/`EmbeddingProvider`, §25.1's `JobQueue`, §26.1's `RealtimeBus`, §22.1's `KnowledgeRetriever`, §27.1's `ObjectStorage`) is explicitly marked, where relevant, as illustrative rather than final for this reason.

### Current code involved
Every file under `src/lib/` (§6's mapping table is the exact source→target list).

### Target change
`src/lib/` is organized by domain per §6's table, including the new `platform/` module for control-plane concerns. `resolveTenantPlacement()`/`getPrismaForTenant()` exist (§28.2) even though `InfrastructurePolicy` doesn't yet (always resolves to the shared-default connection — zero behavior change, verified by the repository-level tests from Phase 2 continuing to pass unchanged). Module dependency direction (§5.7) is enforced by an ESLint import-boundary rule (e.g., `eslint-plugin-boundaries` or an equivalent custom rule): channel-adapter modules cannot import from `ai/`; `ai/` cannot import concrete channel SDKs; route handlers cannot import infrastructure adapters directly, only application-service functions.

### Detailed tasks
1. Move files per §6's table, updating all internal imports (mechanical, IDE-assisted rename/move).
2. Introduce `resolveTenantPlacement()`/`getPrismaForTenant()` (§28.2) and route `getScopedPrisma()` (§8.3, built in Phase 2) through it, so the two seams compose correctly from the start.
3. Configure the module-boundary ESLint rule with the dependency directions from §5.7's diagram encoded as explicit allow/deny pairs.
4. Introduce the `AIProvider`, `EmbeddingProvider`, `ChannelAdapter`, `ObjectStorage`, `JobQueue`, `RealtimeBus`, `KnowledgeRetriever` interfaces at a **minimal, sketch level** (no new implementations beyond wrapping existing code where a stage is trivial) in their target module locations, explicitly labeled as subject to refinement by their implementing phase, so Phases 4-6 have an agreed module boundary and dependency direction to build against from day one, without being locked into a signature nobody has validated yet.
5. Split `chat()` into the staged pipeline described in §18.1, preserving exact current behavior (still calling the unbounded `getKnowledgeBase()` and hardcoded OpenAI at this point — Phase 4 is what fixes those; this phase only separates *responsibility*, not *behavior*).

### Tests first
Every existing test file's imports are updated to the new module paths (mechanical); no new test *behavior* is required for the pure file-move tasks. For the `chat()`-splitting task (5), the Phase 0 characterization suite (§46.0) is the regression guard — it must pass unchanged before and after the split, since this task is refactor-only by design.

### Migration/data considerations
None.

### Acceptance criteria
- `npx tsc --noEmit`, full test suite, and `npm run build` pass after the reorganization.
- The module-boundary lint rule is active and a deliberately-introduced violating import (e.g., `channels/whatsapp-adapter.ts` importing directly from `ai/orchestrator.ts`) fails lint — verified by a scratch-violation test, same pattern as Phase 2's lint-enforcement verification.
- `resolveTenantPlacement()`/`getPrismaForTenant()` exist, are used by `getScopedPrisma()`, and the full Phase 2 isolation/repository test suite (including the composite-FK bypass tests) passes unchanged through it (proves zero behavior change from introducing the seam).
- The Phase 0 characterization suite passes unchanged after `chat()` is split into staged modules.
- Every contract sketched in this phase has, at minimum, its module location and allowed dependency direction fixed and lint-enforced — its exact method signature is explicitly out of scope for this phase's acceptance criteria (it belongs to the implementing phase's acceptance criteria instead).

### Risks
- Large mechanical diff (file moves) — mitigated by doing it as its own PR with no logic changes mixed in, so review is straightforward (a mechanical move diff is easy to verify even at large size, unlike a mixed move+behavior-change diff).
- Import-boundary rule false positives on legitimate shared-utility imports (`logger`, `errors`) — mitigated by explicitly allowlisting a small set of genuinely cross-cutting leaf modules that have no dependencies of their own.
- Leaving interfaces intentionally underspecified could, if not communicated clearly, be mistaken for "not designed yet" rather than "deliberately left open pending real implementation" — mitigated by this section's explicit rationale being referenced from each contract's own section elsewhere in this document, so an implementer knows the shape shown is a sketch, not a contract to build against verbatim without judgment.

### Dependencies
Phase 2 complete.

### Explicitly deferred
Actual new provider/adapter/queue implementations beyond the module boundaries and minimal contract sketches — that is Phases 4-6's content, by design, including finalizing each contract's exact signature.

---

## 46.4 Phase 4 — AI/Embedding Provider Abstraction and Knowledge Retrieval

### Objective
Make AI provider selection real (§21) — now explicitly split into **generation** (`AIProvider`) and **embedding** (`EmbeddingProvider`, §21.5, review concern 13) — and connect the already-working semantic search into the live chat path (§22), fixing the two most consequential AI-layer defects verified in §2.3, using the module boundaries Phase 3 just established.

### Why now
This is the single highest-leverage correctness fix in the plan relative to effort: `searchKnowledgeBase()` already exists and works (§2.3/§22.2); wiring it in is not new engineering, it's finishing already-done work. Both fixes are self-contained within the `ai/`+`knowledge/` modules Phase 3 just carved out, requiring no channel or tenant-membership changes, making this a good next phase to de-risk before touching channels (Phase 5).

### Current code involved
- `src/lib/ai/engine.ts` (`getKnowledgeBase()`, `callAI()`, `getAIConfig()`).
- `src/lib/ai/semantic-search.ts` (`searchKnowledgeBase`, `indexKnowledgeEntry` — the direct OpenAI embeddings call at lines 26-48 is what moves behind `EmbeddingProvider`).
- `src/lib/ai/guardrails.ts` (wiring in the previously-dead `checkBlockedTopics`/`enforceResponseLength`, and fixing the `hasToolCalls` hardcoded-`false` bug, §2.3).
- `src/app/(auth)/setup/page.tsx` (`PROVIDER_OPTIONS` — becomes honest instead of aspirational).
- `BusinessConfig.aiProvider/aiModel/embeddingProvider` (Phase 1 schema).

### Target change
`AIOrchestrator.respond()` calls `knowledgeRetriever.retrieve(ctx, query, {limit})` instead of loading every entry; calls `aiProviderRegistry.get(config.provider).complete(...)` instead of a hardcoded `new OpenAI(...)`; `KnowledgeRetriever`/`semantic-search.ts` calls `embeddingProviderRegistry.get(config.embeddingProvider).embed(...)` instead of `fetch`-ing OpenAI's embeddings endpoint directly. Two real generation providers work (OpenAI, Anthropic); one embedding provider works (OpenAI); Ollama generation is honestly stubbed. Guardrail pre/post checks (`checkBlockedTopics`, `enforceResponseLength`) are actually invoked. The confidence-scoring `hasToolCalls` bug is fixed.

### Detailed tasks
1. Finalize and implement the `AIProvider` interface (sketched in Phase 3) for OpenAI (thin wrapper around today's exact `engine.ts:219-229` call) and Anthropic (new, using Anthropic's Messages API with tool use) — this is the phase that settles the interface's exact shape, per §46.3's revised approach.
2. Finalize and implement the `EmbeddingProvider` interface (§21.5) for OpenAI, wrapping `semantic-search.ts:26-48`'s exact existing call.
3. Implement `AIProviderRegistry.get(name)`/`EmbeddingProviderRegistry.get(name)` and wire `AIOrchestrator`/`KnowledgeRetriever` to use them, keyed by `BusinessConfig.aiProvider`/`BusinessConfig.embeddingProvider` (tenant-scoped via Phase 1-2's config model, replacing the old global `Settings.aiProvider` read).
4. Fix `estimateConfidence`'s `hasToolCalls` threading bug (§2.3) — the recursive `callAI`/orchestrator loop must carry whether a tool was successfully used earlier in the same turn through to the final confidence calculation.
5. Wire `checkBlockedTopics` as a pre-check (blocks/redirects before calling the model) and `enforceResponseLength` as a post-check (truncates per `BusinessConfig`'s configured max, defaulting to today's `2000`) into the orchestration pipeline.
6. Implement `KnowledgeRetriever` wrapping `searchKnowledgeBase()` (tenant-scoped — add `businessId` filtering to its `prisma.knowledgeEntry.findMany` call, per Phase 2's scoped-client pattern, and route its embedding calls through `EmbeddingProvider` per task 2), replace `getKnowledgeBase()`'s call site in the orchestrator with `knowledgeRetriever.retrieve()`.
7. Update `setup/page.tsx`'s `PROVIDER_OPTIONS` to only list providers with a real, tested implementation as fully supported, with Ollama clearly marked "coming soon" rather than silently broken (§2.3).
8. Persist `CompletionResult.usage`/`EmbeddingResult.usage` (§21.1/§21.5/§39.1) — decide at implementation time whether this lands on a new lightweight table or `Message`-adjacent storage (§38.1's open question), since this phase is the first one that has real usage data to persist.

### Tests first
- `AIProvider` and `EmbeddingProvider` contract test suites (§34.1), written against each interface before its implementations, then run against `OpenAIProvider`/`AnthropicProvider`/`FakeAIProvider` and `OpenAIEmbeddingProvider`/a fake embedding provider alike.
- A regression test asserting `chat()`/`AIOrchestrator.respond()` never loads more than the configured retrieval `limit` worth of knowledge entries into the prompt, regardless of total KB size (directly tests the fix for §2.3's core finding) — seed 100 knowledge entries, assert the constructed prompt only contains the top-`limit` most relevant.
- A regression test for the confidence-scoring bug: simulate a turn with a successful tool call, assert the final confidence score reflects the `+0.1` bonus.
- A test confirming a message containing a blocked-topic keyword (e.g., "legal advice") is redirected/handled per the guardrail, where previously (Phase 0 characterization baseline) it was not.
- A test confirming knowledge retrieval never calls the OpenAI SDK/API directly — only through `EmbeddingProvider` — verified by asserting the fake embedding provider was invoked and no real network call was attempted in the default test run.

### Migration/data considerations
`BusinessConfig.aiProvider`/`aiModel`/`embeddingProvider` already exist from Phase 1's migration (carried over from `Settings`, with `embeddingProvider` a new, Phase-1-introduced nullable field). No new schema changes required unless task 8's usage-persistence decision requires a new table (`AIInteractionLog`) — if so, it is a purely additive migration.

### Acceptance criteria
- Selecting "Anthropic" in a business's configuration results in real Anthropic API calls, verified via the contract test suite and (manually, once) against a real Anthropic key in a non-CI environment.
- A knowledge base of 100+ entries results in a bounded, relevant subset (not all 100) being sent to the model on every turn — verified by the regression test above, and manually inspectable via logged prompt sizes.
- `checkBlockedTopics`/`enforceResponseLength` have real callers and real test coverage, closing two of the seven dead-code findings from §2.4.
- The `hasToolCalls` confidence bug is fixed and regression-tested.
- `semantic-search.ts` has zero direct calls to `fetch("https://api.openai.com/...")` — all embedding calls route through `EmbeddingProvider`, verified by code review and the contract test suite.

### Risks
- Anthropic's tool-calling request/response shape differs meaningfully from OpenAI's (different message role conventions, different tool-result formatting) — mitigated by the contract test suite exercising tool-calling specifically against both real providers (in the optional credentialed suite, §34.2) before considering the abstraction validated, not just trusting that "it compiles against the interface."
- Changing what's actually sent to the model (bounded knowledge instead of everything) could measurably change response quality/behavior for businesses with small, curated knowledge bases where "everything" was previously well within limits — mitigated by making the retrieval `limit` a `BusinessConfig`-tunable value (not a hardcoded constant) so it can be raised for a specific business if needed, and by defaulting it generously enough (e.g., top 8-10 entries) that small KBs are effectively unaffected.

### Dependencies
Phase 3 complete (module boundaries and minimal interface sketches must exist).

### Explicitly deferred
pgvector/external vector DB (§22.3 — deferred by design until a real scale trigger). Ollama's real implementation (§21.2 — honest stub only). A second `EmbeddingProvider` implementation (§21.5 — not needed until a concrete private-endpoint requirement exists, Phase 9). Knowledge ingestion beyond manual entry (§22.4 — boundary named, not built). Per-tenant AI cost quotas/limits (§39 — attribution only, no enforcement).

---

## 46.5 Phase 5 — Channel Adapters, Normalized Events, and Inbound Deduplication

### Objective
Introduce the `ChannelAdapter` contract (finalized per §46.3's approach) and `ZiyrakEvent` envelope; migrate all five existing channels behind it, each with **`InboundEventReceipt` deduplication** (§17.4) and the **fast-acknowledge, enqueue-for-processing** pattern (§17.6) as non-negotiable parts of the migration, not follow-ups; build the new **Web Chat adapter** (§20.4, review concern 21) as the first channel with no legacy code to wrap; introduce `processInboundMessage(ctx, event)` (§18.2) as the single inbound entry point, callable synchronously or from a job handler, replacing five near-duplicate implementations of "resolve customer → find/create conversation → chat()".

### Why now
This is the largest de-duplication opportunity in the codebase (§2.5) and the direct prerequisite for Phase 7's production WhatsApp/Web Chat work. It depends on Phase 4's `AIOrchestrator` existing as a stable call target for the new unified inbound pipeline, and — new in this revision — on nothing from Phase 6, since deduplication and fast-acknowledgment are pure webhook-handling concerns that do not require the job queue to be fully built yet (the webhook route can enqueue into a queue whose worker-side processing is completed by Phase 6, as long as the enqueue-and-ack half is correct now — see task 6's note).

### Current code involved
`src/lib/channels/whatsapp.ts`, `email.ts`, `sms.ts`, `telegram.ts`, `phone.ts` (all five, per §2.5's full review), plus their route handlers under `src/app/api/channels/**`, plus `src/lib/twilio-verify.ts` (reused, relocated behind the adapter contract). Web Chat (`src/lib/channels/webchat.ts`, a new file, plus a new embeddable widget script under `public/` or a dedicated static asset) has no existing code to migrate.

### Target change
Each channel is a `ChannelAdapter` implementation, mapped to one-or-more `ChannelConnection` rows per business (§7.7). `InboundEventReceipt` deduplication (§17.4) runs for every channel before any business logic executes. Every real provider channel's webhook route does verify → resolve → dedupe → persist → enqueue → ACK, never running the AI pipeline inline (§17.6). `processInboundMessage(ctx, event)` is the one function every adapter's inbound path funnels through, callable directly (internal chat API) or via a job handler (real channels).

### Detailed tasks
1. Finalize `ChannelAdapter`/`ChannelCapabilities` (§19.1) — including the three-way `validateInbound` return type folding in dedup — against real implementation needs, per §46.3's "interfaces finalized by their implementing phase" approach.
2. Implement `WhatsAppWebAdapter` wrapping `whatsapp.ts` verbatim, **including fixing the `whatsappClient`-assignment race** (§2.5/§20.2 — assign inside the `"ready"` handler, not after `initialize()` resolves) since the file is already being restructured here.
3. Implement `EmailAdapter`, `SmsAdapter`, `TelegramAdapter` (adding the missing Telegram secret-token verification, §19.2/§32), `PhoneAdapter` (fixing `getPhoneStatus()`'s hardcoded value, §2.5) wrapping their respective existing files — **each with its dedup key strategy from §19.2 implemented and tested** (email `Message-ID`, Twilio `MessageSid`/`CallSid`, Telegram `update_id`).
4. Implement `InboundEventReceipt` (§17.4) as a shared utility (`registerInboundEvent(ctx, source, externalEventId, eventType)` → `{ isDuplicate: boolean }`, using `INSERT ... ON CONFLICT DO NOTHING`), used identically by every adapter.
5. Implement the **new `WebChatAdapter`** (§20.4): publishable-token generation/validation, origin allowlist checking, the widget embed script, and its own dedup strategy (client-generated message ID). This is genuinely new code, not a migration.
6. Implement `processInboundMessage()` (§18.2) with its explicit-`ctx` signature, and wire every adapter's webhook route to: verify → resolve business via `ChannelConnection` → dedupe via task 4 → persist the normalized event → **enqueue a `process-inbound-message` job** (using `FakeJobQueue`/a minimal `JobQueue` stub if Phase 6's real `PgBossJobQueue` is not yet merged — the interface from Phase 3/§25.1 is sufficient to build against; the *real* queue backing it is Phase 6's concern, not blocking this phase's webhook-handling correctness) → ACK. The internal chat API continues calling `processInboundMessage()` directly and synchronously (§17.6).
7. Introduce `ChannelConnection`-based business resolution in each adapter's `validateInbound()` (mapping Meta phone-number-ID / Twilio account SID / Telegram bot token / IMAP account / widget token to a `businessId` and a specific `connectionId` — §7.7).
8. Tenant-prefix and fully migrate `RealtimeBus` (§26) onto the `ZiyrakEvent` envelope (Phase 2 did the minimal channel-naming fix; this phase completes the abstraction).
9. Update every channel-status dashboard route to work against `ChannelConnection` (supporting multiple connections per type in the UI, even if the initial UI only surfaces "add a connection" minimally).

### Tests first
- Contract test suite for `ChannelAdapter` (§34.1), run against each of the six adapters' (five migrated + Web Chat) `validateInbound`/`sendMessage`/`getStatus`.
- **§33.4 item 1 — duplicate inbound webhook:** for each channel, deliver the identical `externalEventId` twice and assert exactly one `Conversation`/`Message`/downstream job is created, with the second delivery acknowledged safely.
- The end-to-end WhatsApp/Web Chat integration test from §34.3 item 3, now implementable for real.
- A regression test for the `whatsappClient` race fix: simulate `"ready"` firing before `initialize()`'s promise resolves (achievable by controlling a test double's event emission order) and assert `sendWhatsAppMessage`-equivalent no longer no-ops.
- A test asserting an inbound webhook with credentials matching no `ChannelConnection` is rejected before any `Customer`/`Conversation`/`InboundEventReceipt` row is touched.
- Web Chat: a request from a disallowed origin is rejected; a request from an allowed origin succeeds; a widget token cannot access any admin-scoped endpoint (§34.3 item 7).

### Migration/data considerations
`Channel.config`'s existing JSON shape per channel type (already migrated to `ChannelConnection` in Phase 1, §13.2.7's scope extended to cover this) is preserved where it maps directly onto the new per-connection config shape.

### Acceptance criteria
- All six channels (five migrated + Web Chat) function end-to-end through `processInboundMessage()`, verified by the Phase 0 characterization suite's channel-specific tests continuing to pass through the new path for the five migrated channels, plus new coverage for Web Chat.
- **Every channel's webhook route acknowledges the provider without waiting for AI/knowledge/tool processing to complete** — verified by a test asserting the route returns before the (fake, artificially-delayed) AI call resolves.
- **Every channel correctly deduplicates a redelivered webhook** (§33.4 item 1) — this is now a hard acceptance gate, not a nice-to-have.
- Zero duplicated "resolve customer → conversation → chat" logic remains outside `processInboundMessage()` — verified by code review / grep for the pattern across the six adapter files.
- Telegram inbound webhooks are signature/secret-token verified (closing the previously-undocumented gap, §19.2).
- `getPhoneStatus()` reflects real configuration state.
- The `whatsappClient` race is fixed and regression-tested.
- Web Chat's widget token is confirmed structurally incapable of accessing any admin API (§20.4) — a deliberate penetration-style test, not just a documentation claim.

### Risks
- Behavioral drift during the resolve-customer/conversation consolidation (subtle per-channel differences in today's five implementations, e.g. slightly different "find existing conversation" `where` clauses across files) — mitigated by diffing each adapter's pre-migration logic against the unified `processInboundMessage()` path line-by-line during implementation, and by the characterization suite catching any behavior change.
- Meta/Telegram/Twilio webhook contract details are easy to get subtly wrong without live testing — mitigated by the optional credentialed integration suite (§34.2) and, for WhatsApp specifically, deferring full Meta Cloud API implementation to Phase 7 (this phase only needs the *contract* and the *existing* `WhatsAppWebAdapter` to be correctly wrapped).
- Building the enqueue side of the job pipeline (task 6) before Phase 6's real queue exists means this phase's webhook routes enqueue against a provisional/fake implementation of `JobQueue` — mitigated by the interface being stable from Phase 3 (§46.3), so swapping the fake for `PgBossJobQueue` in Phase 6 is a pure implementation swap behind an unchanged call site, not a redesign of this phase's work.

### Dependencies
Phase 4 complete (`AIOrchestrator` must exist as the call target for the unified pipeline).

### Explicitly deferred
`MetaCloudWhatsAppAdapter` implementation itself — Phase 7. The real `PgBossJobQueue` backing the jobs this phase's webhook routes enqueue into — Phase 6 (this phase only needs the enqueue *interface* to be correct). Production hardening of Web Chat's rate limiting beyond the in-memory limiter (Redis-backed, per-token limiting) — Phase 8.

---

## 46.6 Phase 6 — Tools, Actions, and Durable Execution

*(This phase merges the first pass's Phase 6 "Tool/Action Registry" and Phase 7 "Job Queue/Workers" into one phase, per review concern 11 — see §45.1 for why. It is internally sequenced as three ordered PRs, described in the task list below, specifically so no externally-visible state ever claims durability the codebase doesn't yet have.)*

### Objective
Replace `owlyTools`/`executeToolCall`'s switch statement with the `ToolRegistry` (§23); introduce `ActionExecution` (§24) with the attempt-scoped idempotency redesign (§24.4, review concern 10); introduce the `ToolPolicy`/`ExecutionPrincipal` split so AI authorization is independent of human RBAC (§9.5/§23.4, review concern 5); stand up pg-boss and the worker process (§25); implement per-conversation ordering via singleton keys (§25.5, review concern 9); build the shared, DNS-resolution-aware SSRF-hardened outbound HTTP dispatcher (§32.1, review concern 19); make the explicit, reasoned keep/deprecate call on automation rules vs. the flow builder (§44.2); and — because the queue now exists in the same phase — make `schedule_followup`, webhook retry, SLA breach checking, retention, and campaign sending durably real, closing every decorative-scheduling finding from §2.4 in one coherent phase rather than across two with a gap between them.

### Why now
Depends on Phase 4's `AIOrchestrator` (tools are invoked from within it) and Phase 5's channel adapters (the campaign-send fix needs `ChannelAdapter.sendMessage()`, and the `process-inbound-message` jobs Phase 5's webhook routes already enqueue need this phase's real queue to actually run). This is also the phase that closes the SSRF gap shared by `trigger_webhook` and `webhook-delivery.ts`, since both are being touched here.

### Current code involved
- `src/lib/ai/tools.ts` (all six tools + the switch statement).
- `src/lib/automation.ts`, `src/lib/flow-builder.ts`, `src/lib/plugins.ts` (the keep/deprecate decision, §44.2).
- `src/lib/webhook-delivery.ts` (`setTimeout`-based retry, §2.6, and the target of the new shared SSRF-hardened dispatcher).
- `src/lib/campaigns.ts` + `src/app/api/campaigns/[id]/execute/route.ts` (fixed to actually send, durably, §2.4).
- `src/lib/conversation-engine.ts`'s `checkSLABreaches()` (§2.4, dead).
- `src/lib/gdpr.ts`'s `applyRetentionPolicy()` (§2.4, dead).
- `src/instrumentation.ts`/`src/lib/shutdown.ts` (graceful shutdown must now also drain the worker).
- `package.json`, `docker-compose.yml`, `helm/owly/templates/` (new `worker` service).
- The `process-inbound-message` job handler stubbed in Phase 5 (§46.5 task 6) — this phase completes its backing queue.

### Target change
`ToolRegistry` with six built-in tools, each governed by a real `ToolPolicy` row per business, distinguishing AI authorization from human RBAC. `ActionExecution` records every tool invocation with an attempt-scoped idempotency key and, for AI calls to approval-gated tools, a `pending_approval` pause. `pg-boss`-backed `JobQueue` implementation and a standalone worker entrypoint exist. `schedule_followup` is fully durable end-to-end from the moment it is first exposed to the AI at all — never before. Webhook retries survive process restarts and route through the SSRF-hardened dispatcher. SLA breach checking and retention policy actually run on a schedule, for every business. Campaign execution durably sends to every matched customer with per-customer success/failure tracking. Automation rules are reconnected into `processInboundMessage()`; the flow builder is removed from the tenant-facing dashboard (data model retained, unread). Per-conversation message ordering is enforced under concurrent workers.

### Detailed tasks, sequenced as three ordered PRs (review concern 11's resolution)

**PR 1 — Tool registry and durable-action foundation (synchronous tools only):**
1. Implement `ToolRegistry` (§23.2), `ActionExecution` (§24.2, with `NOT NULL idempotencyKey` and the `pending_approval` status), and `ToolPolicy` (§23.4) as an additive migration.
2. Implement `ExecutionPrincipal` resolution for `ai_agent`/`system_job` actors (§9.5) and wire `ToolRegistry.getAvailableTools()`/`.execute()` to branch on `actor.kind` per §23.2/§9.5 — `ToolPolicy` for AI, RBAC for humans, never conflated.
3. Extract the five **synchronous** existing tools (`create_ticket`, `assign_to_person`, `send_internal_email`, `get_customer_history`, `trigger_webhook`) into `src/lib/tools/builtin/*.ts`, adding Zod schemas, `requiredPermission`, and seeded default `ToolPolicy` rows per §23.4's table.
4. Build the shared, DNS-resolution-aware SSRF-hardened HTTP dispatcher (§32.1) and route `trigger_webhook` through it immediately (`webhook-delivery.ts` is routed through it in PR 2, once its retry mechanism is being touched anyway).
5. Wire `AIOrchestrator` to call `toolRegistry.getAvailableTools(ctx)`/`toolRegistry.execute(...)` instead of the hardcoded `owlyTools` array and `executeToolCall` switch. **`schedule_followup` is defined but its `ToolPolicy.enabledForTenant` defaults to `false` and it is excluded from `getAvailableTools()` — it does not become available until PR 3.**
6. Reconnect `automation.ts`'s `evaluateRules()` into `processInboundMessage()` (§44.2's decision), tenant-scoped, with its matched actions actually executed via the `ToolRegistry`/direct conversation-mutation calls rather than just returned and discarded as today. Newly-migrated `AutomationRule.isActive` rows default to requiring an explicit re-confirmation in the dashboard before taking effect post-migration, so no business is surprised by dormant configuration suddenly activating.
7. Remove the flow-builder and plugin-system UI/routes from the tenant-facing dashboard (§44.2's decision) — retain the underlying code (`flow-builder.ts`, `plugins.ts`) per the instruction not to discard working logic without strong reason, with a code comment/README note explaining the deprecation.

**PR 2 — pg-boss, the worker, and per-conversation ordering:**
8. Add `pg-boss` dependency; implement `PgBossJobQueue` against the `JobQueue` interface (§25.1), including `singletonKey` support (§25.5).
9. Build the worker entrypoint (`src/worker.ts`) registering all job handlers with explicit `(ctx, payload)` signatures (§16.3), calling `jobQueue.start()`; add `npm run worker` script.
10. Wire Phase 5's already-enqueuing webhook routes to the now-real queue — the `process-inbound-message` job handler resolves `TenantContext` and calls `processInboundMessage(ctx, event)`, with `singletonKey: `${businessId}:${conversationId}`` for ordering (§25.5).
11. Migrate `webhook-delivery.ts`'s retry chain onto a `deliver-webhook` job using pg-boss's native retry/backoff, removing the `setTimeout`-based `attemptDelivery` recursion, and route it through PR 1's SSRF-hardened dispatcher.
12. Implement `sweep-sla-breaches` and `sweep-retention` as `scheduleRecurring` jobs, iterating all businesses via the control-plane `Business` table then resolving each one's `TenantPlacement`.
13. Update `docker-compose.yml`/Helm templates with a `worker` service definition (§25.3), and update `shutdown.ts` to also cover worker-process graceful drain (finish in-flight jobs before exiting).

**PR 3 — enable the async tools, now that the queue is real:**
14. Implement the `send-followup` job handler and flip `schedule_followup`'s `ToolPolicy.enabledForTenant` default to `true`: `execute()` becomes `jobQueue.schedule("send-followup", {...}, { runAt, idempotencyKey })` → `ActionExecution` → `scheduled` → honest return. This is the **first moment** `schedule_followup` is ever exposed to the AI, and it is durable from that first moment, per §24.3's revised sequencing.
15. Implement `execute-campaign` as a job that fans out one send attempt per matched customer with per-customer try/catch and result tracking, replacing `campaigns.ts`/`execute`'s target-count-only behavior (§2.4) with an actually-durable send.

### Tests first
- The end-to-end workflow test from §34.3 item 4 (automation configured → event occurs → action executes) — the concrete proof automation's reconnection was followed through.
- **§33.4 item 2 (concurrent conversation messages):** simulate two workers racing on `process-inbound-message` jobs for the same conversation and assert strict ordering via the `singletonKey` mechanism, alongside a control case proving a different conversation processes without waiting.
- **§33.4 item 6 (worker retry executes exactly once):** force a transient failure in `send-followup`/`deliver-webhook`, let pg-boss retry, and assert the side effect (message sent, webhook delivered) happened exactly once, by count, not merely that the job reached `succeeded`.
- **§33.4 item 7 (SSRF redirect/DNS resolution):** against the local test HTTP server (§35), assert a URL resolving to a private/link-local/metadata address is rejected, and a URL that redirects to one is rejected at the redirect hop — written to fail against pre-dispatcher code first.
- The end-to-end workflow test from §34.3 item 5, now fully implementable, including its "exactly once under retry" clause.
- The end-to-end workflow test from §34.3 item 6 (AI requests an approval-gated tool → pauses → human approves → executes) — exercised against a test tool with `requiresHumanApproval: true`, since no real high-stakes tool ships in this plan's built-in set.
- A test seeding a breached SLA rule for one business and an unbreached one for another, running the sweep, and confirming only the breached business's conversation is escalated (tenant-isolation check applied to job-based sweeps specifically, per §33.2).
- A test for `execute-campaign` confirming partial failure (one customer's send fails) does not prevent the remaining customers from being processed, and that failure is recorded per-customer, not just aggregated.
- A test confirming a tool not permitted by `ToolPolicy` for the caller's actor kind (an AI call to a tool with `allowedForAI: false`, or a human call from a role outside `allowedForHumanRoles`) is rejected by the registry, not merely hidden from the UI.

### Migration/data considerations
Additive: `ActionExecution`, `ToolPolicy` tables, plus pg-boss's own schema tables (created via its own migration mechanism, run alongside Prisma's). No changes to existing tenant-owned tables beyond what Phase 1 already did.

### Acceptance criteria
- All six tools run through the registry with real Zod validation (replacing today's untyped `args as string` casts), real `ToolPolicy`-based AI authorization, and real RBAC-based human authorization — evaluated independently, never conflated.
- Every tool invocation produces an `ActionExecution` row with an honest status and an attempt-scoped `idempotencyKey` — `schedule_followup` never, at any point in its history in this codebase, returns "scheduled" without a corresponding durable job (§24.3's revised guarantee, verified by the PR sequencing itself, not just by a test).
- **Per-conversation ordering holds under concurrent workers, and cross-conversation concurrency is preserved** — both halves of §33.4 item 2 verified.
- **A retried job produces its side effect exactly once** — §33.4 item 6, verified by count.
- **The SSRF dispatcher rejects private/link-local/metadata-resolving URLs and redirect chains to them** — §33.4 item 7, verified against the local test server, used by both `trigger_webhook` and `webhook-delivery.ts` with no duplicated, unguarded `fetch` remaining anywhere in the platform.
- Automation rules, once configured, visibly affect live conversations (§34.3 item 4 passes).
- The flow builder and plugin system are confirmed unreachable from any route/UI (grep-verified) while their code remains in the repository.
- SLA breach checking and retention policy run automatically on their configured schedule across all businesses, each correctly tenant-isolated.
- Campaign "execute" sends real messages to every matched customer (up to the existing 1000-row fetch cap, unchanged in this phase per §30.1's "future optimization" classification) with per-customer result tracking.
- The worker process can be stopped and restarted without losing or duplicating in-flight work.

### Risks
- Sequencing this as three PRs within one phase, rather than two separate phases, means a mid-phase state (after PR 1, before PR 2) technically has tools without a real queue — mitigated by PR 1 explicitly not enabling any queue-dependent tool for the AI (task 5's `ToolPolicy` default), so there is no externally-visible claim of durability that doesn't yet exist, satisfying Principle 4 (§4) even at this intermediate point; this is the entire point of the merge.
- Reconnecting automation rules changes live conversation behavior for any business that had previously-inert rules configured — mitigated by the explicit re-confirmation requirement in PR 1, task 6.
- pg-boss's exact API surface for recurring/scheduled/singleton-key jobs must be validated against the specific installed version — mitigated by building the contract tests (§34.1) against pg-boss's documented behavior before wiring real handlers, catching API mismatches early.
- Deprecating the flow builder is a product decision with UI/communication implications beyond code — flagged for explicit stakeholder sign-off before this task ships, not assumed to be purely an engineering call.
- Running SLA/retention sweeps across *all* businesses in one recurring job could become slow as business count grows — acceptable for MVP scale; if it becomes one, the natural fix is per-business job fan-out (already structurally easy given jobs are already tenant-tagged), noted as a Phase 8 candidate if needed rather than solved speculatively now.

### Dependencies
Phase 4 and Phase 5 complete (`AIOrchestrator` and `ChannelAdapter`, including Phase 5's provisional job-enqueue interface, are both call targets for this phase's work).

### Explicitly deferred
Redis-backed queue (BullMQ) — not needed; pg-boss is the standing recommendation unless Phase 8 finds a concrete throughput reason to revisit (§25.1). Per-business job-fan-out for sweeps — noted, not built, unless scale demands it. Third-party/tenant-defined custom tools — a natural registry extension, not built now. A real high-stakes, `requiresHumanApproval` built-in tool (e.g., an actual refund/payment action) — no such tool exists in Owly today to migrate, and none is required for the MVP (§44); the `pending_approval` mechanism is built and tested against a synthetic test tool so it is proven and ready the day a real one is added.

---

## 46.7 Phase 7 — Production Channels (WhatsApp + Web Chat) and MVP Hardening

*(Renumbered from the first pass's Phase 8. Revised per review concern 21 to include Web Chat as a co-equal production MVP channel, not a WhatsApp-only phase.)*

### Objective
Implement `MetaCloudWhatsAppAdapter` (§20.2) and finish hardening `WebChatAdapter` (§20.4, built in Phase 5) for real production traffic; close out the remaining MVP checklist (§44.1); ship a real multi-business signup flow; run the full MVP acceptance scenario (§44.3) end-to-end against real infrastructure, for both channels.

### Why now
This is the phase where Ziyrak becomes sellable to a real first customer — it depends on every prior phase's foundation (tenant isolation, provider abstraction, channel contract with deduplication, durable actions, real job queue with ordering) being in place, since production channels are exactly where all of those need to work together correctly under real external traffic.

### Current code involved
- `src/lib/channels/whatsapp.ts` / the Phase 5 `WhatsAppWebAdapter` (reference implementation for adapter shape, not reused logic — Meta Cloud API is a fundamentally different, stateless integration).
- The Phase 5 `WebChatAdapter` and widget embed script (functionally complete from Phase 5; this phase hardens it under real traffic and ships the production embed flow).
- `src/app/(auth)/setup/page.tsx`, `login/page.tsx` (extended into a real multi-business signup flow, per Phase 1/2's deferral notes).
- `src/lib/platform/` (Phase 1-2's `Business`/`Membership`/`TenantPlacement` creation logic, now exposed through a real UI flow instead of only a migration script).

### Target change
A new business can sign up (creating its own `Business`+owner `Membership`+`TenantPlacement`, not just the migration-seeded Default Business), embed the Web Chat widget on their own site and/or connect a real WhatsApp Business number via Meta's Cloud API, and run the full MVP scenario from §44.3 through either or both channels.

### Detailed tasks
1. Implement `MetaCloudWhatsAppAdapter`: `validateInbound` (Meta webhook signature verification via `X-Hub-Signature-256`, mapping `phone_number_id` → `ChannelConnection` → `businessId`, Meta's `wamid` as the `InboundEventReceipt` dedup key), `sendMessage` (Cloud API `POST /messages` call), `getStatus`, credential setup flow (Meta app review/business verification is an external, non-code dependency — flagged as a risk below).
2. Harden `WebChatAdapter` for production: finalize the embeddable widget script's distribution (a small, versioned JS snippet businesses paste into their site), confirm origin-allowlist enforcement and rate limiting behave correctly under realistic traffic patterns, and build the minimal dashboard UI for a business to generate/rotate its publishable widget token and configure allowed origins.
3. Build the multi-business signup flow: create `Business` + `TenantPlacement` (shared-default) + owner `User`/`Membership` from a signup form, replacing the single-installation `isSetupComplete()` gate (Phase 1's interim fix) with a real "create a new business" path alongside "log in to an existing business."
4. Harden the MVP tool set (§44.1): confirm `create_ticket`, `assign_to_person`, `get_customer_history`, `schedule_followup`, `trigger_webhook` all function correctly end-to-end for a freshly-signed-up business with no pre-seeded data (i.e., graceful behavior with empty `Department`/`TeamMember` tables, not just the Default Business's pre-populated ones), and that default `ToolPolicy` rows are seeded correctly for a new business.
5. Wire human handoff/escalation UI to be clearly tenant-scoped and usable by a brand-new business's first agent.
6. Run the full §44.3 acceptance scenario against a staging environment with two real, independently-created businesses, through **both** Web Chat and WhatsApp.

### Tests first
- `MetaCloudWhatsAppAdapter` contract tests (§34.1) against a sandboxed/test Meta Business account (credential-gated, optional suite per §34.2).
- A full signup-to-first-message integration test for **each** channel: create Business A via the new signup flow, configure the channel, simulate an inbound event, assert a correct AI reply is generated and "sent" (via a fake adapter for the default suite; via the real sandbox/a real browser-driven widget request for the credentialed suite).
- The full §33 isolation matrix, including the database-bypass tests, re-run against two businesses created through the *real signup flow* (not just seeded via script), to confirm the production onboarding path produces correctly-isolated data.
- Web Chat's cross-business/cross-connection isolation test (§34.3 item 7), now run against the production-hardened adapter rather than Phase 5's initial implementation.

### Migration/data considerations
None beyond what prior phases already established — this phase is primarily new application logic (signup flow, Meta adapter, widget distribution) rather than data migration.

### Acceptance criteria
- §44.3's MVP acceptance scenario passes in full, against a staging environment, with two real independently-signed-up businesses, through both Web Chat and WhatsApp.
- A real WhatsApp message and a real Web Chat widget message both receive a correct, knowledge-grounded AI reply within an acceptable latency (define a concrete target at implementation time, e.g. p95 under 10 seconds for WhatsApp given Meta Cloud API + OpenAI latency, and a materially lower target for Web Chat given no provider hop).
- Business isolation holds for businesses created via the real signup UI (not just via migration/seed scripts), for both channels.
- A business can rotate its Web Chat widget token without any other channel or admin credential being affected.

### Risks
- Meta Business API access requires app review and business verification, which is an external process with its own timeline, not fully controllable by engineering — flagged explicitly as a scheduling risk for this phase, mitigated by starting the Meta developer app/business verification process in parallel with earlier phases' engineering work (it can begin as soon as Phase 5's adapter contract exists, since the actual credentials aren't needed until this phase's implementation and testing), and by Web Chat providing a fully-controllable, credential-free path to validate the entire MVP scenario even if Meta's review is still pending.
- A brand-new business with no pre-seeded `Department`/`TeamMember`/`KnowledgeEntry` data may hit edge cases the Default-Business-only testing in earlier phases didn't exercise (e.g., `assign_to_person` finding zero available team members) — mitigated by task 4's explicit empty-state testing.
- The Web Chat widget's public JS being served/versioned correctly (a caching or CDN misconfiguration could serve a stale or broken script to a business's real customers) — an operational concern to cover in this phase's deployment runbook, not an architectural one.

### Dependencies
Phase 6 complete (durable actions/jobs, including per-conversation ordering, must be fully working before relying on them for a real customer on either channel).

### Explicitly deferred
SMS/Telegram/Phone/Email as fully-marketed, hardened production channels (structurally ready per Phase 5, not required to be feature-complete for v1, per §44.1). Billing. Platform-admin support tooling. `InfrastructurePolicy`/dedicated infrastructure (Phase 9).

---

## 46.8 Phase 8 — Scalability and Shared Infrastructure

*(Renumbered from the first pass's Phase 9. Content materially unchanged beyond the `RealtimeBus` renaming and reduced-phase-count cross-references — the review's concerns did not require rethinking this phase's substance.)*

### Objective
Introduce Redis for cache/rate-limit/`RealtimeBus` (§29), PgBouncer/connection-pool tuning (§28.4), validate true horizontal scaling of both the app and worker tiers, and — only now — safely enable the Helm chart's existing HPA (§2.1/§2.7/§41).

### Why now
Sequenced last among the "must-have-before-scale" work specifically because every contract this phase needs (`RealtimeBus`, `JobQueue`, `TenantPlacement`'s connection resolution) was already built for isolation/modularity reasons in Phases 2-6 — this phase's job is narrowly "swap the adapter, prove it under load," not "design the abstraction," per §30.2's central claim. It comes after Phase 7 because there is no product-driven urgency to scale before there is a real customer generating real load.

### Current code involved
- `src/lib/rate-limit.ts`, `src/lib/cache.ts` (in-memory implementations, §2.7).
- `src/lib/realtime/` (Phase 5's `RealtimeBus`, currently `InMemoryRealtimeBus` only).
- `src/lib/platform/tenant-placement.ts` (Phase 3, connection pooling/caching).
- `docker-compose.yml`, `helm/owly/templates/hpa.yaml`, `helm/owly/values.yaml`.
- `package.json` (add `redis` as a real, non-dynamically-guessed dependency, §2.1/§29).

### Target change
Redis-backed rate limiting, cache, and `RealtimeBus` are the default in production configuration (in-memory remains the local-dev default, §40). PgBouncer sits in front of Postgres. The app and worker tiers can each run N replicas with correct behavior (verified under an actual load test, not just code review) — no dashboard client misses a durable state change (though it may miss a best-effort notification, §17.3), no rate limit under/over-counts across replicas, and per-conversation ordering (§25.5) continues to hold under multiple concurrent worker replicas.

### Detailed tasks
1. Add `redis` package dependency; implement `RedisRateLimiter` and confirm `cache.ts`'s existing Redis path (§2.7's noted latent bug — dynamically imported but never actually installed) now genuinely works end-to-end. Wire Web Chat's stricter per-token rate limit (§20.4) onto this same backend.
2. Implement `RedisRealtimeBus` (§26.1) and switch the default `RealtimeBus` selection to Redis when `REDIS_URL` is configured, mirroring `cache.ts`'s existing selection pattern.
3. Configure PgBouncer (transaction pooling mode) in `docker-compose.yml`/Helm chart; tune `PrismaPg`'s `connection_limit` per §28.4's sizing formula.
4. Add a `redis` service to `docker-compose.yml`/Helm chart (optional locally, required in the scaled-production Helm values).
5. Run a real multi-replica load/soak test (2+ app replicas, 2+ worker replicas) exercising: realtime notification delivery across replicas, rate limiting correctness across replicas (aggregate limit is honored, not multiplied by replica count), job processing without duplication (pg-boss's `SKIP LOCKED` semantics, verified under real concurrent workers), and **per-conversation ordering holding under multiple concurrent worker replicas specifically** (§25.5's guarantee, now validated at real scale, not just in a single-process test).
6. Enable the Helm chart's HPA (`autoscaling.enabled: true`) for the `app` deployment; add an analogous scaling policy for the `worker` deployment (§42).
7. Add a short-TTL Redis cache in front of `resolveTenantPlacement()`'s control-plane lookup (§28.4's noted candidate), since this lookup now happens on every request/job across many replicas.

### Tests first
- Contract tests for `RedisRateLimiter`/`RedisRealtimeBus` against the same shared interface test suite used for the in-memory implementations (§34.1) — both must pass identically from the caller's perspective.
- A test harness that runs two instances of the application (or two instances of the relevant module under test) against a shared Redis/Postgres and asserts cross-instance rate-limit consistency and per-conversation ordering under concurrent job pickup — this is the direct regression test for §2.7's most severe finding, extended to also cover §25.5's ordering guarantee at multi-replica scale.

### Migration/data considerations
None beyond infrastructure/deployment configuration changes.

### Acceptance criteria
- Rate limiting is correctly aggregated across replicas (verified by a test issuing requests split across two replica instances and confirming the shared limit, not `limit × replicas`, is enforced).
- Per-conversation ordering (§25.5) holds when two+ worker replicas are racing on jobs for the same conversation, verified under this phase's load test, not only Phase 6's single-process test.
- The full test suite (including tenant isolation and the composite-FK bypass tests) passes unchanged with Redis-backed adapters selected, proving the swap is behavior-preserving from the application's perspective.
- The Helm chart's HPA can be safely enabled per this phase's own load test results, with the "do not enable yet" note from §41 formally lifted in documentation.

### Risks
- Redis becoming a new single point of failure — mitigated by using a managed/HA Redis offering in production (operational recommendation, not a code change) and by scoping Redis's responsibilities (§29) to cache/rate-limit/`RealtimeBus` specifically, none of which are the durable source of truth for anything (jobs/data remain in Postgres), so a Redis outage degrades gracefully (cache misses, best-effort-notification delivery gaps) rather than causing data loss or duplicated actions.
- Load-testing infrastructure/tooling is new work in its own right — scope it minimally (a scripted concurrent-request harness against a docker-compose-scaled local setup is sufficient to validate the specific claims above; a full production-grade load-testing platform is not required).

### Dependencies
Phase 7 complete (validating scale is only meaningful once there's a real MVP generating real traffic patterns to reason about).

### Explicitly deferred
Multi-region deployment. Managed-Redis-specific failover tuning (operational, not architectural). Per-tenant rate-limit tiers tied to a subscription plan (§39's billing scaffolding is attribution-only; enforcement is a future billing-system concern).

---

## 46.9 Phase 9 — Enterprise Infrastructure Overrides

*(Renumbered from the first pass's Phase 10. Materially strengthened per review concerns 3 and 4 — the dedicated-database bootstrap this phase implements now has a real, already-proven resolution path, since `TenantPlacement`/`DatabaseProfile`/`StorageProfile` were introduced in Phase 1 rather than invented here under time pressure.)*

### Objective
Implement `InfrastructurePolicy` (§11) and the real, non-default branch of `TenantPlacement` resolution (§28.2-28.3) — pointing a specific business at a dedicated `DatabaseProfile`/`StorageProfile` rather than the shared defaults — plus Postgres RLS as an opt-in defense-in-depth layer (§8.8), for the first business that actually requires one of these, not speculatively.

### Why now
This is explicitly the last phase because it should be triggered by a real compliance-driven customer requirement, not built ahead of demand (Principle 2, §4). Every prior phase already built the seam this phase fills in (§11.2's "nullable field read by a factory function" claim, now concretely `TenantPlacement` + two profile tables, live since Phase 1) — this phase's job is to prove that claim by actually provisioning the non-default branch, and — per the review's specific concern — this phase no longer faces the bootstrap circularity the first pass's design would have hit, because the control-plane resolution step (§7.5) was never something this phase needed to invent; it has been resolving to `"shared-default"` since Phase 1.

### Current code involved
- `src/lib/platform/tenant-placement.ts` (Phase 3's resolver — this phase adds its real non-default provisioning path).
- `src/lib/storage/` (Phase 7/8's `ObjectStorage` — this phase adds a per-tenant `StorageProfile` branch, already structurally supported since §27.1).
- New `InfrastructurePolicy` model and its admin-facing configuration UI (likely platform-admin-only, not tenant-self-service, at least initially — a business requiring dedicated infrastructure is a high-touch sales/support relationship, not a self-service toggle, for the first customers who need this).

### Target change
A specifically-flagged business can be provisioned with a dedicated `DatabaseProfile` (real connection secret resolved only through `SecretResolver`, never visible in `TenantPlacement` or `InfrastructurePolicy` themselves — §7.6), a dedicated `StorageProfile`, a data-region constraint, and/or a restricted AI/embedding-provider allowlist — with **zero code changes required in any application/domain module, only new control-plane rows**.

### Detailed tasks
1. Implement `InfrastructurePolicy` model (additive migration) and `getInfrastructurePolicy(businessId)`.
2. Build the provisioning procedure for a new `DatabaseProfile`: create the dedicated Postgres instance/database, run Phase 1's full schema migration set against it (the migration tooling must support targeting an arbitrary connection string, not just the default), register the connection secret via `SecretResolver`, create the `DatabaseProfile` row, and only then update the business's `TenantPlacement.databaseProfileId` to point at it.
3. Build the equivalent provisioning procedure for a dedicated `StorageProfile`.
4. Build the **data migration** procedure: export the business's existing tenant-scoped data from the shared database (every table in §12, filtered by `businessId`), import it into the new dedicated database, verify row-for-row (same discipline as §13.4's Phase 1 verification, applied to a single business this time), cut over `TenantPlacement`, and only then decommission the business's rows in the shared database.
5. Implement the AI/embedding-provider-allowlist enforcement: `AIProviderRegistry.get()`/`EmbeddingProviderRegistry.get()` consult `InfrastructurePolicy.permittedAiProviders`/`permittedEmbeddingProviders` (when present) and refuse to resolve a disallowed provider, even if `BusinessConfig` requests one.
6. Implement Postgres RLS as an additional layer specifically for dedicated-database tenants (§8.8) — `SET LOCAL app.tenant_id` inside the dedicated connection's transactions is now cheap and uncontroversial, since the connection is not shared across tenants.
7. Build minimal platform-admin tooling to configure `InfrastructurePolicy` and trigger the provisioning/migration procedures for a specific business (internal tool, not a polished self-service product surface).

### Tests first
- A test provisioning a business onto a dedicated (test) database via the full procedure in task 2/4, and confirming its data is physically absent from the shared database, and vice versa, afterward.
- A test confirming `InfrastructurePolicy.permittedAiProviders`/`permittedEmbeddingProviders` correctly block a disallowed provider selection for both generation and embeddings independently.
- RLS-specific tests confirming that even a raw, unscoped query against the dedicated database (simulating a hypothetical application-layer bug that also somehow bypassed the composite-FK layer, §8.4) is blocked at the database level for that tenant's connection — the literal "defense in depth" claim, tested directly, now the *sixth* layer of protection for these specific tenants (five shared layers plus RLS).
- A test confirming the job queue (shared, per §25.6) correctly routes a dedicated-tenant's job to its dedicated database via `TenantPlacement`, with no special-casing required in job-handler code.

### Migration/data considerations
Provisioning a business onto dedicated infrastructure requires migrating its existing data (previously in the shared database) into the new dedicated database — a live-migration procedure that must itself be carefully tested against a non-production business before ever being run for a real customer, following the same backup-and-rehearsed-restore discipline established in §13.3 (review concern 17) rather than assuming any part of it is trivially reversible.

### Acceptance criteria
- A test business can be fully migrated onto dedicated database + storage with zero application-code changes, only new control-plane rows + a data-migration run.
- The shared-tenant majority's behavior and performance are unaffected by this phase's changes (verified by the full test suite passing unchanged for businesses with no `InfrastructurePolicy` row).
- RLS is proven effective as a sixth layer for the dedicated-database case.
- The job queue requires no per-tenant configuration to correctly process a dedicated tenant's jobs against its dedicated database (§25.6's claim, verified directly).

### Risks
- This phase is speculative in scope until a real customer requirement defines exactly which overrides matter first (region? database? storage? provider?) — mitigated by the `TenantPlacement`/profile seam meaning partial implementation (e.g., only the database override, not yet storage) is safe to ship incrementally, in whatever order real demand dictates, rather than requiring all of §11.1's overrides to land together.
- Live tenant data migration to dedicated infrastructure is inherently risky — mitigated by treating it with the same rigor as Phase 1's schema migration (full backup, staged verification, rehearsed against non-production data first, per §13.3's corrected rollback language).

### Dependencies
Phase 8 complete (the shared-infrastructure path should be proven at scale before adding a dedicated-infrastructure path on top of it).

### Explicitly deferred
Multi-region *deployment* infrastructure itself (this phase implements the configuration/data-residency seam, not a live multi-region rollout of the application). A self-service UI for tenants to request dedicated infrastructure (internal/sales-assisted tooling only, for the foreseeable future).

---

## Final Section — Recommended First Implementation Task

Unchanged by this revision: once this document has been reviewed and approved, the first implementation task should still be **Phase 0 in full** (§46.0), started with its very first sub-task: **fixing the five unauthenticated routes identified in §2.2** (`/api/chat`, `/api/realtime`, `/api/channels/whatsapp`, `/api/channels/email`, `/api/webhooks/test`) plus the real-JWT-verification fix to `middleware.ts`. None of the 25 second-pass review concerns touched Phase 0's scope or reasoning.

This is the correct starting point, not any tenant/architecture work, for three concrete reasons: (1) it is a live, externally-exploitable defect today, independent of everything else in this plan, and every day it remains unfixed is unnecessary risk; (2) it is small and bounded — the fix for each route is a one-line `requireAuth()` addition with an already-known correct permission argument (§46.0's task list gives the exact permission for each), and the `middleware.ts` fix is a direct swap of a hand-rolled structural check for the already-existing, already-correct `verifyToken()` function; and (3) it requires no architectural decisions this document hasn't already made — there is nothing to design, only to implement and regression-test.

Immediately following that specific fix, within the same Phase 0 effort, the remaining Phase 0 tasks (Settings-singleton race fix, `admin/users` role-list fix, CI lint-gate fix, dependency installation, and the characterization test suite) should be completed before any Phase 1 (tenant model) work begins, per this plan's explicit phase-ordering rationale (§45).

**One addition specific to this revision:** do not begin Phase 1's schema migration work until Phase 0's regression suite is green and merged — Phase 1's own acceptance criteria (§46.1) depend on having a trustworthy characterization baseline to migrate *from* — **and, per §45.2, plan Phase 1 and Phase 2 as a single external release unit from the start.** An engineering agent picking up Phase 1 should already know, before writing a line of migration code, that its output does not ship to any externally-reachable environment on its own; scheduling and review checkpoints for Phase 1 should be set up jointly with Phase 2 accordingly, rather than treating Phase 1's own "acceptance criteria met" as a green light to onboard a second real business.

---

## Appendix — Items Requiring Human Product/Business Decision Before or During Implementation

This appendix consolidates the handful of places throughout this document where the *architecture* is settled but a genuinely non-technical judgment call remains open — collected here so a reviewer can see the full list in one place rather than hunting through 46 sections for them.

1. **Exact default `ToolPolicy` values per built-in tool** (§23.4) — the table given there is illustrative; the specific `allowedForAI`/`requiresHumanApproval` defaults for a first release are a product-risk judgment call, not an architectural one.
2. **The flow-builder deprecation** (§44.2, §46.6) — architecturally justified, but removing a dashboard feature has user-communication implications outside this document's scope; flagged in §46.6's risks as needing explicit stakeholder sign-off.
3. **Concrete latency targets for WhatsApp/Web Chat replies** (§46.7's acceptance criteria) — a product/SLA decision, not derivable from the architecture alone.
4. **Which specific enterprise infrastructure override (region, database, storage, or provider) a first Phase-9 customer actually needs** (§46.9's risks) — this plan deliberately does not guess, since the seam supports any of them being built first, in whatever order real sales/compliance conversations surface.
5. **Whether platform-support impersonation tooling (§15.2) is needed before or after the MVP** — named as a deferred capability throughout, but the actual timing is a support-operations decision once the platform has real customers to support.
6. **Managed Redis/Postgres/object-storage vendor selection** (§41, §42) — this plan specifies the *shape* of infrastructure (managed vs. self-hosted, pooled vs. not) but not a specific vendor, which is a commercial/operational decision.

None of these six items block starting Phase 0, or any phase up to the one where each becomes concretely relevant — they are called out so they are not mistaken for oversights when an implementer reaches that point.

---

## Development Execution Protocol

This section makes `PLAN.md` directly usable as an operating manual by future Claude/Codex engineering sessions during implementation. It governs *how* work proceeds from here — it does not add, remove, or reinterpret any architectural decision made in §1–§45 or any phase's content in §46.0–§46.9. Where anything below appears to conflict with an earlier section, the earlier section (the architecture) governs, and the conflict itself should be raised per rule 12, not silently resolved either way.

**1. Read `PLAN.md` first, every session.** Before touching code, an engineering session reads this document — at minimum the phase it has been assigned (§46.x), that phase's dependencies, and the architectural sections it references. A session that has not done this has not met the bar for starting work, regardless of how confident it is about the codebase from other context.

**2. Scope discipline: work only the explicitly selected phase, module, or task.** A session is handed one of: a phase (e.g., "implement §46.4"), a module (e.g., "the `knowledge/` module"), or a specific task within a phase's task list (e.g., "§46.6, PR 1, task 3"). It does not expand that scope on its own initiative.

**3. No opportunistic unrelated changes.** Seeing a real improvement in a module outside the current scope is not sufficient justification to change it. Note it (in the session's final report, rule 15, or as a follow-up suggestion) instead of acting on it. A bug fix inside the module actually being worked is fine; refactoring a neighboring module "while I'm here" is not.

**4. Before writing code for a selected module, restate its contract from `PLAN.md`.** Concretely, identify: what it owns (its section in §6's module table, or the relevant model/contract section), its public contract (the interface it exposes — e.g., `ChannelAdapter` from §19.1, `ToolRegistry` from §23.2, `JobQueue` from §25.1), what it may depend on and what must not depend on it (§5.7's dependency-direction diagram and the per-module "depends on" column in §6), the tests required before/alongside it (§33/§34, plus that phase's own "Tests first" list), and its Definition of Done (that phase's "Acceptance criteria" list, verbatim — not a paraphrase of it). This restatement does not need to be a formal artifact; it needs to actually happen before implementation, not be skipped because the module "seems obvious."

**5. Follow the dependency direction already fixed in `PLAN.md`.** §5.7's rule — application/domain modules depend on contracts, never on concrete SDKs; infrastructure adapters never depend back on application/domain modules — is not a suggestion. A session that finds itself wanting to import, say, `ai/` from inside a `ChannelAdapter` implementation has found an architecture problem to raise (rule 12), not a shortcut to take.

**6. Tests first, wherever `PLAN.md` says so.** Every phase's "Tests first" section is a required ordering, not a nice-to-have: for tenant isolation, security regressions, and contract tests specifically, the test is written and confirmed failing against pre-change code before the change is made (this is already how §46.2's isolation-matrix rollout and §46.0's auth-bypass regression suite are specified — this rule generalizes what those phases already require to every phase).

**7–8. Build and test modules independently; integrate incrementally through defined contracts.** The development philosophy for all implementation work under this plan is:

> **Build independently. Test independently. Integrate incrementally. Verify globally at the end.**

A module is developed and unit/contract-tested against its own interface (using the fakes named throughout this plan — `FakeAIProvider`, `FakeJobQueue`, `InMemoryRealtimeBus`, a fake `ChannelAdapter`, etc., per §34.1–§34.2) before it is wired into the modules that will actually call it in production. Integration then happens through the public contract already defined for that module (§6's table, the interface sections in §19/§21/§22/§25/§26/§27), not through a bespoke, one-off wiring path invented to save time.

**9. Run the right test layers after every integration, not just at the end of a phase.** After wiring a module into its real caller: run that module's own unit/contract tests, the relevant integration test(s) from §34.3, tenant-isolation/security tests where the module touches tenant-owned data or a trust boundary (§33), and the full regression suite where the change is broad enough to warrant it (judgment call, but bias toward running it). **Do not postpone all integration to the end of a phase, and do not postpone all of the above to the end of implementation.** Modules are integrated continuously as they are completed, each time through the layers just listed. The final full-system verification (rule 16) is for proving the complete, already-integrated system end to end — it is not the first time independently-built pieces meet each other.

**10. A module or phase is done only when all of the following are true, not when the code merely compiles:**
   - Its required tests (rule 6) pass.
   - Its phase's acceptance criteria in `PLAN.md` (§46.x) pass, verbatim — not "close enough" or "the spirit of it."
   - Its integrations work through the intended contracts (rule 8), verified by the integration tests that exercise them.
   - No known tenant-isolation or security regression exists as a result of the change (§8, §32, §33).

**11. Do not silently change the architecture.** If implementation reveals that some part of `PLAN.md` is incorrect, impractical, or incomplete — a contract that doesn't fit the real provider API, a phase dependency that turns out to be wrong, a data-model detail that doesn't hold up — the session stops before making a significant deviation and instead: documents the problem concretely, explains specifically why the current plan does not work (not merely that a different approach is preferred), proposes the smallest reasonable correction, and identifies exactly which `PLAN.md` sections and phases the correction would touch. Architecture changes because implementation produced concrete evidence the original design was wrong — never because an agent prefers a different style, a trendier pattern, or a more elegant abstraction. This is the direct continuation of this document's own Principle 2 (§4): every abstraction and every contract in this plan was justified against something concrete, and any revision to one must be held to the same bar.

**12. Small implementation details that don't affect architectural contracts don't need this treatment.** Rule 11 exists to prevent casual redesign while working on one module — it is not a mandate to escalate variable names, internal helper structure, or file-local organization. If a decision doesn't change a module's public contract, its tenant-isolation guarantees, its dependency direction, or another phase's acceptance criteria, it's an implementation detail and the session should just make a reasonable choice and move on.

**13. Preserve module replaceability — this is the point of every contract in this plan.** Knowledge-layer code stays behind `KnowledgeRetriever`/`EmbeddingProvider` (§21.5, §22.1); AI generation stays behind `AIProvider` (§21.1); channel implementations stay behind `ChannelAdapter` (§19.1); object storage, jobs, and realtime stay behind their respective contracts (§25.1, §26.1, §27.1). A future module's implementation must not leak provider-specific details (an OpenAI-specific type, a Twilio-specific payload shape, an S3-specific URL format) into an unrelated module that only knows about the contract. If a caller needs to know which concrete provider/adapter is behind an interface to do its job correctly, that is itself evidence of a contract violation worth raising under rule 11, not a detail to work around locally.

**14. Every implementation session ends with a concise report** covering: scope implemented, files/modules changed, tests added or updated, tests executed and their results, which `PLAN.md` acceptance criteria were satisfied (cite them, e.g. "§46.2 acceptance criteria items 1, 3, 5"), any deviations from the plan and why (per rule 11, if applicable), and remaining open issues within that phase. This report is what lets the next session — which may not be the same agent, or the same person driving it — pick up work without re-deriving context that already exists.

**15. Full-system verification is a distinct, final activity, not a substitute for continuous integration along the way.** Once all phases relevant to a given release milestone are implemented (at minimum, the MVP boundary defined in §44), run an end-to-end verification of the complete flow this plan was built around:

```
Business/tenant setup (§46.1/§46.2, §7)
  → channel connection (§7.7, §19)
  → inbound customer event (§17.1)
  → deduplication (§17.4, InboundEventReceipt)
  → customer/conversation resolution (§18.1, customer-resolver)
  → knowledge retrieval (§22, KnowledgeRetriever/EmbeddingProvider)
  → AI orchestration (§18.2, §21, AIProvider)
  → tool/action execution, including ToolPolicy-gated and approval-gated paths (§9.5, §23, §24)
  → durable job execution where applicable (§25, singleton-key ordering per §25.5)
  → outbound response (§19, ChannelAdapter.sendMessage)
  → realtime/dashboard update (§17.3, §26 — best-effort, verified as best-effort, not as the correctness path)
  → audit/usage records (§38, §39)
```

This verification additionally and explicitly covers, per §33's isolation strategy and §31's reliability strategy: **multiple businesses operating simultaneously with confirmed cross-tenant isolation** (including the database-bypass tests, §8.4/§33.4 item 3), **duplicate provider delivery** (§33.4 item 1), **concurrent messages against the same conversation** (§33.4 item 2), **retries at every layer that has one** (AI provider, job, webhook delivery — §31.1, §33.4 item 6), **provider failures** (an AI provider or channel adapter returning errors, §21.3/§31.3), **job failures and dead-lettering** (§25, §31.3), **tool failures** (§23.2's error path), and **restart/recovery behavior** (a worker restarting mid-job, §46.6/§46.8's restart tests) — this list is a floor, not a ceiling; a session performing this verification should extend it where a specific phase's own acceptance criteria named a scenario not already covered above.

## Git and Commit Workflow

The Development Execution Protocol above governs *implementation* — what gets built, in what order, against what contract. This section governs how that completed implementation is *recorded safely* in Git. Where the two appear to conflict, implementation correctness (rules 1–15 above) still comes first; this section constrains how, not whether, that work gets committed.

### Repository ownership

- Ziyrak uses its own Git history, beginning from the migration baseline (the new root commit created when Owly's original ancestry was detached).
- Owly's original history is preserved separately for reference/provenance (backup branch, tag, and/or bundle) — not deleted.
- Required MIT attribution/license notices from upstream Owly must remain intact in the working tree (`LICENSE`), unchanged by the history change.
- Future work is committed to the Ziyrak repository/remote, not pushed to the original Owly remote.

### Commit philosophy

Use: **one coherent change → one coherent commit.**

Avoid:
- giant phase-wide commits when several independent changes exist,
- meaningless tiny commits for individual files,
- mixing unrelated refactors/fixes into the current task.

Examples:

```text
fix(auth): secure unauthenticated API routes
test(auth): add authentication regression coverage
fix(settings): make settings initialization race-safe
chore(next): migrate middleware to proxy
```

For later architecture work:

```text
feat(tenant): add Business and Membership models
feat(tenant): enforce tenant ownership relationships
test(tenant): add cross-tenant isolation coverage
feat(data): introduce tenant-scoped Prisma access
```

### Phase workflow

A phase normally consists of several meaningful commits, not one:

```text
phase
  → task / coherent implementation
  → tests
  → commit
  → next task
  → tests
  → commit
  → phase-wide verification
  → phase completion/tag
```

Do not force one commit per phase.

### Commit requirements

Before every commit:

1. `git status` must be reviewed.
2. Stage only the intended task.
3. Review `git diff --cached`.
4. Ensure unrelated changes are not included.
5. Run the tests appropriate for that commit.
6. Commit message follows Conventional Commit style.

### Working-tree discipline

- Never discard unrelated user changes.
- Never automatically stage unrelated files.
- For mixed files (a file with both in-scope and pre-existing out-of-scope hunks), use selective staging.
- If a task discovers unrelated work, report it rather than modifying it.
- Do not silently rewrite history after commits have been shared/pushed.

### Phase completion

Before marking a phase complete:

- all phase commits exist,
- required tests pass,
- full phase acceptance criteria pass,
- full regression/security checks required by `PLAN.md` pass,
- working tree contains no accidental phase leftovers,
- deviations are documented.

### Tags

Use milestone tags such as:

```text
phase-0-complete
phase-1-complete
phase-2-complete
mvp-v1
```

Only tag after the corresponding acceptance criteria pass.

### Agent behavior

Future Claude/Codex sessions must:

- inspect current Git status before modifying code,
- never assume the working tree is clean,
- preserve unrelated local work,
- show staged diff/status before committing,
- never push unless explicitly instructed,
- never force-push or rewrite shared history unless explicitly approved.

### After this section

This document should now be re-read once, in full, to confirm the protocol above does not contradict any architectural decision or any phase's acceptance criteria already written — that check was performed as part of adding this section, and again when the Git and Commit Workflow section above was added. No other content in `PLAN.md` was altered to add either section.

**`PLAN.md` is now frozen for implementation.** Future changes to the architecture, module boundaries, data model, security design, or phase roadmap should originate from concrete findings surfaced during implementation (per rule 11 above), not from further speculative redesign in the absence of code having been written against it.