# Ziyrak project and deployment review — 2026-10-25

**Decision: do not launch unrestricted paid production yet.** The modular foundation is sound and a controlled pilot is a reasonable next destination. First fix the concrete security/operational defects below, rehearse the actual deployment and recovery, and verify the final candidate. A staging deployment for that work is different from approving customer rollout. No rewrite is indicated.

Reviewed baseline: `5b45bd7ef8b899284277ee54ab5cc75cb64dffa6`, initially clean `main`. This is a code, configuration, evidence, dependency and product review, with three independent **AI-agent** reviews integrated by the lead. It is not an independent human penetration test, a deployment, or certification. No product behavior, dependencies in main, live database, credentials, callbacks or running services were changed. Recommendations below are proposed scope, not a newly authorized implementation milestone.

**Answers to the owner's questions**

| Question | Assessment |
| --- | --- |
| Ready to deploy? | Ready to prepare staging/pilot, conditional on the release gates below. Not ready for an unrestricted paid launch as-is. Health/configuration, security defects and missing current operational proof matter more than the number of merged features. |
| Safe? | Meaningful defense in depth exists. No cross-tenant escape or direct account takeover was confirmed in inspected paths. Credential forwarding, reset atomicity, ingress limits and dependency advisories still need attention. Absence of a found exploit is not proof of absence. |
| Enough tests? | Strong engineering regression coverage; insufficient release and AI-quality assurance. Some existing tests explicitly preserve incorrect behavior, and the AI scorer has reproducible false passes. |
| Problems during development? | Yes, including serious worker/delivery and permission bugs. Many were discovered and fixed through assembled browser runs and reviews. Some evidence and operational tools still lag those fixes. |
| Redundancy? | Unused UI dependencies, dormant integrations, a stale manifest backup, duplicate status records, and obsolete product documentation. Some compatibility identifiers and legacy models remain intentional migration support. |
| Dependencies fresh? | Mixed. Next's lock is current at 16.4.3 in the registry snapshot, but several packages lag, including security fixes. Main's installed dependencies also disagree with its lockfile. |
| Easy future upgrades? | Better than a tightly coupled application: provider/channel/storage/job contracts and lint boundaries help. Prisma alignment, embedding migrations, model evaluation, runtime packaging and manual update management remain sources of effort. |
| Payments next? | Design the billing boundary now; put production readiness and a small monitored pilot before automated paid rollout. Start with a simple subscription plus included allowance, subject to unit economics and merchant-country/provider eligibility. |

**Evidence and verification limits**

Fresh checks used a source archive of the reviewed commit in `/private/tmp/ziyrak-review-20261025-8aZznQ/source`, with an independent `npm ci` installation from the unchanged lockfile. Node was 24.8.0; CI/Docker specify Node 22, so this is not a substitute for target-runtime acceptance. Prisma generation passed. Both database URLs were explicitly pointed to an unreachable synthetic target; no real database tests were run.

- TypeScript: `tsc --noEmit --incremental false` passed.
- ESLint: `npm run lint -- --max-warnings 0` passed after a sequential rerun. The first run overlapped filesystem-writing lint regression tests and encountered a removed scratch file; this was review orchestration interference, not a product lint failure. Run those checks sequentially.
- Focused existing tests: **6 files / 53 tests passed**, covering SSRF dispatcher, secret resolver, R2 cases/scoring, health, module boundaries and raw-Prisma restrictions. These are narrower than the full suite.
- Synthetic reproductions against the actual source confirmed redirect credential forwarding, key-retirement failure and AI-scoring false passes. [Runner](evidence/project-review-2026-10-25/reproduce.cjs), [observations](evidence/project-review-2026-10-25/reproductions.json). Run the script with a checkout path; DNS/HTTP are mocked and credentials are synthetic.
- Build: **blocked by the review environment, not passed**. The initial sandbox run failed to fetch Inter from Google Fonts; the network-enabled retry failed when Turbopack/PostCSS attempted to bind a local port (`Operation not permitted`). No product compilation failure is established by those infrastructure errors. This external font dependency is also a reproducibility consideration. Details: [check results](evidence/project-review-2026-10-25/checks.json).
- Fresh npm advisory queries: **6 affected package entries: 1 high, 5 moderate, 0 critical**. Production-dependency query: **4 entries: 1 high, 3 moderate**. These are package/advisory counts, not six demonstrated application exploits. [Full audit](evidence/project-review-2026-10-25/audit.json), [production audit](evidence/project-review-2026-10-25/audit-production.json), [version snapshot](evidence/project-review-2026-10-25/dependency-snapshot.json).
- Historical R5 evidence records 1,812 tests passed/1 skipped and 30/30 browser journeys on candidate `0b9a1a2`, Next 16.4.3, build `U7J0zXpmaJ_C489Aoz04Y`, stand-in AI and captured mail. R5 tag points to merge `905b4ca`; subsequent logo merge is `3d5d15e`. These were **not rerun as a full suite in this review**.
- The retained owner record reports a real Business A recipient-visible Meta reply on build `905b4ca` (2026-10-25), real OpenAI, after an expired token was replaced. Business B was not retested; a historical waiver is not a pass. The callback used a temporary tunnel; confirm its current configuration before any real deployment. No live provider/message/mail calls were made in this review.
- Historical real-mail proof is delivery of one message through personal Gmail SMTP, not a production sender-domain or complete real-mail verification/reset journey. Dedicated provider smoke suites remain recorded as not run. GitHub connector queries returned empty status/run arrays for this main head; that limited response does not establish current CI success or failure.

