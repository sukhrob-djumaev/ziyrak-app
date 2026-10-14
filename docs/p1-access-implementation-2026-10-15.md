# P1 implementation and criterion evidence

Status: first boundary slice implemented; P1 foundation/full acceptance open.
Authority: [explicit contract](p1-access-contract-2026-10-15.md) and PLAN P1.
Parent2adfc1b, isolated P1 checkout, own dependencies/no live environment copied.
Containing code commit is discoverable through Git, not predicted here.

## First slice

Workspace team update/remove guards deny generic ownership changes, API-key role
management and global account name/password changes. They validate all input before
membership writes, guard target role at mutation and return404 if a concurrent
promotion removes the authorized target. UI editing sends only the workspace role;
new secured account provisioning retains initial account fields.
Inbound resolves same-contact threads by connection identity, validates explicit
real-channel thread ownership/contact before preparation, and preserves authorized
internal API continuation through a tenant-scoped lookup. Unknown/foreign IDs404.

### Executed evidence

- Tests before changes: two new real-PG suites7failed/1passed against parent.
- Requested independent review regressions: actual-route API-key PUT/DELETE deny;
  cached target read followed by promotion cannot mutate/delete owner. The race
  error-mapping test initiallyfailed (500), then passed with controlled404.
- Focused five files21passed: team, connection ownership, internal chat, conflict,
  provider-signed phone/SMS pipeline with controlled provider/AI fixtures.
- Full134files1194passed/23 optional Redis skips; type and strict lint passed.
- Independent source/security review: no confirmed issue, including final late recheck.
  Reviewer did not run checks. No platform/restricted support workflow enabled.
- Existing phone test lacked creation's ownership stamp; corrected fixture to
  reference its actual test connection. No insecure legacy inference introduced.

### Open verification

First slice code1322b03 was integrated into isolated runtime candidate80b5f33.
Production buildwLh2ej40gDoE5_A4LJVCH and all17 browser journeys passed on the fresh
`ziyrak_acceptance_p1_slice_20261015` database; manifest/evidence are under
`.work/p1-slice-20261015` in the R1 candidate checkout. Owned topology stopped and
identity verification found no remaining owned process. These results apply to
that first slice, not the later uncommitted foundation. Provider fixtures
prove local routing/persistence, not real recipient delivery. R4 retains affected
provider checks. No P1 criterion closed on these counts; foundation, every exposed
resource path, mandatory support audit/lifecycle, actual roles/UI and full browser
acceptance remain required. No live bootstrap/migration or deployment.

## Foundation implementation checkpoint (P1 acceptance remains open)

Current P1 working tree adds explicit selected-workspace resolution, normalized
membership/API-key connection scope, separate platform assignments/support-grant
schema (no support console/bootstrap exposed), scoped nested reads/counts/filter
predicates and guarded callback transactions. Applied only to isolated P1 test DB.
Legacy platform-admin flags confer no new authority; unclassified API keys deny.

Tests-first query regressions exposed related-history predicate/counter inference
and raw/foreign batch transaction escapes. Additional regressions reproduced
contact-only erasure, retention FK partial deletion, deferred transcript/tool
completion and cached erased receipt replay. Sequential and controlled deferred
cases now pass. Scoped short writes use a transaction-scoped business advisory
gate, Read Committed and fresh monotonic retirement checks on the actual mutation
transaction. AI/provider calls stay outside; inbound helpers reuse their guarded
transaction and realtime notification waits for commit. Workspace writes serialize;
timeouts roll back and fail closed. Dedicated migration still requires quiescence;
no cross-database atomicity claim. Independent read-only design and source reviews
supported this protocol after the confirmed findings were repaired. Reviewers did
not execute tests; streams, delegated authority and support remain outside their
foundation conclusion.

The actual account entry now selects a newly created workspace, clears stale
selection on multi-workspace login, lists only the person's current legitimate
memberships and requires explicit selection. Switching reloads the document to
clear old tenant views/subscriptions. RSC and request resolution share the selected
workspace resolver. API keys retain their own workspace, explicit scope, recorded
issuer ceiling and revocation checks. Generic team delegation requires a full
workspace human context; nested key-scope creation validates the real connection.

Related-resource filters, nested selection/counts, predicates, cursors and grouped
counts are scoped without changing aggregate result shapes. Raw SQL, foreign batch
transactions and extension-client escape deny. Parent references cannot detach or
cross connection ownership. Unknown conversation ownership denies restricted access.

Retirement is separate from workflow cancellation. Erasure includes completed and
cancelled cached private work, contact-only receipts and unbound delivery operations.
Discovery reuses the customer resolver's read-only identity precedence through the
actual transaction, pages receipt payloads in100-row batches and preserves another
customer's established thread lineage. Retention retires work and clears action
references before deleting conversations in200-row transactions. Deferred AI/tool
checkpoints fail closed after retirement; approval/rejection admission uses CAS.

### Executed foundation checks

- Tests first reproduced query/cursor/count escapes, key/issuer widening, unsafe
  parent moves, deferred completion/start admission, erasure aliases/cancellation,
  approval races and retention FK failures. Focused cases passed after repair.
- Final full suite:141files1253passed/23 optional skips, real isolated
  `ziyrak_p1_test_20261015`, pool5 and maxWorkers3; log
  `/private/tmp/ziyrak-p1-foundation-full5.log`. Type and strict lint passed.
- Final lifecycle suite22passed, including cancelled cached PII. Independent final
  privacy source recheck confirmed that finding closed with no further confirmed
  finding in its inspected boundary.
- Signup-seeded rerun:73files751passed on separately migrated isolated
  `ziyrak_p1_signup_test_20261015`, pool5/maxWorkers3; log
  `/private/tmp/ziyrak-p1-foundation-seeded2.log`. Earlier parallel full/seeded runs exhausted
  Postgres connections and shared fixture state; they are failed runs, not acceptance
  evidence. Subsequent runs are sequential with bounded workers.
- Three migrations applied only to those isolated test databases. Existing users
  receive explicit legitimate scopes; legacy platform flags grant no new authority.
  No production migration/bootstrap, support console or restricted assignment UI.

Foundation code524fc17083d2faf2ad59d85b8d9d2666066226a8 integrated to isolated
runtime candidate ddfb28bc7b218e4953bacf7334cba2fc9d1a6d22. Production build
wGZWKxtJLXDsM9Bpq5mC2 and fresh all17 browser journeys passed on
`ziyrak_acceptance_p1_foundation_20261015`; source digest
7364792ea1f6a5f5c5aa568914dfa945c82d83f8fed89d29081b6270981d06dc.
Manifest/evidence: R1 candidate `.work/p1-foundation-20261015`; browser log
`/private/tmp/ziyrak-p1-foundation-browser.log`.

Native Chrome exploratory run (private window, local production app) verified:
multi-workspace login opened the actual choice page; choosing the second workspace
as viewer loaded that workspace's dashboard/account label; its Settings UI showed
insufficient permissions; Switch workspace returned the picker; selecting the owner
workspace reloaded its own dashboard/account label and restored Approvals access.
The second viewer membership was a documented synthetic DB prerequisite because
joining an existing account is not exposed until P3 invitations. UI login and
selection used the real UI. This is owner/viewer switching evidence, not the entire
P1 role/support matrix. The private test window and all owned runtime processes
were closed; identity verification reported remainingOwned[]. No real-provider claim.
P1 still requires fresh per-event stream checks, delayed-work provenance,
secured platform provisioning/support grants and their actual role/browser matrix.
Followup targets supplied only in tool arguments also need durable parent binding
before the delayed-work slice can close. Do not expose this partial candidate live.
