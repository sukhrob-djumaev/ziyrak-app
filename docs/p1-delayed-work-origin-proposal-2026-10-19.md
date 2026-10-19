# P1 delayed work beyond follow-ups: findings and proposal (needs owner approval)

Status: PROPOSAL. No code changed. Campaigns need new persistent state, so PLAN rule 11 applies.

## Findings (source at ab17c20)

- **Campaign execute** (`POST /api/campaigns/[id]/execute`, `automation:create`): queues
  `execute-campaign` with only `businessId` and `campaignId`. The worker sends to every target
  through `sendProactiveMessage`, which calls the channel adapter directly. No requester or authority
  is saved; no `DeliveryOperation`, so no claim, lease or unknown-outcome handling. A queue retry
  after a partial run re-sends to customers already messaged (duplicate risk, an R1-class gap).
  The worker also reads the campaign's current message and targets at run time.
- **Recovery resend** (`POST /api/deliveries/[id]/recover`, `actions:approve`): queues `retry-delivery`
  with ids only. The worker dispatches through the follow-up admission, which rechecks the
  _original follow-up action's_ saved authority. The recovery requester is not itself rechecked.
  To confirm: whether a removed approver's queued resend should be refused.
- **Manual webhook retry** (`retryDelivery`): re-queues delivery of an already-created event to the
  webhook's configured URL. No customer message is sent. Lower risk; the requester's authority is
  not rechecked at run time.

## Proposal

1. **Campaigns:** add a `CampaignRun` record created at execute time holding the requester's
   saved authority snapshot (same shape as the follow-up snapshot), a frozen copy of message,
   channel, connection and target ids, and a status. The worker creates one `DeliveryOperation`
   per recipient (operation key `campaign:<run>:<customer>`), each sent through the existing
   single sending admission, which rechecks the saved authority per recipient. A revoked
   requester stops the remaining recipients; a retry cannot re-send accepted ones. One additive
   migration (table plus index). Existing campaigns are unaffected until executed.
2. **Recovery resend:** record the recovery requester on the operation and recheck that
   requester at admission, in addition to the original authority. Small, no new table.
3. **Webhook retry:** recheck the requester's current membership/permission when the retry job
   runs; refuse safely if gone. Small. (Alternative: accept as out of P1 with your dated waiver.)

## Tests first

Real isolated Postgres, two workspaces: requester removed/demoted/restricted/expired between
execute and send sends nothing; partial run plus retry sends each recipient at most once;
concurrent executes; erasure/redaction; fence behavior as for follow-ups. Independent security
review before merge; full browser pass on a frozen candidate.

## Decisions needed

A. Approve the `CampaignRun` migration and per-recipient operations (recommended).
B. Webhook retry: recheck (recommended) or waive for P1.