**Fix before unrestricted customer launch**

Priority here means release importance, not a CVSS rating. Findings are open at the reviewed baseline.

| ID | Finding, trigger and impact | Evidence | Required correction / proof |
| --- | --- | --- | --- |
| F01 | Known vulnerable dependency versions, including high-severity Zod resource exhaustion. Zod is used for application validation; several schemas accept arrays. Nodemailer is in account-mail delivery. Application exploitation was not attempted. | `package-lock.json`; retained audit JSON; `src/lib/validations.ts:142,149,273`; `src/lib/mail/transport.ts:48–56` | Update to patched compatible versions in isolation; verify validation, invitations/reset mail, adapters and final runtime image. Confirm request-size defenses rather than assuming validation alone limits memory. |
| F02 | Credentialed webhooks follow cross-origin redirects with original headers, including HTTPS→HTTP. A compromised or open-redirect configured endpoint can leak its bearer/API credentials. | `src/lib/integrations/http-dispatcher.ts:237–253`; `trigger-webhook.ts:48`; synthetic reproduction | Reject cross-origin/downgrade redirects for credentialed calls or apply a deliberate header-stripping policy; add tests for both. Existing private-IP/DNS checks are valuable but address a different threat. |
| F03 | Password reset consumes the link, changes the password, then revokes sessions in a separate write. Failure between writes can leave earlier sessions usable and the token already consumed. | `src/lib/identity/account-service.ts:151–159`; `src/lib/identity/auth.ts:80–84` | Atomically validate/consume token, update password and session cutoff. Test injected failure and concurrent changes. This is a confirmed structural failure window; no crash exploit was exercised. |
| F04 | `/api/health` returns HTTP 200 when the DB is unavailable; Docker/Helm probes check only HTTP status. The existing health test expects this. | `src/app/api/health/route.ts:49–63`; `tests/api/health.test.ts:29–38`; `Dockerfile:81–82`; Helm deployment probes | Separate liveness and readiness; fail readiness for required unavailable dependencies, without turning every external-provider incident into a restart storm. Exercise the actual probe contract. |
| F05 | Deployment templates lag the managed service. Generated Helm Secret omits encryption key, platform proofs, Meta verify token and platform SMTP configuration. `existingSecret` is a workaround only with a compatible external pooler/configuration; chart PgBouncer rejects that combination. | `helm/ziyrak/templates/secret.yaml:9–33`; `_helpers.tpl:122–123`; `src/lib/secrets/env-key-resolver.ts:27–33`; `.env.example` | Define and validate one complete production configuration contract; rehearse customer signup, real mail, managed AI and channel setup in the selected topology. Do not deploy default values as a ready production system. |
| F06 | Public handlers can buffer an oversized body before rejecting it. Chunked Meta requests evade the early Content-Length check; Web Chat parses whole JSON first. | Meta webhook route `:78–84`; `src/lib/channels/http-request.ts:36`; `src/proxy.ts:106`; commented ingress body limit | Prove hard byte/time limits at the deployed edge and use bounded readers where needed. Test missing length/chunked bodies. Actual exposure depends on the edge, which was not inspected. |
| F07 | AI evaluation can accept fabricated facts; it removes any sentence containing negation before looking for forbidden claims. Some categories measure only escalation, not correctness, and empty/inconclusive categories can disappear from the gate. | `tests/helpers/r2-scoring.ts:26–38,61–75`; live evaluation runner `:43,100,123`; retained reproductions | Add adversarial scorer tests, validate repetitions and minimum evaluable counts, enforce correctness/grounding gates, then freeze a fresh holdout and review a sample with a human rubric. Do not present the existing threshold result as calibrated general answer quality. |

