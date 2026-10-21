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

Update2 2026-10-19 (support text-message read, candidate d7eba31, product digest
ef9db79c95abd4f467879ce7a9c3d9270a8928d7276793ea3cf63e0a81f20ef3 same as bb45ed8): tsc/lint
exit0; full unit suite 150 files/1478 passed/23 skipped on isolated PG; fresh FULL browser
24/24 PASSED incl. J19 (Redis 6381, prefix ziyrak_acc_p1_support_r3:) and J22 text-message view,
build thvv7QyOM4jCGfIRWYUEY, DB ziyrak_acceptance_p1_support_msgs_20261019r3, work dir
/private/tmp/ziyrak-p1-support-msgs-work-r3, log /private/tmp/ziyrak-p1-support-msgs-full-r4.log.
Deviation: headless system Google Chrome via CHROMIUM_PATH (puppeteer Chrome 148 not installed,
download failed); isolated profiles. Screenshots j22-support-text-messages/-messages-revoked
inspected OK. Stand-in AI, no provider/delivery claim. Exact owned stop, remainingOwned=[].
Earlier attempts r2/r3 (no Redis; J01 browser-missing, J19 no REDIS_URL) are not passes. Stale
15:23 topology (PIDs 83211/83369/83457/9376) stopped with user approval. Failed/old DBs retained.
Independent review lead-only for harness; security review independent. NEXT: independent
review of full-diff 72873e3..d7eba31 not needed beyond done; remaining: user decision to merge
dev commits (d1b81a4, 2a07191, bb45ed8, d7eba31) into main, then next eligible P1 task
(restricted member editor waits delayed lifecycle). No push/merge/deploy/tag/new phase.

Update3 2026-10-19 (INTEGRATED): user-approved local merge commit 485cc9b brings dev line
d7eba31 (support text-message read + Settings/Administration/support-list work) onto main; docs
conflicts resolved keeping main's newer state; code tree identical to d7eba31 (src/prisma/
scripts/tests diff empty). Verified on 485cc9b in idle runtime worktree: tsc/lint exit0; full
suite 150 files/1478 passed/23 skipped exit0 on fresh migrated DB ziyrak_test_support_msgs_
20261019d. Deviation: run with CLI --hookTimeout=120000 --testTimeout=180000 because host load
~250 (unrelated dartvm processes) caused 10s hook timeouts in 3 earlier runs (not product
failures; one earlier run also hit a dirty DB I contaminated). Browser 24/24 evidence is for
d7eba31 (same product digest). No fresh browser on 485cc9b (docs-only delta). No push/tag/
deploy; main ahead of origin. NEXT: restricted member editor still waits delayed lifecycle;
phase/milestone boundary otherwise reached. Prohibited: push/release/new phase without approval.

Update4 2026-10-19: OWNER APPROVED docs/p1-followup-admission-proposal-2026-10-15.md (bounded
local implementation + tests only; no deploy/provider/account change/milestone closure). Task:
delayed follow-up sending admission (fences, coherent admission, retirement markers). Existing
uncommitted WIP is in /Users/sukhrob/.codex/worktrees/p1-workspace-access/owly on old base c78a1ff
(16 files +342/-52); do not trust it as current; port selectively onto a fresh dev worktree from
main 485cc9b. Tests-first: the 3 red cases in tests/security/followup-authority.test.ts.

Update5 2026-10-19 (follow-up admission, IN PROGRESS, dev worktree
/Users/sukhrob/.codex/worktrees/p1-followup-admission/owly detached, base 7b7942a, commit 9320fbf):
ported old WIP + single sending admission: tenancy withAdmissionSession (control fence then
data fence; shared placement reuses one tx), bound identity/policy/provider/destination readers,
key expiry judged at final timestamp before the conditional claim, transport after release.
Tests rewritten to contract (writer blocked behind admission; change committed before admission
blocks). Verified there on isolated DB ziyrak_test_followup_admission_20261019: tsc/lint ok,
followup-authority 21/21, tests/repository + delivery unit/security suites pass (239). NOT yet:
(1) admitted-then-retired attempt marker (sanitized nonreplayable, needs schema+migration, scope
tables; DeliveryOperation cascades from conversation/action); retirement currently labels admitted
'sending' ops cancelled and loses transport outcome; (2) tests: retirement/erasure with held
transport for accepted+uncertain, dedicated lock order + both commit-failure directions, two
workers/one claim, real pg-boss retry/restart, adapter scoped write proves locks released, policy
creation while default applies, shared tx reuse; (3) all authority-reducing writers inspected for
the fence (scoped-prisma mutations already fenced; list non-scoped writers e.g. platform/session);
(4) PLAN/§8,15,24,25,31,33 + dispatch-contract doc clarifications; (5) independent security
review, full regressions, fresh full browser. P1 stays open; no push/merge/deploy.

