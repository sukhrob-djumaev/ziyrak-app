# P1 platform authority and support contract

PLAN P1 and §§7–9,12,14–16 govern. This slice owns only platform/control-plane
account authority, operator assignments and explicit support grants. Platform
services own those records and mandatory audit. Identity owns verified account,
session and selected-grant resolution; tenancy/RBAC enforce normal resources and
operations. No infrastructure/provider SDK, implicit owner, new tenant hierarchy,
public role assignment or P2 service/allowance policy is introduced.

Exact applicable P1 acceptance:

> Super admin provisions operators and assignments; owners/admins manage only
> permitted workspace roles. Resolve selected workspace on the server; reject
> guessed IDs, privilege escalation, stale/revoked membership, expired support
> access and scope widening through API keys.

> Completion criteria: allowed and denied cases pass; no blanket tenant bypass;
> privileged bootstrap/recovery and audit behavior documented/tested; existing users
> retain legitimate access without gaining privilege. Support access records actor,
> target workspace, scope, reason and lifetime. P3 supplies the shared invitation
> lifecycle; until then use secured operator provisioning, never public role assignment.

## Authority and persistence

- Initial enrollment targets the authenticated, explicitly selected existing account.
  A separately supplied owner proof is compared with a server-configured fixed-length
  hash in constant time. Bootstrap and recovery use separate configured proofs;
  missing/malformed configuration denies. No proof/token/password in response,
  logs or audit. No first-signup, username or legacy display-flag shortcut.
- Singleton PlatformControl(id=authority) and User.platformRole must agree for
  fresh platform authority. Their individual schema constraints are insufficient.
  Bootstrap/recovery, role changes, assignment changes and grant issuance serialize
  through the same short control transaction; authority rechecks occur inside it.
  Recovery requires expected generation, advances generation and atomically retires
  the displaced role/support grants. Mandatory audit failure rolls back all changes.
- Super admin creates secured operator accounts and named assignments. Existing
  global credentials are never overwritten. Operator cannot provision roles,
  assign self or obtain management/secret authority. Operators and super admin
  retain ordinary memberships only where already legitimately assigned.
- Assignments name operator/workspace, explicit operational permissions, resource
  scope/profile capability, administrative reason and optional lifetime. Revocation
  is monotonic; issue a new record instead of clearing revokedAt. Assignments for
  another actor/workspace or inactive workspace deny; connection links validate
  real named same-workspace connections. Empty restricted scope denies.

## Explicit support grant

- Issuance is an explicit actor-self action with named workspace, nonempty named
  operational permissions, scope, reason, expiry and request UUID. Super admin may
  initiate one for any active workspace; operator requires a current matching
  assignment. Nullable assignmentId is never treated as an operator bypass.
- Operator issuance and every use cap permissions, connection IDs, shared-profile
  capability and lifetime by the current assignment. Mandatory use audit succeeds
  before tenant exposure/effect; a failed audit denies. Audit records actual actor,
  operation/admission decision, immutable workspace/grant/assignment identifiers,
  normalized scope/reason/lifetime. It never labels authorization as completed work.
- UUID replay compares the entire normalized request (including reason/expiry).
  Identical live replay is idempotent; changed payload conflicts; expired/revoked
  grants never extend/revive. Recovery/role removal revoke displaced grants to
  prevent later reprovisioning from reviving temporary authority.
- Grant selection is explicit and conflicts with another workspace locator deny.
  Grant ID is a locator, never authority. No automatic fallback from failed member
  permissions and no grant creation during normal request resolution. Tenant actor
  is platform_admin with actual userId and role:null, bounded named operations and
  explicit resource scope. No owner impersonation or durable authority delegation.
- Operational support excludes ownership/billing, team/global identity, API-key
  issuance, platform roles, secrets and configuration administration. Approval/tool
  execution/recovery remain denied until specifically permitted contracts exist;
  existing ToolRegistry/recovery guards are not worked around with fabricated roles.
- Fresh checks cover revocable signed session, actual platform role/control, actor,
  workspace status, assignment, grant, expiry/revocation and current ceilings.
  Streams and delayed work consume those checks; a saved grant is not reusable
  job authority. Support activation remains unavailable until those integrations
  enforce the contract.

## Verification scheduled before implementation

Real isolated PG contract/security regressions before changes: wrong/missing proof,
legacy flag/public signup/key/revoked session denial, singleton pointer-role drift,
concurrent bootstrap/recovery and stale generation, audit rollback, old-super races,
operator self-assignment/escalation, foreign connection FKs, assignment/grant scope
and lifetime narrowing/revocation/removal, exact replay/conflict and non-revival.
Actual local UI must exercise secured bootstrap/recovery, operator provisioning,
assignment, explicit grant issuance/use/revocation, each allowed/denied role and
direct URLs/API calls. Full browser rerun and independent implementation security
review remain required. Synthetic local proofs/accounts are test evidence, not
production bootstrap or permission to alter live accounts/secret configuration.

Independent read-only design review verified fit with PLAN and supplied these
race/audit tests. It is not implementation security signoff. Implementation has
not started at this contract checkpoint; P1 remains incomplete.