**Operational, maintainability and product findings**

| ID | Finding | Evidence and practical action |
| --- | --- | --- |
| F08 | Unsafe local test/load harness assumptions | `tests/setup.ts:13` accepts arbitrary DB URLs; some tests delete all `AiServicePolicy` rows. `scripts/loadtest/run.sh:38` sets only DATABASE_URL although `prisma.config.ts:15` prefers DIRECT_DATABASE_URL; `:28` uses broad `pkill`; `:31–33` can reuse a stale image. Fix before those scripts are run: enforce both URLs, disposable target identity, owned PIDs and exact image identity. This review did not execute them. CI's isolated DB is a mitigating factor. |
| F09 | Encryption-key retirement is broken | `env-key-resolver.ts:27–35` requires contiguous versions from V1. V2-only throws; V1+V3 selects V1. Reproduced. Use an explicit active version or correctly discover configured versions; retain old keys only while old ciphertext needs them. Rehearse rotation and recovery with encrypted records. |
| F10 | Outbound timeout is not an overall deadline | `http-dispatcher.ts:159–201`: DNS has no deadline, each hop gets its own timeout, and a dripping response can keep draining beyond the nominal timeout. Add a whole-operation deadline and terminate oversized responses. No hostile endpoint was contacted. |
| F11 | Worker and service monitoring are incomplete/misleading | Compose worker inherits an HTTP probe although it has no HTTP server; Helm omits worker probes. Health checks legacy Settings rather than managed AI and defaults to the wrong version. Add worker heartbeat, queue age, failed/uncertain delivery alarms and deployed SHA/image identity. Source: Dockerfile, compose worker, health route, Helm worker `:59–61`. |
| F12 | Container evidence differs from source evidence | Runtime image copies all development modules because worker uses `tsx`; it always installs Chromium for the demo WhatsApp Web path. `audit --omit=dev` therefore understates shipped inventory. Docker publish workflow does not consume a tested image/CI result; ordinary CI does not build/test the image. Build once, scan/test the immutable image and promote its digest. Compile the worker and separate optional browser dependencies when practical. |
| F13 | Analytics response time ignores current inbound messages | `analytics/route.ts:131` expects `role === 'user'`; `conversations/messaging.ts:41` stores `customer`. Current channel conversations can show zero/no samples. Fix and test realistic inbound→assistant timestamps before relying on this metric for service quality. |
| F14 | UI offers a nonworking alert | Automation UI exposes Keyword Alert (`automation/page.tsx:48,68`), while execution intentionally skips all alerts (`automations/automation.ts:209–217`) after prior security closure. Disable or explain this feature until a supported tenant-safe notification path exists; do not restore unsafe global SMTP. Wiki still claims delivery. |
| F15 | Release/status records disagree | PLAN said R2 unstarted and R5 unmerged after both merged; CURRENT contradicted itself about P3 mail/tag and referenced an ignored, absent `.agent/progress/r5.md`; HANDOFF retained deleted worktrees. This review reconciles the live pointers, preserving original evidence and waivers. Add a lightweight consistency check and avoid authoritative evidence links to ignored ephemeral files. |
| F16 | Security policy and support routing overclaim/drift | `SECURITY.md` promises Zod on every API body and no logged secrets, but enforcement is not universal; logger has no central redactor. Its private-reporting URL points to upstream `sukhrob-djumaev/ziyrak-app` rather than this repository. Fix claims/contact routing, supported-version matrix and redaction tests. No actual secret leak was established. |

Configuration-dependent security residuals also deserve an explicit launch decision: enforce `TRUSTED_PROXY_HOPS` against the real proxy topology and prevent backend bypass; apply a shared Origin/content-type mutation policy to cookie-authenticated workspace writes (platform writes already have stronger checks); prioritize MFA for platform super-admin/operator access. SameSite=Lax reduces ordinary cross-site POST risk but is not a complete sibling-subdomain defense. These are hardening recommendations, not claims of a demonstrated universal CSRF/account-takeover exploit.

