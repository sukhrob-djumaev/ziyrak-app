# Handoff - latest session (2026-11-01)

- L5 payment lifecycle in PR #60 (worktree `/Users/sukhrob/Development/Repos/JS/ziyrak-l4-4`, branch `docs/l4.2-commercial-policy`), Stripe test mode only. Done: L5.1 checkout/webhook inbox/apply/hold, L5.2 upgrades, scheduled reductions, owner seat choice, restore-member, reconcile job, audited `repair_provision`, open-incident count in operator health, security-review fixes 1-6b.
- L5.3 tests added (real DB): concurrent webhook delivery (`billing-concurrency`), concurrent upgrades, overlapping reconcile, never-paid workspace keeps baseline (`billing-rollout`; narrower than the full B10 migration test). Local full run before these: 233 files / 2193 tests, tsc+lint clean. CI on each pushed head: check `gh pr checks 60`.
- NOT done: independent security re-review after L5.2 (required before merge), browser journey J36 (stand-in) and the J-run for billing UI/hold/restore, B10 migration test proper, credential-gated `test:smoke:stripe`, console button for repair_provision, paging on `billingIncidents`. Test DB: docker `ziyrak-l5-pg` 127.0.0.1:55434 (`ziyrak_test_l50`).
- Continuation: wait for CI green, request independent security review, then browser run, then merge per standing authorization.

## Previous session (2026-10-29)

- Merged the ziyrak rename (PR #57, `0992611`): exact-head `ac83eda` CI build+image green, browser 35/35 (system Chrome via CHROMIUM_PATH, stand-in AI). GitGuardian red, owner chose to merge. Screenshots and demo.gif re-captured (PR chore/recapture-brand-images). Old-name leftovers removed. Open: acceptance DBs `ziyrak_acceptance_rename57*`, worktree `ziyrak-wt-rename`, topology still running (stop it).

## Previous session (2026-10-28)

- Merged L4.1c (PR #56, `98a0327`): platform AI ceilings, daily new-workspace cap, console section, J35. CI green + browser 35/35 on `8aa013e`. Independent security review done, M1/M4 fixed, M2/M3/L1/L3 recorded. Evidence: `docs/evidence/l4.1c-platform-limits-2026-10-28.md`.
- L4.1b merged earlier (PR #55, `081c35c`). Browser runs: AC power, load under 8, fresh migrated DB, flushed task Redis, detached with nohup, read-only log monitor.
- Worktree `ziyrak-l4-3` (L4.1c, merged) can be removed. Old scratch dirs /private/tmp/ziyrak-l*-acc* remain until `rm -rf` is allowed; acceptance DBs ziyrak_acceptance_l41* can be dropped.
- Continuation: L4.2 needs owner commercial decisions (seller entity/country, currencies, pricing, trial/grace, refund/tax/invoice, processor vs merchant of record). Other open owner inputs: backup RPO/RTO, alert routing, incident owners, offboarding, OpenAI key for L1.4, task sessions, bulk-export-after-downgrade.
