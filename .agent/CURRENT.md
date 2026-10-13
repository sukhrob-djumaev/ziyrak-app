# Current task

Updated: 2026-10-14 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** Phases 0–9 are done. Phases 0–8 are tagged (`phase-0-complete` … `phase-8-complete`). Phase 9 (§46.9, built synthetically — no customer) was merged in #8; its record is `PLAN.md` §46.9. After it, an overnight **post-Phase-9 hardening** pass merged #12–#22 (sign-out revocation, approvals UI, tool policies, header identity, live dashboard, GDPR/logger/conflict fixes, `npm audit fix`, Next.js 16.4.0); the log is in `PLAN.md` ("Post-Phase-9 hardening log"). There is no Phase 10.
- **Baseline:** `main` @ `b3beedf` or later (#12–#26 merged); CI green. Nothing is in progress. The full 16-journey browser acceptance suite passed on 2026-10-14 (see the PLAN hardening log).

## Live stack (2026-10-14)

- **Database `owly`:** migrations applied through `20261014000000_revoked_token` (backups taken first, in the Claude session scratchpad `owly-before-phase9.dump` and `owly-before-revoked-token.dump` — copy them somewhere durable if you want to keep them).
- **Worker:** `com.ziyrak.meta.worker` (launchd, not persistent across reboot) restarted on `main` @ `f07f3f9`; queue heartbeat 30 s verified. It was stopped for ~6 min at 15:49 UTC on 2026-10-14 by the acceptance harness's old `pkill` (fixed in #26) and restarted; if you see a second gap, check `launchctl print gui/$(id -u)/com.ziyrak.meta.worker`.
- **Web:** the owner's foreground process on `127.0.0.1:3000` is still the **old build** (before approvals/policies/live updates/revocation). This folder's `node_modules` are still the old set (Next 16.2.2); the lockfile now says 16.4.0. To deploy: stop the web; `git pull`; `PUPPETEER_SKIP_DOWNLOAD=1 npm ci` (the Chrome download is blocked in the sandbox and not needed); `npm run build`; start with `NODE_ENV=production node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1`; then `launchctl kickstart -k gui/$(id -u)/com.ziyrak.meta.worker`.
- **Port 7700 and its cloudflared tunnel belong to the owner's remote-control service — never use or touch them.** No tunnel points at port 3000, so Meta cannot reach the web app until the owner sets one up.

## Owner decisions open

1. Deploy the web build (above).
2. Short AI replies with no tool use score 0.5 < 0.6 and escalate (existing regression tests encode this) — keep or change?
3. Remaining `npm audit` highs (16): the dev/demo WhatsApp Web adapter's puppeteer tree and `imap` — each needs a major bump or replacement.
4. Optional Origin check on state-changing cookie-authenticated requests (defence in depth).
5. Meta reachability (tunnel to port 3000).

## Notes for the next session

- Tests must use `DATABASE_URL=…/owly_test` — `.env` points at the live `owly` database. Docker Desktop and `owly-db-1` are running.
- **Do dependency work and browser builds in an isolated git worktree** (own `node_modules`, own port, `owly_test`): this folder is what the live worker runs from, and a failed `npm audit fix` here once left `@prisma/engines` half-removed (restored). Keep this folder on `main`.
- Acceptance suite: `ACC_DB=… scripts/acceptance/start-all.sh all` then `run-all.sh`, from an isolated worktree on ports 3100/4010/4020–4022; the harness now records the acceptance worker's PID and never kills by process name. J09/J10 needs a fresh database each run.
- Browser checks: the Claude-in-Chrome extension failed ("different extension" error); headless Chrome via `puppeteer-core` worked. One browser window per role (background tabs are throttled); wait for the URL, not `networkidle` (the event stream stays open); the login limit is 5/min per address.

## Prohibited

Pushing/merging/deploying without the owner's say-so (standing permission from 2026-10-14: merge own PRs when CI is green; restart the worker and apply additive migrations after a backup), merging without checking CI first, changing product architecture without the rule 11 decision, touching Business A's or B's Meta connections, using port 7700.
