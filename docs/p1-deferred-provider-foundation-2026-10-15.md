# P1 explicit deferred provider-origin foundation

Implementation onf2c0262; containing commit identifies source. Internal provenance
helper only: no queue producer, worker/dispatch authorizer or adapter invocation.

Tenancy validates strict v1 server-created receipt→inbound operation→conversation→
connection references through scoped repositories; platform returns only active
workspace/connection ID/type, never credentials. Capture requires actual AI/work
parents, no human/support/delegated authorization and preparing delivery. Missing
or failed human/key provenance cannot fall back to this provider branch.

Receipt/envelope workspace, type, source/connection/external ID and correlation
must agree. Inbound operation must have the exact receipt operation key, no action
parent, exact conversation/connection/channel/contact and a known live state.
Conversation is nonretired with the exact ownership stamp; connection/workspace
remain active. Refresh requires a role-null system worker and cannot turn these
facts into TenantContext or generic operation permission. Provider authenticity
still rests on the existing validate-before-registration ingress invariant; the
helper is not a new cryptographic receipt verifier.

## Tests and correction evidence

Seven tests first failed at missing module; initial implementation passed16 combined
identity/provider cases. Independent source review found sending absent from valid
refresh states: a short-delay follow-up could be falsely refused while its original
reply was submitting. Added the desired realPG assertion and reproduced1failed/
6passed before allowing sending on refresh; capture stays preparing-only.

Added omitted event conversation-ID positive, worker/role/authorization denial,
cancelled delivery and action-parent cases. Explicit minimal lifecycle selects
then exposed an existing inventory omission: conversation.retiredAt was absent
from SCOPE_SCHEMA despite being a real Prisma field. Positive reads failed before
repair. An overly broad first edit hit a nested relation's inventory; independent
review caught it, and the final diff adds only conversation.retiredAt, with no
other inventory change. Final18combined cases passed with real Redis selected;
full146files/1367passed/23optional skips, signup77files/849passed, type/strict lint
passed. Independent final source-only recheck found no remaining confirmed finding;
reviewer did not execute checks.

Tests cover same-type connection substitution, every persisted chain link,
retirement/cancellation, unknown states, inactive workspace/connection, missing
stamp, strict malformed/foreign snapshots, optional event conversation locator,
actual preparing/received state, sending and uncertain/refused/completed inbound
reply states, and survival of unrelated employee removal. All isolated Postgres;
no real provider, AI invocation, tenant database cleanup or live queue operation.

Logs: /private/tmp/ziyrak-p1-deferred-provider-{red,focused,sending-red,
final-focused-redis,final-focused-redis2,final-focused-redis3,full,signup,
final-type,final-lint}.log. Earlier failures remain failures; only final results are
reported as passed. The current grant-console browser build excludes this helper.
Queue/admission/submission-time acceptance remains open. Next public seam and tests
are specified in p1-followup-dispatch-contract-2026-10-15.md; no reverse dependency
or queue-adapter authorization import is permitted.
