# Status and model-work review — 2026-10-14

Reviewed baseline: `c20513d78421816ac0096eff1cf3dbb0d6c9aa55` on `main`.
Review completed around 03:35 UTC / 11:35 Asia/Kuala_Lumpur. Assessment only;
no product changes, deployment, migrations, live messages, or paid model calls.

## Assessment

Ziyrak has an implemented multi-tenant MVP, tested scaling infrastructure, and
synthetically exercised enterprise database features. Its implementation is
substantial and its evidence is much stronger than the early phase reports.
It is not accurate to equate "Phases 0–9 done" with every original acceptance
criterion being satisfied, every provider being freshly verified, or reliable
exactly-once external delivery under every failure mode.

The coding agents were effective at building modules and fixing concretely
reproduced defects. Their weaker areas were initial integration completeness,
calibration of completion claims, and operational isolation. Independent reviews
and real browser/provider/multi-process runs repeatedly found material defects
after large automated suites were green.

These are qualitative judgments of this repository's recorded work, not a
controlled benchmark of model families. Git co-author trailers do not capture
all assistance, prompts, retries, human interventions, or model settings.

## Current verification

- Initial working tree and index were clean; local `main` and `origin/main`
  pointed at the reviewed baseline. Latest GitHub main workflow has the same SHA.
