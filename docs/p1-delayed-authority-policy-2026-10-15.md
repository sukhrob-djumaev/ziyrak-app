# P1 delayed permission contract and approved lifetime decision

Source-only independent investigation against productf84e423, integrated by lead.
This is a concrete next implementation packet, not implemented or runtime evidence.
PLAN P1 requires fresh delayed user-origin authority; queue adapters remain generic.

## Implementation contract

Tenancy owns strict versioned capture/parsing/refresh, consuming a narrow platform
control-plane identity reader. ActionExecution.authorizationSnapshot already exists;
no schema addition is needed. Capture after exact destination selection, before
queue scheduling. Persist exact business/action/conversation/connection, operation,
resource ceiling, admission mode and origin references; never a bearer or copied
role. Do not overwrite an existing snapshot during duplicate admission.

Registry supplies a server-owned direct/internal-chat/approval mode. Approval binds
its approving principal while preserving requester audit. AI retagging retains
human/key provenance; actor.kind or requestedBy=ai cannot establish provider origin.
Provider-origin work requires exact receipt → inbound delivery → conversation →
connection chain within the workspace, with active/nonretired lifecycle. Scheduling
occurs during reply preparation; completion of the inbound response is not required.
Support mutation and unknown/legacy origins fail closed, without live queue migration.

Worker reads its own bound action metadata, refreshes origin and constructs only
system_job/role:null with fixed operation permission, intersected saved/current scope
and exact work binding. Dispatch independently refreshes immediately before adapter
submission on every attempt. A pre-submission denial is known refusal/cancellation,
never an uncertain provider outcome. Already accepted outcomes remain projectable.
Preserve legitimate full-workspace unstamped conversations deliberately; forcing
all ceilings to connection-only scope would narrow the current product contract.

## Lifetime choice approved by owner

Existing long-delay schedules do not document whether logout or original session
expiry should cancel intent. P1 explicitly requires revocation checks; it does not
clearly settle this additional lifetime cap. Do not let optional session fields
silently decide it.

Owner selected: membership-origin schedules survive logout/session expiry but re-read
exact original membership identity and current permission/scope at every send/retry.
Deleting/recreating membership cannot revive them. API origins always recheck exact
key validity/expiry/revocation and exact issuing membership, and saved scope never
widens. This separates an already recorded request's lifetime from the browser
session used to submit it. Alternative: additionally require original session JTI
not revoked and original expiry still future, so logout/expiry cancels schedules.

Owner explicitly selected this option in the current session on 2026-10-15.
Record session identifiers only for attribution where needed, never as a lifetime
cap or bearer. Support access still requires a fresh revocable session for each
request; this delayed-membership policy does not extend support grants. No
policy-dependent producer/consumer has been implemented yet. No deployment or live
queue cutover is authorized. This clarifies P1 request lifetime without changing
module ownership or dependency direction.

## Tests first and acceptance

Real isolated Postgres and controlled queue/adapter barriers: exact membership
removal/recreation/demotion, key/issuer revocation/expiry/narrowing, workspace status,
internal-chat provenance, actual approving principal, scope-widening non-expansion,
provider lineage valid/forged/retired, missing/malformed/wrong bindings, support
mutation denial, retirement after persistence, and revocation between pickup and
submission. Include real pg-boss retry/restart plus fresh full browser suite.
Independent security review required. Recovery/campaign/manual-webhook retry consume
the same provenance discipline in subsequent integrations; none is accepted here.
