# P1 request-local support conversation list

PLAN P1, §§6/8–9/15/16 and the platform-support/query contracts govern. This is
approved P1 implementation, independent of the pending follow-up cutoff. Identity
consumes platform's public audited grant facts and placement contract; conversations
own the scalar DTO/read service; application handlers compose them. Tenancy keeps
query/resource gates. No provider/SDK reversal or reusable support job authority.

Exact applicable acceptance:

> Resolve selected workspace on the server; reject guessed IDs, privilege escalation,
> stale/revoked membership, expired support access and scope widening through API keys.

> Restricted users cannot recover excluded channel data through related resources,
> counts/search/exports, attachments or realtime.

> Support access records actor, target workspace, scope, reason and lifetime.

Implement only exact GET /api/conversations + conversations:read, selected by the
request-local x-support-grant-id and x-workspace-id locators. Check selection before
API-key/member resolution; any API-key header, missing permission, other path/method,
empty/malformed locator or cookie/header workspace conflict denies. No failed-grant
fallback to membership, persisted support cookie or generic dashboard selection.
Signed person plus current platform control/role, own grant, current assignment,
workspace, scope, session and mandatory audit remain authoritative.

Construct role:null/actual platform_admin user with only conversations:read, explicit
scope/support provenance/session identity and exact query profile. No bearer in
context. Rate-limit actual actor for audited reads. Ordinary member APIs remain
normal; SSR, streams, delayed jobs and unsupported routes never gain support context.

Use a separate scalar list/count service with the existing eight permitted fields,
bounded paging/search/channel/status and normal pagination envelope. Existing joined
list/detail is unavailable to this profile. Before returning rows OR count, repeat
fresh audited grant/session resolution with the same original token/grant/workspace/
operation; require same actor/session/grant/workspace/placement and unchanged normalized
scope. Discard the entire result if changed; no automatic widening/requery loop.
For final exposure, finish awaited placement BEFORE the final audited grant/session
decision; only synchronous binding/scope/deadline checks may follow it. Authorization audits are
not proof of customer exposure/receipt. All support responses are private,no-store.

Console: explicit View limited conversation list, Refresh and Close; no detail links
or previews/related data. Clear rows on grant change/revocation/error/close, abort
superseded requests and reject late responses. For a conflicting selected membership
workspace, show an intentional Clear workspace selection and retry action. Add only
a signed-person, same-origin DELETE /api/workspaces using existing clearWorkspaceCookie;
never silently ignore/replace selection or fabricate customer membership.

Tests first in the existing platform-control fixture ownership file (avoid racing a
second singleton owner): actual own grant/person/operator; scalar rows/count across
two workspaces/two same-type channels; missing/foreign/revoked/expired grant, assignment/
platform/session loss, audit failure; exact path/method/permission, key, SSR/stream/
paid-work and ordinary-member compatibility. Post-query barriers must revoke/narrow
scope/session or fail final audit and prove no data/count response. Workspace clear
is tested for auth/origin/key failure and explicit cookie clearing. No real provider
calls. Independent implementation security review remains required.

Extend J22 through actual grant-console UI for limited view/search/page/close, conflict
clearing, denied routes, revoke/refresh denial and actual-actor audit; inspect screens.
Run fresh full browser after integration on an identified candidate. Earlier runtimec24277b/buildfF41LTQ5Z5NPbD7hoWtuQ passed the query/facade
full22suite and was stopped with remainingOwned=[] verified. Its evidence remains
separate; the new list workflow needs a fresh identified build/database/full suite. P1 stays open; other support operations,
streams, delayed origins and the complete role matrix are separate acceptance.