Privacy has implementation support—tenant scope, export/erasure and retention—but policy and full lifecycle evidence remain necessary. Follow-up queue payloads still carry contact/message content (`schedule-followup.ts:134`); the earlier P1 review records this residual outside ordinary erasure/retention. Verify queue retention, backups, logs and support access when stating data-deletion guarantees. No legal/compliance certification is inferred from a function named GDPR.

**What the tests establish, and what they miss**

The testing work is substantial: 185 test files (180 default, five separately gated provider files), real Postgres isolation/composite foreign-key tests, raw-Prisma escape guards, concurrent allowance reservation, delayed authority, worker restart/recovery and thirty ordered browser journeys. Tests often assert durable business effects. These are good foundations.

CI runs migrations, typecheck, lint, the default suite twice with Redis variations, and build. Browser acceptance, signup-seeded coverage, provider suites, dependency audit, container validation and coverage are separate or absent. Keeping paid/provider tests outside ordinary CI is sensible; a release still needs the affected boundaries on an identified candidate. The advertised V8 coverage command lacks `@vitest/coverage-v8`; fix the command and inspect coverage of critical failure paths, rather than imposing an arbitrary percentage inconsistent with the plan.

The new-business J30 journey is narrower than its description: it creates knowledge/channel via APIs and sends customer/human messages via authenticated APIs, without exercising that workspace's embedded widget and observing a visible human reply (`j30-new-business-journey.cjs:72–114`). Other journeys cover parts separately. Complete the integrated customer journey through the UI, as PLAN requires, so a collection of isolated passes cannot conceal a wiring regression.

R2's scorer was changed after evaluation outputs were seen; that contamination is disclosed in its implementation record. The runner retains summaries and only truncated failed replies, so independent grounding review cannot be reconstructed for all passing outputs. Retain sanitized full observations, case/scorer/config hashes, category denominators and manual review notes. Expand a fresh holdout to the actual pilot languages, ambiguous requests, knowledge conflicts, provider failures and user pressure. A heuristic is not a calibrated confidence probability.

Historical Phase 8 tests did exercise two web/two worker processes, ordering/deduplication and Redis/shutdown behavior. They explicitly did not establish throughput capacity or deployed Kubernetes HPA. No current production restore drill, RPO/RTO, rollback rehearsal, alert ownership or capacity result was located. This means evidence was not found in the reviewed repository—not that no backup exists anywhere.

**Problems encountered during development**

The retained history records real problems, not just harness noise. These are historical fixes unless explicitly identified as open above; none is asserted to have recurred in this review.

- A standalone worker had no registered channel adapters, so it could persist an AI reply without sending it. Single-process tests missed the wiring defect; shared startup registration fixed it.
- An in-memory realtime bus could not deliver widget replies across the web/worker boundary. Persisted-message polling became the correctness path, with realtime only an accelerator.
- Browser runs exposed `/widget.js` being redirected to login, lost escalation metadata, missing audit calls and later restricted-administration UI regressions.
- Multi-process tests found that `npm` as PID 1 swallowed termination signals; direct Node entrypoints and drain grace periods addressed worker shutdown.
- P1 reviews found and fixed restricted-admin credential/configuration gaps, delayed-work authority bypasses, approver rechecks and username timing differences.
- A prior dependency update damaged the serving checkout's Prisma installation; this is why this review installed and generated only in an isolated copy. Current installed-vs-locked drift shows that environment identity still needs discipline.
- Development records distinguish real product defects from obsolete harness assertions/missing test environment variables. The worker-restart test has a historical flake record; it was not rerun here, so it is not labeled currently failing.

Sources: `docs/implementation-history.md:191–202,324–338,356–369`; `docs/p1-whole-surface-review-2026-10-21.md:21–30`; `docs/p3-accounts-onboarding-implementation-2026-10-22.md:52–63`. The recurring lesson is to test process boundaries, authority at execution time and customer-visible outcomes—not only individual modules.

**Dependency freshness and a sustainable update path**

Registry snapshot is dated; recheck at remediation time. Pin and test a coherent lockfile rather than treating `latest` as a deployment recommendation.