- [CI run 38432123466](https://github.com/sukhrob-djumaev/ziyrak-app/actions/runs/38432123466)
  succeeded. Retrieved job `115416709853` and its actual logs: type check, lint,
  migration, both test variants, and build succeeded. Default: **1149 passed /
  4 skipped**. Redis-selected: **1152 passed / 1 skipped**. Both collected
  1153 tests across 119 files. Skips are configuration-specific cache/Redis tests;
  live-provider tests are excluded from these suites entirely.
- The historical handoff's 1118/23 count is superseded by that exact-SHA CI run.
  No new full local suite, signup-seeded suite, or full browser suite was run
  during this assessment.
- Local installed dependencies include Next.js 16.4.0 and nodemailer 10.1.0.
  `.next/BUILD_ID` was modified at 02:40:42 UTC today; the built route manifest
  includes approvals, `/api/me`, and tool policies.
- Port 3000 is served by PID 51167, `next-server (v16.4.0)`.
  `com.ziyrak.meta.worker` is running as PID 51216. Process ages place both
  starts just after that build. This contradicts the old handoff's statement
  that the local web/dependencies still use 16.2.2. No embedded Git build stamp
  was verified, and this is not a fresh end-to-end deployment acceptance run.
- A fresh `GET http://127.0.0.1:3000/api/health` returned `status: ok`,
  `environment: production`, database connected, OpenAI reachable. The health
  route checks the database and a provider HEAD request; it does not prove worker
  job execution or current grounded model replies. Its uptime starts when the
  route module loads, so it is not a reliable process-start timestamp.
- Database migrations/backups, external Meta reachability, and current Meta
  account status were not independently rechecked. Preserve those distinctions.
- Latest recorded browser suite: **16/16 automated scripts**, using a local LLM
  stand-in and separate production web/worker processes. `run-all.sh` confirms
  live J16 is not one of these scripts. This is workflow evidence, not a new
  live-model or WhatsApp-delivery measurement.

## Phase-by-phase coding assessment

| Step                            | Judgment                                                     | Evidence and limitation                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — security baseline           | Good, focused                                                | Closed five unauthenticated routes, real JWT signature verification, and the CI lint escape. Tag records 335 tests. Later ordinary-navigation rate-limit failures show this was not a complete session/UX review.                                                                                                                                                                                                                                                 |
| 1 — tenant schema and migration | Good data foundation; incomplete transition                  | Composite tenant FKs, encrypted secrets, and hashed API keys provided real structural protection. Phase 2's record says login still used `Admin` after Phase 1 and had to be cut over; Phase 1's login-preservation criterion should not be inferred from the schema work alone. No fresh backup/restore rehearsal was performed in this review.                                                                                                                  |
| 2 — auth and tenant isolation   | Weak first closure; substantially improved by audit          | The initial report said a second business was safe while `/api/settings` exposed Default Business configuration and `/api/chat` mixed ownership/knowledge. `efe79e0` and the runtime-isolation tests corrected this. Real Postgres isolation and raw-client lint tests are valuable; the original assurance was premature.                                                                                                                                        |
| 3 — module boundaries           | Good, controlled refactor                                    | Separated ownership, introduced placement seams, retained characterization/isolation tests; record reports 584 tests. Explicit temporary channel-to-AI exceptions were later removed. Six commits in the tag interval have no model co-author trailer, so precise model attribution is unavailable.                                                                                                                                                               |
| 4 — providers and retrieval     | Useful architecture; insufficient initial integration proof  | Added provider contracts, bounded retrieval and usage. Stored-entry embedding ingestion remained unwired until October 1. Real OpenAI tool turns then exposed an invalid wire-format cast (`284fee2`) that mocks missed; provider errors also leaked masked key fragments (`9be5304`, fixed). Historical Anthropic success was plain-text only, on a now-retired model; the replacement catalog lacks a recorded successful live grounding/tool run.              |
| 5 — channel pipeline            | Mixed first implementation; good correction work             | Unified ingress, signature/token checks, receipts and fast ACK. Follow-up audits corrected synchronous Phone processing, missing Web Chat customer resolution, and cross-business disconnect access. Worker adapter registration and cross-process Web Chat delivery were only proven/fixed in Phase 7.                                                                                                                                                           |
| 6 — tools and jobs              | Strong functionality; durability claims need narrowing       | Real pg-boss, policies, approvals, SSRF checks and scheduled follow-ups. Initially approvals were reachable only from tests; scheduling trusted a model-supplied conversation ID; a later real-browser run found missing tool registration in the approval route. Current post-send failure handling still permits duplicate follow-ups, reproduced below.                                                                                                        |
| 7 — MVP and live acceptance     | Strong investigative recovery; mixed first-pass verification | Browser/provider runs caught public-widget routing, worker wiring, settings and tool-call defects. The first committed browser harness printed observations without acceptance assertions, and initially used the wrong database name. It was repaired and rerun. Later real OpenAI and two-number Meta traces are useful evidence; second-number visible delivery was explicitly waived, not passed.                                                             |
| 8 — scaling                     | Strongest executed systems evidence, after review            | Two apps/two workers, Redis-on/off controls, ordering, cross-process events and worker scale-down. Load test caught PID-1/SIGTERM behavior; security review caught exposed Redis, broad Helm selectors and timeout/TLS issues. These were fixed and rerun. Kubernetes HPA was rendered/linted, not exercised on a cluster; no production capacity claim follows.                                                                                                  |
| 9 — enterprise overrides        | Promising, partial enterprise capability                     | Dedicated DB migration/routing, policy allowlists and RLS tested with real Postgres. Review fixed control-plane ingress tables moving away from authentication, an allowlist bypass, and secret refresh. Dedicated storage is deferred despite the original DB-plus-storage criterion; no Phase 9 tag exists. Cutover requires manual quiescence before and for at least one minute afterwards; the row-lock race reasoning is not an executed concurrency proof. |
| Post-9 hardening                | Valuable output; operational discipline was uneven           | Added revocation, approvals/policies UI, identity and live updates; fixed browser-discovered stream/rate-limit problems. The handoff admits merging #7 without checking CI, dependency repair in the live checkout, and an acceptance `pkill` stopping the live worker for about six minutes. Corrections exist, but these incidents reduce confidence in unattended operational autonomy.                                                                        |

Primary phase evidence: `PLAN.md` §§46.0–46.9, especially implementation records
at lines 2505, 2578, 2647, 2717, 2811, 2923, 2994, 3179, 3247 and the hardening
log at 3259; corresponding Git tags and selected fix commits were inspected.

Git trailers associate most Phase 0/1/2/4/5/6 implementation with Claude Sonnet 5;
Phase 7 with a mixture of Sonnet 5, Sonnet 5.5, Opus 5.5 and unlabelled commits;
Phase 8 and most later work with Sonnet 5.5. The evidence cannot rank these
models fairly: they did different tasks with different scaffolding and review.

## Confirmed current reliability findings

An isolated diagnostic fixture outside the repository imported the **current
real handlers**, with mocked database, channel adapter, queue registration and
other dependencies. No socket, database, worker process, or external provider was
used. Four diagnostic assertions passed; two intentionally assert undesirable
behavior to demonstrate the findings, rather than declaring the product correct.

1. **A follow-up can be delivered twice after a post-send persistence failure.**
   `src/lib/jobs/handlers/send-followup.ts:45` sends before creating the message
   and recording `succeeded`. The skip guard at line 28 only helps once success
   was recorded. Injecting a message-write failure after the adapter returned
   success produced one send and a failed action; retrying the same payload
   produced a second send and a succeeded action. A control with success already
   persisted correctly made no send. This demonstrates the uncovered failure
   window; it is not a live duplicate-delivery incident or a SIGKILL test.

2. **A failed inbound reply delivery can finish as processed without retry.**
   `src/lib/conversations/inbound.ts:194` logs `success: false` from the adapter
   and returns normally. Its handler then marks the receipt `processed` at line 213. With a simulated transient channel failure, the handler resolved and
   marked the receipt processed. An adapter that throws takes a different path.
   The Meta adapter returns failed `SendResult`s, so this is a relevant contract
   path, not just an impossible fake response. This is distinct from Meta
   accepting a message and later rejecting delivery asynchronously.

3. **Confidence is a heuristic, not measured model reliability.**
   `estimateConfidence('We open at 9am.', 8, false)` yields 0.5 and escalation.
   The production retrieval limit is eight, while knowledge-count bonuses
   require more than 20/50 entries; those bonuses cannot fire on this path.
   Correct short answers can therefore escalate. This is an existing recorded
   product choice, not a model failure rate.

Diagnostic files: `/private/tmp/ziyrak-status-review-20261014/`.
Command (from the repository):

```sh
node node_modules/vitest/vitest.mjs run --config /private/tmp/ziyrak-status-review-20261014/vitest.config.mjs --reporter=verbose
```

Review was lead-only. This is a bounded status/source audit, not an independent
security certification or an exhaustive code review. No product fixes were made.

## Ziyrak's runtime model performance

The strongest retained live evidence is `openai/gpt-4o-mini` on October 1–2,
recorded in `PLAN.md` §46.7. These are small acceptance samples, not a benchmark:

| Pipeline step            | Evidence                                                                                                                                                      | What can be concluded                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embeddings and retrieval | Real stored 1536-dimensional embeddings; zero-keyword-overlap questions ranked the intended entry first, cosine 0.33–0.42; cross-tenant queries stayed scoped | Semantic retrieval worked in the exercised fixtures; ranking scores are not accuracy percentages.                                                         |
| Grounded Web Chat        | 36/36 replies recorded as grounded, 8/8 own-marker requests, no opposite marker, six cross-tenant bait questions declined                                     | Good narrow grounding/isolation evidence. One response misframed an allowed cancellation with “Unfortunately”; grounding did not mean flawless reasoning. |
| Ticket/tool use          | Natural request triggered a real ticket; after provider wire-format repair the customer received a useful reply                                               | Tool selection succeeded in the example. The initial broken follow-up completion was adapter integration, not evidence of poor model tool selection.      |
| Follow-up scheduling     | Real model used `delayHours: 0.0167`; selected jobs survived worker restart                                                                                   | Useful task success after schema wording was clarified. It does not prove crash-window exactly-once delivery.                                             |
| Human handoff            | Owner manually changed the conversation to escalated; human reply arrived, persisted, and remained tenant-isolated                                            | Handoff transport passed. This run did not prove that the model autonomously escalated correctly.                                                         |
| Approvals                | Model requested a ticket; pending state, role denial, owner approval/rejection behaved correctly                                                              | Model/tool integration passed; approval security is enforced by application code.                                                                         |
| Automation               | Exact configured reply for a matching A-only rule; other cases went to the model                                                                              | Primarily deterministic rule behavior, not model intelligence.                                                                                            |
| Response time            | Server p95 2.80/3.33 s; widget-visible p95 5.411/5.486 s, n=24/12                                                                                             | Passed the later explicit <5 s server / <7 s visible targets in those historical samples. No fresh latency measurement.                                   |
| Meta                     | Two-number inbound/routing/grounding/Graph acceptance; observed delivery on A; B visible delivery waived                                                      | Useful integration evidence with a documented delivery limit, not two fully delivered end-to-end paths.                                                   |

No representative held-out task set, calibrated escalation precision/recall,
multilingual quality study, or controlled provider/model comparison was found in
the reviewed evidence. Claims of a general “100% accurate AI” are unsupported.

## Closure and continuation

- Phase 7 has a lightweight tag at `0ff11cb`; honor the recorded October 11
  owner waiver for second-number visible delivery. Do not resurrect the old
  blocker as though that decision never happened. Also do not relabel it passed.
- Phase 8 has its completion tag. Phase 9 is merged but has no completion tag
  and deferred storage. “Merged synthetic DB/RLS capability” is more precise
  than unqualified enterprise completion.
- Historical text still contradicts later records: Phase 7 says the smoke was
  not run/tag absent after earlier bullets report a smoke pass and later Git
  establishes the tag; the journey table's J16 entry is older than the waiver.
  Historical “not built” lists also predate approvals/policies/live updates.
- The local deployment note was stale; current process/version observations
  above replace it. Current external Meta reachability remains unverified.
- Resolve the two reproduced delivery-reliability findings as a separately
  selected scope before stronger delivery guarantees or a customer rollout.
  Any solution must distinguish replaying computation from repeating external
  sends; simply retrying the entire inbound handler is not sufficient.
- Keep the existing product decisions about escalation, remaining dependency
  advisories and optional cookie-request Origin checks visible. The CI install
  reports 21 high/1 low advisories across all dependencies; the prior handoff's
  16-high figure was production-only and is not directly comparable. No fresh
  production-only npm audit was run here.

No additional phase, deployment, merge, live acceptance, or provider comparison
is authorized by this review request.
