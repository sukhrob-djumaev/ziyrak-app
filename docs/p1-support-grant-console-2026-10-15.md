# P1 support grant management checkpoint

Implementation on f84e423; containing commit identifies the new source. This slice
exposes explicit grant issue/revoke and safe actor-self management metadata. It does
not create a tenant context, select a grant for requests, expose customer data or
activate support streams/jobs. The UI states that workspace access is unavailable.

## Contract and exact acceptance

Platform owns assignments/grants/audit; identity owns person-session authentication.
This slice adds only the account-level management surface, consuming existing
locked lifecycle services. No raw tenant repository or provider/queue dependency.

> Support access records actor, target workspace, scope, reason and lifetime.

> Resolve selected workspace on the server; reject guessed IDs, privilege escalation,
> stale/revoked membership, expired support access and scope widening through API keys.

These criteria remain open for actual support use; management alone cannot accept
them. The full P1 support role/resource/stream/browser matrix remains required.

## Changes

- GET/POST /api/platform/support-grants require a signed person and fresh platform
  authority. All responses are private/no-store; writes require same-origin JSON,
  strict lifecycle input and an actor-based attempt budget. Issue is actor-self;
  revoke is self or current super admin, with mandatory actual-actor audit.
- Metadata lists only the actor's own grants. Operators discover only active own
  assignments and their same-workspace connection union; super admin discovers
  active workspace metadata. No credentials, configuration or customer rows are
  selected. Lists cap at 200 with an explicit truncation notice.
- /platform/support presents assignment/workspace selection, explicit permitted
  reads and connections, profile ceiling, reason and expiry, recorded grants and
  revocation reason. No operations are selected implicitly. Operator UI choices
  stay within assignment limits; server lifecycle checks remain authoritative.
  Retries preserve the UUID for the same payload. Ordinary accounts see denial
  without controls. Enrollment links actual platform accounts to the screen.
- J22 is extended to issue/revoke through the actual operator UI, inspect persisted
  actor/workspace/assignment/operations/scope/expiry and audit, and verify that a
  recorded grant does not silently grant tenant access. This new harness passed
  on its matching production build in the complete22 suite.

## Verification

Two new tests were added before implementation; their first run failed at missing
entry points (not a reproduced behavioral exploit). Then 52 real isolated PG
platform cases passed, including the new foreign-actor revocation and metadata/
credential exclusions. The same 52 passed with real Redis selected. Full regression
144 files / 1349 passed / 23 optional skips; type and strict lint passed. Signup-seeded
75 files / 831 passed. Matching fresh uninterrupted complete22browser suite passed with exit0 on
runtime56bed6c/buildIXJigGX3F97tgWvfsptnv/product digest
15a3efb1be69774e61d5b4844256a4e41ef967e2076e6eba33c0e1a0f467b7a4.
Fresh isolated database ziyrak_acceptance_p1_grant_console_20261015, production
web/separate worker, real Postgres/Redis and local LLM stand-in. Actual operator
UI issue/revoke, exact actor/workspace/assignment/operations/scope/expiry/audits,
ordinary-account denial and no implicit tenant activation passed. Supplementary
focused J22 visual rerun passed; recorded/revoked full-page screenshots inspected.
Exact owned topology stopped with remainingOwned[]; database evidence retained.
Private env /private/tmp/ziyrak-p1-grant-console-acceptance.env and browser/visual
logs /private/tmp/ziyrak-p1-grant-console-{browser,visual}.log; workdir
scripts/acceptance/.work/p1-grant-console-20261015. No real provider claim.
Independent source-only security review found no confirmed issue in this management
slice. Separate source-only harness review requested stronger exact operation,
expiry and persisted-revocation assertions; added. Neither review claims execution.

Logs: /private/tmp/ziyrak-p1-grant-console-{red,focused,redis,type,lint,full,signup}.log.
Full and signup databases are separate from acceptance; paired database URLs are
pinned. This is synthetic local evidence, not live provider or production acceptance.

## Next integrations

Support activation needs an exact method/path allowlist, explicit operation at
identity admission, model/root/related projection/filter/count gates, mutation and
configuration/credential denial even for workspace grants, and fresh audit before
responses/frames. Generic dashboard SSR remains denied until reviewed page-level
admission exists. Existing conversation reads include messages/tickets/profiles;
knowledge-test POST performs paid AI work despite its read permission. Permission
names alone cannot define support-safe routes. See the platform support contract.

Delayed work separately follows the owner's approved durable-request lifetime:
logout/session expiry preserves a schedule, while current exact membership/key
permissions and saved resource ceilings are rechecked before sending. No delayed
authority producer or consumer is implemented here. No live accounts, queues or
services changed; no push, deployment, release or P1 closure is claimed.