Update6 2026-10-19: admission dev worktree now at 211d903 (3 commits over 7b7942a). Added:
sanitized retired-marker for admitted in-flight attempts (redacted, detached, 'unknown', late
outcome settles via retirement ctx; recovery/list/resend refuse retired), writer-inventory test
(authority-reducing writers all via fenced scoped repo; no app membership/suspension writer yet),
two-worker one-claim, adapter-scoped-write fence release, dedicated session lock order/no
deadlock/both commit-failure directions (primitive level), real pg-boss retry revocation.
Verified on isolated DBs: followup-authority 28 tests, admission-session-dedicated 5, full suite
at b85e349 151 files/1503 passed/23 skipped (211d903 adds tests; full rerun pending). PLAN and
dispatch-contract clarified (docs only, no acceptance claimed). Independent security review of
7b7942a..211d903 delegated read-only, result pending. STILL OPEN: review findings, dispatch-level
dedicated test (claim committed + control failure never calls adapter) not written, full rerun,
fresh full browser, merge approval to main (code is NOT on main), P1 closure. No push/deploy.

Update7 2026-10-19 (follow-up admission VERIFIED in development, NOT on main): dev worktree
/Users/sukhrob/.codex/worktrees/p1-followup-admission/owly head 9d37bc8 (base 7b7942a; commits
9320fbf, b85e349, 211d903, 9870516, 9d37bc8). Independent security review (read-only subagent,
ran no checks): no leak/bypass; findings fixed in 9870516 (frozen workspace-bound control reader,
outer tx timeout margin, notAfter validation, send from admitted row, sequential provider reads in
session, marker for already-uncertain attempted ops) and test hardening; 'add failed to denied
action statuses' declined (retryable refusal projects action to failed; real pg-boss retry relies
on it); hostile-getter copy of authorizer result not done (trusted internal code). Verified:
tsc/lint exit0; full unit suite 153 files/1519 passed/23 skipped (isolated PG, at 9870516).
Browser: first full run on 9870516 FAILED at J17 (fixture: synthetic follow-up without saved
authority correctly refused; harness repair 9d37bc8, lead-only harness review). Fresh FULL browser
on 9d37bc8 build 4bFB8NhnUvuQzcBn-65Sx (product digest a2a6a427...21a45fb, unchanged vs 9870516),
fresh DB ziyrak_acceptance_p1_followup_admission_20261019b, Redis prefix ziyrak_acc_p1_followup_adm2:,
system Chrome via CHROMIUM_PATH: 24/24 PASSED exit0, log /private/tmp/ziyrak-p1-followup-admission-
browser2.log, J17 screenshot inspected, exact owned stop remainingOwned=[]. Failed-run DB/log
retained. Stand-in AI, no provider claim. NOT DONE: dispatch-level dedicated placement browser/
end-to-end (primitive + dispatch-level shared tested); full unit rerun on 9d37bc8 (script-only
delta). OPEN: owner approval to merge dev line into main; restricted member editor (waits on this
landing), campaigns/recovery requester/manual webhook retry origin integration, P1 closure, R3
final cutoff. No push/deploy/tag.

Update8 2026-10-19 (INTEGRATED + PUSHED): owner-approved merge commit e18389f brings follow-up
admission line 9d37bc8 onto main (no conflicts; src/prisma/scripts/tests identical to 9d37bc8).
Verified on e18389f in idle runtime worktree: tsc/lint exit0; full suite 153 files/1519 passed/
23 skipped exit0 with DEFAULT timeouts on fresh DB ziyrak_test_merge_e18389f_20261019. Browser
24/24 evidence is for 9d37bc8 (same product digest; docs-only delta). Owner then authorized
`git push` of main to origin (fast-forward, origin/main had no new commits). Still OPEN: restricted
member editor, campaigns/recovery requester/manual webhook retry origin integration, other
support surfaces, R3 final cutoff, P1 closure. No tag/release/deploy.

