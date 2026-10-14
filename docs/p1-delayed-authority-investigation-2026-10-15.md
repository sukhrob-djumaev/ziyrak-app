# P1 delayed-work investigation and next test packet

Independent read-only source investigation, integrated/rechecked by the lead.
No product edits, runtime exploit, provider call or new acceptance pass is claimed.
PLAN P1/§15.2/§25 requires fresh authority for delayed user-origin work; the queue
keeps a system-job principal with only the defined operation, never a saved human
role, bearer token or reusable support grant. Platform/support activation is still
unimplemented and must remain closed until its real resolver/lifecycle gates exist.

## Confirmed source gaps

- `tools/registry.ts` records only `runtimeCtx.conversationId` on ActionExecution.
  `tools/builtin/schedule-followup.ts` independently falls back to parsed arguments.
  Existing `tests/unit/schedule-followup-e2e.test.ts` happy-path calls AI(A), argument
  A and runtime containing only toolCallId, producing an unbound action for a job
  targeting A. With that missing runtime, AI(A)/argument B can select B; authoritative
  principal/work context is not compared. Existing runtime-bound calls intentionally
  ignore model-supplied target IDs, a documented contract to preserve when fixing.
- `jobs/handlers/send-followup.ts` permits a null stored action conversation and
  checks equality only when non-null. `conversations/retire-work.ts` discovers and
  redacts actions through the stored conversation column, so unbound scheduled
  actions/private inputs escape that retirement selection. Existing destination/
  reference checks still reject retired/missing conversation sends. This finding
  proves missing lineage/redaction, not a newly demonstrated post-retirement send.
- ActionExecution.authorizationSnapshot has no producer/consumer. Follow-up jobs
  save destination/content/idempotency but not originating permission provenance or
  scope ceiling. Both queue adapters create scope-less system_job contexts. Scoped
  repositories grant such defined autonomous jobs workspace scope; they do not
  reconstruct and refresh the initiating membership/session/API-key authority.
- Recovery resend, campaign execution and manual webhook retry also drop initiating
  authority before worker dispatch. `ai/engine.ts` can retag internal-chat work as
  ai_agent while preserving human/API authorization, so principal kind alone cannot
  distinguish autonomous provider work from user-origin work.

## Smallest coherent implementation order

1. Normalize the authoritative conversation before creating an action. AI/work/
   server runtime sources must agree; model arguments cannot redirect it. Direct
   human/API argument targets require current scoped validation before enqueue.
   Persist one target in action, execution workBinding and job; worker requires
   exact non-null agreement. Preserve documented safe handling of redundant model
   arguments rather than silently changing the existing tool contract.
2. Produce a versioned server-created snapshot before enqueue: exact operation/tool,
   origin provenance, resource ceiling, lifecycle/action/conversation/connection
   binding. No bearer token or copied role as worker authority. Autonomous provider
   work needs an explicitly validated server origin, not a missing-provenance guess.
3. Refresh exact membership identity/session expiry/revocation or exact key/current
   issuer at pickup, immediately before dispatch, and each retry. Intersect current
   scope/permissions with the saved ceiling; retain system_job/role:null and narrow
   operations. Delete/recreate of membership must not revive an old job. Denied
   origins never fall back to autonomous workspace authority.
4. Keep retirement and cancellation behind the existing lifecycle gate. A narrow
   cleanup can cancel exact bound work after authority loss; it cannot send. Extend
   the same provenance pattern to recovery, campaign fan-out and manual retry.
5. Define cutover for old queued rows that lack provenance. Do not infer autonomous
   origin from requestedBy="ai", silently revive expired authority or migrate live
   queues under this local-only session. Unknown origin must fail closed or be
   handled by an explicitly authorized quiescence/retirement procedure.

## Tests before changes

Use real isolated Postgres, controlled adapters and a paused queue/explicit barrier:
missing-runtime follow-up persists a real parent; AI target disagreement cannot
redirect; foreign/excluded human target denies before enqueue; retirement before
release cancels/redacts the bound action and yields zero adapter calls. Cover exact
membership removal/recreation/demotion, session revocation/expiry, key revocation/
expiry, issuer removal/narrowing and workspace suspension; later widening cannot
widen a saved ceiling. Missing/malformed snapshots and wrong action/conversation/
connection/message/job type deny. Pause between pickup and dispatch, revoke, then
release; repeat through retry/restart. Internal-chat AI retains human-origin checks;
provider-origin work remains independent of unrelated employee revocation.

Preserve R1 accepted/uncertain delivery and duplicate controls. At least one real
pg-boss pickup/retry revocation case plus required full browser rerun must verify
the queue integration; direct-handler/fake-queue tests alone cannot close it.
