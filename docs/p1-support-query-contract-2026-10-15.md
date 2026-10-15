# P1 support conversation-list query prerequisite

PLAN P1, §§8–9/15/16 and the existing platform-support contract govern. Tenancy
owns guarded repository query shape and resource predicates; platform owns fresh
audited grant facts; identity owns exact server method/path/operation selection.
This slice adds only the query prerequisite. It does not activate support auth,
SSR, routes, streams, jobs or a customer-visible workflow. No provider/SDK dependency.

Exact applicable acceptance:

> Restricted users cannot recover excluded channel data through related resources,
> counts/search/exports, attachments or realtime.

> Support access records actor, target workspace, scope, reason and lifetime.

> allowed and denied cases pass; no blanket tenant bypass

The repository consumes an explicit server-created request profile for GET
/api/conversations + conversations:read, actual platform_admin user with role:null,
matching support provenance/operation and explicit resource scope. A profile or grant
ID alone is not authority; future identity resolution must supply fresh audited
facts before exposure. No caller body/header is translated directly into this context.

Initially permit only conversation findMany and root count. Require an explicit
allowlisted scalar projection, bounded pagination and scalar search/channel/status/
ID predicates and ordering; preserve existing workspace/connection ownership scope.
Deny implicit all-field projections, relations/counts, relation predicates/orderings,
aggregates/grouping, other models and every mutation, including guarded transactions.
Allowed reads remain guarded inside transaction callbacks; every mutation and
other model remains denied there. Transaction entry itself adds no authority.
Missing/wrong profile, actor, operation, role or scope deny. Copied support provenance
on delegated jobs/AI denies. Normal member behavior is unchanged.

Tests first: real isolated PG, two workspaces/two same-type connections, correct and
excluded IDs/search/count, unstamped ownership, full-workspace configuration/secret/
mutation negatives, nested/filter/order/count and transaction bypasses, context
mismatches and ordinary member compatibility. Synthetic trusted contexts isolate the
query boundary; they do not prove platform/session/grant admission. Independent
security source review and affected regression/type/lint checks are required.

Later activation must classify exact method/path/permission, deny permissionless SSR,
paid knowledge-test POST, campaigns, detail/mutations and unrelated operations,
reaudit exposure and recheck streams. Existing list includes messages/tags/counts;
it cannot be activated unchanged by this scalar-only profile. A fresh full browser
run is required when a real support UI/API flow is wired. P1 stays open.
