# Current task

Updated: 2026-10-11 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** 7 — Production Channels and MVP Hardening (§46.7); still incomplete. Tags exist through `phase-6-complete`; `phase-7-complete` is absent.
- **Objective:** Close J16's remaining visible-delivery criterion for the two-number run and the open review decisions; preserve A's and B's evidence and configuration.
- **Branch / code baseline:** `claude/phase7-openai-acceptance`; hardening fix `cf6eec7` on top of `6823456`. Recheck Git at every resume.

## Status (2026-10-11)

- **Two-number isolation: PASS** (A `ziyrak_test`, B "Ziyrak Test C"): no cross-leak either way, duplicate replay unchanged, bad signature 403. Recorded in `PLAN.md` §46.7 (2026-10-11 entry).
- **Recipient-visible delivery: BLOCKED by Meta.** Sends accepted then fail with 131031 "Business Account locked"; Health Status `BLOCKED` for both WABAs: profile 131000, business verification 141010, payment method 141006. Phone numbers/apps `AVAILABLE`. External account state.
- **Independent security review done; fixes in `cf6eec7`** (3 MiB body cap, no silent global-secret fallback on unreadable/empty credential, no `credentialRef` in API responses). Full suite 967 tests, tsc, lint, build pass on isolated `owly_test`; rebuilt web restarted and probed live.
- **Decisions (owner, 2026-10-11):** keep per-tenant App Secrets and retire the global fallback; implement optional hardening. Done: unique active `phoneNumberId` index (migration `20261011120000`, applied to `owly`), webhook rate limit, text-message pick in batches, failed-delivery status logging; full suite 970 tests pass. The global `META_APP_SECRET` fallback is retired (A and B each verify with their own secret; 971 tests). **Not done:** multi-message batches (needs `ChannelAdapter` contract change). The owner chose to skip clearing the Meta lock (visible delivery) for now.

## Next actions

1. **User (Meta) — currently skipped by the owner:** in each portfolio complete Business Info (Legal Name, Country, Website), add a WhatsApp payment method, check Business Support Home, start Business Verification if needed; then ask the lead to re-run `GET /{phone_number_id}?fields=health_status` for A and B.
2. Optional later: decide whether to extend `ChannelAdapter` for multi-message batches.
3. **Lead, once sending is `AVAILABLE`:** have the sender message A and B; confirm the replies are visible and record instrumented/observed latency; optionally run `npm run test:smoke:meta` (creates a temporary tenant and sends a real message: isolated DB, authorized recipient). Then re-evaluate all Phase 7 gates; tag only if every gate passes.
4. Consider storing/logging Meta status-webhook errors so delivery failures are visible (needs approval).

## Environment notes

- Docker/`owly-db-1` restarted on 2026-10-09; live DB `owly` (A and B connections). Web :3100 and worker run under launchd (`com.ziyrak.meta.web`, `.worker`); web was rebuilt and restarted 2026-10-11. Our quick tunnel (`com.ziyrak.meta.tunnel`, metrics port 20251) dies every few hours and its URL changes: re-save it in each Meta app's callback. The user's other app's tunnel (:7700) must not be touched. Logs in `/private/tmp/ziyrak-meta-*.log`.
- A is on app `ziyrak_test` and B on app "Ziyrak Test C"; both have an encrypted per-connection App Secret. Temporary Meta tokens expire in ~24 h.

## Prohibited

Starting Phase 8, tagging Phase 7 complete on present evidence, changing product architecture without the rule 11 decision, overwriting A's or B's connection, simulating Meta traffic as acceptance, or pushing/releasing/deploying without explicit authorization.
