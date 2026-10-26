# Current task — LP-2026-10-25 launch preparation

## Status
- Owner explicitly APPROVED L1–L6 launch preparation on 2026-10-25 and requested clean Claude/Codex continuation.
- Selected roadmap: PLAN live board → `docs/launch-roadmap-2026-10-25.md` (L0–L7).
- L0 and continuation preparation COMPLETE. L1–L6 product implementation NOT STARTED; criteria NOT RUN.
- L1.1 safe verification harness MERGED (PR #36, `9f9b4ec`, CI green on head `bc15eaa`; no browser trigger: tooling-only). Residuals: DB ownership is name+local host+env (no in-DB marker); load check `realtime cross-replica` FAILS (unbaselined, owner of L2.1/F-triage); fence CLI proven only in the rehearsal. Record: `docs/evidence/l1.1-safe-verification-harness-2026-10-25.md`.
- L1.2 (PR #37, head `4660de4`, CI green on code head `6e8ddbb`): implemented + independently reviewed; NOT merged: combined-build browser run incomplete.
  Run 3 passed j01-j10 then stalled (Mac "Maintenance Sleep" every ~16 min on battery; caffeinate ineffective). Record:
  `docs/evidence/l1.2-dependencies-http-boundaries-2026-10-25.md` (on the PR branch).
- L1.3 (draft PR #38, branch `fix/l1-3-account-secret-safety`): F03/F09/F16, mutation origin policy, signup ceilings, platform TOTP MFA (default optional) implemented + reviewed;
  CI/browser pending. Record on the branch: `docs/evidence/l1.3-account-secret-safety-2026-10-26.md`. Open: first-enrollment proof, TRUSTED_PROXY_HOPS contract, MFA enrollment UI.
- Active checkouts: /Users/sukhrob/Development/Repos/JS/owly-l1-2 (L1.2), /Users/sukhrob/Development/Repos/JS/owly-l1-3 (L1.3); owly-l1-1 is merged (remove when convenient).
- Task-owned resources: docker `ziyrak-l11-pg` (127.0.0.1:55433), `ziyrak-l12-redis` (127.0.0.1:56379); DBs `ziyrak_acceptance_l12`, `_l12b`, `_l12c`; scratch `/private/tmp/ziyrak-l12-acc*`.
- Start guide: `docs/guides/agent-continuation.md`; run one lead at a time, honor coordinator/task STOP markers.
- Target contracts: `docs/billing-and-entitlements-spec.md`, `docs/dashboard-and-access-review-2026-10-25.md`.
- Base plus optional add-ons is the agreed starting model; existing implemented capabilities/prices become data-managed.
  New capabilities still need code. Merchant country/currency/provider and production policies remain open (L4.2).

## Next actions
0. USER ACTION: run the Mac on AC + awake (lid open or `sudo pmset -a disablesleep 1`), then rerun the full browser suite on a fresh `ziyrak_acceptance_*` DB with `REDIS_URL` set (L1.2 head first; L1.3 after) and merge when CI + browser are green.
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
