# Latest session handoff

Session: 2026-10-10/11 (Asia/Kuala_Lumpur) — live Meta J16 two-number acceptance and security hardening.

## Changes and findings

- Fixed delivery of live traffic: subscribed each Meta app to its WABA, re-pointed callbacks to the quick tunnel, corrected the B token/app mix-up (B uses "Ziyrak Test C"; A uses `ziyrak_test`).
- Live evidence (recorded in `PLAN.md` §46.7, 2026-10-11): A/B isolation passed both ways, replay and bad-signature probes held. Recipient-visible delivery is blocked by Meta error 131031 (Health Status: profile 131000, verification 141010, payment 141006).
- Independent read-only security review found no bypass or cross-tenant injection. Code fixes (`cf6eec7`, tests first): 3 MiB webhook body cap (413), no silent fallback to the global secret for unreadable/empty stored credentials, `credentialRef` removed from channel API responses (`credentialConfigured` boolean instead). Owner decisions then added a second commit: unique active `phoneNumberId` index (applied to live DB), webhook rate limit, text-message pick in batches, failed-delivery status logging. The global-secret fallback was then retired after A's own secret was saved (A and B verified live). Still open: multi-message batches.
- Web rebuilt and restarted (only that launchd job); worker and the user's other tunnel untouched.

## Verification

- `npx vitest run`: 95 files / 971 tests passed; `npx tsc --noEmit`, `npm run lint -- --max-warnings 0`, `npm run build` passed (isolated `owly_test`). Live probes after restart: oversized 413, signed replay 200 with unchanged counts, bad signature 403. `npm run test:smoke:meta` and the browser journey suite were not run.
- Read-only Graph calls and temporary scripts only (deleted); no secrets printed or stored. The `PLAN.md` file has pre-existing Prettier warnings.

## Continuation point

Follow `.agent/CURRENT.md`: the user clears the Meta account blockers and decides the App Secret design; the lead then re-runs Health Status, gets a visible-reply run for A and B, optionally the Meta smoke, and re-evaluates Phase 7's gates. Phase 7 stays open; stop before Phase 8.

## Addendum (same session)

- Owner decision recorded in `PLAN.md`: visible delivery on the second number is waived for this run (Meta test accounts blocked for A and B alike; A's visible delivery observed 2026-10-06). Remaining Phase 7 gate: the live `test:smoke:meta` run (needs a third number; see `CURRENT.md`). Tag only after every gate passes and the owner authorizes.
- Closure: live `test:smoke:meta` 3/3 (run on isolated `owly_test` with A's stored credential via process env; recipient must be on the test number's allowed list) and the full browser suite 16/16 (acceptance build needs `NEXT_PUBLIC_APP_URL=http://localhost:3100`; clean DB/profiles) passed and are recorded in `PLAN.md`. `phase-7-complete` tagged locally; nothing pushed. Live web restored on its normal build; acceptance DB dropped.
