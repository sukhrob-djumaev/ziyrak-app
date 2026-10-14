# Current task

Updated: 2026-10-14 (Asia/Kuala_Lumpur). `PLAN.md` governs scope and criteria.

- **Authorized milestone:** quality recovery R1–R4 in PLAN, approved by the owner on October 14. This session updates documentation only; a subsequent `continue` resumes recovery. No new product phase or deployment is implied.
- **Next task:** R1 delivery reliability — not started; verification not run. Read its referenced contracts and both findings in `docs/status-review-2026-10-14.md`; inspect current handlers; add durable desired-behavior regressions and observe them fail before implementing the smallest fix. Do this in an isolated worktree, since the live worker runs from this checkout. Do not simply replay the entire AI pipeline after a send failure.
- **Sequence:** R1 → R2 → R3 → R4. Prepare R2 cases or perform independent R3 work if an earlier external dependency/owner decision is blocked. Keep the blocked criterion open. Stop at recovery closure or a genuine remaining decision boundary.
- **Baseline:** product code `c20513d78421816ac0096eff1cf3dbb0d6c9aa55`; assessment commit `1ea078cab50f66b7598869a3c40e14812ef93a49`. Documentation revision is the commit containing this state. Inspect Git for the actual current HEAD and preserve unrelated work.
- **Phase status:** 0–8 tagged. Phase 7 includes the October 11 owner waiver for second-number recipient-visible delivery. Phase 9 synthetic DB/RLS merged, storage deferred, no completion tag. Historical records now live in `docs/implementation-history.md`.

## Verification status

- The earlier October 14 review verified exact-product-SHA CI: 1149 passed/4 skipped default, 1152/1 Redis-selected. Latest recorded 16-script browser pass used a stand-in and excluded live J16. No new application verification during this documentation update.
- R1's two failures were reproduced with real handlers and mocked dependencies. Temporary diagnostics: `/private/tmp/ziyrak-status-review-20261014/`; recreate from the report if unavailable. Passing diagnostic assertions demonstrate bugs, not fixes.
- R2 policy/thresholds require an owner decision on a concrete proposal. R3 dependency audit needs refreshing. R4 live acceptance is not started; use PLAN's verification-selection policy instead of requiring Meta for every edit.

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
- Confirmed external blockers affect the corresponding acceptance/release, not all development. Record evidence, next manual action and retry condition; continue eligible R1–R4 work.
- Optional Origin hardening, dedicated storage, new channels and enterprise cutover automation remain outside this milestone. Preserve the historical Business B waiver without broadening it.
- No push/release/deploy/history rewrite without applicable explicit authorization. The previous handoff records October 14 standing permission to merge own PRs only when CI is green, and to restart the worker/apply additive migrations after a backup; honor those exact conditions if relevant, not a broader implied permission. This documentation task exercises none of them.
