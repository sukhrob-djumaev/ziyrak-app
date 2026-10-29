# Operations runbook (L2.2)

What it takes to ship, run, recover and wind down Ziyrak. Written from what the repository actually does today; anything that still needs an owner decision or a name is marked **INPUT NEEDED**. Companion to [operator setup](operator-setup.md).

## 1. Release identity and promotion

- **One image, built once, tested as built, promoted by digest.** CI builds the image from the commit (`APP_BUILD_SHA` = the commit SHA), runs `scripts/release/image-smoke.sh` against *that image* (strict production configuration, web + worker + a real Postgres), and scans it. The publish workflow repeats build → smoke → scan for the release commit and pushes **the image it just tested**; the pushed digest is printed in the job summary. Deploy by digest: set `image.digest` (`sha256:...`) in the Helm values; it wins over `image.tag`. Publishing is allowed only from a release tag or `main`, for a commit whose push-to-main CI run completed successfully. The scanner reads a saved copy of the image and never receives the Docker socket.
- The smoke test proves, on the image itself: the worker refuses an incomplete production configuration; web migrates and becomes live and ready; the worker heartbeat turns `ok`; the reported build SHA equals the commit; the public health answer leaks nothing; the worker stops cleanly on SIGTERM; and no development or demo weight is shipped (no `src/`, `tsx`, test tooling, or Chromium unless built with `--build-arg WITH_BROWSER=true`).
- What runs in production is therefore identifiable: `/api/health` with the operator token shows `build.sha`.
- **Not done by a pipeline step (needs owner authorization):** publishing to a registry, tagging a release, deploying, DNS or sender changes.

## 2. Migrations and rollback

Rollback means **redeploying the previous image digest against the newer schema**. Therefore:

- Migrations are **expand/contract**. A release's migration must be compatible with the previous app version: add nullable or defaulted columns and new tables; do not drop, rename, retype or tighten in the same release. Remove what is no longer used in a **later** release, after the previous version can no longer be rolled back to.
- `tests/unit/migration-compat.test.ts` is a pattern guard for this (not a SQL parser). For every migration added after `20261026030000`, a statement that drops, renames, retypes, tightens, adds a constraint or unique index on an existing table, rewrites data, deletes data, or adds a required column without a default fails the test unless the line directly above that statement is `-- contract-migration: <reason>`. Approval covers that one statement only. Reviewers still read every migration: the guard catches common forms, not all of them.
- Migrations run before the app starts (init container / image start command) using the **direct** database URL, never a transaction pooler.
- **Roll back the app:** deploy the previous digest. The newer schema stays. This is safe only because of the rule above.
- **Roll back the data:** a destructive or incorrect data change is recovered from backup (section 3), not by running migrations backwards. There are no down migrations.
- Keep the old encryption key configured until `reencryptMfaSecrets()` and your stored-credential re-encryption have moved all ciphertext to the new key (see operator setup, F09).

## 3. Backup and restore drill

- **Backups: INPUT NEEDED.** The repository does not take backups. Use the managed database's point-in-time recovery or scheduled `pg_dump`, stored away from the database host, with restricted access. Decide the **RPO** (how much data you can lose) and **RTO** (how long recovery may take) and record them in the table below.
- **Rehearse restoring** with `SOURCE_DATABASE_URL=... scripts/ops/restore-drill.sh`. It dumps the source read-only, restores into a throwaway Postgres whose data is in memory (no Docker volume is left behind), compares the row count of every `public` table, compares the restored migration history with this checkout, and prints the elapsed time. The dump is a temporary file; use an encrypted disk for real data. Counts are a smoke check, not proof of content integrity. Run it against a snapshot or a quiet database.
- First recorded drill (2026-10-26, isolated test database, local Docker): 60 application tables (schema public) restored, **0 mismatches**, dump + restore **3 s**, restored database at the same 29 migrations as the checkout. This proves the procedure and the script, not production restore time or size. **Repeat on a production-sized copy and record the result.**
- Also rehearse: restoring with the previous image digest (rollback) and with a rotated encryption key set (the old key must still be available for old ciphertext).

| Item | Value |
| --- | --- |
| RPO target | INPUT NEEDED |
| RTO target | INPUT NEEDED |
| Backup mechanism and location | INPUT NEEDED |
| Last drill date / source size / elapsed | 2026-10-26 / test database / 3 s (script check only) |

## 4. Retention, deletion and offboarding

What exists:
- **Per-workspace retention sweep** (`sweep-retention`, daily 03:00 UTC): applies `BusinessConfig.retentionDays` where a workspace has set it; a workspace without a value is skipped (nothing is deleted by default).
- **Customer data requests:** export and deletion/anonymization for a single customer (`src/lib/customers/gdpr.ts`).
- **Account mail tokens** are single-use and expire (verification 24 h, reset 1 h); expired and used tokens are purged.

What does **not** exist yet (open, needs a product decision before launch):
- **Whole-workspace offboarding** (export everything, then delete the workspace and its backups on a schedule). Today this would be a manual, audited operator procedure; it is not implemented or rehearsed.
- A published retention schedule for logs, backups and platform audit records, and the legal basis for each. **INPUT NEEDED** (owner/legal).

## 5. Alerts

The product now exposes the signals; wiring them to a pager or dashboard is a deployment task.

| Signal | Where | Suggested alert |
| --- | --- | --- |
| Web not ready | `/api/health/ready` 503 (probe) | Any replica not ready for 2 min; all replicas not ready immediately |
| Worker absent or stale | `/api/health` `services.worker` = `stale` or `none` (token), and the container heartbeat probe | `stale` or `none` for 2 min |
| Queue backlog | `queue.oldestWaitingSeconds` | > 300 s |
| Failed jobs | `queue.failedLastHour` | > 0 sustained, or a rising trend |
| Redis down | `services.redis` = `down` | Page; service continues with per-process limits |
| Deployed version | `build.sha` | Mismatch with the intended release |
| Failed or uncertain deliveries | delivery recovery console | Any item older than your SLA |
| Platform spend ceilings | managed AI allowances | Per owner policy (L4) |

Alert thresholds and routing are **INPUT NEEDED** (owner).

## 6. Incident ownership

| Role | Owner |
| --- | --- |
| Incident commander / first responder | INPUT NEEDED |
| Security contact (private vulnerability reporting) | INPUT NEEDED (see SECURITY.md; must be established before public launch) |
| Database / infrastructure | INPUT NEEDED |
| Communications to customers | INPUT NEEDED |

Minimum first-response steps: check `/api/health/ready` and the worker state; check the queue age; check the last deploy's build SHA and roll back to the previous digest if the change correlates; restore from backup only for data loss or corruption; record a timeline and the customer impact.

## 7. Capacity

- Method: `scripts/loadtest/run.sh redis` (2 web replicas + 2 workers behind PgBouncer with shared Redis, stand-in AI at 300 ms). It runs in an isolated Compose project, validates a disposable `ziyrak_load` database, and tears down only what it created.
- Results and their limits are recorded in `docs/evidence/l2.2-release-operations-2026-10-26.md`. A stand-in AI and one laptop are **not** the production topology: re-measure on the intended hosting before sizing.
