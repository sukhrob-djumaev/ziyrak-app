# Latest handoff — L1.2/L1.3 in review, 2026-10-26

- Merged: L1.1 (PR #36). Open PRs: #37 L1.2 (CI green, browser run blocked by Mac sleep), #38 L1.3 draft (CI pending).
- L1.2: dependency patches + Prisma alignment, redirect credential policy, whole-operation deadlines/body caps, bounded inbound bodies, Next proxy body cap. Review found a worker-crash regression (fixed) and the proxy buffering issue (fixed).
- L1.3: atomic reset, key discovery/rotation helper, log redaction, same-origin JSON policy (cookie writes + /api/auth), signup ceilings, platform TOTP MFA (optional by default; `ZIYRAK_PLATFORM_MFA=required` to enforce), audited reset, enrollment route.
- Harness lessons: J19 is single-use per DB (rotates a token) and needs REDIS_URL from the start; run on AC power; Chrome via CHROMIUM_PATH (Chrome for Testing download blocked); GitGuardian flagged fake test credentials (dismissed by owner).
- Do next: rerun browser suite when the Mac stays awake; merge #37 then rebase/merge #38; then L1.4 (quality evidence) or L2.1 (runtime contract). Never run default DB env: always use the isolated 55433 Postgres.
