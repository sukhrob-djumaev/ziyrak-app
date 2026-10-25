# Current task — LP-2026-10-25 launch preparation

## Status
- Owner requested current docs, flexible self-service subscriptions and dashboard/access/usability review.
- Selected roadmap: PLAN live board → `docs/launch-roadmap-2026-10-25.md` (L0–L7).
- L0 documentation/requirements rebaseline COMPLETE. L1–L6 implementation NOT STARTED; criteria NOT RUN.
- Next: L1.1 safe verification harness. No deployment/live charging/pilot is authorized by this reset.
- Product baseline `5b45bd7`; prior audit commit `3066b33`. This documentation commit changes no product code.
- Target contracts: `docs/billing-and-entitlements-spec.md`, `docs/dashboard-and-access-review-2026-10-25.md`.
- Base plus optional add-ons is the working offer; existing implemented capabilities/prices become data-managed.
  New capabilities still need code. Merchant country/currency/provider and production policies remain open (L4.2).

## Next actions
1. Read PLAN's execution/verification/Git protocols and L1.1 criteria; inspect live Git/process topology.
2. Create an isolated worktree/dependencies; state test-harness contract before code and write failing guard tests.
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
then push main/recheck CI when that standing instruction applies. This docs session performs only a local commit.
Stop for tags/deploys/releases, destructive cleanup, new scope, real credential/mail actions and protected topology.
