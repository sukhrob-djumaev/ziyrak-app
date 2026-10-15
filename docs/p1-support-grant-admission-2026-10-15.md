# P1 internal support-grant lifecycle and admission

Code6b5e3d7 on operator candidate21c269f in isolated P1. Internal service only: there is
no HTTP route, selected-grant cookie, tenant-context resolver, stream integration or
job integration. Support activation remains closed. PLAN P1/§15.2 and the existing
platform-support contract govern; this checkpoint does not complete those criteria.

## Contract and required behavior

Platform owns explicit actor-self grant records, current assignment ceilings and
mandatory audit. Identity will consume fresh admission facts and build a concrete
tenant context; normal scoped repositories continue to own customer-data access.
This service returns no tenant role/context, customer content or reusable bearer.

> Super admin can initiate a grant for any workspace; an operator only within a
> current assignment.

> Revocation/expiry/assignment removal must end access, including active streams
> and queued user-initiated work.

The latter remains an integration criterion, not proved by this service's tests.
Every future consumer must reauthorize at its real operation/dispatch boundary;
returned facts cannot be cached or reused as authority for later work.

## Implementation

- Explicit workspace, actor-self, reason, operations, resource/profile scope, expiry
  and UUID request. New grants are capped at24hours as a conservative security
  default, further bounded by current assignment lifetime. No owner/team/settings/
  credentials/tool execution operations; the current allowlist is read-only.
- Current role/control/session and active workspace are checked in the existing
  shared control transaction. Operator assignment must match actor/workspace and
  cap requested operations/scope/profile/expiry. Empty/unknown/foreign scopes deny.
- Exact normalized UUID replay is idempotent only while current authority and
  the original grant remain live. Any changed normalized payload conflicts;
  expired/revoked records never revive. Request UUIDs are lowercase before lookup,
  persistence and audit. Revocation is monotonic, actor-self or super-admin only.
- Internal use admission refreshes current role/session/grant/assignment/workspace,
  intersects issued ceilings with current ceilings, filters surviving connections
  and requires the exact operation. Role promotion cannot convert an old operator
  grant into a super-admin grant. No membership fallback or customer data bypass.
- Mandatory allowed/owned-denied admission audits identify actual actor, immutable
  workspace/grant/assignment, operation, reason, effective scope and expiry. They
  record admission, never completed tenant effects. Denials commit their audit
  before returning an error, rather than throwing inside and rolling it back.
- After audit persistence, session revocation/expiry and effective grant/assignment
  expiry are rechecked. An end during the audit wait finalizes only this transaction's
  unpublished audit row as denied, so no successful admission is returned/recorded.

## Evidence and limits

Tests written before each capability initially failed at the missing module/export;
those are capability absence, not successful behavioral regression execution.
Independent source review found UUID casing replay and expiry-during-audit gaps.
Lead added controlled realPG regressions and observed distinct duplicate grants and
successful expired admissions before fixing them. Lead also reproduced logout
committed during the audit wait returning an admission, then repaired that boundary.
Expiry tests advance only Date with a controlled audit barrier; Postgres is real.

Final focused50platform cases passed with real Redis selected. Cases cover full
issuance/replay/conflict/limits, actor/workspace/assignment/scope/lifetime, audit
rollback, foreign revocation, fresh narrowing/no expansion, deleted connections,
revoked grants/assignment/session/role/workspace, expiry and audit-wait races.
Independent source recheck found no remaining confirmed issue in this internal
module; reviewer executed no checks. Final full144files/1335passed with23optional skips; signup-seeded75files/828passed;
type and strict lint passed. Product digest ab15eae9553fe7d1719257f7f0c705f2238ed4e1b22def19e4ec070eb808be80.

The frozen22browser run belongs to operator21c269f/runtime buildM_rq0OTQsJstuUKedMRia
and excludes this new unwired module. It cannot establish support selection, tenant
access, live stream termination, queue revocation or browser support acceptance.

Logs: /private/tmp/ziyrak-p1-grants-uuid-red.log,
/private/tmp/ziyrak-p1-grants-expiry-red.log,
/private/tmp/ziyrak-p1-grants-session-red.log,
/private/tmp/ziyrak-p1-grants-final-focused-redis.log and
/private/tmp/ziyrak-p1-grants-final-{type,lint,full,signup}.log.
No provider call, live account/configuration/database change, deployment or P1
closure is claimed. Next is exact delayed provenance/lifecycle binding and its
fresh execution checks, then explicit grant selection/tenant/stream integration
and actual restricted-resource/support browser acceptance before activation.
