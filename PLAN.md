# Ziyrak AI — Architecture and Delivery Plan

## Start here: current status and authorized work

Updated 2026-10-14. This plan owns architecture, acceptance criteria and work scope.
`README.md` explains setup; `AGENTS.md` defines the shared Codex/Claude workflow;
`.agent/CURRENT.md` identifies the next task; `.agent/HANDOFF.md` records the latest session.

The owner approved **managed-service readiness** on 2026-10-14: finish the quality
recovery work and add the account, access and managed-AI product direction below.
The planning session changed documentation only. The October 14 continuation
started R1 and R3. The owner approved the rule 11 delivery correction; durable
recovery and harness safeguards are being implemented and verified. `continue` advances through eligible tasks in the live
plan, without routine reapproval, while preserving necessary decision boundaries.
This does not authorize deployment, live account/provider changes or a new channel.

### Live plan — finished foundations and upcoming work

This is the single current roadmap. Update this board and the selected package's
criterion evidence together; CURRENT is a continuation pointer, not another roadmap.
**Implemented does not mean newly verified or ready for customer rollout.**

| Finished foundation | Implementation | Verification and limits |
| --- | --- | --- |
| Phases 0–6: tenant foundation, roles, knowledge/AI, channels, tools and jobs | Implemented and tagged | Historical phase evidence; R1 and R2 address current delivery and AI-quality gaps. |
| Phase 7: Web Chat and Meta WhatsApp MVP | Implemented and tagged | Real Web Chat/OpenAI and Meta evidence exists. October 11 second-number visible-delivery waiver remains a waiver, not a pass. |
| Phase 8: shared infrastructure and multiple processes | Implemented and tagged | Redis and multi-process tests recorded; Kubernetes HPA not cluster-verified. |
| Phase 9: enterprise placement | Dedicated-DB/RLS portion merged; no completion tag | Synthetic evidence only; dedicated storage deferred, migration manually quiesced. Full enterprise acceptance incomplete. |
| Post-9 hardening | Merged through PR #28 | Product baseline `c20513d78421816ac0096eff1cf3dbb0d6c9aa55`; see the [status review](docs/status-review-2026-10-14.md). |
| Development process and this product plan | Documented | Shared Codex/Claude continuation, evidence rules and targeted provider testing. These are process changes, not application fixes. |