Decision 2026-10-19 (owner): P1 support access scope is the audited, read-only limited
conversation list plus per-conversation text messages ONLY. Customer details/notes, realtime/
streams and other support surfaces are out of P1 (later work under the same grant contract).
P1 closure plan: closure matrix doc first, then restricted member editor, delayed-work origins,
final cutoff record, P1 acceptance pass (independent review + full role browser run). Open
questions to ask one at a time: delayed-work paths in P1, restricted-editor scope, R3 advisory
timing, housekeeping deletion approval.

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

## Update9 (2026-10-19, delayed-work scope)

Owner: all three delayed paths (campaigns, recovery resend, webhook retry) are in P1.
Findings and proposal: docs/p1-delayed-work-origin-proposal-2026-10-19.md (campaigns need a
CampaignRun migration, awaiting owner approval, rule 11). Closure matrix:
docs/p1-closure-matrix-2026-10-19.md. Dev worktree p1-delayed-origin (at ab17c20, no code yet).
Next: restricted member editor (no approval needed) while the proposal waits. No pushes.

## Update10 (2026-10-19, restricted member editor)

Dev worktree p1-delayed-origin (head 5e572ad on top of main ab17c20; commits 9324552 editor
backend, 99cf0bb UI, 9266e7a J25 journey, 5e572ad review fixes). Editor: PUT /api/admin/users/[id]
accepts `scope` (workspace|connections, connectionIds, customerProfileAccess default none); raw
control-plane transaction under lockTenantWrites; target + acting admin re-read under the fence;
no self/owner edits; grant ceiling = actor's profile access; list shows scope only to
workspace-wide viewers. Independent read-only security review: no access-widening path found;
three findings fixed with tests first. Unit evidence on 5e572ad: tsc/lint clean, 154 files / 1532
passed / 23 skipped (clean npm ci in the worktree; main's node_modules makes 3 patched-dependency
tests fail, pre-existing). Frozen build + full browser run (25 journeys incl. J25) in progress,
DB ziyrak_acceptance_p1_editor_20261019a. Not merged. Delayed-work proposal still awaits owner
approval (campaign CampaignRun migration; webhook retry recheck or waiver).

## Update11 (2026-10-20, restricted member editor verified, awaiting merge approval)

