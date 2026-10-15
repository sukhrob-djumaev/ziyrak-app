# P1 follow-up authority integration contract

Prepared from source and independent read-only review before wiring. This refines
PLAN P1, §§6,15,23–25 within the approved milestone; it introduces no reverse
infrastructure dependency, new policy subsystem or live cutover.

## Ownership and public seam

Tools own ActionExecution, immutable saved follow-up authority and ToolPolicy.
Tenancy supplies strict fresh identity/provider provenance facts. Application job
handlers compose tools' public authorization service into the delivery contract.
Queue adapters remain generic. Delivery does not import a concrete tools service;
tenancy does not import tools. No global registration or startup ordering hook.

Add an explicit per-call `AuthorizeFollowupSubmission` contract in conversations:
worker context plus read-only binding from the persisted operation (delivery/action/
conversation/connection/channel/recipient/response) returns a newly constrained
system_job/role:null context. Only application handlers compose the implementation.
Missing/invalid authorization must deny every nonterminal follow-up submission.
Validate returned actor/job/workspace/placement, exact lifecycle parents, fixed
operation and explicit resource ceiling; a malformed callback cannot widen authority.

Check before dispatch claim and again immediately before adapter invocation. Keep
the original worker context for each fresh resolver invocation. Authorization failure
after claim clears the owned claim as known refusal/cancellation, outside the
transport uncertainty catch. Transient pre-submission infrastructure failure is a
known unsent retry boundary; it is never a fabricated unknown provider outcome.
Terminal accepted operations remain projectable without legacy provenance replay.

## Producer and immutable snapshot

Registry passes server-owned direct/AI/approval admission separately from caller
ToolRuntimeContext. Approve forces the actual approver, retaining original requester
history. Callback arguments cannot override admission with a request/runtime field.
The existing runtime locator/attempt fields and attempt IDs remain unchanged.

After exact active destination resolution, before queue schedule, persist strict v1:
fixed schedule_followup/send-followup operation, business/action/conversation/
connection bindings, admission mode and validated identity/provider ceiling. No
bearer, copied role, reusable support grant, mutable model-supplied origin or
conversation inference. Compare-and-set an empty snapshot on the exact running
bound action; never overwrite established authority on replay. Retirement invalidates
it. No enqueue on capture/persistence denial. Unknown legacy origin fails closed;
this local session performs no live queue migration or permission to cut over.

## Fresh admission modes

| Mode | Required fresh authority |
| --- | --- |
| Direct human/key tool | Exact current origin and saved scope ceiling; enabled tool and current allowed human role, plus the tool's required permission when defined. |
| Internal-chat AI retaining human/key provenance | Exact current origin, original internal-chat permission and saved ceiling; tool enabled and AI permitted. AI retagging never makes a denied human autonomous. |
| Human approval | Actual approving membership/current actions:approve, enabled tool and explicit binding. Preserve approval's distinct semantics; do not substitute direct-tool role allowlists. |
| Provider AI | Exact durable inbound receipt→operation→conversation→owning active connection; tool enabled/AI permitted and fixed resource/operation ceiling. Never infer from actor kind alone. |

Logout/session expiry preserves recorded human intent by the owner's actual choice;
current membership/key removal, permissions, key expiry/revocation, issuer identity,
workspace/connection activity and saved ceiling remain enforced before send/retry.
Provider capture requires preparing; refresh permits real noncancelled preparation,
sending, accepted and refusal/review states. Human full-workspace access to legitimate
unstamped conversations is preserved; provider origin requires a real ownership stamp.

## Exact P1 acceptance and verification

> Recheck revocation for long-lived subscriptions and delayed user-initiated work;
> system jobs retain only their defined operation, not a reusable human support grant.

> Restricted users cannot recover excluded channel data through related resources,
> counts/search/exports, attachments or realtime.

Tests first with real isolated Postgres, controlled queue/adapter barriers: producer
persists before enqueue, missing/forged origin and runtime mode deny, exact approver,
all mode-specific current policy changes, deleted/recreated or demoted membership,
key/issuer loss, widening/narrowing, legacy/malformed/wrong bindings, no-authorizer
and malformed callback results, revoke between pickup/claim/submission, known
unsent denial, retry/restart, retirement and accepted replay. Include real pg-boss
retry revocation; fake/direct handler evidence cannot close that boundary. Obtain
independent implementation security review and a fresh full browser run after wiring.

Recovery requester, campaigns and manual webhook retry need their own origin
producer/consumer integration. Accepting the follow-up boundary alone cannot close
P1 delayed-work acceptance, support activation or deployment readiness.
