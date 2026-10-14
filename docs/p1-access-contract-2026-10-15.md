# P1 access contract and implementation slices

Authority: PLAN MS-2026-10-14 P1 and §§7–9,12,14–16. R3's isolated safety
baseline is verified; its residual acceptance remains pending. No live migration,
bootstrap, restart or deployment is authorized. This document makes the approved
contract concrete; it does not authorize a new architecture or milestone.

## Permission matrix before code

All tenant actions require a current identity, selected workspace, permitted
operation and resource scope. Existing role permissions remain additive. Explicit
scope narrows those permissions; it never grants additional workspace privileges.

| Authority               | Platform operations                                                                                                                                 | Tenant operations and team limits                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Super admin             | Provision operators, named assignments/workspaces and platform policy. Secured audited bootstrap only; legacy display flag grants no new authority. | Requires explicit support grant; never automatically owner. Actual user, reason, expiry, allowed operations and resources are audited on issuance/use.                           |
| Operator                | Only named assignments/permitted support operations; cannot assign self, grant platform roles or read provider secrets.                             | Requires current matching support grant; revocation/expiry/removal denies further reads/writes, stream events and delayed human work.                                            |
| Workspace owner         | No platform authority.                                                                                                                              | Existing owner permissions inside membership scope; owner-only transfer/delete/billing. Generic team management cannot create an owner or modify global account credentials.     |
| Workspace admin         | No platform authority.                                                                                                                              | Existing admin permissions inside membership scope; cannot modify/remove owner or grant owner. Cannot edit another person's global name/password through a workspace membership. |
| Supervisor              | No platform authority.                                                                                                                              | Existing supervisor permissions, intersected with explicit resources. No workspace role/configuration delegation.                                                                |
| Agent                   | No platform authority.                                                                                                                              | Existing agent permissions, intersected with resources; no privilege grants.                                                                                                     |
| Viewer                  | No platform authority.                                                                                                                              | Existing viewer reads, intersected with resources; no writes/privilege grants.                                                                                                   |
| API key                 | No platform authority.                                                                                                                              | Fixed recorded workspace, capped role and explicit scope no wider than issuer; missing/unknown scope fails closed. Revocation rechecked for long-lived/delayed use.              |
| Channel/AI/system actor | No reusable human/platform authority.                                                                                                               | Only the authenticated ingress/defined conversation/tool/job operation. Delayed user actions retain revalidatable actual-human provenance.                                       |

Connection scope refers to `ChannelConnection.id`, not channel type. Same customer
on two same-type connections must not merge authorization or reply destinations.
Restricted scope covers related messages/media/tickets/history/search/export,
analytics/counts, recovery and realtime. Unknown conversation ownership denies
restricted access. Shared customer profile fields require a separate explicit
permission; visible conversation history does not imply global profile access.
Workspace-wide knowledge/settings retain their distinct role permissions.
Generic team-access writes require workspace-wide human authority: a connection
restriction never authorizes durable membership/role delegation. Secured new-member
provisioning explicitly inherits the issuer's shared-profile capability instead
of relying on schema defaults; P3 supplies the invitation lifecycle.

## Existing-user migration and controls

Reuse User/Business/Membership and tenant repositories. Existing legitimate
memberships receive explicit full-workspace scope at migration without higher
roles. New restricted grants require named same-workspace connection references;
empty or malformed restrictions deny. Existing API keys need explicit documented
classification/backfill, not an unbounded missing-scope fallback. Conversation
ownership backfill uses validated same-workspace evidence; ambiguous rows remain
unavailable to restricted contexts. Bootstrap enrolls an explicitly selected
account through secured audited action, never first signup or old display flag.

Do not enable support/restricted assignment workflows before repository/service,
related-resource and lifecycle enforcement are complete. P3 owns invitations,
verified identity and reset lifecycle; P1 uses secured provisioning and denies
workspace-based credential takeover. No production bootstrap is performed here.

## Execution slices and exact verification obligations

