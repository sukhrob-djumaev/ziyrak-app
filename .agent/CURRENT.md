# Current task

Updated: 2026-10-09 (Asia/Kuala_Lumpur). Operational snapshot; `PLAN.md` governs.

- **Phase:** 7 — Production Channels and MVP Hardening (§46.7); still incomplete. Tags exist through `phase-6-complete`; `phase-7-complete` is absent.
- **Objective:** Finish the remaining real Meta J16 acceptance for Business B / a second independent `phone_number_id`, preserving Business A's completed evidence and configuration.
- **Status:** External acceptance pending; the second-number setup and live environment need rechecking. This workflow-only session did not inspect credentials, provider accounts, DB contents, or running services.
- **Branch / code baseline:** `claude/phase7-openai-acceptance` at `5e5b60770d1c353910a1547edb5edd70bd8cd7dc` before the workflow documentation commit. Worktree was clean at intake. Recheck Git at every resume.

## Completed evidence (historical, not rerun this session)

- `PLAN.md` §46.7, **Real OpenAI acceptance run (2026-10-01, second)** and **Real OpenAI closure pass (2026-10-02)**: real Web Chat grounding/isolation, embeddings, tools, and closure journeys are recorded. Web Chat latency targets were decided and passed.
- §46.7, **Real Meta J16 — Business A single-number closure (2026-10-06)**, and **MVP Browser Acceptance Suite / J16**: real inbound/signature/routing/worker/knowledge/OpenAI reply, duplicate replay with unchanged counts, and eight successful Graph sends. ACK p95 was 103.81 ms. Recipient-visible delivery passed by manual confirmation at approximately 1–2 s; this is not an instrumented numeric end-to-end p95.
- Latest application commits: `b5177be` adds per-connection webhook signature verification; `5e5b607` adds encrypted App Secret configuration/preservation. These postdate the recorded Business A run. Their presence and source were checked; current-runtime acceptance and test results for that newer code were not established here.

## Immediate continuation

1. Read §46.7's latest records, J16, the execution/Git protocols, and `.agent/HANDOFF.md`; reconcile them with current Git. Review the two newer Meta commits and their security tests before relying on earlier acceptance for this build.
2. Address the recorded documentation discrepancy: §46.7's opening implementation record describes one platform App Secret and verification before connection resolution; current code selects one candidate connection's encrypted App Secret (legacy global fallback) before HMAC verification, then constructs tenant context. Check recorded authorization before further security-design changes; surface unresolved architectural disagreement under protocol rule 11. This handoff does not approve or reverse that design.
3. Recheck the existing acceptance environment without exposing secrets: production web + separate worker + correct Postgres, provider-reachable HTTPS callback, subscription, and existing tenant connections/knowledge. Reuse Business A. Determine whether Business B's independent number/account is already configured before requesting manual setup.
4. Prepare/run the applicable automated checks on an isolated test DB, independent security review of the newer changes, and the browser/live verification required by the plan. Read `tests/integration/meta-whatsapp-live.test.ts` before the smoke: it creates a temporary tenant and sends a real message, so use an isolated DB and an authorized test recipient; do not collide with existing acceptance connections.
5. When external prerequisites and authorization are satisfied, exercise both real tenant routes and cross-tenant knowledge/data/credential isolation for J16, preserving A's evidence. Record fresh outcomes in the plan, then re-evaluate all phase-completion gates. Do not infer a pass from outbound Graph acceptance or a skipped test.

## Blockers / user actions / boundary

- **Recorded release blocker:** Business B / second independent Meta `phone_number_id` isolation. Current availability of that resource is unknown, not proven absent.
- **If absent:** the user must provision/authorize the independent Meta number/app resources and enter credentials through the secure local/product setup; after callback/subscription readiness, an authorized human sender must send real WhatsApp messages to the test numbers. Ask for the exact missing step only, never raw secrets in chat.
- **Prohibited:** starting Phase 8, tagging Phase 7 complete on present evidence, changing product architecture as part of the workflow setup, overwriting A's connection, or pushing/releasing/deploying without explicit authorization.
