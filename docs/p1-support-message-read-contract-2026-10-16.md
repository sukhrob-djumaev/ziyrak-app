# P1 request-local support text-message read (contract, before code)

PLAN P1, §§6/8–9/15/16 and the platform-support, support-query and support-list
contracts govern. Approved P1 work, independent of the pending follow-up cutoff.
Identity consumes platform's audited grant facts; conversations own the scalar
read service; tenancy keeps the query gate. No provider/SDK reversal, no reusable
support job authority, no stream/SSR support context.

## Exact applicable acceptance (PLAN P1, verbatim)

> Resolve selected workspace on the server; reject guessed IDs, privilege escalation,
> stale/revoked membership, expired support access and scope widening through API keys.

> Restricted users cannot recover excluded channel data through related resources,
> counts/search/exports, attachments or realtime.

> Support access records actor, target workspace, scope, reason and lifetime.

## Module contract

- **Route:** only `GET /api/conversations/{id}/messages` with permission
  `messages:read`, selected by request-local `x-support-grant-id` and
  `x-workspace-id`. Every other path/method/permission, any `x-api-key` header
  (even empty), missing/empty/malformed locator, malformed path id, or cookie/header
  workspace conflict denies. No fallback to membership, no persisted support
  selection. The grant must itself allow `messages:read` (`SUPPORT_OPERATIONS`
  already names it); `conversations:read` alone never reads messages and the
  reverse. The audit records operation `messages:read`.
- **Admission/exposure** reuse `resolveSupportRequest`, generalized from a single
  hard-coded route to an exact allowlist of two (operation, method, path-pattern)
  entries. The support-query profile carries the operation and, for messages, the
  validated parent conversation id; it is the only source of that id downstream.
- **Rows:** a separate scalar service, never the normal `listMessages`. Fields
  exactly `id, conversationId, role, content, createdAt`. Rows with a non-null
  `mediaType` or `mediaUrl` are excluded from rows AND count (text-only). `toolCalls`,
  media URLs and every related model are never selected or filterable. Order
  `createdAt asc, id asc`; `take` 1..100, `skip` 0..100000; normal pagination
  envelope with a count using the identical predicate.
- **Predicates are composed in `prepareSupportQuery`, not by the caller:** for
  model `message` the where is the caller's allowlisted scalar filter AND
  `{conversationId: <profile parent>, mediaType: null, mediaUrl: null,
conversation: {is: {retiredAt: null}}}`. The generic resource scope predicate
  then adds the grant's connection/workspace scope through the parent. Caller
  cannot widen the parent or re-admit media rows. Unknown fields, FieldRef
  operands, relation filters/selection, aggregate/groupBy and other models deny.
- **Missing/foreign/out-of-scope/retired parent** returns the same 404 shape; no
  existence oracle across workspaces, connections or retirement.
- **Final exposure:** before returning rows OR count, finish placement, then the
  fresh audited grant/session decision for the same original token/grant/workspace/
  operation; inside that check (after the audited grant facts, before the
  session/expiry comparisons) re-verify the selected parent still exists, is
  unretired and is inside the fresh scope. Same actor/session/grant/workspace/
  placement and unchanged normalized scope are required; any change in actor/session/grant/
  workspace/placement/scope discards the entire result with `SUPPORT_CONTEXT_CHANGED`;
  loss of the selected parent itself (missing, retired or out of scope) discards it
  with the same 404 shape as above, so the final check adds no existence oracle. No requery/widening loop. Authorization
  audits are not proof of customer exposure; there is no recall promise for data
  after the final checked snapshot leaves the server. All support responses are
  `private, no-store`.
- **Rate limit:** per actual actor, per-operation key (`support-<operation>:actor:<id>`), 60/min.
- **Console:** explicit per-row "View text messages" in the limited list, Close and
  Refresh; shows role/time/text only (text rendered as text, never HTML), a visible
  note that media/tool data is excluded. Clears rows on grant change, revocation,
  error, close or superseded request; aborts superseded requests and rejects late
  responses. No links to detail, notes, tickets, customer profile or send actions.

## Dependencies / exclusions

Tenancy `support-query` may not import identity/conversations. Identity may not
import UI. Notes (`messages:read` on notes route), message POST, detail, SSR,
streams, exports, attachments, realtime and delayed jobs remain unavailable to
support; the notes route shares the permission string but fails the exact path
allowlist. Customer-profile data stays gated by `customerProfileAccess`; message
text is governed by `messages:read` plus connection scope.

## Tests first (real isolated Postgres, existing platform-authority fixture file)

Actual own grant/person/operator; text rows/count across two workspaces and two
same-type channels with media, tool-call and system/assistant/customer rows; missing/
foreign/revoked/expired grant; grant lacking `messages:read`; assignment/platform/
session loss; audit failure; path/method/permission/key/locator/cookie denial; notes,
POST, detail and conversations-list not allowed under a messages-only grant;
retired/foreign/out-of-scope parent identical 404; post-query barriers that revoke,
narrow scope, retire the parent or lose session / fail final audit and prove no
data or count response; ordinary-member compatibility unchanged (media rows still
visible to members). No real provider calls. Observe desired failures before code.
Then J22 extension through the actual console, screenshots inspected, fresh full
browser on an identified candidate, independent security review. P1 stays open;
other support operations and the complete role matrix are separate acceptance.
