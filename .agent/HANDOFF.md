# Latest session handoff

Session: 2026-10-13 → 2026-10-14 (Asia/Kuala_Lumpur) — Phase 9 close-out, then an overnight hardening pass the owner asked for ("work as much as possible until morning").

## Changes (all merged, CI green)

- Phase 9 (#8): policy + provider allowlists, dedicated database provisioning/migration/routing, identity-bound RLS, `npm run infra`. Dedicated `StorageProfile` deferred (no `ObjectStorage` implementation exists).
- Worker heartbeat (#7) + CI timing fixes (#9, #19). I merged #7 without checking CI and `main` was red until #9 — always check CI first.
- Hardening #12–#22: sign-out revocation (`RevokedToken`), approvals UI, tool policy API/UI (`tools:read`/`tools:update`), `GET /api/me` + header identity, live dashboard updates, GDPR delete contract, logger fix, non-retried Web Chat id conflict, approve route registers its tools, `npm audit fix`, Next.js 16.2.2 → 16.4.0. Details and limits: `PLAN.md` "Post-Phase-9 hardening log" and §46.9 record.
- Env/repo hygiene: `.env.example` rewritten (#10), compose ports bound to 127.0.0.1 and `.dockerignore` widened (#11). Audit of git history found no committed secret.

## Findings worth remembering

- Independent read-only reviews (subagents) ran on Phase 9, token revocation and tool policies; every confirmed finding was fixed (e.g. `ApiKey`/`ChannelConnection` must stay on the control plane for dedicated tenants; SSE streams must re-check their session; concurrent policy edits lost updates).
- Real-browser checks caught what unit tests could not: the approve route's missing tool registration (a latent production bug), stale `[object Object]` logging, and the login limit's interaction with scripts.
- A failed `npm audit fix` in the live working copy damaged `@prisma/engines` (restored from a pristine clone). Work on dependencies only in an isolated worktree.

- The acceptance rerun (16/16 on an isolated production build) found three real defects and a hazard, all fixed in #26: the live stream leaked through the back/forward cache (six navigations hung a tab), the per-IP API limit (60/min) was exhausted by the dashboard's background requests (now per-session, keyed by `jti`), and J09/J10's `pkill` stopped the **live worker** for ~6 min (restored; the harness now kills only its own recorded PID). Lesson: anything that stops processes by name must be fenced; run harnesses from an isolated worktree.
- Also fixed after the first reviews: `/api/actions/[id]/approve` registers its tools (#21); nodemailer 10 (#25).

## Verification

`npm run test` 1118 passed / 23 skipped; `test:signup-seeded` ~640; `tsc`, lint, build clean on Next 16.4.0; browser suites header 2/2, approvals 19/19, policies 12/12, live updates 7/7 (production build in a worktree against `owly_test`, never the live app). Live DB migrated with backups; worker restarted and verified.

## Continuation point

The live web still runs the old build — see CURRENT.md for the deploy steps and the open owner decisions. No work is in progress.
