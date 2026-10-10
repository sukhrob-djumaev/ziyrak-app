# Latest session handoff

Session: 2026-10-09/10 (Asia/Kuala_Lumpur) — live Meta J16 Business B bring-up. No application code or `PLAN.md` changes.

## Changes and findings

- Restarted Docker/`owly-db-1`; restarted only our Cloudflare quick tunnel twice (dies every few hours; URL changes). Other app's tunnel not touched.
- Meta-side change (user-approved): `POST /{B WABA}/subscribed_apps` with B's stored token, subscribing "Ziyrak Test C". Before this, no webhook reached the app at all.
- After that, live B inbound passed end to end up to Graph send (see `CURRENT.md`). Fresh evidence is in the database/logs only; not yet written into `PLAN.md`.
- Outbound delivery fails asynchronously with 131031 "Business Account locked". Health Status shows both test accounts blocked for incomplete profile (131000), unverified business (141010) and payment method (141006). Web research (n8n thread, vendor guides, Meta docs) is consistent but has no verified fix.
- `.env` access token was updated by the user for A, but A's stored product credential still has the expired token.

## Verification

- Read-only Graph calls only (phone/WABA info, `subscribed_apps`, `health_status`) using stored/`.env` credentials without printing secrets; temporary scripts deleted. DB queries by id/hash only.
- No automated tests, build, security review, or isolation journey run this session.

## Continuation point

Follow `CURRENT.md` Next actions: user fixes Meta business profile/payment/verification and refreshes A's token in the product; lead re-runs health check, then drives A/B isolation, replay, tests, independent security review, and records evidence in `PLAN.md`. Phase 7 stays open; stop before Phase 8.
