# P1 support query and scoped repository checkpoint

Product baseline `0bfe1ae`; this bounded implementation is identified by its
containing local commit. Follow-up dispatch integration remains separate uncommitted
work with three known admission races; it is excluded from this verified candidate.

## Change and module contract

Tenancy enforces one explicit server-selected GET /api/conversations +
conversations:read query profile over a matching role:null platform/support actor
and explicit resource scope. Only bounded conversation findMany with named scalar
fields and root count are permitted. Current tenant/connection ownership predicates
remain underneath; retired rows are excluded. Relations, implicit projection,
private scalar fields/operands, nested counts/filter/order, aggregates, other models
and mutations deny. Allowed read callbacks stay guarded inside transactions.

This is a repository query prerequisite. No support session/grant resolver, route,
SSR, UI, stream or job is activated. Trusted synthetic contexts isolate query
enforcement; a profile/grant locator alone is never fresh identity authority.

Independent security review found an inherited scoped-client escape: Prisma root
and model $parent exposed the pre-extension client. New null-prototype frozen
facades expose only named models/operations and guarded transactions. Their methods
return native promises rather than fluent Prisma request/delegate objects. Raw SQL,
parent/private client aliases, SDK extensions and property-descriptor escapes deny.
Normal tenant and dedicated database behavior retain the existing contracts.

## Executed evidence

- Tests first, real isolated Postgres: initial support20cases had18desired failures/
  2positive passes. Configuration/credentials/other models, unsupported query shape,
  mutations and malformed context were not rejected by the old resource guard.
- Review regressions reproduced a private-summary FieldRef predicate, transitive
  copied support provenance and missing identity. Separate actual foreign-workspace
  queries via root/model $parent produced2desired failures before facade changes.
- Final focused query/surface tests: **37 passed**. Existing membership behavior,
  scoped transaction reads, excluded ownership/search/count, erasure filtering,
  projection/mutation denial and private aliases are covered.
- Inherited/getter arguments did **not** reproduce an unbounded SQL query or forbidden
  ordering: Prisma canonicalized them. A first expected403 pagination assertion was
  too strict (one bounded row was returned) and was corrected to assert that bound.
  Fresh construction/literal checks remain defensive helper hardening.
- Clean isolated candidate in /Users/sukhrob/.codex/worktrees/p1-support-query/owly
  contains only these changes on0bfe1ae. Full148files **1426passed/1optional skip**,
  type and strict lint passed. Full suite includes real dedicated database/RLS and
  pg-boss worker-restart regressions. Signup-seeded79files **886passed**. The single full skip is the mutually exclusive
  no-Redis placement-cache control, since this run uses real Redis.
- Independent final source review found no remaining confirmed finding. Reviewers
  did not execute tests; all execution counts above are lead runs.
- Fresh build/full browser is pending; do not reuse the previous grant-console22pass
  as verification of the new repository facade.

Sanitized logs: /private/tmp/ziyrak-p1-support-query-{red,identity-red,review-red,
args-red,getter-red,final-focused2,isolated-full,isolated-signup,isolated-type,
isolated-lint}.log and /private/tmp/ziyrak-p1-repository-parent-red.log.
The first focused green35preceded two added argument controls; the final result is37.

## Continuation and limits

Freeze a coherent local candidate and run the fresh complete
browser suite before calling this slice verified across the application boundary.
Support activation still needs exact method/path admission, fresh audited grant/
session checks before exposure, safe route/service DTOs, explicit UI, streams and
negative paid-work/SSR/other-operation coverage. The existing conversation list's
message/tag joins cannot simply be enabled under this scalar profile.

P1 and R3 remain open. The owner-approved schedule-after-logout policy remains;
its final send cutoff awaits the separate rule11 proposal. No deployment, live
account/provider/user-database change or new milestone is authorized.