| Group | Locked versions | Observed update path / assessment |
| --- | --- | --- |
| Zod | 4.3.6 | [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) fixed at 4.6.6; registry wanted/latest 4.6.7. Priority security update. |
| Nodemailer / mailparser | 10.1.0 / 3.9.38 | [Nodemailer advisory](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8) fixed at 10.1.4; current compatible releases 10.2.1 / 3.12.4. Validate address handling and identity mail. |
| Vitest / mocker | 4.1.11 | Patched compatible 4.1.12; latest major 5.0.5 is a separate migration. |
| fast-uri | Transitive via Prisma local-stream tooling's AJV | Audit reports versions below 3.1.9 affected. Resolve its parent chain and assess runtime reachability; do not assume application URI handling uses this package. |
| Next / eslint-config-next | 16.4.3 | Keep paired. Main actually had 16.4.0 installed; isolated review used 16.4.3. |
| Prisma CLI / client / adapter | 7.10.0 / 7.6.0 / 7.6.0 | Align deliberately; compatible registry releases 7.10.1. The registry's CLI `latest` points at 8.0.0-rc.27: do not automatically adopt a release candidate. |
| OpenAI / Anthropic SDK | 6.33.0 / 0.127.0 | OpenAI compatible 6.49.0, latest major 7.43.0; Anthropic latest 1.3.0. Use adapter contract tests and model evaluation, not a bulk major bump. |
| React / React DOM | 19.2.4 paired | Latest 19.3.1; an intentional pin is not inherently unsafe. Upgrade together with framework/browser verification. |
| Runtime/types/toolchain | Node 22 in CI/image; local 24.8; Node types 20 | Declare supported Node/package-manager versions and align types. TypeScript latest 7.0.2 and ESLint 10.13.0 are separate major projects, not urgent merely because newer. |

The audit identifies affected packages, not all exploitable paths. Account email uses validation that reduces malformed-recipient exposure; no Nodemailer account takeover was demonstrated. The Docker image still ships development dependencies. The old R3 “zero production advisories” result is historical and is superseded by this fresh snapshot.

