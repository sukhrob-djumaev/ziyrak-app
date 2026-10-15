# P1 follow-up admission: proposed contract clarification

Status: **proposal; owner decision pending**. Last verified product baseline
`0bfe1ae`; isolated development has an uncommitted, incomplete dispatch integration.
No live rollout or queue migration is authorized by this proposal.

## Reproduced problem

The integration refreshes authority before claim and immediately before the adapter.
Independent asynchronous reads still mix facts from different moments. In real
isolated Postgres tests, pausing the final identity return and then (a) disabling
the actual tool policy, (b) retiring/removing the conversation, or (c) advancing the
clock past the actual API key expiry each allowed one synthetic adapter submission.

Executed desired-behavior result: **3 failed, 10 passed**, not acceptance. Fixture:
`tests/security/followup-authority.test.ts`; sanitized local log:
`/private/tmp/ziyrak-p1-followup-authority-admission-red.log`.
Earlier malformed-callback, accepted-checkpoint projection and membership-change
during destination lookup findings were reproduced and repaired, but those ten
passing cases do not close these three further gaps. No real provider was contacted.

Reordering reads cannot keep policy, origin and lifecycle facts coherent. Holding
a database transaction across a provider call would violate the existing short
tenant-write contract and still cannot atomically commit a remote send.

## Smallest proposed behavior

Use the durable local **sending admission** as the cancellation cutoff:

- A membership/key/permission, workspace/channel, policy or resource change
  committed before admission blocks sending. Check key expiry against the current
  clock at the final admission decision, after waits; a key already expired at
  that decision cannot admit work.
- Once a coherent sending admission commits, the attempt may reach the provider
  even if logout, revocation, expiry, cancellation, conversation retirement or
  erasure follows. That later change blocks subsequent attempts and retries;
  it cannot promise recall of this already admitted attempt.
- Customer-visible receipt may occur after local admission. Logout continues to
  preserve schedules under the owner's separate lifetime decision. Support-origin
  delayed mutations remain unavailable.
- Preserve R1 uncertainty: a crash after admission can be unknown even if no
  external call happened. Never automatically resend an uncertain attempt.
- Retirement/erasure still redact persisted content and cancel unadmitted work.
  An in-flight admitted copy cannot be guaranteed recalled; do not restore erased
  messages/action content when its transport result arrives.

Timing is explicit: the final decision timestamp is taken under both fences after
awaited checks and immediately before the conditional claim. Expiry is judged at
that timestamp; the clock can advance during commit or transport. Admission becomes
durable when the claim commits (the data-plane commit for dedicated placement).
Transport still requires successful outer control-transaction completion. A failed
claim is no admission; a committed dedicated claim plus failed outer completion is
an unresolved R1 recovery state, never permission to call the adapter. Expiry after
the checked decision cannot guarantee recall of a subsequently committed attempt.

This qualifies the P1 phrase "before sending" with a precise local ordering point.
It does not reduce current-role or resource checks, extend saved scope, or grant a
system job a reusable human/support role.

## Bounded implementation contract, after approval

Tenancy supplies a short internal admission session using the existing per-workspace
write fence. Tools interpret effective policy and immutable origin; conversations
validate destination and persist the token-bound R1 sending claim. Application job
handlers compose those contracts; queue and channel adapters remain generic.

Use ReadCommitted for both transactions, acquire each fence before authority or
lifecycle reads, and use only the bound readers throughout; never reuse a prior
snapshot transaction. Acquire control-plane fence first and data-plane fence second.
For shared placement,
reuse the same transaction, avoiding nested-lock deadlock. For dedicated placement,
retain the control fence through data-plane commit. Expose narrow transaction-bound
identity/connection readers and guarded repositories, without raw SQL/client escape,
nested transaction methods or provider calls. All authority-reducing application
writers must use the same fence; inspect existing and newly added writer paths.
Placement migration retains its existing quiesced/manual contract.

Read current identity/scope, policy (including default/absence), action snapshot,
provider lineage and active destination under the fences, then claim once.
Check expiry after awaited reads, immediately before the local claim.
Invoke transport only after the local admission transactions succeed and release.
A known pre-claim denial is unsent. If a dedicated data-plane claim commits but the
outer control transaction fails, do not submit or invent cross-database rollback:
retain conservative R1 claim/recovery semantics. Unknown commit outcome is never
permission to resend.

Acceptance must also cover retirement racing an admitted attempt: no PII restoration,
no second submission and honest unresolved outcome where persistence was retired.
Current retirement cancels non-accepted operations including sending, clears claims
and redacts payloads. Adapt retirement/projection so an admitted-then-retired attempt
retains sanitized admission/outcome accountability without content; a cancelled label
must not imply proven non-submission of that admitted attempt. Conversation/action
cascade deletion must not erase all admission accountability: retain a sanitized,
nonreplayable marker with opaque attempt identity, time and bounded outcome only.
Until an outcome is known, describe it as retired with an unresolved admitted attempt.
Keep recipient/body/message/audit PII erased; a marker never authorizes resend or
bypasses resource authorization for audit reads. Test both accepted and uncertain
results after actual erasure/removal while transport is held.
Arbitrary privileged SQL and provider-side recall are not guarantees of this gate.

## Exact plan touchpoints and verification

Clarify PLAN P1 delayed-work acceptance and §§8/15 (revocation/lifecycle ordering),
§24 (saved action authority), §§25/31 (claim/transport/retry), §33 (race tests), and
`docs/p1-followup-dispatch-contract-2026-10-15.md`.
Retain §§5–6 dependency direction, §19 ChannelAdapter, generic JobQueue, ReadCommitted
database isolation, R1's approved uncertainty contract and P1's open status.

Required tests before closure: the three actual failures above; revocation before
admission versus writer blocked behind admission; policy creation while default
applies; exact role/key/issuer/scope/approval/provider cases; shared transaction reuse;
dedicated lock order and both commit-failure directions; two workers/one claim;
real pg-boss retry and process restart; adapter performing a scoped write to prove
locks released; retirement/erasure during admitted transport; independent security
review, appropriate full regressions and a fresh full browser run.

Independent architecture review inspected source and recommended this qualification;
it did not execute the tests. Owner approval would authorize only this bounded local
implementation and tests, not deployment, provider/account changes or milestone closure.
