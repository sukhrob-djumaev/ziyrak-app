# R3 initial operational assessment

Status: **assessment only; safety fixes and rehearsal not implemented**.
Source baseline `551f9cd1d5146ed13368fda1e2ed85610f4fba21`, product baseline
`c20513d78421816ac0096eff1cf3dbb0d6c9aa55`. No dependency version, operational
script, database, live process or provider configuration changed.

## Isolation used in this session

The attached R1 worktree is
`/Users/sukhrob/.codex/worktrees/r1-delivery-reliability/owly`, initially detached
at the source baseline, with its own `node_modules` installed using
`npm ci --ignore-scripts`. No live `.env` was copied. Fault-injection unit tests
set both database URLs to an unreachable synthetic target and mock persistence.
They require no database; no cleanup/migration command ran. Port 3000 was
observed listening under PID 51167 before work. Worker health/queue execution
was not checked, and no live-service readiness claim is made.

## Fresh dependency evidence

Both registry queries executed in the isolated worktree on October 14:

- `npm audit --omit=dev --json`: exit 1; **16 high**, zero other severities.
- `npm audit --json`: exit 1; **21 high, 1 low**, zero critical/moderate.
- `npm ls deepmerge-ts mysql2 semver extract-zip basic-ftp braces esbuild --all --json`:
  exit 0; dependency-path inspection completed.

Audit exit 1 means advisories were reported, not that the registry query failed.
The first sandboxed registry requests failed DNS resolution; the authorized
network retries succeeded. [Compact audit evidence](evidence/r3-dependency-audit-2026-10-14.json)
retains both scopes, affected nodes, upstream advisories, suggested fixes and
the exact lockfile SHA-256. Counts include transitive/metavulnerable packages;
they are not counts of independently exploitable application vulnerabilities.

| Dependency path and installed version                                      | Classification and inspected reachability                                                                                                                                                                                                                                                       | Next safe step                                                                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imap@0.8.19 → utf7@1.0.2 → semver@5.3.0`                                  | Production dependency; email adapter imported by channel bootstrap. Inspected utf7 calls compare trusted `process.version` against constant `6.0.0`; no attacker-controlled semver input identified in those calls. This is bounded inspection, not proof of absence of all paths.              | Test a targeted semver patch within major 5, preserving the legacy adapter contract; do not downgrade imap blindly.                                                   |
| `prisma@7.10.0 → @prisma/config@7.10.0 → deepmerge-ts@7.1.5`               | Prisma CLI/config tooling is packaged as a production dependency. Runtime raw-client uses the PostgreSQL adapter. The advisory requires recursive object graphs; ordinary JSON alone does not establish that path.                                                                              | Check a supported compatible Prisma/config patch; verify generation, migrations and build in isolation.                                                               |
| `prisma@7.10.0 → mysql2@3.15.3`                                            | Installed through Prisma; no direct MySQL connection path identified in product source using the PostgreSQL adapter. CLI path is not assessed as safe merely because the product uses Postgres.                                                                                                 | Review compatible upstream repair/targeted patch and CLI usage; no automatic Prisma major downgrade.                                                                  |
| `whatsapp-web.js@1.34.7 → puppeteer@24.38.0`, plus dev `puppeteer@24.43.1` | Browser download/extraction/proxy dependency tree. WhatsApp Web eligibility is explicitly feature gated and restricted to the dev/demo business, but the module is still imported. Browser provisioning has separate supply-chain/archive risks; import alone does not prove exploit execution. | Verify installed download/proxy call paths and compatible upstream patches. Do not replace the supported Meta path or silently delete the historical demo capability. |
| `eslint-config-next@16.4.0 → fast-glob → micromatch → braces@3.0.3`        | Development/lint tooling; not a runtime API handler. Full audit includes it, production-only does not.                                                                                                                                                                                          | Review trusted pattern input and compatible fixes. Preserve Next 16.4 conventions; npm's suggested Next 14 downgrade is not a safe mechanical repair.                 |
| `tsx`/`vite → esbuild@0.27.7`                                              | Low-severity advisory in the full audit, not production-only. Platform/path applicability has not been established by this assessment.                                                                                                                                                          | Check a compatible patch and worker/test/build behavior; do not label this accepted.                                                                                  |

The vulnerability descriptions were checked against upstream
[DeepmergeTS](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
[extract-zip](https://github.com/advisories/GHSA-jmr9-qjv8-65gv),
[semver](https://github.com/advisories/GHSA-c2qf-rxjj-qqgw), and
[MySQL2](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr) advisories.
Reachability classifications above are source-based inferences with the stated
limits, not a penetration test or residual-risk acceptance. No forced audit fix
or package upgrade was run. Safe patch proposals need actual compatibility checks;
only remaining unresolved risks need an owner decision after that work.

## Acceptance harness gaps found by inspection

1. `start-all.sh` sets child `DATABASE_URL` but not `DIRECT_DATABASE_URL`.
   `prisma.config.ts` and `src/lib/jobs/queue.ts` prefer the direct URL. An inherited direct
   URL can therefore disagree with the selected acceptance DB. Pin/check both
   together before migrations and every startup; test mismatches fail closed.
2. `run.sh` still calls `pkill -f "Google Chrome for Testing"` and deletes all
   `Singleton*` profile files in the chosen directory. This is process-name
   cleanup and has no run-ownership check. Replace it with recorded ownership
   or avoid preemptive cleanup; never signal unrelated browser instances or
   delete locks for active profiles.
3. J09/J10 now uses a recorded numeric worker PID, which corrected the previous
   broad kill, but does not validate current process identity/run ownership
   before signaling. A stale PID can be reused. Validate ownership and reject
   stale/foreign records; rehearse using test-owned processes only.
4. `lib.cjs` still falls back to a historical acceptance database without ACC_DB.
   Its default SQL command also derives only user/database from the URL and
   assumes Docker container `owly-db-1`, ignoring host/port. An ACC_PSQL override
   is unverified against the app's target. Require an explicit throwaway target
   and verify current database/server identity before collecting evidence.
5. `start-all.sh` records only the worker PID; web, LLM and hosts have no complete
   run manifest. Add run identity, checkout/build identity and exact ownership
   for start/stop/recovery. Check ports before startup and preserve port 7700.
   Do not infer ownership from a healthy endpoint or a matching executable name.

Installed Next.js CLI documentation was read at
`node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`; it confirms
production `next start` requires a build and allows an explicit port/hostname.
No Next.js code/API change was made.

## Remaining R3 verification

Audit execution is complete; dependency remediation, independent security review,
isolated startup/stop/recovery rehearsal, build identity and exact-commit CI are
**not run**. R3 remains open. Do not run the old full acceptance startup/cleanup
unchanged merely to produce evidence. Add desired-behavior safety regressions
first, fix the listed harness boundaries, and rehearse in a separate throwaway
topology before R1 durability/browser verification. Preserve backup/restore gates
for selected migration work. No migration or deployment permission is inferred
from this assessment or the historical standing-permission note.
