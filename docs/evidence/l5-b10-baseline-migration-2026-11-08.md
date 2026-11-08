# B10 — baseline migration test (2026-11-08)

`tests/repository/baseline-migration.test.ts` replays the real migration chain in a scratch database (created and dropped by the test): schema up to just before `20261028000000_l4_1b_purchases`, three workspaces seeded the old way (one suspended), then that migration, then every later one.

Asserts (all passed, 4/4, throwaway pgvector Postgres 16, local):
- every existing workspace holds exactly one active `baseline` purchase of `legacy-baseline` v1, price 0 (not billed);
- no row in any pre-existing table is deleted or changed in count; workspace status untouched;
- the baseline grants exactly the five pre-packaging capabilities plus `seats.members` 1000, nothing wider;
- a workspace inserted afterwards (older app version during a rolling deploy) also receives the baseline via the trigger;
- running all later migrations keeps every active baseline purchase.

Limits: SQL-level migration test; does not exercise the resolver or the app after migration (covered by `tests/security/entitlement-enforcement.test.ts`), and does not prove production data volume or lock time. A DB-level rollback is not tested (migrations are forward-only). Closes the B10 follow-up named in L5; B10's "restart preserves provider mappings" part belongs to the Stripe-credentialed L5 acceptance and stays open.
