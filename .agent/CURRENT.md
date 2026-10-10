# Current task

Updated: 2026-10-10 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** 7 — Production Channels and MVP Hardening (§46.7); still incomplete. Tags exist through `phase-6-complete`; `phase-7-complete` is absent.
- **Objective:** Finish the remaining real Meta J16 acceptance for Business B / a second independent `phone_number_id`, preserving Business A's completed evidence and configuration.
- **Branch / code baseline:** `claude/phase7-openai-acceptance`; no application code changed this session. Recheck Git at every resume.

## Status (2026-10-10)

- **Business B inbound path: PASS (live, not yet recorded in `PLAN.md`).** Business B ("Test company B", connection `0db5d7d6…`, number `+1 555-639-1554`, own Meta app "Ziyrak Test C") received real WhatsApp messages: signature verified, routed to B only, receipt `processed`, customer/conversation created, B's knowledge entry (`ZIYRAK-META-B-284` → `cobalt-river-284`) retrieved, real OpenAI answer produced, Graph send accepted (HTTP 200).
- **Root cause of earlier silence:** the app was not subscribed to B's WABA (`subscribed_apps` only listed Meta's 1P app). Fixed on 2026-10-10 with one authorized `POST …/subscribed_apps` (via B's stored token). Also the free `trycloudflare` quick tunnel dies every few hours; restarted twice (ours only, launchd job `com.ziyrak.meta.tunnel`, metrics port 20251; the user's other app's tunnel to :7700 untouched). Current webhook URL changes on every tunnel restart and must be re-saved in Meta.
- **Recipient-visible delivery for B: BLOCKED by Meta.** Every outbound send is accepted then fails asynchronously with status `failed`, error **131031 "Business Account locked"** (user-pasted status webhooks). Read-only Health Status (B and the `.env` test account, apparently A's, app `ziyrak_test`): `can_send_message=BLOCKED` for both WABAs/portfolios because of (a) incomplete business profile 131000 (Legal Name, Country, Website), (b) business not verified 141010, (c) WABA payment-method error 141006. Phone numbers and apps are `AVAILABLE`. Business A sent fine on 2026-10-06, so Meta enforcement evidently changed since. The app discards status webhooks, so this reason is invisible in logs.
- **Not done:** A/B cross-tenant isolation over WhatsApp (A's stored credential still has the expired 2026-10-06 token; `.env` was updated but the product connection was not), duplicate-replay check for B, instrumented/visible reply for B, automated Meta security tests re-run, independent security review of `b5177be`/`5e5b607`, and the §46.7 design-drift question (per-connection App Secret vs plan's platform secret) — surface under protocol rule 11, unresolved.

## Next actions

1. **User (Meta):** in both portfolios complete Business Info (Legal Name, Country, Website), add a WhatsApp payment method, check Business Support Home / Account Overview (Request Review if offered), start Business Verification if needed. Then ask the lead to re-run the read-only Health Status check (`GET /{phone_number_id}?fields=health_status`) for B and A.
2. **User (product):** save a fresh access token in Business A's WhatsApp channel setting (credentials only through the product UI/API, never in chat).
3. **Lead, once sending is `AVAILABLE`:** have the user message B's and A's numbers; verify visible replies, B-only knowledge on B / no A phrase on B and vice versa, duplicate replay with unchanged counts; run the Meta unit/security tests on an isolated DB; obtain independent security review; record fresh outcomes in `PLAN.md` §46.7/J16; re-evaluate phase-completion gates.
4. If the lock persists >1 day, consider a fresh WABA/real number; that needs new credentials via the product and a new `subscribed_apps` call.
5. Optional hardening (needs user approval, small code change): log/store Meta status-webhook errors so delivery failures are visible.

## Environment notes

- Docker had stopped; `owly-db-1` restarted. Live DB is `owly` (two active `whatsapp_cloud` connections). Web on :3100 and the worker have run since 2026-10-07 under launchd (`com.ziyrak.meta.web`, `.worker`). Quick-tunnel logs: `/private/tmp/ziyrak-meta-cloudflared.log`.
- Mac sleep can break runs; prefer short foreground sessions.

## Prohibited

Starting Phase 8, tagging Phase 7 complete on present evidence, changing product architecture, overwriting A's connection, simulating Meta traffic as acceptance, or pushing/releasing/deploying without explicit authorization.
