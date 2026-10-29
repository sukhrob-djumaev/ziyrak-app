# Current task — LP-2026-10-25 launch preparation

## Status
- Owner explicitly APPROVED L1–L6 launch preparation on 2026-10-25 and requested clean Claude/Codex continuation.
- Selected roadmap: PLAN live board → `docs/launch-roadmap-2026-10-25.md` (L0–L7).
- L0 and continuation preparation COMPLETE. L1–L6 product implementation NOT STARTED; criteria NOT RUN.
- L1.1 safe verification harness MERGED (PR #36, `9f9b4ec`, CI green on head `bc15eaa`; no browser trigger: tooling-only). Residuals: DB ownership is name+local host+env (no in-DB marker); load check `realtime cross-replica` FAILS (unbaselined, owner of L2.1/F-triage); fence CLI proven only in the rehearsal. Record: `docs/evidence/l1.1-safe-verification-harness-2026-10-25.md`.
- L1.2 MERGED (PR #37, `5b67aae`): exact-head CI green + combined-build browser 30/30 on `4660de4`. Record: `docs/evidence/l1.2-dependencies-http-boundaries-2026-10-25.md`.
- L1.3 MERGED (PR #38, `6249869`): CI green + browser 30/30 on `995d496`. Record: `docs/evidence/l1.3-account-secret-safety-2026-10-26.md`.
  Open from L1.3: MFA is `optional` by default (set `ZIYRAK_PLATFORM_MFA=required` only after the enrollment UI + journey exist); `TRUSTED_PROXY_HOPS` edge contract (L2.1);
  per-account TOTP lockout/alerting; no browser journey for enrollment. Owner decision recorded: first enrollment needs a super-admin setup code (or owner proof for the first super admin).
- L1.4 deterministic part MERGED (PR #49, `fd2ea15`): scorer fixes, run-validity gate, frozen holdout, human rubric. OPEN/BLOCKED: real-model evaluation on the holdout + human sample review need `OPENAI_API_KEY` (not present here) and an owner decision on model/spend. Record: `docs/evidence/l1.4-quality-evidence-2026-10-26.md`.
- L2.1 MERGED (PR #50, `926add3`): liveness/readiness split, worker heartbeat + queue signals + build identity, startup configuration contract (strict in production; `ZIYRAK_CONFIG_PROFILE=relaxed` only for local Compose/harnesses), Helm chart contract incl. existingSecret + PgBouncer. CI green + browser 30/30 on `3a1172a`. Record: `docs/evidence/l2.1-runtime-contract-2026-10-26.md`. Open: live outage drill, cluster probe behaviour, alert wiring.
- L2.2 MERGED (PR #51, `c19c4fe`): slim reproducible image (3.87 -> 1.55 GB, Trivy 0 fixable HIGH/CRITICAL, bundled worker, no npm/src/dev tools), CI `image` job (build/smoke/scan), publish workflow gated (tag or main + push-to-main CI; NOTHING published), restore drill, migration expand/contract guard, runbook, `image.digest` in Helm. CI green + browser 30/30 on `f67d70c` (ran on battery). Record: `docs/evidence/l2.2-release-operations-2026-10-26.md`. Open: RPO/RTO, backup mechanism, alert routing, incident owners, whole-workspace offboarding (INPUT NEEDED, in runbook); actions/base image not digest-pinned; no live outage drill.
- L3.1 MERGED (PR #52, `786e89b`): permission-derived nav + route guard, My account, truthful forms, channel matrix, owner-aware onboarding, J13 via UI, new J31 five-role journey. CI green + browser 31/31 on `4c22555`; independent review findings fixed. Record: `docs/evidence/l3.1-dashboard-access-2026-10-27.md`. Open: stale-tab permissions, webhook header exposure to supervisors (separate ticket), no user sessions yet.
- L3.2 MERGED (PR #53, `41d0490`): nav grouped by work, phone menu + keyboard entry, F13 analytics fixed, Keyword Alert closed (F14), served OpenAPI corrected (D11), visible load/save failures on 9 pages, new J32. CI green + browser 32/32 on `2473fbf`; independent review findings fixed. Record: `docs/evidence/l3.2-daily-workflow-2026-10-27.md`. Open: observed task sessions with intended users NOT done; label association/contrast/screen-reader pass not done.
- L4.1a MERGED (PR #54, `a977869`): registry + versioned catalog + super-admin console; CI green + browser 33/33 on `b7b1e2b`. Record: `docs/evidence/l4.1a-catalog-2026-10-28.md`. Design: `docs/l4.1-catalog-entitlements-design.md` (Revision 2).
- L4.1b MERGED (PR #55, `081c35c`): purchases + baseline (trigger + helper), live resolver, enforcement at channels/automation/webhooks/export/seats/tools, owner Plan & usage, console assignment, J34. CI green + browser 34/34 on `d70e631`. Record: `docs/evidence/l4.1b-entitlements-2026-10-28.md`.
- L4.1c MERGED (PR #56, `98a0327`): platform AI ceilings (locks 92845/92846), daily new-workspace cap, console section, J35. CI green + browser 35/35 on `8aa013e`. Record: `docs/evidence/l4.1c-platform-limits-2026-10-28.md`. Open: M2/M3/L1/L3 follow-ups in the record.
- Next: L4.2 (needs owner commercial decisions: seller entity/country, currencies, pricing, trial/grace, refund/tax/invoice responsibility, processor vs merchant of record). Browser runs: AC power, load under 10 (quit iOS simulator/VMs), flushed task Redis, migrated fresh DB, run detached with nohup.
- Task-owned leftovers (remove with owner OK): docker `ziyrak-l11-pg` (127.0.0.1:55433), `ziyrak-l12-redis` (127.0.0.1:56379); DBs `ziyrak_acceptance_l12*`, `ziyrak_acceptance_l13a`; worktrees ziyrak-l1-1/-l1-2/-l1-3; scratch `/private/tmp/ziyrak-l1*-acc*`.
- Start guide: `docs/guides/agent-continuation.md`; run one lead at a time, honor coordinator/task STOP markers.
- Target contracts: `docs/billing-and-entitlements-spec.md`, `docs/dashboard-and-access-review-2026-10-25.md`.
- Base plus optional add-ons is the agreed starting model; existing implemented capabilities/prices become data-managed.
  New capabilities still need code. Merchant country/currency/provider and production policies remain open (L4.2).

- Legacy-name rename complete on branch `chore/rename-owly-to-ziyrak` (worktree ../ziyrak-wt-rename): cookie `ziyrak-token`, Redis `ziyrak:`, DBs `ziyrak*`, `helm/ziyrak`. NOT merged: needs exact-head CI green + browser run; local DB needs the old-named dev DB renamed to `ziyrak`.

## Next actions
0. Browser runs: Mac on AC + awake; fresh `ziyrak_acceptance_*` DB, `REDIS_URL` and synthetic platform proof hashes set from the start.
1. Run/read the read-only preflight; read HANDOFF, the L1.1 packet and PLAN protocols; inspect Git/topology.
2. Create an isolated task worktree; record its absolute path/branch here before edits, then install/test in isolation.
3. Fence both DB URLs/disposable targets, owned PIDs and image identity before running cleanup/load tools.
4. Continue eligible L1–L6 tasks in board order; unresolved provider/business choices stop only dependent work.
5. L7 requires explicit rollout/live-money authorization after L6 evidence; do not start new channels/enterprise work.

## Evidence and limits
- `docs/project-review-2026-10-25.md` + retained `docs/evidence/project-review-2026-10-25/`: open F01–F16.
- Prior fresh isolated install/generate/tsc/lint/53 focused tests passed; full DB/browser/provider NOT RERUN.
  Build environment-blocked (font network then Turbopack bind EPERM), not a pass.
- Historical R5: 1812 passed/1 skipped, browser 30/30 on `0b9a1a2`, stand-in AI/captured mail.
- Meta A visible reply recorded on `905b4ca` (Oct25); B not retested; old waiver is not a pass.
  One historical Gmail message is not production-sender verify/reset/invitation acceptance.
- New dashboard findings D01–D11 are source-only. Billing is specified, not implemented. L0 ran no app/provider tests.

## Operational boundaries
- Main may serve a live worker. Installed Next/eslint-config-next16.4.0 vs lock16.4.3;
  Puppeteer24.43.1 vs lock25.15.0 (Oct25 audit). Do not install/build here.
- Review scratch: `/private/tmp/ziyrak-review-20261025-8aZznQ`; no DB/services created by docs review.
- Never run old loadtest unchanged: unpaired DB URLs, broad pkill and stale-image reuse (F08).
- Preserve port7700/live worker/remote-control tunnel. Confirm temporary Meta callback target before live checks.
- Prior cleanup recorded in `5b45bd7`; do not assume old worktrees/DBs still exist or delete them automatically.

## Standing authorization retained (owner, 2026-10-23)
Within selected implementation scope, merge only with exact-head CI green and required combined-build browser green,
then push main/recheck CI when that standing instruction applies. This preparation performs only local commits; CI green alone never proves browser acceptance.
Stop for tags/deploys/releases, destructive cleanup, new scope, real credential/mail actions and protected topology.
