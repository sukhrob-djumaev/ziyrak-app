# Current P1 task (reconciled 2026-10-17)

P1 incomplete/P2 ineligible. Main docs-only. Support text-message read: contract on main
(9de3f54, 360da65). Development worktree /Users/sukhrob/.codex/worktrees/p1-support-identity/owly
(detached) already holds d1b81a4 failing regressions, 2a07191 implementation, bb45ed8 gate
tests + J22 console extension (parent 72873e3). Checked this session on bb45ed8: tsc exit0,
lint --max-warnings 0 exit0. NOT yet run: platform-authority/support-query tests on real PG,
J22 browser, independent security review, full browser. Criteria remain NOT RUN/open.

EXTERNAL BLOCKER (confirmed 2026-10-17): shared Docker Postgres localhost:5432 accepts TCP
but pg handshake times out (8s); `docker ps/info` hang. Redis 6381 TCP open (unverified).
Retry condition: user restarts Docker Desktop (or confirms PG healthy); then create a fresh
DB (e.g. ziyrak_test_support_msgs_20261017), set DATABASE_URL+DIRECT_DATABASE_URL, run
`npx vitest run tests/security/platform-authority.test.ts tests/security/support-query-profile.test.ts`,
then affected/full suites, independent security review, J22 + fresh full browser on an
identified candidate. Do not touch live 7700, acceptance or user DBs.

Recheck 2026-10-19: Docker daemon not running (docker.sock absent), localhost:5432 closed. Blocker unchanged: user must start Docker Desktop and the shared PG.

Update 2026-10-19 (blocker CLEARED): Docker/PG healthy (owly-db-1). Fresh DB
ziyrak_test_support_msgs_20261019b migrated (prisma migrate deploy). On dev worktree bb45ed8:
platform-authority + support-query-profile 129/129 pass; full `npm run test` 150 files,
1478 passed/23 skipped, exit0 (isolated DB only; skips not a pass). Independent security
review of 72873e3..bb45ed8 (read-only subagent, source only, ran no checks): no leak/bypass;
one low contract deviation (final-check parent loss gives 404 not SUPPORT_CONTEXT_CHANGED)
resolved by contract wording (same 404, no oracle); weak assertions tightened in dev d7eba31
(platform-authority 97/97 on isolated DB). Dev head now d7eba31. STILL OPEN:
full-suite rerun on d7eba31 (tests only change), J22 browser, fresh full browser on a frozen candidate, build. Do not
touch live 7700, acceptance or user DBs. Leftover DB ziyrak_test_support_msgs_20261019
(pre-existing, unknown owner) untouched.

--- Earlier state (still valid for Settings) ---

P1 incomplete/P2 ineligible, MS-2026-10-14; main docs-only. Development
/Users/sukhrob/.codex/worktrees/p1-support-identity/owly clean504d08e: Settings product7fc5dab
plus login-wait harness repair. Product digest45f6b5e938e6393a402aebdaa7ca30dc6c020bc64d1b862804162b13622147d3.
Affected53/full150files1476+1Redis-mode skip/signup81files936/type/strictlint pass exit0;
independent security/harness source closure clear, reviewers ran no checks. Own3200/PG
6green exit0 and exact-owned probe stopped/absent. Settings evidence/contract in docs.

Runtime /Users/sukhrob/.codex/worktrees/r1-delivery-reliability/owly58e9ff3.
Focused2 buildPd7JxJEi0zqIn_436mr1v J24passed exit0, screenshots inspected; exactowned
stop/remainingOwned=[] verified. Same productdigest above. Full -settings-full.env
freshEMPTY ziyrak_acceptance_p1_settings_20261015 recheckedBusiness0; full24 FAILED
exit1 on build96ITzoFyBUJCwB4Dut7X8, unchanged product digest above. Seventeen journeys
passed; J18 timed out at line82 waiting for obsolete Settings text "Insufficient
permissions"; current server denial says "Access denied". Six later journeys not run.
This is a confirmed source/assertion mismatch, not a new product acceptance pass.
Log /private/tmp/ziyrak-p1-settings-full-browser.log; session88489 exit1 collected.
Workdirp1-settings-20261015. Exact owned stop/remainingOwned=[] verified. Failed DB/
profiles retained, never reset. Next repair J18 assertion in NON-serving development,
independent harness review, new candidate/build/fresh full24 and exact cleanup.

Prior92/buildJ-\_zhfIwE6uMJRaeusp8r J21actual5Settingsroles passed exit0. J24 first
browserTargetclosed beforefixtures (rootcauseunknown), retrymissingloginselector fixed
by explicitwait; independent recheckclear. No productfailure inferred. Prior topology
stopped/remainingOwned=[] verified, failedDB/profiles retained. CorrectedJ24 and exactcleanup now passed as above; fresh full24 remains open.

Administration89/afcab/buildOxGeKpu78acIcGaW740sU fresh23+supplementuser403/no persistence
passed exit0, screenshots checked/exactstopnone; separate earlier source. Original
p1-workspace-access/owly follow-upWIP19focused16pass3admission races excluded. Logout-
surviving schedule approved, final cutoff/R3 acceptance pending, no waivers. Nexteligible
independent P1 afterSettings: safe support text-message read; restrictedmembereditor
activation waits delayed lifecycle. Live7700/provider/account/userDB untouched. PairedDB/
exactPIDbirthcwd only, retain Redis6381/sharedPG. No push/merge/deploy/tag/newphase/reset.

Support-message investigation only, no code: independent security source review
requires exact selected-parent/text-only SQL predicates for rows+count, final parent
verification composed inside final audited grant check before session/expiry checks,
and no promise of recall after the final checked snapshot. Contract/tests still due.

Update: J18 repair committed in development worktree as 72873e3 (assertion text only,
syntax/format checked). Pending: independent harness review, new candidate/build,
fresh full24. Acceptance still open; no run claimed.

Update2: fresh full24 on runtime 897fdff/build bJsO0xiUf7E8wvd83Irjm, unchanged product digest, empty DB ziyrak_acceptance_p1_settings_j18_20261015: 24/24 PASSED, exact owned stop verified. OPEN: screenshot inspection (needs /add-dir of the workdir); harness review lead-only. Next: support text-message read, tests first.
