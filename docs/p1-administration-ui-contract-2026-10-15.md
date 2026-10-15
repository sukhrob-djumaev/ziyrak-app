# P1 Administration permission presentation

PLAN P1 §§6/8–9/14–16 governs; this follows the already committed limited-list slice
and is independent of the pending follow-up cutoff. UI/application owns rendering,
identity owns fresh cookie/session/membership resolution, platform/identity services
retain API authorization. No new permission endpoint, hierarchy or provider coupling.

Exact applicable acceptance:

> Super admin provisions operators and assignments; owners/admins manage only
> permitted workspace roles.

> Resolve selected workspace on the server; reject guessed IDs, privilege escalation,
> stale/revoked membership, expired support access and scope widening through API keys.

> Browser journeys must use each actual role, workspace selection and denied direct
> URLs/API calls.

Concrete source finding: Administration currently fetches protected users/keys for
every role, silently renders403 as an empty table and exposes Add User/key controls.
Owner rows offer forbidden generic mutation. J21 explicitly accepts the empty shell.
Independent source investigation confirmed it; no owner product decision required.

Implement a fresh server /admin wrapper using existing getTenantContextFromCookies
and admin:read; denied roles see explicit access denial with no admin client mounting,
rows, dialogs or protected fetches. Missing/ended selected context follows existing
workspace-entry behavior. Existing client moves behind that wrapper. Pass only
server-derived boolean capabilities. Workspace-wide human plus existing permissions
required for user mutations, owner rows immutable. Key capabilities match current API
semantics independently: scoped human admin may still read/manage/issue a scoped key;
PUT key currently uses admin:read. No widening or narrowing of backend contracts.

Dashboard layout reuses already resolved context to hide Administration navigation
without admin:read. No new account/permission fetch and no support SSR context. Other
navigation presentation stays a separate task. On401/403 clear all protected rows,
dialog state, generated key and pending work; show denial and refresh server context.
Reject late overlapping responses using abort/sequence invalidation. Normalize nested
API errors into text, including denied mutation responses. API server checks remain
mandatory; rendering booleans confer no authority.

Tests first: actual isolatedPG/JWT/cookie resolver SSR output for five roles, restricted
admin, selected workspace/membership/session loss and sidebar visibility. Initial
regressions must demonstrate actual forbidden controls/absent denial rather than only
missing helper exports. Preserve owner/admin positives and current restricted-key
semantics. Browser J21 actual logins must prove no denied controls/nav and allowed
member/key flows, immutable owner UI and rejected direct APIs; seeded restricted scope
is labelled controlled prerequisite. Demote actual admin with dialog open, trigger a
rejected request and prove state clears/no exception. Independent security review,
focused/full/signup/type/lint/build and matching complete browser suite required.

Current runtimee85dc4e/buildQdF756rE7IdlnyaEb39sR is frozen/running the limited-list
full22suite; do not edit or use its product/build/harness/browser/DB. This task stays
in non-serving p1-support-identity/owly on c199376. Paired isolated testDB only. P1
incomplete, P2 ineligible; no live main/provider/account/deployment changes.

Continuation: bind every Administration request to the server-rendered workspace
using the existing x-workspace-id conflict guard. Shared cookies can change in a
second tab without refreshing the original form. Real Chrome/PG on frozen1208d3d
confirmed old A user form POST201 created one membership in B after actual second-tab
workspace UI selection. Current actor genuinely administered both: wrong-workspace
intent, not backend permission bypass. Header is a locator, never authorization;
fresh existing server checks remain mandatory. No architecture deviation. Browser
regression must reject403 without persistence in either workspace, discard old form
and replace context; normal same-workspace user/key flows remain positive. J23 adds
actual second-tab key-form regression; separate actual-user probe covers users.
