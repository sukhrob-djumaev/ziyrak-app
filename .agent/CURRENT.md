# Current task

Updated: 2026-10-14, about 11:35 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** Phases 0–8 are tagged (`phase-0-complete` … `phase-8-complete`). Phase 7 closure includes the recorded October 11 owner waiver for Business B's recipient-visible delivery; that criterion was not passed. Phase 9 (§46.9, synthetic — no customer) was merged in #8, with dedicated storage deferred and no Phase 9 completion tag. Post-Phase-9 hardening through #28 is merged; see the PLAN hardening log. There is no Phase 10.
- **Baseline:** reviewed product code `main` @ `c20513d78421816ac0096eff1cf3dbb0d6c9aa55`; exact-SHA GitHub CI verified green (1149 passed / 4 skipped default; 1152 / 1 Redis-selected, 119 files). Latest recorded 16-script browser pass used a stand-in LLM and excluded live J16; it was not rerun in this review.
- **Bounded task:** status and model-work assessment complete; no product implementation in progress. Evidence and phase-by-phase judgments: `docs/status-review-2026-10-14.md`. Two current delivery-reliability gaps were reproduced with isolated mocked dependencies; next implementation scope must be explicitly selected.

## Live stack (2026-10-14)

- **Database `owly`:** prior session recorded migrations through `20261014000000_revoked_token`, after backups (`owly-before-phase9.dump` and `owly-before-revoked-token.dump` in its scratchpad; copy somewhere durable if needed). This review verified database health, not the migration list or backups.
- **Worker:** `com.ziyrak.meta.worker` reports running, PID 51216, started around 02:41 UTC today; queue processing was not freshly exercised. Prior session verified its 30 s heartbeat. The acceptance harness's old `pkill` stopped the live worker for ~6 min on October 13 at 15:49 UTC (fixed in #26); preserve process isolation. The launchd job was previously recorded as not persistent across reboot.
- **Web:** `127.0.0.1:3000`, PID 51167, is now `next-server (v16.4.0)`; installed Next.js is 16.4.0 and nodemailer 10.1.0. Build timestamp 02:40:42 UTC; manifest includes approvals, `/api/me`, and tool policies; web/worker starts follow it. Fresh `/api/health`: production, status ok, database connected, OpenAI reachable. Exact embedded Git build identity and end-to-end deployment acceptance were not verified. The earlier "old build / Next 16.2.2 / deploy pending" note is superseded.
- **Port 7700 and its cloudflared tunnel belong to the owner's remote-control service — never use or touch them.** The prior session recorded no tunnel to port 3000; current external Meta reachability was not rechecked here.

## Owner decisions open

1. Select a follow-up scope for the two reproduced reliability findings: duplicate follow-up after a successful send plus failed persistence; failed inbound outbound send still marked processed. Report has exact paths and reproduction. No product fix was attempted.
2. Short AI replies with no tool use score 0.5 < 0.6 and escalate (existing regression tests encode this) — keep or change?
3. Dependency advisories: prior production-only audit recorded 16 highs in the dev/demo WhatsApp Web adapter's puppeteer tree and `imap`. Latest exact-SHA CI install reports 21 high / 1 low across all dependencies (different scope); production-only audit not freshly rerun.
4. Optional Origin check on state-changing cookie-authenticated requests (defence in depth).
5. Confirm Meta reachability before any new live acceptance. Business B visible delivery remains a recorded owner waiver; do not silently turn it into a pass or revoke the waiver.

## Notes for the next session

- Tests must use `DATABASE_URL=…/owly_test` — `.env` points at the live `owly` database. Docker Desktop and `owly-db-1` are running.
- **Do dependency work and browser builds in an isolated git worktree** (own `node_modules`, own port, `owly_test`): this folder is what the live worker runs from, and a failed `npm audit fix` here once left `@prisma/engines` half-removed (restored). Keep this folder on `main`.
- Acceptance suite: `ACC_DB=… scripts/acceptance/start-all.sh all` then `run-all.sh`, from an isolated worktree on ports 3100/4010/4020–4022; the harness now records the acceptance worker's PID and never kills by process name. J09/J10 needs a fresh database each run.
- Browser checks: the Claude-in-Chrome extension failed ("different extension" error); headless Chrome via `puppeteer-core` worked. One browser window per role (background tabs are throttled); wait for the URL, not `networkidle` (the event stream stays open); the login limit is 5/min per address.

## Prohibited

Pushing/merging/deploying without the owner's say-so (standing permission from 2026-10-14: merge own PRs when CI is green; restart the worker and apply additive migrations after a backup), merging without checking CI first, changing product architecture without the rule 11 decision, touching Business A's or B's Meta connections, using port 7700.
