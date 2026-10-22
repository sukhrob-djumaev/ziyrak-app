# Managed-service readiness — finished work packages (R1, R3, P1, P2, P3)

Archived out of `PLAN.md` on 2026-10-22; text unchanged. These packages are closed (see the live board); their status
lines below are as of the date of each entry and may read 'not merged' or 'open' where later work closed them.
The live summaries in `PLAN.md` are authoritative for current status. Do not read this file whole; grep for the package.

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
- **Result (2026-10-22, branch `p3-onboarding`; not merged, not deployed):** owner approved the proposal
  (`docs/p3-accounts-onboarding-proposal-2026-10-22.md`). Implemented per
  `docs/p3-accounts-onboarding-implementation-2026-10-22.md`. Evidence: tsc/lint clean; unit/real-PG 176 files /
  1748 passed / 23 skipped (isolated DB); independent agent security review, confirmed findings fixed tests-first;
  fresh-DB frozen full browser run on candidate `01d9b59`, all 28 journeys passed (J01 signup/verify/sign-in through
  the real wizard and captured mail, J23-J26 via invitations, J27, new J28), stand-in AI, platform mail captured to
  a file, headless system Chrome. Limits: agent reviews not human; no windowed-browser run; no real provider through
  the browser.
  **Open items (owner decisions 2026-10-22):**
  - *Operator invitations: deferred to a follow-up.* Reason: they add a new account-creation surface (a platform
    role created from an emailed link) that needs its own tests-first work and its own security review. Super admins
    still create operators with a chosen password (the P1 flow); the workspace-invitation path never grants a
    platform role.
  - *Controlled real mail delivery check: NOT RUN (skipped by the owner for now).* Email delivery is NOT claimed
    ready; every mail result above is the local capture adapter. Retry condition: SMTP sender settings
    (`PLATFORM_SMTP_*`) in the environment and a real recipient mailbox.
  - Owner merge approval for the branch.
