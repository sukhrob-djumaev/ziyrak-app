# Current task

Updated: 2026-10-14 (Asia/Kuala_Lumpur). PLAN governs scope and criteria.

- **Authorized milestone:** managed-service readiness (MS-2026-10-14).
  Live order: R1 → R3 → P1 → P2 → P3 → R2 → R4 → R5. Phases 0–8 are
  historically tagged; Phase 9 remains partial. No deployment/new channel implied.
- **Current objective:** R1 delivery reliability, regressions and contract
  investigation in progress; product implementation awaits a necessary rule 11
  owner decision. See [proposal](../docs/r1-delivery-contract-proposal-2026-10-14.md).
  Approve conservative unknown-send and interrupted-preparation review states,
  qualifying unconditional external exactly-once claims before implementation.
- **New evidence:** desired-behavior tests ran against unchanged product code:
  5 failed/1 passed. They expose post-send duplicate dispatch, processed refused
  receipt, AI entry-point replay, uncertain-send replay and injected in-flight
  recovery. Persistence/provider dependencies are mocks; no durability or real
  delivery claim. Independent read-only architecture review confirmed the gap.
- **R3 preparation:** fresh audit executed: production 16 high; all dependencies
  21 high/1 low. [Assessment](../docs/r3-operational-assessment-2026-10-14.md)
  records DB-target/process ownership gaps. No dependency/script fixes or safety
  rehearsal yet; risks are not accepted. R3 remains open.
- **Code baseline:** product c20513d78421816ac0096eff1cf3dbb0d6c9aa55; planning
  HEAD 551f9cd1d5146ed13368fda1e2ed85610f4fba21. Main remains the live checkout.
  The attached isolated worktree is
  `/Users/sukhrob/.codex/worktrees/r1-delivery-reliability/owly`, with its own
  node_modules and no copied live .env. Its local test checkpoint is identified
  in HANDOFF. It is deliberately red, not a merge/release candidate.

## Exact continuation

1. Resolve the R1 proposal's owner decision; do not interpret another plain
   `continue` as approval to change the delivery contract.
2. R3 harness safeguards can be investigated/fixed independently: pin/check
   both DB URLs; remove name-based browser cleanup; verify run-owned process
   identity before signals; remove stale DB fallback; record build/run ownership.
   Write desired safety regressions before fixes and rehearse isolated recovery.
3. After the approved R1 contract and safe topology exist, implement recovery
   without replaying AI/tools, make regressions green, add real isolated
   Postgres/pg-boss/isolation/restart tests and the operator UI/browser checks.
   Worker/channel changes require the full 16-script browser suite. R4 retains
   affected real-provider checks. None of those checks ran in this session.

## Protected boundaries

Keep product/dependency/build work out of live main. Never touch port 7700 or its
remote-control tunnel. Never kill processes by name. Live `.env` targets `owly`;
repository tests and fresh acceptance DBs must be separate, with DATABASE_URL and
DIRECT_DATABASE_URL set/checked together. Do not copy live secrets or alter Meta
connections to unblock local work. Preserve the October 11 historical B waiver.

Port 3000 was freshly observed under PID 51167 at session start; do not rely on
that PID later. Worker, queue, backups and public Meta reachability were not
verified. No live services were changed. Previous standing permissions must be
checked against original authorization and exact conditions before use. No
push, merge, deploy, migration or completion tag in this session.
