# Current task

Updated: 2026-10-14 (Asia/Kuala_Lumpur). `PLAN.md` governs scope and criteria.

- **Authorized milestone:** managed-service readiness, approved October 14; canonical order/status and criteria are in PLAN's live board and task packages. This session updates documentation only. A subsequent `continue` implements eligible work within that milestone; it does not authorize deployment or new channels.
- **Next task:** R1 delivery reliability — not started; verification not run. Read its referenced contracts and both findings in `docs/status-review-2026-10-14.md`; inspect current handlers; add durable desired-behavior regressions and observe them fail before implementing the smallest fix. Use an isolated worktree because the live worker runs from this checkout. Do not replay the whole AI pipeline after a send failure. R3 environment safeguards apply before any product work.
- **Continuation rule:** follow the live board's dependencies; keep blocked criteria open and continue eligible independent work. Stop at milestone closure or a genuine remaining decision boundary. R5 is the final branding task; rerun affected acceptance before closure.
- **Baseline:** product code `c20513d78421816ac0096eff1cf3dbb0d6c9aa55`; assessment commit `1ea078cab50f66b7598869a3c40e14812ef93a49`. Documentation revision is the commit containing this state. Inspect Git for the actual current HEAD and preserve unrelated work.
- **Phase status:** 0–8 tagged. Phase 7 includes the October 11 owner waiver for second-number recipient-visible delivery. Phase 9 synthetic DB/RLS merged, storage deferred, no completion tag. Historical records now live in `docs/implementation-history.md`.

## Approved product direction

MS-2026-10-14 in PLAN records the owner's decision: business customers create private
workspaces; platform super admin and assigned Ziyrak operators remain distinct from
customer owners/admins/team. Ziyrak manages AI credentials/models with workspace
allowances. P1–P3 define access, managed AI, account lifecycle and onboarding; they
are approved upcoming work, not implemented features. Current signup still presents
AI setup, and platform/channel-scoped administration is missing. R2 quality thresholds
and P2 allowance values/limit behavior need concrete proposals before locking policy.

## Verification status

- The earlier October 14 review verified exact-product-SHA CI: 1149 passed/4 skipped default, 1152/1 Redis-selected. Latest recorded 16-script browser pass used a stand-in and excluded live J16. No new application verification during this documentation update.
- R1's two failures were reproduced with real handlers and mocked dependencies. Temporary diagnostics: `/private/tmp/ziyrak-status-review-20261014/`; recreate from the report if unavailable. Passing diagnostic assertions demonstrate bugs, not fixes.
- All milestone criteria remain not run. R3 dependency audit needs refreshing. Use PLAN’s verification-selection policy: deterministic/local checks by default, real-provider checks for the affected acceptance claim.

## Runtime snapshot — historical, recheck before operating

Observed during the earlier October 14 review, not refreshed in this documentation session:
web `127.0.0.1:3000`, PID 51167, Next.js 16.4.0; worker launchd job
`com.ziyrak.meta.worker`, PID 51216; build timestamp 02:40:42 UTC. Health was
production/ok, DB connected, OpenAI reachable. Embedded Git build identity, queue
execution and current external Meta reachability were not verified. Never act on
these old PIDs without checking ownership again. The worker job was previously
recorded as not persistent across reboot.

Prior session recorded live `owly` migrations through `20261014000000_revoked_token`
and scratchpad backups `owly-before-phase9.dump` / `owly-before-revoked-token.dump`;
existence/restorability was not rechecked. Preserve backup/restore gates before changes.

## Environment and external boundaries

- Keep this live checkout on `main`; product changes, dependency installs and browser builds belong in an isolated worktree with its own `node_modules`, environment and ports.
- `.env` points at live `owly`. Repository tests use disposable `owly_test`; acceptance uses a distinct fresh throwaway DB. Check `DATABASE_URL` **and** `DIRECT_DATABASE_URL`; set both to the intended isolated target. Never run destructive test cleanup on live/retained data.
- Acceptance topology: web 3100, stand-in 4010, customer sites 4020–4022; build with `NEXT_PUBLIC_APP_URL=http://localhost:3100`. Read `start-all.sh` and `run-all.sh`; set `ACC_DB` and matching DB variables. J09/J10 needs a fresh DB each full run. Stop only verified test-owned PIDs, never by process name.
- Browser: prior headless Chrome via `puppeteer-core` worked; the Claude-in-Chrome extension failed. Recheck available tools. Use one window per role; persistent event streams make `networkidle` unsuitable. Avoid burning the 5/min login limit during debugging.
- **Port 7700 and its cloudflared tunnel belong to the owner's remote-control service. Never touch them.** No application tunnel is assumed ready. Do not alter Business A/B Meta connections to unblock unrelated work.
- Confirmed external blockers affect the corresponding acceptance/release, not all development. Record evidence, next manual action and retry condition; continue eligible work in the approved live plan.
- Optional Origin hardening, dedicated storage, new channels and enterprise cutover automation remain outside this milestone. Preserve the historical Business B waiver without broadening it.
- No push/release/deploy/history rewrite without applicable explicit authorization. The previous handoff records October 14 standing permission to merge own PRs only when CI is green, and to restart the worker/apply additive migrations after a backup; honor those exact conditions if relevant, not a broader implied permission. This documentation task exercises none of them; recheck the original authorization before relying on this historical note.
