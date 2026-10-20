# P1 campaign execution through single sending admission (contract, before code)

Owner approved (2026-10-20): `CampaignRun` migration and per-recipient operations. PLAN P1
governs. Criteria in scope: "stale/revoked membership … scope widening" and "restricted users
cannot recover excluded channel data"; a campaign must not send under authority its requester
no longer holds, and must not send twice to one recipient.

## Today (source at 681f46b)

`execute-campaign` reads the campaign's _current_ message, channel and segments at run time,
sends through `sendProactiveMessage` (adapter called directly), keeps no requester, no
per-recipient record, no claim/lease. A queue retry re-sends to everyone already messaged.

## Design

1. **`CampaignRun`** (new, additive migration): `id, businessId, campaignId, status
(pending|running|completed|cancelled|failed), authorizationSnapshot (Json, the deferred
identity ceiling of the requester), channel, connectionId, message, targetCustomerIds
(Json array), createdAt, updatedAt, retiredAt`. Unique `(businessId, campaignId)` is NOT
used (a campaign may be run again later); a run is created in the execute request, in the
same request that saves the requester's authority, and the job carries only `runId`.
Everything the worker sends is the frozen copy; later edits to the campaign change nothing.
2. **Execute route:** requires `automation:create` as now. Resolves the connection (active,
   type = campaign channel, and inside the requester's resource scope) and the targets under
   the requester's scope, then creates the run with `captureDeferredIdentity`. A restricted
   requester can only run to connections within scope; targets are limited by the requester's
   `customerProfileAccess` (read needed to resolve contacts). Provider/AI origins cannot start
   campaigns.
3. **Worker:** for each target, `ensureDelivery` with `kind: "campaign"`, key
   `campaign:<runId>:<customerId>`, creating the destination conversation (metadata
   `channelConnectionId`) before the operation turns `ready`, then `dispatchDelivery` with a
   campaign authorizer. Re-running the job finds existing operations by key and never creates or
   sends a second one; accepted/unknown/rejected operations are never re-sent automatically.
4. **Admission generalization:** `dispatchDelivery`'s admission branch applies to `followup`
   and `campaign` kinds. The campaign authorizer (`authorizeCampaignSubmission`) re-reads under
   the existing two-fence session: run not cancelled/retired, snapshot parse, fresh identity
   (`refreshDeferredIdentity`) still holding `automation:create` and a scope containing the
   connection, the campaign tool allowed, the recipient conversation unretired. Revocation,
   demotion, restriction or expiry between execute and send refuses that recipient and every
   later one (`rejected`, not retryable, no provider call). Binding for provenance validation
   uses the run id in place of the action id (new nullable `campaignRunId` column on
   `DeliveryOperation`, additive).
5. **Acceptance writes** the customer-visible assistant message as for follow-ups. Run status
   is projected from its operations; `sentCount` counts `accepted` operations.
6. **Not in this slice:** scheduling (`scheduledAt`), editing a run, unknown-outcome recovery UI
   (the existing delivery recovery lists campaign operations; resend there is the requester
   recheck of slice 2).

## Tests first (real isolated Postgres)

Requester removed, demoted below `automation:create`, restricted to another connection,
suspended, or expiring between execute and send: nothing sent, remaining recipients refused;
campaign message/segments edited after execute: frozen copy is sent; job redelivered after a
partial run: each recipient at most once; two concurrent workers on one run: one send per
recipient; cross-workspace run id or customer id: refused; restricted requester cannot target
an out-of-scope connection or customers outside their profile access; erasure retires run
operations; ordinary follow-up and inbound delivery unchanged. Observe each as failing before
the change. Then independent security review, a J26 browser journey on a frozen candidate, and
the full browser suite.

## Known limits

Stand-in channel only, no provider claim. Pre-created recipient conversations remain (empty)
when a send is refused or rejected; they are marked by campaign metadata so they can be
filtered. Dedicated data-plane placement is not exercised end to end.