No repository Dependabot/Renovate configuration was found. Add scheduled grouped update PRs for Next+eslint-config, Prisma components, React pairs, test tools and provider SDKs, with security updates prioritized. Track override purpose, upstream issue and removal condition; six override blocks currently make transitive upgrades less obvious. Require targeted contracts, DB recovery/isolation for Prisma/pg-boss, browser checks for framework/auth/channel changes, and a canary/rollback path. GitHub supports update schedules and dependency groups in its [Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

Fourteen Radix packages have no authored source/test/script references; ElevenLabs SDK has no import (an unused phone helper calls the HTTP endpoint directly). These are removal candidates after build/visual checks. `package.json.before` is a stale tracked backup. Dormant `deliverWebhook()` has no runtime callers and enqueues a shape its handler now rejects; clean up or explicitly mark the unsupported contract. Do not confuse these with compatibility cookie/Redis/database names, which have documented reasons to remain.

**Architecture and product direction**

Keep the modular monolith. AI generation and embedding contracts, channel normalization, durable job/realtime interfaces, scoped repositories and lint dependency rules reduce future provider replacement work. The separate worker is appropriate. There is no evidence that microservices or a new framework would solve the identified problems.

Replacement is not free: new embeddings may require dimension/provenance compatibility and reindexing; model updates require behavioral evaluation; new tenant-owned models require synchronized Prisma/scoping/permission/inventory changes. Central scoping files and several 800–1,275-line customer pages are maintenance hotspots. Extract cohesive UI components when those features change, rather than undertaking a broad prelaunch refactor. Object storage currently has a contract but no implementation; dedicated storage, automated enterprise cutover and new channels remain deferred.

Useful next product work is reliability visible to customers: channel connection/delivery status, actionable failed-send recovery, human-handoff inbox/notifications, an onboarding test that proves the real channel, knowledge freshness/conflict feedback, workspace usage/budget visibility, and a support/incident contact. Start with a narrow customer segment and measure activation, successful resolution, human handoff, repeat usage, latency and cost per conversation. Repair analytics first. Avoid adding Phone, more providers or enterprise placement until a real customer need justifies the operating burden.

Before commercial rollout, assign ownership for incident response, customer support, vulnerability reports, refunds and billing disputes. Prepare accurate product claims, privacy/retention terms, subprocessor/data-region disclosures and account export/offboarding expectations for the actual business jurisdiction. These are launch deliverables requiring the owner's business choices and appropriate review, not a claim that this repository proves legal compliance.

**Payments: recommended first slice**

Working assumption: businesses pay Ziyrak for a subscription. Merchant registration country and whether businesses should collect their own customers' payments remain unconfirmed; no provider/account selection is made here.

Existing `Business` ownership and owner-only `business:billing` permission are useful anchors. Existing AI reservations are **not invoices**: uncertain provider attempts retain a conservative charge; AI interaction logging is best effort; allowances reset at UTC calendar-month boundaries, not subscription anniversaries (`ai/allowance.ts:5–10,31–33`; `ai/usage.ts:6–12,24–41`). Billing must reconcile those semantics explicitly.

| Decision | Recommendation |
| --- | --- |
| Initial commercial model | One or two monthly plans with included allowance and an explicit limit/grace policy. Avoid usage overage charging until billable metering/reconciliation is accurate and unit economics are measured. Preserve incoming messages and human access when AI is limited. |
| Checkout | Hosted checkout and customer portal, to reduce custom payment UI and card-data handling. Use server-side approved price IDs and workspace-owner authorization. |
| Billing domain | Provider adapter; workspace→provider-customer/subscription mapping; versioned plan/entitlements; immutable billing events; signed webhook inbox with unique event IDs; durable processing and reconciliation. |
| Lifecycle | Trial, active, incomplete, past due, grace, canceled, refund/dispute and reactivation rules; decide downgrade/proration and quota-period semantics. Do not grant service based solely on a success redirect. |
| Tests | Wrong signatures, replay/duplicates, reordered events, wrong workspace mapping, parallel checkout, failed renewal, cancellation at period end, refunds, provider outage, quota changes in flight, reconciliation and owner-only portal access. |

Stripe Billing is a reasonable conditional option when the merchant entity and required methods are supported; confirm [country availability](https://stripe.com/global). Subscription state is asynchronous, so signed events and payment failures must drive access changes ([subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)). Stripe explicitly does not guarantee event ordering and documents duplicate handling ([webhook delivery guidance](https://docs.stripe.com/webhooks)).

A merchant-of-record provider such as Paddle is worth comparing if handling the SaaS sale, subscription administration and tax collection/remittance through one provider is preferred. Confirm seller onboarding, product acceptance, payouts and contractual responsibilities for the actual company; buyer-country reach is not seller eligibility. [Paddle's SaaS model](https://developer.paddle.com/get-started/how-paddle-works/saas/) describes its hosted portal and subscription lifecycle. Neither provider is selected solely from these documents.

If “payments” means businesses collecting from their customers, that is a different product boundary: connected merchant onboarding, account capabilities, payouts, refunds/disputes and isolation between sellers. [Stripe Connect](https://docs.stripe.com/connect) is designed for platforms modeling multiple accounts and moving funds between parties. Scope this separately from charging for Ziyrak; do not let an AI tool authorize a payment/refund without explicit customer authorization and policy.

**Proposed next milestone and exit gates**

1. **Close review defects:** patch compatible security dependencies; fix F02–F06; fence DB/process test tools; fix key rotation and outbound deadlines; repair misleading analytics/alerts. Add failing regressions first where required, independent security review, and affected browser checks.
2. **Restore trustworthy acceptance:** repair R2 scorer and use a fresh holdout; complete the managed widget/human-reply UI journey; run the full automated/Redis/browser matrix on one final candidate; run only the applicable real-provider/mail boundaries. Preserve waived/blocked criteria explicitly.
3. **Rehearse operations:** build/scan/test an immutable image with the actual Node/config/proxy topology; exercise migration and rollback; restore a backup including encrypted secrets; establish capacity/latency targets, queue/worker alerts and an incident owner. Demonstrate production sender and stable Meta callback setup.
4. **Run a small monitored pilot:** narrow channels/segment, conservative AI limits, human fallback, explicit support expectations and measured unit economics. Agree the pilot's residual risks and boundaries.
5. **Add the bounded subscription slice:** select merchant country/provider and pricing, implement lifecycle/entitlements/reconciliation, sandbox and controlled live acceptance, then authorize paid rollout separately.

The project has enough structure to improve incrementally. The missing step is a coherent release candidate with trustworthy evidence and an operating plan, followed by billing that reflects the service actually delivered.
