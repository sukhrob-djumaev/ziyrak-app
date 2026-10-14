# R1 delivery recovery: contract correction for owner review

Status: **proposed, not approved or implemented**. Product baseline
`c20513d78421816ac0096eff1cf3dbb0d6c9aa55`; session started at
`551f9cd1d5146ed13368fda1e2ed85610f4fba21`. Product source is unchanged.

## Why a decision is required

PLAN R1 explicitly requires a rule 11 proposal if §31.2's exactly-once language
cannot be met. A Postgres commit cannot atomically commit an external provider
send. Current `ChannelAdapter.sendMessage` has neither an operation key nor a
reconciliation method, and `SendResult` contains only `success` and `error`.
Recording success earlier or combining the post-send writes in a transaction
does not close the crash between external acceptance and local persistence.

Concrete source evidence:

- `src/lib/jobs/handlers/send-followup.ts:24–67`: only recorded `succeeded`
  suppresses replay; sending precedes both message creation and action success.
  A post-send write failure is recorded as failed and a retry sends again.
- `src/lib/conversations/inbound.ts:189–213`: AI runs before dispatch; a false
  send result is logged and the receipt is still marked processed. Replaying
  the handler calls AI again.
- `src/lib/channels/types.ts:45–48`: known refusal and uncertain transport
  outcome cannot be distinguished.
- `src/lib/channels/meta-whatsapp-adapter.ts:235–276`: the actual request carries
  no caller operation key; a provider message ID is logged but not returned;
  transport errors become the same failed result as explicit refusal. Its
  existing comment correctly distinguishes Graph acceptance from delivery.
- `src/lib/ai/engine.ts:310–312`: tools use provider-generated tool-call IDs.
  A new generation after a crash need not reuse those IDs. Saving only the
  final response cannot prevent tool replay before that checkpoint exists.

This is a source-level limitation of the current contract. No assertion that
Meta lacks every possible reconciliation feature has been made; provider-specific
idempotency and error classification must be verified before relying on them.

## Smallest proposed correction

Preserve exactly-once local effects where transactions/unique operation keys
prove them. For external sends, promise **no automatic duplicate dispatch after
recorded acceptance or an uncertain outcome**, with explicit operator recovery.
Do not promise unconditional eventual delivery and exactly-once external effects
simultaneously without a verified provider idempotency/reconciliation contract.

1. Persist a tenant-scoped operation and claim preparation before automation/AI.
   Persist the completed response and its delivery intent before dispatch.
   A known send refusal retries that same response; it never reruns AI/tools.
2. Claim dispatch durably before contacting the adapter. Return distinct
   accepted, rejected and unknown outcomes, with optional provider message ID
   and retryability for a rejection known to have produced no external effect.
   Provider acceptance is not recipient delivery.
3. Skip recorded acceptance. Retry a proven nonacceptance with bounded queue
   policy. An interrupted dispatch, ambiguous transport exception or failed
   acceptance write becomes unknown and blocks automatic resend. A crash before
   contacting the provider can also conservatively become unknown.
4. If preparation was interrupted before a completed response exists, expose
   it for review instead of automatically regenerating AI or repeating tools.
   This is the smallest safe recovery rule; full resumable AI/tool-loop
   checkpointing would be a separate, larger design if automatic recovery of
   that earlier window is required.
5. Show unresolved operations and sanitized reasons to authorized workspace
   operators. Recovery records the actual actor and decision. Reconciliation
   can close an operation using provider evidence; an explicit fresh resend
   warns that the previous request may already have succeeded. No invisible
   owner impersonation, tenant bypass, secret disclosure or whole-pipeline replay.

Illustrative behavior:

| Observation                                                        | Automatic behavior                         | Operator-visible state                                        |
| ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------- |
| Provider explicitly refuses without accepting                      | Retry only saved delivery when retryable   | Failed/retry pending                                          |
| Provider accepts and local success persists                        | Skip on replay                             | Accepted; delivery unconfirmed unless separately observed     |
| Provider accepts, then persistence fails                           | Block resend on recovery of dispatch claim | Unknown; reconcile                                            |
| Timeout/reset after submission or worker dies during dispatch      | Block resend                               | Unknown; reconcile or explicitly resend with duplication risk |
| Worker dies after preparation claim and before response checkpoint | Block computation replay                   | Preparation interrupted; review tools and customer state      |