| Order | Upcoming task | Implementation / verification | Depends on / intended outcome |
| --- | --- | --- | --- |
| 1 | **R1 — Delivery reliability** | Local criteria passed; R4 provider boundary open | Candidate63247f6; durable replies and audited recovery, all17 browser scripts passed. |
| 2 | **R3 — Operational safety** | Complete locally; residuals decided 2026-10-21; not deployed | Puppeteer 25 (PR #29) removes extract-zip: 0 production / 5 high full (braces lint tooling, accepted) advisories. |
| 3 | **P1 — Platform and workspace access** | Complete locally 2026-10-22 (tag `phase-p1-complete`); not deployed | Workspace/resource boundaries, secured operators, support and delayed-work authority; evidence in the P1 closure record. |
| 4 | **P2 — Managed AI and usage limits** | Complete 2026-10-22 (merged, CI green on the exact head; tag `phase-p2-complete`); verified in development (see the P2 result); not deployed | Platform-managed policy, durable per-workspace token allowances, customer usage view and super-admin console; completion tag awaits owner decision. |
| 5 | **P3 — Accounts and customer onboarding** | Not started / not run | P1 invitations/access and P2 managed AI; verified signup through first useful reply. |
| 6 | **R2 — AI decision quality** | Not started / not run | R1 and P2–P3; evaluate the configuration and journey customers actually receive. Policy/threshold decision remains open. |
| 7 | **R4 — Final functional acceptance** | Not started / not run | R1–R3 and P1–P3; verify the assembled managed-service candidate. |
| 8 | **R5 — Final Ziyrak naming and branding** | Not started / not run | After R4; rename safely and rerun every check invalidated by the final changes before closure. |

Keep the R identifiers stable for earlier evidence; P identifies newly approved
product work. This order replaces the earlier R1 → R2 → R3 → R4 → R5 queue.
Preparation that does not depend on an unfinished contract may proceed when an
external blocker is recorded; implementation must respect the dependencies above.
No task in this upcoming table has passed acceptance yet.

The October 14 review verified CI for that exact product baseline: default
1149 passed/4 skipped; Redis-selected 1152 passed/1 skipped. The latest recorded
full browser run passed 16 scripts using a stand-in LLM, excluding live J16.
These are dated results, not evidence for subsequent edits or the current deployment.

Architecture and phase requirements remain in §§1–46. Dated implementation
records are preserved in [implementation history](docs/implementation-history.md).
The old September 14 code inventory and migration instructions describe the
pre-migration baseline; they do not direct agents to restart Phase 0.
Read current decisions and the relevant later record when interpreting them.

### Decisions and boundaries to preserve

- Meta credentials use each connection's encrypted App Secret; the platform-wide
  secret fallback was retired. Follow the October 11 record, not the earlier
  Phase 7 implementation snapshot. Preserve tenant-scoped, fail-closed verification.
- The October 11 second-number delivery waiver is specific to that historical
  test run. It does not authorize claiming future customer delivery or skipping
  required release verification after relevant changes.
- Dedicated storage, automated enterprise cutover, new channels and broader
  enterprise release work are deferred. This milestone does not authorize building them.
- The managed-service decision below is approved product scope. It replaces the
  earlier pending product discussion and the specifically mapped original deferrals;
  all other tenant isolation, module boundaries and security contracts remain.
- Escalation behavior and evaluation thresholds need an explicit product decision
  in R2. Optional cookie-request Origin hardening remains an unselected follow-up.
- Use isolated worktrees, dependencies, test databases and ports for product work.
  This host's main checkout supplies the live worker. Never run cleanup tests on
  live `owly`, kill processes by name, or touch port 7700 and its remote-control tunnel.

## Approved product direction — managed service

**Decision MS-2026-10-14, owner approved.** Ziyrak is a managed AI customer-support
service for businesses. A registering business customer creates a private workspace
and becomes its owner. Reuse `Business` as that workspace boundary; WhatsApp numbers,
Web Chat and future Phone connections are resources inside it, not separate tenants.
People messaging a business are customers, not dashboard accounts.

The October 14 source inspection found that signup already creates a Business, User
and owner Membership atomically, but the wizard asks the customer for AI keys/models.
Roles currently cover the whole business; request context chooses the earliest
membership. A platform-admin flag exists without a platform console or support-access
workflow. Verified email, recovery/invitation flows and enforceable managed-AI quotas
are missing. These findings justify extending the existing foundation, not replacing it.

### Accounts and responsibilities

| Role | How it is obtained | Allowed scope |
| --- | --- | --- |
| Platform super admin | One initial owner-controlled account, provisioned through a secured bootstrap/recovery procedure; never public signup | All platform management: workspaces, operator assignments, service policy, AI credentials/models and limits. Customer-data access uses the explicit audited support flow below. |
| Platform operator (scoped admin) | Super admin creates/invites and assigns named workspaces and permitted support operations | Only assigned workspaces; no self-assignment, platform-role grants or global provider-secret access. |
| Business owner | Public signup creates their own private workspace; existing accounts may join another through an invitation | Own workspace, business configuration, channels and team; owner-only accountability remains in §9.1. |
| Workspace admin | Owner delegates within their workspace | Workspace settings and team operations permitted by the existing role matrix; no platform administration. |
| Team member | Owner/admin invitation with an explicit role and resource scope | Existing supervisor/agent/viewer permissions, restricted to authorized channels/conversations where assigned. |

“Small admins” therefore has two explicit meanings: **Ziyrak operators** and
**customer workspace admins**. Do not combine them into a role that can accidentally
cross businesses. The initial single super admin is a provisioned account, not a
hardcoded username, shared password or implicit first-public-signup privilege.

Super admin access to all platform management does not bypass tenant data isolation.
Opening a customer's workspace for support creates an explicit, time-bounded,
revocable, audited grant with the actual operator identity and reason. Operators
can obtain such access only inside their assignments and permitted operations.
Every tenant operation still resolves a concrete workspace and uses normal tenant
repositories; never impersonate an owner invisibly or expose decrypted secrets.

A person can belong to several workspaces and select one explicitly. The server
checks current membership/support grant and resource scope on every operation;
knowing a workspace or channel ID does not grant access. Channel scope limits
conversation-derived messages, attachments, tickets, customer history, search,
exports, analytics and realtime streams as well as visible navigation. For a
customer appearing on several channels, expose only authorized conversation-derived
data; shared profile fields need an explicit permission, not an accidental join.
Workspace-wide knowledge/configuration remains governed by its own role permissions.
No channel assignment silently grants workspace administration.

### Customer journey and service ownership

Target journey: **register → verify account → create/enter private workspace → add
business knowledge → connect a supported channel → receive a test reply → activate**.
An invited member joins an existing workspace without creating a duplicate. Signup
must be resumable and isolated; a new business does not wait for manual super-admin
assignment. Privileged or unverified accounts cannot bypass activation safeguards.

Ziyrak manages generation/embedding providers, credentials and model selection.
Business users configure their business, knowledge, tone/language, working hours,
channels and handoff behavior; they do not supply AI keys or select raw models.
Channel ownership/credentials still belong to the business and use the existing
secure connection flow. Normal customers see usage and service status, not secrets
or infrastructure controls. P2 enforces limits before paid work and defines a clear
limit-reached state that preserves messages and human handoff.

Web Chat and Meta WhatsApp are the current channel priority. Phone is a later
product direction, not accepted production functionality in this milestone. Focus
on one complete customer journey before adding channels, subscriptions or enterprise
infrastructure. Account-verification email is transactional identity delivery, not
an expansion to the deferred customer-support Email channel.

### Contract amendments and remaining decisions

This decision amends §§5–12, 14–16, 21, 33–34, 36, 39 and 44 through P1–P3:
workspace selection/scoped support and channel authorization, managed AI policy and
durable quotas, account lifecycle and acceptance. The relevant original Phase 1/2/4/7
requirements remain regression obligations; their historical completion records do
not prove these additions. §45 is the original migration roadmap; the live board
above is the active work order. Schema/interface details follow existing contracts
and must be stated before implementation; a further material deviation uses rule 11.

The old deferrals for platform support tooling and quota enforcement are replaced
by this bounded milestone. Full billing, new support channels, dedicated storage
and automated enterprise cutover remain deferred. Existing accounts, memberships,
channel connections, sessions and encrypted credentials need a tested migration;
never discard them or grant new privilege implicitly.

Open product values are limited to a concrete proposal for R2 escalation/quality
thresholds and P2 allowance amounts/periods and customer-facing limit behavior.
Prepare reviewable examples and conservative test configuration first; seek the
owner's decision before locking production policy. Provider account purchases,
email-domain changes and deployment keep their external-action boundaries. These
pending values do not reopen the approved roles or block independent implementation.

## Managed-service readiness milestone

### Completion standard: good, with evidence

The milestone is complete only when all required R1–R5 and P1–P3 criteria have passed,
applicable independent review findings are resolved, and the evidence identifies
the tested code/build, environment, provider, commands, outcomes and limitations.
An agent rating, merge, test count, health response or Graph acceptance alone
does not close a workflow. Do not invent a model score or silently reduce a criterion.

Track implementation separately from verification:

- **Implementation:** not started / in progress / implemented / merged / deferred.
- **Each verification criterion:** not run / passed / failed / blocked / waived.
  Record the test layer and provider (fake, stand-in or real) beside the result.
- A waiver requires the owner's dated decision, exact scope and residual limitation.
  It is never a pass. New waivers or changed requirements need explicit approval.

Each work package uses this template: **problem/evidence; scope/exclusions;
required behavior; verification; completion criteria; result/evidence links**.
The live board above owns ordering and status; CURRENT points to the next eligible task.

### R1 — Delivery reliability

- **Problem/evidence:** the October 14 review reproduced two real-handler failures:
  a successful follow-up send followed by a failed DB write sends again on retry;
  an inbound reply with a failed `SendResult` can finish with a processed receipt.
- **Scope/exclusions:** conversation delivery and follow-up recovery, mapped to
  §§17–19, 24–25, 31, 33–34 and Phases 5–7. No general messaging-platform redesign.
- **Required behavior:** failed delivery remains recoverable/visible; delivery retry
  does not repeat AI generation or already executed tools. Already recorded success
  is not resent. Distinguish known failure from an uncertain provider outcome.
- **Verification:** add durable regression tests derived from the review's
  temporary diagnostic fixture, with desired assertions observed failing before
  the fix. Cover send refusal, successful send followed by persistence failure,
  timeout/unknown outcome, replay and worker restart. Use real isolated Postgres/
  pg-boss where durability is asserted, and deterministic provider fault injection.
- **Completion criteria:** both reproduced defects are resolved; retries and
  recovery satisfy the documented delivery contract; tenant isolation and required
  browser journeys pass; applicable independent security review is resolved.
  Document unavoidable provider-side uncertainty and operator recovery. If the
  existing exactly-once language (§31.2) cannot be met without a contract change,
  propose the smallest correction under rule 11 before implementing that deviation.
- **Result (2026-10-14 continuation):** owner approved the
  [rule 11 correction](docs/r1-delivery-contract-proposal-2026-10-14.md).
  Durable operations, saved responses, conservative uncertainty and audited human
  recovery are implemented and locally verified in the isolated worktree. All17
  browser scripts passed on candidate63247f6; affected real Meta verification
  remains a separate R4 requirement. No deployment or milestone closure.
  [Current evidence](docs/r1-delivery-implementation-2026-10-14.md) separates
  mocked regressions, real Postgres/pg-boss, review and browser/provider layers.

### R3 — Operational safety

- **Problem/evidence:** prior dependency work damaged the live checkout, a browser
  test stopped the live worker, and a PR was merged without checking CI. Dependency
  advisory counts came from different audit scopes and require fresh assessment.
- **Scope/exclusions:** assess reachable dependency risk, repair confirmed in-scope
  issues, and document/test isolated verification and controlled recovery. No bulk
  forced dependency upgrades, live restarts, migrations or deployment in this task
  without applicable authorization.
- **Required behavior:** test and live processes/databases cannot be confused;
  stop only recorded test-owned PIDs. Classify production vs development dependency
  findings and propose safe fixes or a documented owner decision on residual risk.
- **Verification:** fresh scoped audit, affected regression/build checks, isolated
  startup/stop/recovery rehearsal and review of actual scripts/configuration.
  Follow existing backup/restore requirements for any selected migration work.
- **Completion criteria:** confirmed in-scope risks resolved or explicitly accepted;
  safe commands and build identification documented; exact-commit CI checked before
  any authorized merge. Deployment requires separate authorization and observed
  web, worker and end-to-end checks; a health endpoint alone is insufficient.
- **Result (2026-10-15 continuation):** verified isolated safety baseline:
  ownership-safe harness/recovery and all17 assembled browser scripts passed.
  Five targeted dependency overrides reduce fresh audits to5high production and
  10high full. Redis-backed full suite1205passed/1 intentional skip, strict
  type/lint and Node22 Docker build/probes passed; independent candidate security
  review found no confirmed new issue. [Remediation evidence and concrete residual
  decision](docs/r3-remediation-2026-10-15.md) record unpatched extract-zip/braces
  exposure and controls. P1 preparation and implementation may use the verified isolated
  safety baseline; no live changes.
- **Result (2026-10-21):** Puppeteer 25 removes the unpatched extract-zip chain: production
  audit 0 high, full audit 5 high (braces lint tooling only). Verified on `fcb2487`: strict
  type/lint, unit 1573 passed (1595 Redis-backed), Node 22 Docker build and offline non-root probe,
  full browser 26/26 on a frozen build (headless-shell mode); PR #29 exact-head CI passed and was
  merged locally as `d0bc61f`. Owner accepted the braces residual under stated controls. Not
  deployed; whatsapp-web.js untested against a real WhatsApp session. See the
  [remediation record](docs/r3-remediation-2026-10-15.md).

### P1 — Platform and workspace access

- **Problem/evidence:** the platform-admin flag has no operating console; business
  roles are workspace-wide and the earliest membership is selected implicitly.
- **Scope/exclusions:** identity/platform/tenancy/RBAC, workspace selection and
  connection-scoped access (§§7–9, 12, 14–16). Reuse Business/Membership and current
  repository boundaries; no generic project hierarchy or invisible owner impersonation.
- **Required behavior:** implement the approved role table and audited support
  grants, with an explicit permission matrix before code. Super admin provisions
  operators and assignments; owners/admins manage only permitted workspace roles.
  Resolve selected workspace on the server; reject guessed IDs, privilege escalation,
  stale/revoked membership, expired support access and scope widening through API keys.
  Restricted users cannot recover excluded channel data through related resources,
  counts/search/exports, attachments or realtime. Recheck revocation for long-lived
  subscriptions and delayed user-initiated work (for delayed sending, "before sending" means
  before the durable local sending admission commits; see the approved
  [follow-up admission clarification](docs/p1-followup-admission-proposal-2026-10-15.md));
  system jobs retain only their defined
  operation, not a reusable human support grant. Define safe defaults for existing
  full-workspace memberships and new restricted assignments; unknown scope fails closed.
- **Verification:** tests first for authorization/isolation regressions; real isolated
  Postgres across two workspaces and two channels, role/resource matrix, grant audit/
  expiry/revocation, active streams, queue execution and migration cases. Browser
  journeys must use each actual role, workspace selection and denied direct URLs/API
  calls. Obtain independent security review; preserve the full-suite rerun triggers.
- **Completion criteria:** allowed and denied cases pass; no blanket tenant bypass;
  privileged bootstrap/recovery and audit behavior documented/tested; existing users
  retain legitimate access without gaining privilege. Support access records actor,
  target workspace, scope, reason and lifetime. P3 supplies the shared invitation
  lifecycle; until then use secured operator provisioning, never public role assignment.
- **Result (2026-10-15):** explicit permission contract and tests-first team/connection
  slice1322b03 plus foundation524fc17 in isolated P1 worktrees. Foundation full
  141files1253passed/23optional skips; signup-seeded73files751passed; type/strict lint
  and independent source/security/privacy rechecks passed after confirmed repairs.
  Runtime ddfb28b/buildwGZWKxtJLXDsM9Bpq5mC2: fresh all17 browser journeys passed;
  native Chrome owner/viewer workspace choice/switch and viewer Settings denial passed.
  Second viewer membership was a synthetic DB prerequisite, not invitation evidence.
  Owned topology stopped; live main product unchanged. New stream/delegated authority,
  platform bootstrap/support grant lifecycle and full actual-role matrix remain open.
  Stream slice92ae475/runtime b4a317f: full143files1277passed/23optional skips,
  signup74files770passed, type/lint and independent source recheck passed. Production
  build5Wsu11zRYbUiAIFjLzkmu/frozen digestf72cadf...ef64 covered all19 journeys through
  first17 and corrected J18/J19 continuations; first runner failed at new harness
  setup, not claimed as an uninterrupted19-script pass. Real Redis web/worker frames,
  widget visitor binding/token rotation, workspace choice/revocation and UI logout
  were verified. Saved/current PID/birth/cwd checks confirmed owned topology stopped.
  Platform/support, delayed authority and full role matrix remain open. No P1 closure
  or real-provider claim. See [P1 evidence](docs/p1-access-implementation-2026-10-15.md)
  and [stream evidence](docs/p1-stream-authority-2026-10-15.md).

- **Polling follow-up (2026-10-15):** c56686d (runtime d026791) denies wrong-channel/
  retired initial widget reads and enforces current parent predicates in polling/
  public cursors. Tests-first five failures repaired; focused58/full1283,
  23optional skips, type/lint and independent targeted source recheck passed.
  Fresh uninterrupted full19browser pass, build9146d4aHpG45JEXRsbL8K; isolated
  production web/worker/Redis/stand-in/Chromium, owned topology stopped. See
  `docs/p1-widget-poll-authority-2026-10-15.md`. P1 remains incomplete.

- **Secured enrollment checkpoint (2026-10-15):** bootstrap/recovery service and
  own-account UI/API implemented in isolated P1. Seventeen realPG cases and86route
  coverage checks passed; tests-first actor/IP rate evasion repaired, independent
  targeted source/security reviews found no remaining confirmed finding. Frozen
  full144files1301passed/23optional skips, signup75files794passed, type/lint passed.
  Fresh uninterrupted full20browser command and supplementary J21 actual five-role
  UI/API matrix passed on buildoNIe1NB_lH9Q5DEg-o0VY/unchanged digest5607ad...dbb61;
  Redis-backed17platform cases also passed. Actual enrollment/recovery/audit and
  super-admin no-bypass proved. Owned topology stopped. Existing Administration
  page shell/control presentation remains open; protected rows/actions denied.
  No live enrollment, operator/support activation or P1 closure. See
  `docs/p1-platform-enrollment-2026-10-15.md` and role-browser evidence.

- **Operator continuation (2026-10-15):** code21c269f and harnessfe49561 add
  super-only new operator provisioning and named immutable assignments/revocation,
  mandatory audit and denied-state UI, with no implicit tenant membership/grant.
  Two cross-creation username races reproduced then repaired across all application
  identity creators. Full1319/23optional, signup812, realPG/Redis34 and type/lint
  passed; independent source security recheck clear. First22browser command passed21
  then failed J22 network-idle harness wait after a complete403; corrected focusedJ22
  and actual denied UI/noforms/API checks passed. Fresh complete22rerun passed
  uninterrupted with exit0 on the original operator build; the initial failed run
  remains recorded. See `docs/p1-operator-assignments-2026-10-15.md`.
- **Internal grant continuation:** code6b5e3d7 implements explicit actor-self
  issuance/revocation and current scoped admission facts with mandatory allowed/
  denied audit. UUID casing, expiry-during-audit and logout-during-audit regressions
  reproduced before fixes. Full1335/23optional, signup828, Redis50platform cases,
  type/lint and independent source recheck passed. No tenant context/routes/streams/
  jobs wired; support activation remains closed. Frozen operator browser does not
  verify this module. See `docs/p1-support-grant-admission-2026-10-15.md`.
- **Follow-up lineage continuation:** codef84e423 normalizes the authoritative
  parent before action/cache admission, binds approval/cache to the recorded tool/
  parent and refuses unbound worker submission. Nine realPG desired failures
  reproduced before fixes. Full1346/23optional, signup828, Redis18follow-up cases,
  focused60, type/lint and independent source recheck passed. Identified
  build5egIm5D0_uNGgsVhKKb7v/runtime027455c
  passed the fresh uninterrupted complete22browser suite/exit0 with stronger J09/J10
  visitor/queue/action parent assertions. Synthetic local topology; no provider claim.
  Saved origin/authority checks, other
  delayed paths, support integration, restricted UI and legacy cutover remain open;
  no live queue changes or P1 closure. See `docs/p1-followup-lineage-2026-10-15.md`.

- **Grant management continuation:** code4e38f9a adds safe actor-self grant metadata,
  explicit issue/revoke API/UI and reason/expiry/audit. RealPG/Redis52, full1349 with
  23 optional skips, signup831, type/lint and independent source reviews passed.
  Matching runtime56bed6c/buildIXJigGX3F97tgWvfsptnv/digest15a3efb1...67b7a4
  passed a fresh complete22browser with expanded J22 uninterrupted/exit0; actual
  recorded/revoked screens also visually inspected. No tenant
  support context/selection/streams/jobs activated; no P1 closure. See
  `docs/p1-support-grant-console-2026-10-15.md`.
- **Delayed lifetime decision (2026-10-15, owner selected):** recorded schedules
  survive requester logout/session expiry. Before sending/retrying, recheck exact
  current membership or key authority, permissions, active workspace and saved
  resource ceilings; removed/recreated membership cannot revive old work. This
  does not extend support-session/grant lifetime. Implementation is pending; see
  `docs/p1-delayed-authority-policy-2026-10-15.md`.

- **Deferred identity foundation:** strict internal v1 human/key capture and fresh
  control-plane identity facts in codef2c0262. Exact membership/
  issuer recreation, scope ceilings, key expiry/revocation and approved logout
  lifetime covered. Full1358/23optional, signup840, Redis9, type/lint and independent
  source review passed. No TenantContext, queue authority, provider origin or
  operation/snapshot producer/dispatch integration yet. See
  `docs/p1-deferred-identity-foundation-2026-10-15.md`.

- **Provider-origin foundation:** strict internal receipt/operation/conversation/
  connection capture/refresh in code0bfe1ae. Sending false denial
  reproduced then fixed; conversation lifecycle projection inventory repaired.
  Full1367/23optional, signup849, combined Redis18, type/lint and independent source
  recheck passed. No queue/dispatch integration yet. See provider-foundation evidence
  and `docs/p1-followup-dispatch-contract-2026-10-15.md` for the next public seam.

- **Dispatch integration finding (2026-10-15):** isolated uncommitted wiring has
  three reproduced final-check races (policy disable, resource retirement and key
  expiry): desired realPG result3failed/10passed. P1 remains open; coherent admission
  and its cancellation cutoff need the documented rule11 clarification before
  implementation. See [proposal](docs/p1-followup-admission-proposal-2026-10-15.md).
  **Owner approved that proposal on 2026-10-19** (bounded local implementation and tests
  only). Implementation is in progress in an isolated development worktree; P1 and all
  its criteria remain open. Admission ordering also clarifies §§8/15 (revocation/
  lifecycle: a change committed before admission blocks sending, one after it cannot
  recall the admitted attempt), §24 (saved action authority is refreshed under the
  fences), §§25/31 (claim then transport; a failed claim is unsent, an unknown commit
  outcome is never permission to resend) and §33 (race tests).

- **Support query prerequisite (2026-10-15):** code c78a1ff: explicit scalar
  conversation-list
  profile and scoped root/model/transaction facade deny unsupported models, private
  predicates, mutations and raw client escape. Tests-first actualPG failures repaired;
  focused37, independent candidate full148files1426/1mode skip, signup79files886,
  type/lint and independent security source recheck passed. Support auth/routes/SSR/
  streams/jobs remain unactivated by this slice. Matching runtimec24277b
  fresh full22browser passed (exit0), exact owned topology stopped and verified
  remainingOwned=[]. Local stand-in/realPG/standalone worker; no P1 closure. See
  `docs/p1-support-query-implementation-2026-10-15.md`.

- **Limited support-list integration (2026-10-15):** codec199376 activates only
  explicit request-local GET conversation scalar list/count and bounded console,
  current own audited grant/person/assignment/session with final exposure recheck,
  explicit workspace-selection clear. Final-placement grant/JTI revocation2desired
  failures reproduced and repaired. Platform78/full148files1452+1Redis-mode skip/
  signup79files912/type/strictlint passed. Independent security/harness source findings
  integrated; no reviewer execution. Frozen matching runtimee85dc4e/build
  QdF756rE7IdlnyaEb39sR full22browser passed exit0; exact owned topology stopped/
  remainingOwned=[] verified. Actual J22 UI search/paging/conflict clear/revoked
  refresh/read audit passed. Screenshots reveal cramped table columns; visual polish
  remains open for the next candidate. No support details/SSR/
  streams/jobs or P1 closure. See `docs/p1-support-list-implementation-2026-10-15.md`.

- **Administration UI continuation (2026-10-15):** code533201c/45bab35 adds server/
  nav/capability gating, immutable owner controls, context/read-order resets, denied
  clearing/error text, correct safe key fields and J21/J23. Tests-first SSR12initial9red;
  actual Chrome/PG scope/read races red→green. Corrected focused runtime1208d3d/
  buildHNDaRpVjWn1UcaZjB6MWy/digeste62c7bf9...a9b1c J23/J22passed exit0 on synthetic
  clone2, screenshots checked, exact owned stop/none. J21passed on prior9ef; initial
  J23 fixture boolean/schema failures corrected. Actual cross-tab Aform→Bswitch POST201
  wrong-B persistence led to code893cb41 rendered-workspace request binding and actual
  two-tab J23 regression. Independent security/harness source closure clear; no reviewer
  execution. Final affected32/full149files1464+1Redis-mode skip/signup80files924/type/
  strictlint passed. Runtimeafcab4e/buildOxGeKpu78acIcGaW740sU/
  digest6a4381cb48d249080ecd82b84c052c9180bdc0cc7ce54e4517ea8d3fe78f3263 fresh all23
  passed exit0; supplemental actual user-form cross-tab403/no persistence passed exit0,
  screenshots inspected, exact owned topology stopped/none. Local stand-in/realPG,
  no real-provider claim. Settings continuation remains separate; P1 closure open. See
  `docs/p1-administration-ui-implementation-2026-10-15.md`.

- **Settings UI continuation (2026-10-15, not yet accepted):** code7fc5dab
  adds server/nav/capability/context gating, workspace-bound requests, known-denial
  clearing and fresh legacy read/Retry. Real SSR12initial8red/4positive, affected53/type/
  strictlint pass. Actual Chrome/PG red→green six checks include cross-tab wrong-write,
  denied credential retention and inherited mask-overwrite repair; preserved secrets on
  nonsecret edits, explicit replacement/clear. Independent security source closure clear,
  no reviewer execution. Full150files1476+1Redis-mode skip/signup81files936 passed exit0.
  Exact owned3200probe stopped/absent. Independent harness source closure clear after
  CDP URL string correction, no execution. Prior92focusedJ21passed; J24 browserstartup failure then loginselector timing
  gap fixed in harness504d08e. Matching runtime58e9ff3 building correctedJ24 on new
  original-fixture clone2; correctedJ24passed exit0, screenshotschecked/exactownedstopnone.
  Sourceproduct unchanged. Fresh empty full24 runtime58e9ff3/build96ITzoFyBUJCwB4Dut7X8
  failed exit1 after17journeys passed: J18 waited obsolete denial text "Insufficient
  permissions" at line82; current server renders "Access denied". Six later journeys
  not run. Source/assertion mismatch confirmed; repair and fresh full24 still required.
  Exact owned topology stopped/remainingOwned=[] verified, failed fixtures retained.
  Browser acceptance remains open; no P1/P2 closure/provider claim. See
  `docs/p1-settings-context-implementation-2026-10-15.md`.

- **P1 closure candidate (2026-10-22, on main f7fa7fa; P1 not declared complete):** the
  delayed-work slices (campaign runs, recovery-resend approver recheck, webhook-retry requester
  recheck), the whole-surface review fixes and the owner decisions of 2026-10-21 (keyword_alert /
  send_internal_email fail closed; login throttle relies on the documented TRUSTED_PROXY_HOPS
  requirement plus a production warning) are merged. Product code is identical to c9e4aa0, where a
  fresh-DB frozen full browser run passed 26/26 (headless-shell, stand-in AI, no provider claim);
  unit 1597 (1619 Redis-backed); tsc/lint clean; exact-head CI on f7fa7fa green. Reviews were
  three independent agent reviews, not human ones. Per-row evidence:
  `docs/p1-closure-matrix-2026-10-19.md`, `docs/p1-whole-surface-review-2026-10-21.md`. Open
  limits: windowed-browser mode not covered by the recorded run; per-workspace e-mail settings are
  future work. Owner declared P1 complete on 2026-10-22 (tag `phase-p1-complete`).

### P2 — Managed AI and usage limits

- **Problem/evidence:** signup/settings require tenant AI keys; provider/model choices
  are customer editable. Existing AIInteractionLog writes are best effort, so they
  cannot enforce a cap on paid provider use.
- **Scope/exclusions:** platform-managed generation/embedding policy and encrypted
  credentials, per-workspace service configuration/limits (§§10, 16, 21, 39), customer
  usage/status UI. Preserve AIProvider, EmbeddingProvider and SecretResolver; no
  subscription/invoice/payment engine or new AI provider.
- **Required behavior:** super admin configures allowed providers/models and service
  limits; customers cannot read global secrets or change raw model/provider/key fields
  through either UI or API. The backend resolves approved policy for each workspace,
  respecting InfrastructurePolicy restrictions; absence/invalidity fails clearly and
  never falls back to another customer's key. Cover generation, embeddings, tool-loop
  calls, test replies, retries, queued work and concurrent web/worker instances.
  Reserve a conservative bounded allowance durably before each potentially billable
  attempt; reconcile actual usage, refunds and uncertain outcomes idempotently. On
  accounting failure, fail closed for new paid work; preserve inbound data and human
  handling. Best-effort analytics is separate from enforcement. Document units, reset
  periods, reservation expiry/recovery and retry charging; caps are not exact invoices.
- **Verification:** tests first for secret/permission/isolation contracts; deterministic
  provider fixtures and real-DB concurrent reservation, exhaustion, worker crash,
  replay and accounting-failure tests. Check customer endpoints, logs and browser
  responses for secret/configuration leaks. Verify the managed path with a targeted
  real generation/embedding call before acceptance; broader quality is R2.
- **Completion criteria:** approved allowance/limit behavior enforced per workspace;
  one customer cannot exhaust another's allowance; UI explains usage/limit recovery;
  provider outages and missing setup are explicit. Existing encrypted tenant settings
  migrate through an explicit tested transition with backup/rollback considerations,
  no silent loss or surprise switch. Independent security review findings resolved.
- **Result (2026-10-22, branch `p2-managed-ai`, candidate `ffbeeef`; not merged, not deployed):**
  owner approved the proposal and all its recommendations
  (`docs/p2-managed-ai-proposal-2026-10-22.md`). Implemented: control-plane policy/allowance/
  reservation tables, reserve-call-settle metering of every generation, tool-loop, retry, test-reply,
  indexing and query-embedding attempt, fail-closed handoff, customer read-only usage view, super-admin
  console, expired-reservation sweep, explicit `legacy_byok` transition. Behavior, units and known limits:
  `docs/p2-managed-ai-implementation-2026-10-22.md`. Evidence: tsc/lint clean; full unit/real-PG suite
  167 files / 1655 passed / 23 skipped (Redis-gated; isolated DB); independent read-only agent security
  review, confirmed findings fixed tests-first (policy model/error text in the knowledge test route, rate
  limit release, idempotency-key reuse, console usage); fresh-DB frozen full browser run on `ffbeeef`:
  J01-J26 passed in one run, J27 (managed AI: super-admin UI, owner read-only view and refused writes,
  metered chat, exhaustion handoff, audit without key) passed after test-harness-only fixes on the same
  build and database (one intermittent embedding-policy save failure in an earlier J27 attempt was not
  reproduced in five later runs; its response body was not captured). Real provider: the credential-gated
  `tests/integration/managed-ai-live.test.ts` passed against real OpenAI with the environment key
  (chat settled usage equal to the provider-reported tokens; embedding settled; exhausted allowance made
  no paid call). Limits: browser run used the stand-in provider and headless system Chrome; reviews are
  agent reviews, not human; prompt estimate is characters / 3; owner merge approval pending.

### P3 — Accounts and customer onboarding

- **Problem/evidence:** atomic workspace signup exists, but the wizard exposes AI
  setup and there is no verified-email, password-recovery or invitation lifecycle.
- **Scope/exclusions:** self-service business-owner accounts, workspace/team and
  operator invitations, verified email, password reset and resumable onboarding
  (§§7, 9, 12, 14–15, 36, 44). No social-login marketplace, billing or new support channel.
- **Required behavior:** implement the approved customer journey without AI keys.
  Verification gates activation and paid use; repeated signup/onboarding requests do
  not create duplicate workspaces or leak another's account state. Invitations bind
  recipient, workspace/assignment, role and scope; existing verified users join
  without a second identity. Owners/admins cannot invite platform roles or delegate
  privileges they do not hold. Use expiring single-use hashed verification/reset/
  invitation tokens, rate limits and safe non-enumerating responses; reset revokes
  existing sessions. Verify recipient ownership before accepting privileged invites.
  Migration must let existing username accounts securely adopt verified email without
  account takeover or blanket lockout. Workspace administrators manage Membership,
  not another person's global identity/password/email or other workspace memberships.
  Global account changes require authenticated self-service or the audited recovery
  process. Preserve last-owner and ownership rules.
  Onboarding records knowledge readiness, channel setup, a useful test reply and
  explicit activation; its customer-visible state survives reloads and failures.
- **Verification:** tests first for token replay/expiry, wrong-recipient and cross-
  workspace cases, account recovery, privilege changes and migration. Use a local
  mail capture adapter for deterministic flows, then execute browser signup, invite,
  reset and first-reply journeys with production web and separate worker. Test provider
  failure and resume; record actual versus stand-in channel/AI evidence. Require a
  controlled real mail delivery check before claiming email delivery ready.
- **Completion criteria:** a new business owner can reach an isolated working channel
  and useful reply without AI setup; invited staff see only their permitted scope;
  account recovery and existing-account migration pass; no activation on failed
  required setup, hidden provider errors or unverified identity. Independent security
  review resolved. Real Meta acceptance remains separate when that channel is claimed.
- **Result:** implementation not started; verification not run.

### R2 — AI decision quality

- **Problem/evidence:** short correct replies can escalate; knowledge-count bonuses
  cannot fire with the current retrieval limit. Historical handoff transport tests
  do not establish reliable autonomous escalation.
- **Scope/exclusions:** confidence/escalation and a bounded representative evaluation
  of grounding, tool selection and handoff (§§18, 21–24; Phases 4, 6–7). No provider
  migration, model leaderboard or broad prompt rewrite.
- **Required behavior:** propose and obtain agreement on escalation rules and
  measurable acceptance thresholds before changing this product behavior. Prepare
  examples and expected outcomes first; do not ask the owner to design the tests.
- **Verification:** deterministic regressions plus a retained real-model case set
  covering short correct answers, missing knowledge, explicit human requests,
  failed/pending tools and cross-tenant bait. Define sample size, repetitions and
  scoring before the run; keep development examples separate from evaluation cases.
- **Completion criteria:** approved thresholds met, autonomous handoff exercised
  through the product, safety/isolation cases pass, provider/model/configuration
  and failures recorded. Do not describe the heuristic as a calibrated probability.
- **Result:** implementation not started; policy/threshold decision pending;
  verification not run. R1 and the P2/P3 managed customer flow precede final evaluation; case-set
  preparation can proceed independently. Record the actual managed policy version.

### R4 — Final functional acceptance

- **Problem/evidence:** existing evidence spans different dates/builds; the latest
  full browser suite used a stand-in, and the review found gaps after green CI.
- **Scope/exclusions:** verify the assembled managed-service candidate against §§33–36,
  rule 15 and the MVP browser journeys. Do not reopen historical phases or expand
  the Business B waiver into a blanket exemption.
- **Required behavior:** one identified candidate satisfies R1–R3 and P1–P3 criteria
  and applicable functional workflow requirements; evidence distinguishes local, real-provider
  and recipient-visible outcomes.
- **Verification:** after R1–R3 and P1–P3, run required automated/isolation checks, the full
  browser suite on production web plus a separate worker and a fresh acceptance
  database, targeted real AI evaluation, and applicable real Meta checks under the
  verification policy below. Build-changing fixes invalidate affected evidence;
  repeat the required scope on the final candidate. Extend the browser suite for
  verified signup/recovery/invites, workspace selection, operator grants/revocation,
  channel-scoped views, managed AI, cap exhaustion and activation. Verify the
  complete new-business journey without customer AI keys, including human handoff,
  while another workspace stays isolated. Real transactional email delivery requires
  a controlled recipient check before its delivery claim; local mail capture proves
  token/UI behavior only. R2 supplies real-model quality evidence; use targeted Meta
  checks for the affected delivery boundary, not every account-screen change.
- **Completion criteria:** required checks pass; remaining waivers/deferred features
  are explicit; implementation and deployment verification are recorded separately;
  CURRENT/HANDOFF identify the boundary. A blocked required provider check leaves
  that criterion and milestone closure open while eligible work continues.
- **Result:** implementation not started; verification not run. R5 follows this
  functional acceptance; its changes require the affected checks on the final tree.
  No Phase 9 completion tag, new phase or customer rollout is implied.

### R5 — Finish Ziyrak naming and branding

- **Problem/evidence:** user-requested final cleanup (2026-10-14). Owly names remain
  in visible UI/assets, documentation, package/deployment names and internal keys.
- **Scope/exclusions:** one bounded inventory and rename pass after R4. Search
  case-insensitively for `owly` and the whole word `owl` in tracked text and filenames;
  inspect referenced logos/icons as well. Update active product text, metadata,
  translations, owned assets, examples and safe internal identifiers to Ziyrak,
  updating all callers/references together. Do not rewrite historical evidence,
  third-party code, required copyright/license attribution or Git history.
- **Required behavior:** current Ziyrak surfaces consistently show the Ziyrak name
  and intended assets. Treat persisted/integration identifiers (cookies, storage
  keys, database/volume names, queue/cache prefixes, webhook headers, deployed
  service/chart names and public URLs) as compatibility changes, not blind text
  replacement. Document a safe transition or an explicit retained compatibility
  exception; do not rename a live database, move this checkout, lose data/sessions,
  or break external consumers as part of a cosmetic cleanup.
- **Verification:** repeat the text/filename scan and inspect visible affected pages
  and assets. Run checks required by the actual touched contracts under the existing
  policy, including auth/session, persistence, deployment-reference or browser
  regressions if those are affected. Branding alone requires no real Meta send;
  a changed provider-facing identifier uses the normal boundary-verification gate.
- **Completion criteria:** no unintended Owly/Owl branding remains in active product
  surfaces; all retained matches are explained as attribution, history, third-party
  provenance or required compatibility. Links/assets/configuration remain valid and
  affected checks pass on the final candidate. This is the last milestone task;
  preserve R4 evidence and rerun any checks invalidated by the rename before closure.
- **Result:** implementation not started; verification not run. Stop at milestone
  completion; further product scope or deployment requires applicable authorization.

## Verification selection and external blockers

Select checks by the changed contract and the claim being made. Record the reason
for selecting or omitting live checks before implementation. Start with the cheapest
layer that can catch the defect, then add the layers needed to prove the workflow.

| Change or claim | Required evidence | Live provider boundary |
| --- | --- | --- |
| Documentation or mechanical change with no behavior change | Relevant formatting, references and consistency checks | None unless the task changes operational setup instructions that need a rehearsal. |
| Local business logic | Focused regression/contract tests; real DB for query/isolation guarantees | No routine Meta session. |
| Shared conversation, tools, jobs or delivery behavior | Failure-path tests, relevant DB/queue/security coverage and assembled Web Chat/browser checks | Affected real-provider behavior checked before its acceptance/release claim. Shared delivery changes include a targeted Meta boundary check in R4. |
| Meta parsing, signatures, routing, credentials, Graph calls, API version or callback topology | Sanitized signed fixtures, wrong-secret/two-tenant/replay cases, real DB where needed, affected browser journeys | Targeted real Meta verification before accepting/releasing the changed boundary; visible delivery when delivery is claimed. |
| Accounts, roles, workspace/channel scope or recovery | Tests-first security and real-DB isolation coverage, independent security review and full browser suite | Local mail capture for routine account flows; controlled real email for delivery acceptance. No routine Meta setup. |
| Managed AI configuration or quotas | Permission/secret tests, concurrent durable accounting and real-DB worker recovery; managed UI journey | Targeted real generation/embedding before acceptance; deterministic fixtures during development. |
| AI provider, prompts, retrieval or escalation | Deterministic tests plus the agreed real-model evaluation | Real AI needed to claim model quality; Meta only if its boundary is affected. |
| Milestone/release candidate | Existing full-suite triggers, security/isolation checks and relevant real-provider journeys | Required live criteria remain required; mock success cannot satisfy them. |

The full browser rerun triggers below remain mandatory for routing, authentication,
channels, worker or widget changes and major releases/milestone tags. During an
implementation loop, run focused checks first; batch closely related edits into a
coherent candidate and run the full suite before closure. Documentation-only work
does not require rerunning the application or sending WhatsApp messages.

### Meta testing without blocking unrelated development

Use existing tools first: `tests/unit/meta-whatsapp-adapter.test.ts`,
`tests/security/meta-whatsapp-{setup,webhook}.test.ts`, real-DB isolation tests,
the Web Chat acceptance harness with its local LLM stand-in, and the separate
`test:smoke:meta` suite. The latter asserts Graph acceptance, not recipient delivery.
Do not replace the production adapter with a QR/demo channel to satisfy Meta criteria.

1. **Preflight only when a live check is needed:** confirm the intended test
   database/build, reachable callback, app/account subscription, credential/number
   ownership, allowed recipient and send eligibility. Use current provider docs;
   don't guess that an old token, account state or tunnel still works.
2. **Diagnose the failing boundary:** distinguish local setup, application defect,
   provider/account restriction and uncertain delivery. Keep sanitized error codes
   and correlation evidence; never record secrets or customer payloads in fixtures.
3. **Stop identical retries after a confirmed external blocker.** Record the exact
   criterion, evidence, smallest owner/provider action and what change permits a
   retry. Continue eligible authorized tasks and local tests. Ask once for a needed
   manual action; do not recreate accounts, rotate working credentials or rebuild
   unrelated code to chase an unchanged account restriction.
4. **Use a small live boundary test.** Reuse the authorized test setup; test inbound
   receipt, routing, reply and the affected failure/isolation case. Expand only
   for a specific criterion or finding. Run the full two-number live matrix when
   the changed guarantee requires it, not for every unrelated edit.
5. **Keep three observations separate:** API/Graph accepted; provider reported
   delivered/failed; recipient visibly received the expected reply. Persisted local
   messages and a 200 response do not establish the latter two. Current status
   callback handling is limited; capture permitted provider evidence or explicit
   recipient observation rather than inventing application delivery telemetry.

An external blocker limits that capability's acceptance/release; it does not freeze
the project. It also does not authorize skipping safety checks or shipping an
unverified WhatsApp path as ready. Provisioning a stable staging URL or dedicated
test account can be proposed if repeated setup churn justifies it; creating services,
changing accounts or spending money is not authorized by this policy.

Provider references: [Meta's Cloud API quickstart](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/)
separates API response and recipient observation; [Meta's status object reference](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object)
describes delivery/failure callbacks. These explain the evidence distinction, not
a recommendation to adopt the older SDK. Check current provider setup requirements
at the time of a live run.

---

## Architecture and original migration requirements (moved)

The original numbered contracts (§§0–46: architecture, tenant isolation, security, data model, phase 0–9 criteria, dated code inventory) live in
[docs/architecture-reference.md](docs/architecture-reference.md). They still govern unless a later decision amends them; Decision MS-2026-10-14 and P1–P3 explicitly amend the mapped contracts.
Do not read the file whole; grep its headings and read only the section you touch. Code comments of the form `PLAN.md §N` refer to that file.

Read these before the matching work:

- Security, tenant isolation, data access or authorization changes: §§7–9, §15–16, §32–33.
- Channels/webhooks: §19–20. AI, knowledge, tools: §21–24. Jobs/realtime: §25–26. Usage and allowances: §39.
- Phase 0–9 acceptance records: §46.0–§46.9.

### 44.4 Managed-service customer acceptance (current milestone)

R4 executes signup/verification → private workspace → knowledge → supported channel
→ useful grounded test reply → activation without customer AI keys, then team
invitation, scoped human handoff and account recovery. In parallel, another workspace
cannot access that data, a restricted member cannot access another channel, and
platform operators cannot leave assigned support scope. Verify service limits and
support revocation, including worker/realtime behavior. R5 then finishes naming and
reruns affected acceptance on the final candidate. Mocked account mail, stand-in AI
and real recipient delivery retain their distinct evidence labels.

---

## Continuation point

The original Phase 0 starting instruction is [archived](docs/implementation-history.md#original-first-task). Resume the approved managed-service readiness milestone via `.agent/CURRENT.md`; do not restart the migration or retag historical phases.

---

## Appendix — Items Requiring Human Product/Business Decision Before or During Implementation

This appendix consolidates the handful of places throughout this document where the *architecture* is settled but a genuinely non-technical judgment call remains open — collected here so a reviewer can see the full list in one place rather than hunting through 46 sections for them.

1. **Exact default `ToolPolicy` values per built-in tool** (§23.4) — the table given there is illustrative; the specific `allowedForAI`/`requiresHumanApproval` defaults for a first release are a product-risk judgment call, not an architectural one.
2. **The flow-builder deprecation** (§44.2, §46.6) — architecturally justified, but removing a dashboard feature has user-communication implications outside this document's scope; flagged in §46.6's risks as needing explicit stakeholder sign-off.
3. **Concrete latency targets for WhatsApp/Web Chat replies** (§46.7's acceptance criteria) — **partially resolved 2026-10-02:** Web Chat is server p95 under 5 seconds and visible-widget p95 under 7 seconds; WhatsApp retains the p95-under-10-seconds target; later manual 1–2 s observations were not an instrumented p95 measurement (see the Phase 7 history).
4. **Which specific enterprise infrastructure override (region, database, storage, or provider) a first Phase-9 customer actually needs** (§46.9's risks) — this plan deliberately does not guess, since the seam supports any of them being built first, in whatever order real sales/compliance conversations surface.
5. **Platform-support tooling timing (§15.2)** — resolved by MS-2026-10-14: explicit audited support access is required in P1. Preserve actual actor identity; no invisible owner impersonation.
6. **Managed Redis/Postgres/object-storage vendor selection** (§41, §42) — this plan specifies the *shape* of infrastructure (managed vs. self-hosted, pooled vs. not) but not a specific vendor, which is a commercial/operational decision.

These original migration decisions do not authorize restarting Phase 0. Resolve remaining decisions only when they become relevant to the selected task — they are called out so they are not mistaken for oversights when an implementer reaches that point.

---

## Development Execution Protocol

This section makes `PLAN.md` directly usable as an operating manual by future Claude/Codex engineering sessions during implementation. It governs *how* work proceeds from here — it does not add, remove, or reinterpret the architecture in §1–§45, phase contracts in §46.0–§46.9 or the explicit MS-2026-10-14 amendments and P1–P3 criteria. Where anything below appears to conflict with the governing architecture (including its explicit dated amendments), that architecture governs, and the conflict itself should be raised per rule 11, not silently resolved either way.

**1. Read `PLAN.md` first, every session.** Before touching code, an engineering session reads this document — at minimum the phase it has been assigned (§46.x), that phase's dependencies, and the architectural sections it references. A session that has not done this has not met the bar for starting work, regardless of how confident it is about the codebase from other context.

**2. Scope discipline: work only the explicitly selected phase, module, or task.** The approved managed-service readiness milestone is a selected scope: `continue` advances in live-board order through eligible R1–R5 and P1–P3 tasks without asking to reauthorize routine steps. Respect dependencies, product decisions and external-action boundaries; stop at milestone closure. Otherwise, a session is handed one of: a phase (e.g., "implement §46.4"), a module (e.g., "the `knowledge/` module"), or a specific task within a phase's task list (e.g., "§46.6, PR 1, task 3"). It does not expand that scope on its own initiative.

**3. No opportunistic unrelated changes.** Seeing a real improvement in a module outside the current scope is not sufficient justification to change it. Note it (in the session's final report, rule 14, or as a follow-up suggestion) instead of acting on it. A bug fix inside the module actually being worked is fine; refactoring a neighboring module "while I'm here" is not.

**4. Before writing code for a selected module, restate its contract from `PLAN.md`.** Concretely, identify: what it owns (its section in §6's module table, or the relevant model/contract section), its public contract (the interface it exposes — e.g., `ChannelAdapter` from §19.1, `ToolRegistry` from §23.2, `JobQueue` from §25.1), what it may depend on and what must not depend on it (§5.7's dependency-direction diagram and the per-module "depends on" column in §6), the tests required before/alongside it (§33/§34, plus that phase's own "Tests first" list), and its Definition of Done (the selected milestone task criteria and the applicable items from that phase's "Acceptance criteria" list, verbatim — not a paraphrase of them). This restatement does not need to be a formal artifact; it needs to actually happen before implementation, not be skipped because the module "seems obvious." When the selected scope is a phase — or a task within one — that introduces or changes a workflow a user, administrator, agent, customer, or external provider interacts with, also settle at this point how that workflow will be verified in a real run (see "Browser and Live Workflow Verification" below), so it is scheduled rather than discovered missing at closure. The standing instruction for every such phase:

> If this phase has a meaningful user-facing workflow, use available browser/computer-use tooling to exercise it end-to-end before phase closure. Do not stop at API/unit/integration tests when the actual product can be run and interacted with.

**5. Follow the dependency direction already fixed in `PLAN.md`.** §5.7's rule — application/domain modules depend on contracts, never on concrete SDKs; infrastructure adapters never depend back on application/domain modules — is not a suggestion. A session that finds itself wanting to import, say, `ai/` from inside a `ChannelAdapter` implementation has found an architecture problem to raise (rule 11), not a shortcut to take.

**6. Tests first, wherever `PLAN.md` says so.** Every phase's "Tests first" section is a required ordering, not a nice-to-have: for tenant isolation, security regressions, and contract tests specifically, the test is written and confirmed failing against pre-change code before the change is made (this is already how §46.2's isolation-matrix rollout and §46.0's auth-bypass regression suite are specified — this rule generalizes what those phases already require to every phase).

**7–8. Build and test modules independently; integrate incrementally through defined contracts.** The development philosophy for all implementation work under this plan is:

> **Build independently. Test independently. Integrate incrementally. Verify globally at the end.**

A module is developed and unit/contract-tested against its own interface (using the fakes named throughout this plan — `FakeAIProvider`, `FakeJobQueue`, `InMemoryRealtimeBus`, a fake `ChannelAdapter`, etc., per §34.1–§34.2) before it is wired into the modules that will actually call it in production. Integration then happens through the public contract already defined for that module (§6's table, the interface sections in §19/§21/§22/§25/§26/§27), not through a bespoke, one-off wiring path invented to save time.

**9. Run the right test layers after every integration, not just at the end of a phase.** After wiring a module into its real caller: run that module's own unit/contract tests, the relevant integration test(s) from §34.3, tenant-isolation/security tests where the module touches tenant-owned data or a trust boundary (§33), and the full regression suite where the change is broad enough to warrant it (judgment call, but bias toward running it). **Do not postpone all integration to the end of a phase, and do not postpone all of the above to the end of implementation.** Modules are integrated continuously as they are completed, each time through the layers just listed. The final full-system verification (rule 15) is for proving the complete, already-integrated system end to end — it is not the first time independently-built pieces meet each other.

**10. A module or phase is done only when all of the following are true, not when the code merely compiles:**
   - Its required tests (rule 6) pass.
   - Its phase's acceptance criteria in `PLAN.md` (§46.x) pass, verbatim — not "close enough" or "the spirit of it."
   - Its integrations work through the intended contracts (rule 8), verified by the integration tests that exercise them.
   - No known tenant-isolation or security regression exists as a result of the change (§8, §32, §33).
   - Where browser and live workflow verification applies (see "Browser and Live Workflow Verification" below), it has been performed and recorded (or, where browser/computer-use tooling was unavailable, handled as that subsection specifies) — passing automated tests alone do not satisfy this rule for a user-facing or externally-integrated workflow.

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

### Browser and Live Workflow Verification

> **Automated tests prove components and contracts. Browser/live execution proves the assembled user workflow.**

Automated tests are necessary but are not sufficient acceptance evidence for user-facing or externally-integrated workflows. Phase 7 showed why: running the assembled product for real exposed defects that the unit, integration and security suites had not caught — `/widget.js` was redirected to `/login`; Web Chat replies produced in the worker process never reached the widget served by the web process; channel adapters were never registered inside the worker; runtime audit logging was missing; and an escalation path detached a Web Chat conversation from its connection (§46.7's implementation record). Each was a property of the assembled product — routing, process boundaries, runtime wiring, feature interaction — rather than of any one component.

Whenever a phase introduces or changes a workflow that a real user, administrator, agent, customer, or external provider interacts with, the implementation phase must include a real execution of that workflow using the application itself. Examples:

- signup, login and onboarding;
- dashboard configuration;
- business/tenant switching;
- channel setup and credential configuration;
- Web Chat widget installation and interaction;
- customer conversations;
- agent/human handoff;
- approval workflows;
- knowledge management;
- tool/action configuration;
- externally reachable webhook flows;
- production channel integrations;
- any flow whose correctness depends on routing, cookies, CORS, public assets, redirects, browser behavior, worker/web-process interaction, deployment/runtime configuration or process boundaries.

Where browser/computer-use tooling is available, the implementing agent uses it directly instead of asking the developer to click through the workflow manually.

For a browser-verifiable workflow, the agent:

1. starts the actual application and the required supporting services/processes with production-equivalent configuration where practical (for this codebase: a production build with the worker running as its own process, §25.3/§5.8, rather than a single-process dev server);
2. opens the application with browser/computer-use tooling;
3. performs the workflow through the real UI or public product surface;
4. does not substitute direct API or database calls for a UI action where a production UI exists for that step;
5. observes the visible UI state, relevant network behavior, worker/web-process interaction, persisted state, audit/logging state (§38), and relevant external-provider behavior;
6. verifies the outcome against the phase's acceptance criteria;
7. treats any defect found as an implementation finding belonging to the owning phase (a defect that shows the plan itself is wrong is handled under rule 11, not fixed silently);
8. adds a regression test where practical, makes the smallest fix, and repeats the browser/live workflow;
9. records the exact workflow exercised and its result in the phase's implementation record, with the contents listed under "Phase completion" in the Git and Commit Workflow below.

This complements, and never replaces, automated verification:

- unit tests prove local behavior;
- contract tests prove abstractions (§34.1);
- integration and tenant-isolation/security tests prove boundaries, persistence and isolation (§33, §34.1);
- browser/live workflow verification proves that the assembled product actually works from the user's perspective.

It is a per-phase activity: it does not replace §34.3's automated named workflows or rule 15's final full-system verification. It is not required for a purely internal or mechanical phase with no meaningful user-facing workflow (for example, a module reorganization such as §46.3) unless that phase's acceptance criteria explicitly require it.

**External providers.**

- Use the provider's real sandbox/test environment when credentials and an appropriate environment exist.
- Normal CI may continue to use fakes; credential-gated live tests remain a separate suite (§34.2).
- Never print or commit secrets (§37.3).
- If an external dependency prevents required live verification, follow the verification-selection and external-blocker policy above: prepare the test path, record the missing dependency and leave that criterion open while continuing independent authorized work. Required acceptance/release remains blocked; routine development does not. Preserve explicit dated owner waivers without relabeling them passed.

**When browser/computer-use tooling is unavailable.** Missing tooling never turns an API, integration or unit test into browser verification, and a browser run that did not happen is never reported as having passed. As with external providers, an unavailable capability does not justify pretending the corresponding live acceptance criterion passed. Three cases are distinguished:

1. **Tooling available** — the agent performs the workflow itself, as above.
2. **Tooling unavailable, and browser/live verification is an explicit acceptance requirement** of the phase or workflow — the corresponding criterion stays incomplete and the phase is not tagged complete.
3. **Tooling unavailable, and browser/live verification is supplementary only** (the workflow qualifies under this subsection, but the phase's acceptance criteria do not explicitly require a browser run) — the missing run is recorded as a verification limitation, and the phase may be completed only if every acceptance criterion it actually requires still passes.

In cases 2 and 3 the agent also performs all automated and non-browser verification that remains possible, prepares or documents the exact browser workflow still to be executed (steps, environment/topology, and what to observe), and records in the implementation/acceptance record that browser/computer-use capability was unavailable.

### MVP Browser Acceptance Suite

The release-level browser regression suite: rerun it, in full, before any major release or milestone tag, and after any change that touches routing, authentication, channels, the worker, or the widget. It proves what only the assembled, running product can — routing, cookies, CORS, public assets, UI state, the web/worker process boundary, persisted state across reloads and restarts, and tenant isolation *as a user experiences it*. It complements, and never replaces, the automated suites (unit, contract, isolation, `tests/e2e/mvp-acceptance.test.ts`). Current results are dated in the live-plan baseline and [implementation history](docs/implementation-history.md#phase-9); this specification does not itself claim a pass. Live J16 is separate from the 16-script runner. The verification-selection policy above governs focused development loops and required live checks.

**Running it.** `scripts/acceptance/run-all.sh` runs the full suite in its real dependency order (not raw numeric order — J03/J03b's cross-tenant attack surface needs data J04/J05/J06b/J08/J11 create first; see the script's own header comment) and exits non-zero the moment any journey's assertions fail. Every journey script asserts its own acceptance-critical outcomes via `lib.cjs`'s `assert()`/`finish()` and fails loudly (non-zero exit) rather than only printing evidence for a human to read. Chromium is resolved automatically (`CHROMIUM_PATH`, else `puppeteer`'s own cached build). Set `ACC_DB` explicitly; the legacy `sql()` fallback is unsafe to rely on. If the DB is not the compose Postgres, set/check `ACC_PSQL` for that same isolated DB. J09/J10 counts retained rows, so use a fresh acceptance database per full run.

**Topology (production-equivalent; record any deviation).** Use an isolated worktree, its own dependencies/secrets and a fresh throwaway database with migrations applied and no Default Business. Set `ACC_DB`, `DATABASE_URL` and `DIRECT_DATABASE_URL` to that same acceptance target before migrations/startup, with matching `ACC_PSQL` if needed. Build with `NEXT_PUBLIC_APP_URL=http://localhost:3100`; run production web on :3100 and a separate worker, with the local LLM stand-in on :4010 and customer origins :4020/:4021 (additional fixture host :4022). Confirm these ports are available. `scripts/acceptance/start-all.sh all` starts the topology; `run-all.sh` supplies dependency order. Keep fixture identities/profiles isolated and follow current proxy configuration: authenticated dashboard requests use session buckets; unauthenticated traffic still has address-based limits. Stop only verified run-owned PIDs; never stop the live checkout's worker.

**Browser tooling.** Scripts drive a real headless Chromium through `puppeteer-core` (`CHROMIUM_PATH` to override) with separate browser profiles per business owner and isolated contexts per anonymous visitor. This is the agent using browser tooling directly (case 1 above); it is a scripted browser, not the interactive computer-use browser — a session that has the latter should use it for the exploratory pass and keep these scripts for the repeatable one. UI steps go through the real UI wherever a UI exists; the few steps done through the authenticated API or the database are marked **[API]** / **[DB]** below.

**LLM.** Use `scripts/acceptance/llm-standin.cjs` for routine deterministic browser regressions, even when real credentials are available. It answers from the prompt it receives and logs prompts under the acceptance work directory; use synthetic fixture data and protect these artifacts. This proves retrieval/scoping, prompt assembly and tool wiring, not model quality. When the verification policy selects a real-model criterion, use `ACC_REAL_AI=1` and the documented provider/model/key variables, confirm the intended endpoint (no stand-in override), and run cases whose assertions are valid for a real model. Record the exact provider/model and outcomes. Stand-in and real-model runs are separate evidence; credential availability alone does not require repeating every browser journey with a real model.

**Journeys** — current requirements; results belong in dated evidence records:

**Managed-service extensions (P1–P3/R4):** the numbered journeys below describe
existing flows; keep their isolation/delivery guarantees while updating J01 from
customer AI configuration to verified signup and platform-managed provisioning,
and J13 staff creation to the invitation flow. Add named journeys for the P1 role/
channel matrix and support revocation, P2 managed-policy/limit recovery, and P3
verification/reset/invitation/resumable activation. Include them in the full runner
when implemented; do not claim the old 16-script pass covers these additions. Test
platform policy setup through its real UI, using stand-in credentials only in isolated
local runs; customers must not enter an AI key even in the updated browser tests.

1. **J01 Signup.** *Purpose:* two independent businesses via the real wizard. *Steps:* `/setup` → account → profile → AI config → dashboard, twice (bakery, e-scooter shop), separate profiles. *Expect:* each gets its own Business, owner User+Membership, `TenantPlacement` (shared-default), `BusinessConfig` (encrypted AI credential ref), 6 `ToolPolicy` rows, `business.created` audit row; no Default Business used; dashboard renders with a clean console. *Phases:* 1, 2, 7. *Creds:* none. *Auto:* yes.
2. **J02 Auth/session.** *Steps:* refresh, navigate 7 protected pages, Sign Out via the avatar menu, log back in through `/login` (wrong password first), unauthenticated + forged-cookie access to pages/APIs. *Expect:* cookie cleared on sign-out; APIs 401, pages → `/login`; wrong password → "Invalid credentials"; `a.b.c` and wrong-secret JWTs → 401; `/widget.js`, `/api/health` stay public; each session sees only its own user; cookie `HttpOnly; Secure; SameSite=Lax`. *Phases:* 0, 2. *Auto:* yes.
3. **J03 Tenant isolation.** *Steps:* from B's real session, use A's ticket/conversation/customer/knowledge/category/webchat-connection/action ids (and A from B) with GET/PUT/PATCH/DELETE/POST incl. reply-injection, transfer, GDPR export/delete, token rotation, approval, realtime subscribe; `?businessId=` and body `businessId` injection; positive controls with the owner's own session. *Expect:* every attempt 404 / no-op, no data changed (verified in Postgres), controls succeed, B's conversations page never shows A's data. *Phases:* 1, 2. *Auto:* yes.
4. **J04 Knowledge + grounding.** *Steps:* create a category and an entry with a unique code per business through `/knowledge`; ask through each business's widget, including a question that names the *other* business's code. *Expect:* every prompt sent to the model contains only its own business's code; replies use only it; record retrieval mode. The worker indexes each UI-created entry: a 1536-d embedding with provenance, a completed `index-knowledge-entry` pg-boss job, and no raw vector exposed by the API. *Phases:* 2, 4. *Auto:* yes.
4b. **J04b Semantic knowledge.** *Steps:* the owner creates a policy entry through `/knowledge`. A visitor on A's site asks a question that shares no keyword with it (asserted on the fixture). Business B asks the same question. The owner edits the entry through the UI and A's visitor asks again. The owner then deactivates it and A's visitor asks a third time. *Expect:* the entry reaches A's prompt and reply only through its stored embedding; B never sees it; the edit is re-indexed and only the new text is retrieved; a deactivated entry is not retrieved. *Phases:* 4, 6. *Auto:* yes; runs last in `run-all.sh`.
5. **J05 Web Chat setup.** *Steps:* `/channels` → Web Chat card → allowed origin → Create widget → copy the issued snippet onto the customer site. *Expect:* `zy_pub_` token shown once, per-business connection id/origin, `/widget.js` served publicly (200, no redirect, `application/javascript`, cache `public, max-age=300`), independent config per business. *Phases:* 5, 7. *Auto:* yes.
6. **J06 Customer conversation.** *Steps:* anonymous visitor on the embedded site sends messages, reloads, sends again; a second visitor; the same visitor after clearing only the conversation key (Business A); the basic flow for Business B. *Expect:* fast ACK; grounded reply; Customer + Conversation created with `metadata.channelConnectionId`; reload restores history and continues the same conversation; second visitor = separate Customer; same visitor = same Customer, new Conversation. *Phases:* 5, 7. *Auto:* yes.
7. **J07 Web/worker boundary.** *Steps:* stop the worker, send a chat message, watch, restart. *Expect:* ACK returned, persisted receipt `received`, pg-boss job `created`, **no reply and no assistant message while the worker is down**, reply appears after restart. *Phases:* 5, 6, 7. *Auto:* yes.
8. **J08 Tool execution.** *Steps:* visitor asks to open a ticket; owner opens `/tickets` and `/api/actions`. *Expect:* ToolRegistry path, `ToolPolicy` allows, `ActionExecution` `succeeded` (`requestedBy: ai`, key from the provider's tool-call id), ticket visible in A's dashboard, B sees none. *Phases:* 6, 7. *Auto:* yes.
9. **J09 Durable follow-up.** *Steps:* visitor: "follow up with me in 1 minute". *Expect:* `ActionExecution` `scheduled` and a pg-boss `send-followup` job with `start_after` ≈ +1 min immediately; worker sends; visitor sees the message; action ends `succeeded`; no direct DB edits. *Phases:* 6. *Auto:* yes.
10. **J10 Worker restart.** *Steps:* schedule a follow-up, SIGTERM the worker, confirm web up, let the job go overdue, restart. *Expect:* clean drain; web unaffected (health/login/`/widget.js` 200); job still pending while down; sent once after restart; exactly one message and one `succeeded` action per follow-up. *Phases:* 6. *Auto:* yes.
11. **J11 Human handoff.** *Steps:* visitor asks for a manager; owner filters `/conversations` to Escalated, opens it, replies; visitor's widget; refresh. *Expect:* conversation `escalated` by the product's own confidence logic; owner sees it and its messages; reply `201`, reaches the customer via Web Chat, persists across refresh; the other business gets 404. Verify the current dashboard update path and persistence on refresh; distinguish a manually triggered handoff transport test from autonomous AI escalation. *Phases:* 2, 7. *Auto:* yes.
12. **J12 Widget credentials.** *Steps:* HTTP attack matrix (forged/empty token, A's token on B and vice versa, wrong/no/evil origin, nonexistent connection, foreign conversation id write/read/stream, wrong visitor id, widget token as Bearer / `X-API-Key` / cookie against 4 admin APIs, preflights), then rotate A's token through the dashboard and re-test with the old and new embed on the customer site. *Expect:* all rejected (403/404/401), no foreign-origin CORS grant, nothing written cross-tenant; after rotation old → 403, new → 200, B and the owner session unaffected, a stale embed fails visibly ("Chat is currently unavailable"). *Phases:* 5, 7. *Auto:* yes.
13. **J13 Approval-gated action.** *Steps:* set `ToolPolicy.requiresHumanApproval` on `create_ticket` for B through the tool-policy UI; visitor asks for a ticket; a viewer (created via **[API]** `/api/admin/users`) logs in through the UI and tries to decide; owner approves through the approvals UI; repeat and reject. *Expect:* `pending_approval` with no ticket; viewer 403; approve → ticket exactly once (second approve 409); reject → `cancelled`, no ticket. *Phases:* 6. *Auto:* yes.
14. **J14 Automation.** *Steps:* `/automation` → create an Auto Reply rule on "opening hours"; ask that, an unrelated question, and the same in B. *Expect:* rule 201 and active; matching message gets the rule's exact reply, others still go to the AI, B unaffected. *Phases:* 6. *Auto:* yes.
15. **J15 Runtime sweep.** *Steps:* fetch public assets and headers; visit every dashboard page on the production build capturing console/network, including `/settings`, where the owner edits the General tab's business name through the real form and saves it; check cookie attributes and reload behaviour. *Expect:* `/widget.js` public, no dev-server-only paths or `localhost:3000` in the script, no console errors or 4xx/5xx from any page (a cached `304` counts as loaded); `/settings` loads (not 501) and the edit persists across reload. *Phases:* 0, 2, 7. *Auto:* yes.
16. **J16 Meta WhatsApp (live).** *Steps:* register `https://<host>/api/channels/whatsapp-cloud/webhook` on a Meta app, connect a real number through the product, send a real WhatsApp message. *Expect:* signature validated, `phone_number_id` → connection → tenant, dedup, fast ACK, worker, grounded reply delivered to the sender; measure end-to-end latency. *Phases:* 5, 7. *Creds:* the connection's own encrypted App Secret, platform `META_WEBHOOK_VERIFY_TOKEN`, a phone number id + access token, a public HTTPS URL, and an authorized human sender. Preserve the October 11 historical second-number waiver; it is not a pass or a blanket waiver for future delivery. *Auto:* **no** (needs a human sender).

**Guarantee map.** Phase 0 — J02, J15. Phase 1 — J01, J03. Phase 2 — J02, J03, J11. Phase 3 — no user-visible surface; exercised only indirectly (every journey runs on the reorganised modules). Phase 4 — J04, J04b (retrieval scoping, per-business provider config, stored-embedding indexing and ranking; a live-model criterion stays open when the stand-in is used). Phase 5 — J05, J06, J07, J12, J16. Phase 6 — J07–J10, J13, J14. Phase 7 — J01, J05, J06, J11, J12, J16.

**Rules for a run.** Record topology, deviations and which LLM was used. Do not substitute API or DB calls for a UI step that has a UI. Any defect: reproduce, name the owning phase, add a regression test that fails first, make the smallest fix, commit it as post-release hardening (never rewrite phase commits), and re-run the journey. A journey that could not run is reported as not run.

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
- browser/live workflow verification has been determined to apply or not to apply (see "Browser and Live Workflow Verification" above) and, where it applies, has been performed and recorded as specified below (or, where browser/computer-use tooling was unavailable, handled as that subsection specifies),
- working tree contains no accidental phase leftovers,
- deviations are documented.

Before tagging a phase complete, determine whether browser/live verification applies. If it does, the phase's implementation record must include:

- the environment/topology used (which processes, build mode, database, configuration),
- the workflow executed,
- the browser/UI actions performed,
- external-provider involvement, if any,
- the observable result,
- defects discovered and fixed,
- remaining external blockers.

A phase whose acceptance criteria require real-provider verification that has not occurred is not tagged complete; the open criterion is recorded as open.

### Tags

Use milestone tags such as:

```text
phase-0-complete
phase-1-complete
phase-2-complete
mvp-v1
```

Only tag after the corresponding acceptance criteria pass and the phase-completion checks above — including the browser/live verification determination — are done.

### Agent behavior

Future Claude/Codex sessions must:

- inspect current Git status before modifying code,
- never assume the working tree is clean,
- preserve unrelated local work,
- show staged diff/status before committing,
- never push unless explicitly instructed,
- never force-push or rewrite shared history unless explicitly approved.

**Architecture change control remains in force.** Future changes to the architecture, module boundaries, data model, security design, or phase roadmap should originate from concrete findings surfaced during implementation (per rule 11 above), not from further speculative redesign in the absence of code having been written against it.
