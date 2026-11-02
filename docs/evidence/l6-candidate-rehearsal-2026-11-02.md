# L6 candidate rehearsal — 2026-11-02

Candidate: main `875a4a7` (code identical to `f094299`; later commits are docs). Build digest `3713b870…ea212`.

## What ran (all local, stand-ins)
- `npm run test` on `d2b6d15`: 2225 passed / 11 skipped / 0 failed. `npm run test:signup-seeded`: 1471/1471. `tsc --noEmit` and `lint --max-warnings 0` clean.
- Main CI green on `f094299` (build + image).
- Expanded browser suite on `875a4a7`: **36/36 journeys passed** (J01–J36). Topology: isolated worktree, fresh `ziyrak_acceptance_*` Postgres 16, own Redis, stand-in AI and Stripe, captured mail, system Chrome, AC power, synthetic secrets. Not run on a production build host.

## Setup notes
A fresh worktree has no `.env`: the run needs synthetic `JWT_SECRET`, `WEBHOOK_SECRET` and `SECRET_KEY_V1`. Stop a topology with `runtime.cjs stop all` (bare `stop` is a no-op).

## Still external (criteria stay OPEN)
Real supported-channel flows, production mail sender, live outage drill, alert routing, restore from a real backup, capacity/load on production-like infrastructure, real-provider Stripe smoke, L1.4 real-model quality gate (2 of 8 not met; owner decision pending).

L7 (rollout / live money) needs explicit authorization and was not started.