Dev head acd4c42 (worktree p1-delayed-origin, on main ab17c20). Verified on that exact head: tsc/lint
clean; full unit 154 files / 1556 passed / 1 skipped (clean npm ci; paired DATABASE_URL and
DIRECT_DATABASE_URL); fresh empty-DB frozen build + full browser 25/25 incl. new J25 (UI restrict,
reopen, member sees only the granted channel's conversation, widen restores). Independent read-only
security review: no access-widening path; findings fixed with tests (profile access defaults to
none, grant ceiling, actor re-read under fence, UI sends scope only when changed, inventory test
tightened). Browser found a real bug unit tests missed: /api/channels pads id-less per-type
placeholders, so the editor now uses GET /api/admin/connection-options (real connections only).
Earlier full runs: J22 timed out intermittently (hidden tab pauses requestAnimationFrame waits);
fixed in the harness (bringToFront), lead-only harness review; J25 fixture/probe bugs fixed.
Limits: stand-in only, no provider claim; dedicated placement not end to end; connection names can
repeat (UX). Topology stopped, DBs ziyrak_acceptance_p1_editor_2026102* and
ziyrak_test_p1_delayed_20261019 retained. Needs owner: merge approval for acd4c42 (merge commit);
approval of the delayed-work proposal (CampaignRun migration; webhook retry recheck or waiver).
Prohibited: push, P2/P3, deleting DBs/worktrees without approval.

## Update12 (2026-10-20, editor merged, delayed-work approved)

Member access editor merged into main as 8ad8457 (merge commit of acd4c42) and pushed on owner
instruction; CI on 8ad8457 green after a rerun (first run failed once on
tests/unit/realtime-bus-multi-instance.test.ts redis case, a Redis connect timeout on the runner;
untouched by the merge; cause not investigated). Owner approved the delayed-work proposal: (A)
CampaignRun migration with per-recipient operations, (B) webhook retry requester recheck (not
waived). Order: campaigns, recovery resend, webhook retry; each tests-first, independent security
review, then a full frozen browser run. `.claude/settings.json` committed (bcfa29e, local).
Prohibited: push without approval, P2/P3, deleting DBs/worktrees.

## Update13 (2026-10-20, delayed-work slices verified on dev, awaiting merge approval)

Dev worktree p1-campaign-run (branch p1-campaign-run, head 92ac544, based on main 681f46b; not
merged, not pushed). Contract: docs/p1-campaign-run-contract-2026-10-20.md (on that branch).
Slice 1 campaigns: CampaignRun migration (20261020120000_campaign_run, additive), frozen message /
connection / targets / requester identity, per-recipient DeliveryOperation (kind campaign, key
campaign:<run>:<customer>) through the single sending admission, requester rechecked per recipient
(automation:create, whole-workspace scope, profile access), serialized starts, cancel on enqueue
failure, erasure scrubs run targets. Slice 2 recovery resend: approver membership recorded in the
recovery log and rechecked at admission for follow-ups and campaigns. Slice 3 webhook retry: requester
identity in the job payload, rechecked before any request. Two independent read-only security
reviews: no bypass; all confirmed findings fixed with tests. Evidence on 92ac544: tsc/lint clean;
full unit 156 files / 1574 passed / 23 skipped (the skips are Redis-gated tests; CI runs them);
fresh empty-DB frozen build + full browser 26/26 incl. new J26 (log in scratchpad browser6.log,
DB ziyrak_acceptance_p1_campaign_20261020a retained), topology stopped, ports free.
Limits: webchat send is a no-op so J26 proves admission/persistence/worker, not provider delivery;
no campaigns screen exists; no operator cancel path for a stuck run; inbound replies are not
rechecked on resend; legacy approved resends fail closed; screenshots not inspected; reviews were
agent reviews (not human). Needs owner: merge approval for p1-campaign-run (merge commit, then CI on
the exact head). Remaining P1: cutoff/logout-surviving schedules (R3 decision), whole-surface
review, full role-by-role browser run. Prohibited: push, P2/P3, deleting DBs/worktrees.

## Update14 (2026-10-21, R3 Puppeteer 25 candidate verified, awaiting owner)

Branch r3-puppeteer25 (head after this record; code commit fcb2487 on main a34f8bf), worktree
/Users/sukhrob/.codex/worktrees/r3-puppeteer25/owly. Not merged, not pushed. Puppeteer 25 removes
extract-zip: production audit 5 high -> 0, full 10 -> 5 (braces lint chain only). Verified on
fcb2487: tsc/lint clean; unit 1573 passed / 23 skips, Redis-backed 1595 passed / 1 skip; Docker
build + offline non-root probe; full browser 26/26 in headless-shell mode (fresh DB, frozen build).
Harness: opt-in ACC_HEADLESS=shell and explicit select() in J15/J20/J24. Windowed-mode runs had
stalled at random journeys on both old and new code (locked screen, runaway Dart language server,
macOS indexing); old code in shell mode untested. Details: docs/r3-remediation-2026-10-15.md
(Update 2026-10-21). Needs owner: (1) approve merging r3-puppeteer25 (touches whatsapp-web.js, no
real WhatsApp session tested); (2) accept or reject the braces lint-tooling residual. P1 paused at:
cutoff/logout-surviving schedules (R3 decision), whole-surface review, full role-by-role run.
Prohibited: push/merge without approval, P2/P3, deleting DBs/worktrees.

## Update15 (2026-10-21, R3 closed locally)

R3 merged into main as d0bc61f (PR #29, exact-head CI green on 4bb3134); owner accepted the braces
lint-tooling residual. Main is ahead of origin and unpushed (needs owner approval). R3 complete
locally, not deployed. Next: back to P1 (cutoff/logout-surviving schedules needs the owner
decision; whole-surface review; full role-by-role browser run). Prohibited: push without approval,
deploy, P2/P3, deleting DBs/worktrees.
