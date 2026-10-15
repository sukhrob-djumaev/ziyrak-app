# P1 operator provisioning and named assignments

Implementation in the isolated P1 worktree, based on91c301c. Not merged or
deployed. Support activation remains unavailable; this slice does not grant any
customer-data access. PLAN P1 and §15.2 govern.

## Contract and exact selected acceptance

Platform services own new operator identities, named workspace/operation/resource
assignments, monotonic revocation and mandatory control-plane audit. They depend
on identity password/session contracts and existing control-plane persistence;
tenant services continue to consume explicit TenantContext and scoped repositories.
No platform role becomes a workspace membership or an implicit support grant.

> Super admin provisions operators and assignments; owners/admins manage only
> permitted workspace roles.

> Completion criteria: allowed and denied cases pass; no blanket tenant bypass;
> privileged bootstrap/recovery and audit behavior documented/tested; existing users
> retain legitimate access without gaining privilege. Support access records actor,
> target workspace, scope, reason and lifetime. P3 supplies the shared invitation
> lifecycle; until then use secured operator provisioning, never public role assignment.

This slice addresses secured provisioning/assignments; the entire P1 completion
criterion remains open until explicit grants, streams/delayed work and remaining
restricted-resource UI acceptance pass. No invitation lifecycle is claimed.

## Changes

- Super-admin-only API/UI creates a new operator account, rejects existing names,
  hashes a password of at least12characters and at most72UTF-8bytes outside the
  control lock, then rechecks current
  revocable session and platform role inside the shared transaction. UTF-8 input
  exceeding bcrypt's72-byte bound is rejected rather than truncated. No password,
  hash, token, provider credential or connection config is returned/audited.
- Named assignments require active workspace, current operator, nonempty explicit
  read-operation allowlist, resource/profile scope, reason and optional future
  expiry. Selected connections are validated on the shared control plane,
  including for dedicated placements; composite foreign keys remain the backstop.
  Unknown/empty scope and owner/team/settings/tool-execution permissions deny.
- Assignments are immutable. Revocation and operator-role removal atomically
  revoke linked grants/assignments with mandatory actual-actor audit. Audit failure
  rolls back the mutation. Existing person credentials and memberships are preserved.
- Management UI presents Access denied with no forms for non-super accounts.
  Selection defaults to restricted connections/no shared profile capability.
  Management lists explicitly report truncation beyond200entries; pagination and
  broader support UI remain follow-up work. No customer content is listed.
- Independent review found that public signup/workspace-user/operator creation did
  not share atomic case-insensitive username coordination. Two controlled realPG
  races reproduced dual commits before repair. All three application creators now
  reserve the normalized name inside their User-insert transaction; tests require
  one identity and a clean409 loser. Existing names are not rewritten. Raw fixture/
  seed writes do not use this application reservation contract.

## Verification checkpoint

- Initial tests-first service run failed at the missing new module (no behavioral
  assertion executed); this is distinguished from the two later namespace-race
  regressions, which failed their desired409 assertions against actual dual commits.
  -34focused realPG platform cases passed, including HTTP/person/key/Origin denial,
  hashing/duplicate protection, audit rollback, scope/foreign refs, removal/revocation,
  competing case variants, recovery/session revocation during hashing, and dedicated
  placement control-plane validation. The same34passed with real Redis selected.
- Full144files/1319passed,23optional skips; signup-seeded75files/812passed.
  Type check and strict lint passed. First lint identified an impure render-time
  clock; UI now compares expiry against the server's management-evaluation timestamp.
- Independent source-only security review confirmed the namespace fix and found no
  remaining confirmed issue in this slice. Independent source-only harness review
  fixed an ambiguous no-workspace probe by explicitly selecting the assigned target;
  neither reviewer executed checks or accepted the broader P1 boundary.
- Fresh production browser suite expanded to22sequential journeys, adding J21
  actual five-role checks and J22 operator UI lifecycle. Running; no pass claimed yet.
  Runtime parentc2a4562, buildM_rq0OTQsJstuUKedMRia, product digest
  bd9c2ba6a6d8ff59da394077c548cb9292cb6b112d7751246674ffe8381ee94b.
  Development/runtime product digests match. Local LLM stand-in, synthetic accounts
  and owner proofs; real Postgres and Redis, production web and separate worker.

Logs: `/private/tmp/ziyrak-p1-operators-{namespace-red,namespace-green,full-final,signup,
redis,type2,lint2,build,browser}.log`. Test DBs are distinct from fresh acceptance
`ziyrak_acceptance_p1_operators_20261015`; both database URLs are pinned together.
No real AI/mail/Meta delivery, support activation, P1 closure or rollout is claimed.
