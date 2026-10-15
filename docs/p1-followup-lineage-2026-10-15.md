# P1 follow-up lineage checkpoint

Implementation onfe49561 in isolated P1; containing commit identifies source. No saved authorization snapshot,
current delayed permission check or support integration is implemented by this slice.
Current-candidate browser acceptance passed; no migration, deployment or P1 closure claim.

## Contract and exact selected acceptance

Tools own validated arguments, normalized conversation binding and durable action
admission; job handlers consume the same parent and existing delivery contract.
Use scoped repositories and tenancy contracts; no raw tenant persistence or concrete
provider/queue SDK is introduced. Optional ToolDefinition.resolveConversationId
preflights a conversation-bound tool after policy/schema and before cache/action
creation. Registry preserves attempt IDs and persists/passes its resolved parent.
Built-in execute is an internal callback, not a supported product entry point.

> Restricted users cannot recover excluded channel data through related resources,
> counts/search/exports, attachments or realtime. Recheck revocation for long-lived
> subscriptions and delayed user-initiated work; system jobs retain only their defined
> operation, not a reusable human support grant.

This slice establishes lineage needed for those checks; it does not complete
revocation/provenance criteria. Parent normalization prevents a model argument from
redirecting actual AI/server/work context. Redundant model target input remains
ignored when an actual parent exists, preserving the documented tool contract.

## Changes and tests-first evidence

Six realPG desired assertions failed before repair: missing persisted action parent,
AI argument redirect without explicit runtime, actual AI/runtime disagreement,
a permitted restricted human call cancelled because its action lacked a parent,
retirement missing private action input, and a legacy unbound worker action sending.

- New follow-up preflight compares actual AI/work/runtime parents, authorizes a
  concrete nonretired parent through current scope, and normalizes runtime before
  creating requested/pending action and execution workBinding. Direct human/API
  argument fallback is scoped before recording/queuing. Attempt IDs are unchanged.
- Worker requires exact nonnull persisted action parent. It does not infer a legacy
  parent from old input. Existing accepted-delivery/no-duplicate controls remain.
- Independent source review found approval skipped preflight and cache skipped
  tool/parent comparison. Three further desired assertions reproduced unbound
  approval scheduling, cross-parent cached success and cross-tool cached output.
  Cache now requires exact tool/bound parent. Approval requires an existing parent,
  valid stored schema and preflight before status claim; legacy unbound approval
  remains unchanged and unqueued rather than guessed/rebound.
- Added actual workBinding conflict, positive omitted-runtime approval, exact replay
  queues once, and controlled retirement between preflight/admission proving zero
  queue/action/private-input retention. Retirement of newly bound scheduled actions
  redacts input and cancels work. Direct internal callback fixtures are distinct
  from actual Registry entry-point evidence.

All12initial lineage/queue cases passed after first repair, then8affectedfiles/
60checks passed including real pg-boss retry, registry/approval, AI-tools, reference,
delivery recovery/durability/security. Independent source-only recheck found no
remaining confirmed material issue in this bounded lineage slice; reviewer did not
execute checks. Final full144files/1346passed with23optional skips; signup75files/828passed;
type/strict lint and Redis-selected18follow-up cases passed. Product digest
4be90fce88a3d2955e6ba294240586cec6eaf6664e8346e643e7a55d469e9b6e.
Runtime027455c, production build5egIm5D0_uNGgsVhKKb7v and the same product digest
passed the fresh uninterrupted complete22browser suite with command exit0. Strengthened
J09/J10 verifies actual visitor conversation = queued job parent = persisted action
parent before restart; assertions passed. Synthetic local accounts/owner proofs and
LLM stand-in, real isolated Postgres/Redis, production web plus separate worker.
No real-provider boundary is established. Exact owned topology was stopped afterward,
remainingOwned[], with no stale/foreign processes signalled; DB evidence retained.
Runtime later advanced to a separate grant-management candidate, so this source/build
identity remains the lineage evidence, not the newer grant screen's acceptance.
Private env /private/tmp/ziyrak-p1-lineage-acceptance.env; database
ziyrak_acceptance_p1_lineage_20261015; workdir scripts/acceptance/.work/p1-lineage-20261015;
whole-command log /private/tmp/ziyrak-p1-lineage-browser.log.

Logs: /private/tmp/ziyrak-p1-followup-lineage-red.log,
/private/tmp/ziyrak-p1-lineage-approval-cache-red.log,
/private/tmp/ziyrak-p1-lineage-affected2.log and
/private/tmp/ziyrak-p1-lineage-{full,signup,final-type,final-lint}.log.

## Still open

Versioned server-created origin/operation/resource ceilings and exact lifecycle
bindings must be persisted and freshly enforced before dispatch/retry for user/API
work; provider/system origin must be explicit. Internal-chat AI retains human
provenance rather than being inferred autonomous from actor kind. Extend to recovery,
campaigns and manual webhook retries. No queued work is migrated or cancelled in a
live database; legacy unbound input/unknown provenance needs an explicit tested
cutover/retirement procedure before deployment. Rejected legacy approval/worker
submission is fail-closed evidence, not successful legacy migration or completed
privacy cleanup. Grant selection/tenant/streams and support/restricted UI acceptance
remain separate gates. Support activation remains closed.
