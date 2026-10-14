# R1 implementation and verification

Approved scope: PLAN R1 and the October 14 delivery-contract correction.
All product work runs in the isolated attached worktree; live main services,
provider configuration and the `owly` database were not changed.

## Implemented, acceptance still open

- Tenant-scoped durable delivery operations, composite tenant foreign keys,
  saved replies and preparation/dispatch leases.
- Retry a known refusal using the saved response; accepted and uncertain sends
  are never automatically replayed. Interrupted preparation requires review.
- Signed-in owner/admin/supervisor recovery in Approvals, strict destination/body
  boundaries, actual-actor auditing and compare-and-set decisions.
- Typed Meta outcomes and bounded transport timeout; provider acceptance remains
  separate from recipient delivery.
- GDPR cancellation/redaction includes queued follow-ups and recovery reasons.
- Acceptance scripts pin paired isolated database URLs, track source/build/run
  identity, verify listener ownership and signal only recorded owned processes.

## Executed evidence (October 14, candidate working tree)

Product baseline: `c20513d78421816ac0096eff1cf3dbb0d6c9aa55`.
Pre-fix regression checkpoint: `7aa004f530a4cbbbea7ae95b6bbb582191da959c`.
The containing implementation commit will identify this candidate through Git.
Paired database URLs target `ziyrak_r1_test_20261014`; no acceptance/user DB cleanup.

| Criterion/layer                                | Status  | New evidence and limits                                                                                                                                                                                                             |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original failures and replay contract          | Passed  | Six mocked regressions; five failed/one control passed before source changes.                                                                                                                                                       |
| Recovery auth/tenant/FK boundaries             | Passed  | Eight tests with real Postgres and actual route authentication, including current role/revocation and foreign-tenant listing.                                                                                                       |
| Independent review regressions                 | Passed  | Seven real-DB regressions failed before fixes: connection ownership, delayed erasure, recovery reason redaction/concurrent audit, stale parent projection and two terminal-cancellation races.                                      |
| Existing integration behavior                  | Passed  | Combined six-file run: 29 tests, including actual pg-boss refusal/retry (synthetic provider).                                                                                                                                       |
| Persistence/concurrency/preparation durability | Passed  | Four real-DB tests: saved reply reuse, acceptance followed by failing transcript transaction, completed side effect preserved without replay, competing worker claims.                                                              |
| Harness safety fixtures                        | Passed  | Seven tests; real owned child processes, synthetic build identity. Missing topology regression failed before fix.                                                                                                                   |
| Actual worker crash/restart                    | Passed  | Actual test-owned child SIGKILL and replacement worker with real pg-boss; natural heartbeat/lease expiry, one external submission, human-review state. Took 73.4 seconds; no live worker signal.                                    |
| Typecheck/lint/build/full regression           | Passed  | Full128 files/1175 passed,23 optional Redis skips; signup-seeded63 files/680 passed. Type/lint and actual Next16.4 production build passed.                                                                                         |
| Independent implementation review              | Passed  | Independent read-only security review rechecked all confirmed delivery and harness findings as resolved in source. Executed evidence is from the lead, not the reviewer.                                                            |
| Existing queue upgrade                         | Passed  | Real pg-boss existing-queue retry limit/delay regression failed before fix; mutable configured settings now applied on upgrade. Existing active jobs retain sent settings.                                                          |
| Meta outcome contract                          | Passed  | Eight deterministic mocked Graph checks classify rejection/uncertainty, timeout, acceptance reference and ownership preflight; no real Graph call.                                                                                  |
| Operator recovery UI and full browser suite    | Passed  | Fresh final run of all17 scripts exited0 on63247f67e1eae399f8a04cc214e54937d91c9465, buildGg0DWAo-ZUcXzw2VozQmS. Actual ack/resend, one reply after reload, interrupted cancel, foreign404 and owner audit2; screenshots inspected. |
| Affected real Meta boundary                    | Not run | Separate R4 requirement; no stand-in or local persistence proves live recipient delivery.                                                                                                                                           |

Provider faults and customer content in tests are synthetic. Real Postgres and
pg-boss establish those boundaries only; no production delivery/rollout claim.
Dependency risk remains R3 work, with the fresh audit recorded separately.

## Browser candidate and harness corrections

Product/build candidate: `22a99518e987979aa08fba58a5a7891ed5962f25`.
The fresh final migration was applied to browser-only isolated databases.
Browser2 evidence lives in `scripts/acceptance/.work/r1-browser2-20261014`.
The first run exposed duplicate SQL column-name collapse; array row mode fixed it.
J17 exposed JSON objects becoming `[object Object]`; explicit JSON serialization
fixed it. Permanent J04/J17 assertions observed those failures before repair.
All16 existing scripts then passed and J17 passed on focused rerun. No application
source was changed by these evidence repairs. The next clean run uses fresh data
and the corrected helper; preserve these earlier failures as history, not passes.
Screenshots were visually inspected for actual recovery and visitor outcomes.

Final browser run: `scripts/acceptance/.work/r1-final-20261014`, fresh
`ziyrak_acceptance_r1_final_20261014`, independent synthetic secrets and LLM stand-in.
All17 scripts passed in the real dependency-order runner; no previous-run dataset
was reused. Stop rehearsal completed and no matching recorded owned processes
remain alive. Historical run manifests retain process records for evidence.
R1 local criteria are passed; provider-specific live verification remains an R4
acceptance requirement and does not authorize deployment.
