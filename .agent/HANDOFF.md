# Handoff - latest session (2026-11-02)

- Merged L5 (PR #60, `14cec31`; main CI green) and the real-model L1.4 holdout record (PR #61, `d2b6d15`, docs only). L1.4 gate NOT met (missing-knowledge 90% < 95%, human-handoff 80% < 100%; same two cases in all 3 reps: tutoring-5 scorer wording, laundry-6 real hand-off gap). Not tuned on the holdout; fix + re-freeze needs owner decision. Record: `docs/evidence/l1.4-quality-evidence-2026-11-01-real-run.md`.
- L6 regression on main `d2b6d15` in worktree `ziyrak-l14-eval` (disposable DB `ziyrak_test_l6`, Redis :56382): `npm run test` 2225 passed/11 skipped/0 failed; first run had one onboarding `acquirePolicyLock` hook timeout under load (passes alone 11/11, did not recur); `test:signup-seeded` 1471/1471.
- Cleanup done (owner OK): all task containers and worktrees removed (l6, l14-eval, l6-acc); only /tmp scratch remains (rm denied).
- Also merged: PR #62 (`2ace8cf`, strict config refuses non-Stripe STRIPE_API_BASE) and PR #63 (`f094299`, de-flaked billing-status incident-count test after a one-off main CI failure on `2ace8cf`); main CI green on `f094299`. tsc+lint clean on `d2b6d15`.
- Expanded browser suite on `875a4a7`: 36/36 passed (stand-ins, AC power, fresh DB); record `docs/evidence/l6-candidate-rehearsal-2026-11-02.md`. Continuation: remaining L6 items are external (real channels, sender, outage drill, alerts, restore, capacity); owner decision on L1.4 fix pending. L7 needs explicit authorization.

## Previous session (2026-11-01)

- L5 payment lifecycle in PR #60 (worktree `/Users/sukhrob/Development/Repos/JS/ziyrak-l4-4`, branch `docs/l4.2-commercial-policy`), Stripe test mode only. Done: L5.1 checkout/webhook inbox/apply/hold, L5.2 upgrades, scheduled reductions, owner seat choice, restore-member, reconcile job, audited `repair_provision`, open-incident count in operator health, security-review fixes 1-6b.
- L5.3 tests added (real DB): concurrent webhook delivery (`billing-concurrency`), concurrent upgrades, overlapping reconcile, never-paid workspace keeps baseline (`billing-rollout`; narrower than the full B10 migration test). Local full run before these: 233 files / 2193 tests, tsc+lint clean. CI on each pushed head: check `gh pr checks 60`.
- Independent security review RAN (Opus, read-only); findings 1-4 fixed in `aaf8226` (stuck-event sweeper, double-paid parked, incomplete row no longer lifts hold, repair keeps unbound_ref open); CI build+image green on it. Known/unfixed: seat-reduction race on invitation accept (applyDueReductions), invoice.* events read data.subscription (moved in newer API versions).
- Browser: full 36-journey suite PASSED (EXIT=0) on final head `8bb4614` (CI build+image green on it; earlier also on `c8c2c92`), fresh DB + flushed Redis, AC power, stand-in Stripe (role on :4030), system Chrome. New J36 covers signup/verify/login, quote, checkout, signed webhooks (bad signature refused), hold and restore. J33/J36 call `allowUsd` because the billing policy defaults to MYR only. Proves the stand-in topology only, not real Stripe.
- Security re-review RAN (Opus, read-only, on `aaf8226`..`3561ba5`): findings 1-4 confirmed fixed; new F1 (repair closed the double-pay incident -> own kind `double_paid`), F2 (sweep attempts counted on every failure, exhausted events -> `failed`), F3 (incomplete row blocking the index now retries instead of parking) fixed with tests. F4 (invoice subscription ref read from both payload shapes) and F5 (hold date follows the ended row) also fixed; F4 still unproven against real Stripe (smoke test).
- NOT done: B10 migration test proper, credential-gated `test:smoke:stripe` (a skip is not a pass), non-owner member denial in J36, console button for repair_provision, paging on `billingIncidents`. Test DB: docker `ziyrak-l5-pg` 127.0.0.1:55434.
- Expanded browser suite on `875a4a7`: 36/36 passed (stand-ins, AC power, fresh DB); record `docs/evidence/l6-candidate-rehearsal-2026-11-02.md`. Continuation: remaining L6 items are external (real channels, sender, outage drill, alerts, restore, capacity); owner decision on L1.4 fix pending. L7 needs explicit authorization.

## Previous session (2026-10-29)

- Merged the ziyrak rename (PR #57, `0992611`): exact-head `ac83eda` CI build+image green, browser 35/35 (system Chrome via CHROMIUM_PATH, stand-in AI). GitGuardian red, owner chose to merge. Screenshots and demo.gif re-captured (PR chore/recapture-brand-images). Old-name leftovers removed. Open: acceptance DBs `ziyrak_acceptance_rename57*`, worktree `ziyrak-wt-rename`, topology still running (stop it).

## Previous session (2026-10-28)

- Merged L4.1c (PR #56, `98a0327`): platform AI ceilings, daily new-workspace cap, console section, J35. CI green + browser 35/35 on `8aa013e`. Independent security review done, M1/M4 fixed, M2/M3/L1/L3 recorded. Evidence: `docs/evidence/l4.1c-platform-limits-2026-10-28.md`.
- L4.1b merged earlier (PR #55, `081c35c`). Browser runs: AC power, load under 8, fresh migrated DB, flushed task Redis, detached with nohup, read-only log monitor.
- Worktree `ziyrak-l4-3` (L4.1c, merged) can be removed. Old scratch dirs /private/tmp/ziyrak-l*-acc* remain until `rm -rf` is allowed; acceptance DBs ziyrak_acceptance_l41* can be dropped.
- Expanded browser suite on `875a4a7`: 36/36 passed (stand-ins, AC power, fresh DB); record `docs/evidence/l6-candidate-rehearsal-2026-11-02.md`. Continuation: remaining L6 items are external (real channels, sender, outage drill, alerts, restore, capacity); owner decision on L1.4 fix pending. L7 needs explicit authorization.
