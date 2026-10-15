# P1 limited support-list implementation

## Scope and implementation

Contract: p1-support-list-activation-contract-2026-10-15.md, PLAN P1 §§8/9/15/16.
Code identity is the containing local commit (Git), based onc78a1ff. Independent
checkout p1-support-identity/owly excludes the incomplete follow-up integration.

Identity resolves an explicitly selected own support grant only for GET
/api/conversations + conversations:read. Actual signed person, current platform
control/role, assignment, grant, workspace, scope, session and mandatory audit
establish role:null support context; API keys (including empty headers), conflicting
workspace cookie, missing permission and every other route/method deny without
fallback. Locators confer no authority and no support selection is persisted.

Conversation service uses the eight-scalar query profile and root count, never the
normal message/tag joined DTO. Before exposure of either rows or count, placement
finishes before final fresh audited authority resolution. Same actor/session/grant/
workspace/placement and unchanged normalized scope required, with final synchronous
deadline checks. Any change discards all results. Support responses private,no-store.
No detail, paid knowledge, campaign, SSR, stream or job gains support authority.

Support console adds limited table, search, ten-row paging, Refresh and Close. Each
request aborts/invalidates prior work and clears rows/count; close, grant change,
mutation or expiry invalidates outstanding responses. Conflicting workspace selection
requires an explicit signed same-origin DELETE /api/workspaces and retry. This clears
only selection, not person session and creates no customer membership.

## Executed verification

- Tests first: initial ten actual GET/auth/clear route cases produced9failures and
  one ordinary-member compatibility pass. Missing DELETE was a missing capability;
  no exposure-race claim rests on that failure.
- Independent security review found an awaited final-placement revocation gap.
  Added real GET tests that revoke actual grant or actual JTI during the second
  placement lookup. Both returned200 before correction (2desiredfailures).
  Final placement now finishes before final audited authorization; both pass.
- Complete platform-authority file: **78passed**, real isolated Postgres/JWT/services.
  Includes26new route/exposure cases: actual own operator without membership,
  scalar ownership/search/count/projection, foreign/random/revoked selection with
  actual owner fallback denied, method/path/operation/key denial, cookie conflict,
  initial assignment/platform/workspace/expiry/audit loss, post-query scope narrowing/
  assignment/platform/workspace/grant/session loss, final audit failure, placement
  races, member compatibility, explicit selection clear auth/origin/key denial.
- Full **148files1452passed/1skip**, exit0. Real Redis6381; skip is mutually exclusive
  no-Redis placement-cache control. Dedicated DB/RLS and pg-boss restart included.
- Signup-seeded **79files912passed**, exit0. Type and strict lint passed.
- Independent source security recheck closed placement finding with no additional
  confirmed issue. Reviewer ran no tests/browser. UI abort/sequence/expiry/unmount
  behavior source-reviewed; this is not executed browser evidence.
- Independent harness review identified weak page2/rendered-ID assertions, missing
  read-audit assertions and a foreign fixture hidden by an unrelated predicate.
  Harness now checks exact rendered page IDs/unique union, actual-actor allowed/denied
  read audits and adversarial foreign metadata naming the allowed source. Source
  recheck requested. J22/new full browser **not run yet**; no UI acceptance pass.

Sanitized logs: /private/tmp/ziyrak-p1-support-list-{red,placement-red,platform-final,
full,signup,type,lint-final}.log. Initial expanded platform run77pass/1fixture error
(missing assignment scope operatorUserId); corrected fixture, complete rerun78passed.
Expected rejected-build child errors in full-suite log belong to runtime safety tests,
not acceptance build failures; runner exited0.

## Remaining

Freeze candidate, fresh isolated acceptance DB, migrate/build/start real separate
worker + local AI stand-in + trusted installed Chrome, run complete22suite with new
J22 and inspect screenshots. Record exact commit/build/digest/environment/exit outcome.
Afterwards stop only exact owned topology and verify remainingOwned=[]. Do not call
P1 complete: other support operations/streams, delayed origins, restricted UI and
follow-up final admission remain open. Owner selected schedule lifetime after logout;
rule11 admission cutoff and R3 residual-risk acceptance are still undecided.
No deployment/real-provider/account/userDB or new milestone action.
