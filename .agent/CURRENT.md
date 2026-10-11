# Current task

Updated: 2026-10-11 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** 7 — Production Channels and MVP Hardening (§46.7); complete with the recorded owner decision on second-number visible delivery. Tags through `phase-7-complete` (local only).
- **Objective:** Phase 7 closed; next phase needs explicit authorization. Preserve A's and B's connections and evidence.
- **Branch / code baseline:** `claude/phase7-openai-acceptance`; hardening fix `cf6eec7` on top of `6823456`. Recheck Git at every resume.

## Status (2026-10-11)

- **Two-number isolation: PASS** (A `ziyrak_test`, B "Ziyrak Test C"): no cross-leak either way, duplicate replay unchanged, bad signature 403. Recorded in `PLAN.md` §46.7 (2026-10-11 entry).
- **Recipient-visible delivery: BLOCKED by Meta.** Sends accepted then fail with 131031 "Business Account locked"; Health Status `BLOCKED` for both WABAs: profile 131000, business verification 141010, payment method 141006. Phone numbers/apps `AVAILABLE`. External account state.
- **Independent security review done; fixes in `cf6eec7`** (3 MiB body cap, no silent global-secret fallback on unreadable/empty credential, no `credentialRef` in API responses). Full suite 967 tests, tsc, lint, build pass on isolated `owly_test`; rebuilt web restarted and probed live.
- **Decisions (owner, 2026-10-11):** keep per-tenant App Secrets and retire the global fallback; implement optional hardening. Done: unique active `phoneNumberId` index (migration `20261011120000`, applied to `owly`), webhook rate limit, text-message pick in batches, failed-delivery status logging; full suite 970 tests pass. The global `META_APP_SECRET` fallback is retired (A and B each verify with their own secret; 971 tests). **Not done:** multi-message batches (needs `ChannelAdapter` contract change). The owner decided (2026-10-11, recorded in `PLAN.md`) that visible delivery on the second test number is not required for this run: both test accounts are Meta-blocked (A too), A's visible delivery was observed 2026-10-06.

## Next actions

1. **Phase 7 gates are met** under the owner's decision: browser suite 16/16 and `test:smoke:meta` 3/3 (both 2026-10-11, recorded), two-number isolation, 971-test default suite. `phase-7-complete` was tagged locally; it is not pushed. Do not start Phase 8 without explicit authorization.
2. Optional later: decide whether to extend `ChannelAdapter` for multi-message batches.
3. **Lead, once sending is `AVAILABLE`:** have the sender message A and B; confirm the replies are visible and record instrumented/observed latency; optionally run `npm run test:smoke:meta` (creates a temporary tenant and sends a real message: isolated DB, authorized recipient). Then re-evaluate all Phase 7 gates; tag only if every gate passes.
4. Consider storing/logging Meta status-webhook errors so delivery failures are visible (needs approval).

## Environment notes

- Docker/`owly-db-1` restarted on 2026-10-09; live DB `owly` (A and B connections). Web :3100 and worker run under launchd (`com.ziyrak.meta.web`, `.worker`); web was rebuilt and restarted 2026-10-11. Our quick tunnel (`com.ziyrak.meta.tunnel`, metrics port 20251) dies every few hours and its URL changes: re-save it in each Meta app's callback. The user's other app's tunnel (:7700) must not be touched. Logs in `/private/tmp/ziyrak-meta-*.log`.
- A is on app `ziyrak_test` and B on app "Ziyrak Test C"; both have an encrypted per-connection App Secret. Temporary Meta tokens expire in ~24 h.

## Prohibited

Starting Phase 8, tagging Phase 7 complete on present evidence, changing product architecture without the rule 11 decision, overwriting A's or B's connection, simulating Meta traffic as acceptance, or pushing/releasing/deploying without explicit authorization.
