# P1 stream authority slice

Authority: PLAN P1, identity/tenancy/RBAC §§7–9,12,14–16, realtime §26.
Identity owns authenticated current authority; tenant repositories own resource
queries; route/identity admission consumes those contracts and the existing RealtimeBus. Transport and bus remain free of domain persistence dependencies. No SDK,
raw tenant-data query or fabricated owner belongs in the stream route.

Applicable P1 acceptance text:

> Restricted users cannot recover excluded channel data through related resources,
> counts/search/exports, attachments or realtime. Recheck revocation for long-lived
> subscriptions and delayed user-initiated work; system jobs retain only their defined
> operation, not a reusable human support grant.

> Verification: tests first for authorization/isolation regressions; real isolated
> Postgres across two workspaces and two channels, role/resource matrix, grant audit/
> expiry/revocation, active streams, queue execution and migration cases. Browser
> journeys must use each actual role, workspace selection and denied direct URLs/API
> calls. Obtain independent security review; preserve the full-suite rerun triggers.

This bounded slice reauthenticates the original dashboard request before every
queued emission and heartbeat, pins the original authority identity/workspace and
intersects current resource scope/permissions with its connection-time ceiling.
A lost identity/authority or failed lookup ends the stream without private data.
A hidden resource/event is discarded while an otherwise valid stream continues.
Events are hints; authoritative resource lookups provide a minimal named projection,
not arbitrary bus payloads. Unknown notification kinds have no resource contract
and deny. Pending approvals carry the saved action identifier.

Public widget streams require token/origin/active connection plus the visitor's
own conversation, repeat those checks before each event/heartbeat and expose only
persisted customer/assistant message fields. The public widget includes visitorId.
Cancellation/abort closes subscriptions, timers and pending emission. Retirement
prevents late private frames. Polling remains the correctness path.

Tests first: two-workspace/two-connection exclusion, changing membership/scope,
role and API-key/issuer/session revocation, authoritative mismatched message IDs,
unknown notifications, widget wrong visitor/rotation/inactive origin and retired
conversation, heartbeat and cancellation. Real PG plus a controlled event source
proves route enforcement; the bus contract has separate deterministic coverage.
Fresh assembled production/full browser checks and actual workspace switching
remain required before P1 closes. Support grants and delayed authority are separate
unfinished integrations; this slice cannot certify them.

## Executed deterministic evidence

- Fifteen real-PG stream enforcement regressions failed against the foundation
  before implementation. Additional tests first reproduced inactive-workspace
  widget access, the real pending-approval notification envelope, retirement during
  the first projection and revocation during the second private projection.
- Current focused seven files68passed, including19 real-PG stream cases and four
  controlled cancellation/admission tests. Full143files1277passed/23 optional skips;
  signup-seeded74files770passed, sequential pool5/maxWorkers3 on the separate
  isolated P1 test/signup databases. Type and strict lint passed.
- Independent source review confirmed the identified findings repaired and no
  further confirmed finding in its bounded slice. Reviewer did not execute checks.
- Public widget asset mutation failed to invalidate the acceptance fingerprint in
  a new regression; adding public assets to the source digest fixed it. Eight
  runtime/safety checks passed, followed by the full suite above.
- First broad run had one historical cross-business stream fixture omitting the
  newly required visitorId; its403 admission rejection preceded the intended
  foreign-resource404 assertion. Supplying the real fixture visitor preserved the
  foreign-resource test; the final full run passed. No access-denial relaxation.

## Executed browser evidence

New production candidate in the stopped-then-rebuilt isolated R1 runtime checkout,
parent ddfb28b plus frozen dirty stream source, fresh
`ziyrak_acceptance_p1_stream_20261015`, own Redis6381/prefix, standalone worker,
stand-in AI, Chromium and separate customer origins. Existing17 browser journeys
passed. J18 initially failed because a secondary browser context used network-idle
navigation with an intentional long-lived stream; explicit page/UI readiness fixed
that harness defect and J18 passed. J19 initially stopped at an unhandled expected
rotation confirmation; the script now handles only that exact task-owned dialog.
J19 then passed after the expected-dialog handling and exact owned-browser cleanup.
It observed the actual worker's reply via Redis in the widget stream with only
id/role/content/createdAt, matching the visible reply; the dashboard received only
conversationId/messageId/role. Actual UI token rotation ended the old widget stream;
actual UI sign-out ended an independently retained stale dashboard subscription.
No provider fixture/recipient-visible live-delivery claim.

All19 journeys executed and passed on this same frozen product source: the first17
through run-all, corrected J18 and J19 through ordered run.sh continuations. The
initial full-run command failed at the harness defect; it is not reported as a
successful uninterrupted19-script command. Final product build5Wsu11zRYbUiAIFjLzkmu,
parent ddfb28b plus dirty source digest
f72cadfbe44d00cc5a79041c54a07b75914df590c50f9075b03333671700ef64.
This digest matches the P1 development source being committed. Evidence/manifest
under R1 candidate `scripts/acceptance/.work/p1-stream-20261015`; command logs
`/private/tmp/ziyrak-p1-stream-browser.log`, `ziyrak-p1-j18-browser2.log` and
`ziyrak-p1-j19-browser3.log` in the same temporary directory.

A failed dialog run left an owned browser. The lead initially called the identity
comparator with one argument, so the cleanup check missed it. Correct saved/current
PID/birth/cwd comparison identified and stopped that exact browser; prior run
identities were rechecked. Final stop-all plus corrected comparison found
remainingOwned[]. No process-name kill, active-profile lock deletion or live service
change. Product source/build stayed frozen; only new harness scripts were corrected.

P1 remains incomplete: platform/support grants, durable authority, complete actual
role/resource UI matrix and final assembled-candidate/full-suite gates remain open.
Future candidate changes require the plan's full rerun; this is a bounded slice.