1. Tests-first fixes for confirmed team privilege/global-identity takeover and
   same-contact connection conflation. Preserve foreign-ID404 and legitimate
   non-owner team roles. Verify real isolated PG, actual route checks and controlled
   channel adapters; never claim synthetic sends as real provider delivery.
2. Explicit platform/assignment/grant/scope schema/FKs, secured bootstrap/recovery,
   mandatory audit, selection resolver shared by requests/server components.
   Tests first for guessed workspace, stale membership, role widening, issuer scope,
   expiry/revocation, audit failure and bootstrap races.
3. Resource/related-data/read/write/aggregate/reference restrictions, API-key scope,
   stream revalidation and delayed authority. Exercise two workspaces and two
   connections, including shared customer contacts, direct IDs and foreign refs.
4. Actual platform/workspace role UI, switching, grant issuance/use/revocation and
   denied direct routes; independent security review and full browser rerun.

P1 completion requires every allowed/denied case, documented/tested migration and
bootstrap/recovery, no blanket bypass or implicit owner, and mandatory actual-actor
support auditing. A foundation slice or green build does not close P1. Record
implementation separately from verification and preserve R4 live-provider gates.

## Concrete foundation schema and resolver boundary

- `User.platformRole` is a nullable explicit enum (`super_admin`/`operator`), with
  no backfill from display-only `isPlatformAdmin`. A singleton control record and
  transaction serialize initial bootstrap/recovery; actions require possession of
  a separately supplied bootstrap secret and identify an existing selected user.
  No secret/role is exposed through public signup or written to an audit.
- Membership and API key gain explicit scope mode and normalized connection-scope
  rows. Composite business/parent/connection FKs prohibit foreign attachments.
  Existing legitimate memberships backfill workspace scope. Existing agent keys
  receive explicit workspace classification; unexpected higher-role keys become
  inactive/unclassified for owner review. New keys record issuer and explicit scope.
- Operator assignments and support grants are control-plane records with named
  actor/workspace, allowed operations, scope links, reason, expiry/revocation.
  Assignment/grant composite FKs bind workspace and assigned operator. Grant scope
  must be within current assignment at issuance and every use. Unknown scope denies.
- Mandatory control-plane access audit retains actual actor, action, workspace,
  scope, reason/lifetime and grant reference. No tenant content or secrets.
  Audit-write failure denies privileged issuance/use; this is separate from
  best-effort product activity logging. The tenant repository cannot expose these
  platform-only delegates as an implicit administration bypass.
- Conversation ownership reuses validated connection metadata. Connections are
  control-plane resident while conversations can live in dedicated databases;
  do not invent an unenforceable cross-database FK. Missing/ambiguous metadata denies
  restricted access. Creation validates the owning connection; mutation cannot
  replace/drop the ownership stamp, snooze preserves it, cross-connection merge
  denies. API/internal legacy conversations remain visible only to explicit full
  workspace scope unless they have independently validated connection ownership.
- `resourceScope` and authorization provenance accompany TenantContext. Requests
  and server components use one fresh resolver for the selected workspace cookie
  (optional explicit request header must agree). Selection is a locator, never
  authority. Missing selection requires a deliberate workspace choice, including
  accounts with a single membership; login/signup may set selection as part of the
  authenticated user's explicit entry/create action. No earliest-membership fallback.
- Support contexts retain platform actor and named grant, never fabricated owner
  role; allowed operations intersect resource scope. API keys ignore human support
  selection and cannot change their recorded workspace. Current revocation is checked
  before stream content and delayed human operations, not merely on connect/login.

The concrete shared-profile capability is `none`/`read`/`write`, separate from
role and connection scope. Existing legitimate full memberships/classified agent
keys retain their prior profile capability; new restricted scopes default `none`.
Grant/assignment scope cannot exceed the issuer, including this capability.
Support operations exclude ownership, team/identity grants, key creation and
secret/configuration administration; operational support permissions are named
explicitly. Support never creates durable membership or further access authority.