## Contract and scope before implementation

`conversations/` owns inbound composition and persisted response/recovery;
`events/` owns receipt deduplication; `channels/` owns transport outcomes;
`jobs/` owns durable scheduling/retry; `tools/` owns ActionExecution identity.
Every operation carries explicit TenantContext and connection ID. Domain code
depends on contracts; channel adapters must not import AI/orchestration. Keep
pg-boss, the current module boundaries, tenant repositories and connection
ownership checks. No new channel, provider configuration or general messaging
redesign is proposed.

The correction touches R1 and §§17.4, 18.2, 19.1, 24.3–24.4, 25.2/25.4,
31.1–31.3, 33.4 item 6, 34.3 item 5 and 46.6 tests/acceptance. Add a narrow
external-effect qualification where their wording is unconditional; preserve
local idempotency, ordinary retry tests and historical evidence. The same
qualification applies to outbound webhooks, without silently expanding R1 into
a webhook redesign. Phase 5–7 routing, ACK, deduplication and isolation remain
regression obligations, and historical tags/waivers retain their recorded scope.

R1 completion criteria, unchanged pending approval:

> both reproduced defects are resolved; retries and recovery satisfy the
> documented delivery contract; tenant isolation and required browser journeys
> pass; applicable independent security review is resolved. Document unavoidable
> provider-side uncertainty and operator recovery. If the existing exactly-once
> language (§31.2) cannot be met without a contract change, propose the smallest
> correction under rule 11 before implementing that deviation.

Relevant original §46.6 acceptance text currently requires:

> A retried job produces its side effect exactly once — §33.4 item 6, verified
> by count.

> The worker process can be stopped and restarted without losing or duplicating
> in-flight work.

The proposed correction makes uncertainty an explicit unresolved state instead
of calling an uncertain request failed or delivered. All required acceptance
remains open until the approved behavior is implemented and verified.

## New executed evidence and verification path

Permanent fixture: `tests/unit/delivery-reliability.test.ts` in the attached
isolated worktree `/Users/sukhrob/.codex/worktrees/r1-delivery-reliability/owly`.
Dependencies were installed there with `npm ci --ignore-scripts`; no live
dependencies, environment, provider accounts, databases or services were changed.

Run from that worktree:

```sh
DATABASE_URL=postgresql://test:test@127.0.0.1:1/r1_no_database \
DIRECT_DATABASE_URL=postgresql://test:test@127.0.0.1:1/r1_no_database \
node node_modules/vitest/vitest.mjs run tests/unit/delivery-reliability.test.ts --reporter=verbose
```

October 14 result: **5 failed, 1 passed**, as intended for pre-fix desired-behavior
regressions. The successful recorded-action control passed. Failed assertions:
post-send write failure sent twice; refused inbound receipt was processed; replay
called AI twice; uncertain transport outcome sent twice; recovery of an injected
running state dispatched again. These failures do not prove a real worker kill,
database durability, tool execution or provider incident. The computation spy
proves entry-point replay only. The tests remain deliberately red and the
worktree is not a merge/release candidate; do not skip them to report a pass.

After approval: turn these regressions green; add real isolated Postgres/pg-boss
tests for tenant/connection ownership, concurrency, refusal, persistence failure,
replay and process restart. Exercise the actual operator recovery UI and Web Chat,
then run the full 16-script browser suite because worker/channel behavior changes.
Targeted real Meta delivery belongs to the affected R4 acceptance boundary; no
synthetic result closes it. Run affected type/lint/build/regression checks and
obtain independent security review of the actual implementation.

Independent read-only architecture investigation completed October 14 and
confirmed the crash/timeout contract gap, post-send ordering, inbound receipt
bug and earlier AI/tool replay window. It recommended conservative unknown and
interrupted-preparation recovery. This is not an implementation security signoff.

**Owner decision requested:** approve the external-effect qualification and
conservative review states above, including interrupted preparation, or require
a larger resumable-computation/provider-reconciliation design. Production policy,
deployment and new provider/account changes are not part of this approval.
