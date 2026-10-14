# R3 dependency remediation and residual decision

Status: implementation and compatibility verification passed; residual risk
is **not accepted** and R3 is not complete. Main product, dependencies, databases
and running services were not modified. No push, merge or deployment.

## Candidate and changes

Isolated checkout: `/Users/sukhrob/.codex/worktrees/r3-operational-safety/owly`.
Parent `5bfbdca` contains the verified R1 candidate and ownership-safe harness.
The [initial assessment](r3-operational-assessment-2026-10-14.md) is historical;
[remediation audit evidence](evidence/r3-remediation-audit-2026-10-15.json)
records the candidate lockfile hash, paths and both audit scopes.

Five targeted overrides repair installed consumers: utf7 → semver5.7.2;
Prisma → mysql2 3.24.6; Prisma config → deepmerge-ts8.0.2;
get-uri → basic-ftp6.2.3; tsx/Vite → esbuild0.28.2. Prisma7.10 and Next16.4
remain selected; no forced audit fix or bulk major upgrade.
Fresh audits exit1 with **5 high production** (previously16), **10 high full**
(previously21high/1low). Counts include dependent packages and do not mean five
or ten independently reachable exploits.

Automatic browser downloads now default off through `.puppeteerrc.cjs`.
Docker copies that configuration before builder `npm ci` and into the runner.
Root and WhatsApp's nested Puppeteer configuration are tested from their actual
package directories, with all Puppeteer environment variables removed. An explicit
environment override or browser-install command can bypass this default; it is a
control over ordinary provisioning, not a patch for archive extraction.
CI explicitly pins both database URLs to the same isolated test database.

## Verification evidence

- Permanent hostile FTP-listing and recursive Prisma merge regressions failed on
  original dependencies, then passed on targeted patches. Tests use bounded child
  processes; the merge test resolves Prisma's consumed dependency, not the root copy.
- Real test-owned loopback FTP exercises get-uri's successful download/cache,
  unsupported MDTM with MLSD fallback, missing file cleanup, and refusal of a
  different passive transfer host. The security default remains enabled.
- Prisma generation/validation and isolated migration deployment passed. Existing
  schema warnings are not silently treated as repaired.
- Node22/Linux Docker build passed. Candidate image:
  `sha256:1fa65810446e0721e8e8796f4e0dbb5ac3156eecd386f632c27ac739261bfd52`.
  A network-disabled, nonroot container probe independently verified all five
  consumed versions, both browser defaults, bounded recursive merge and hostile
  listing under Node22.23.2. This is build/provisioning evidence, not deployment.
- Redis-backed full suite:132files/1205passed/1 intentional in-memory fallback
  skip. Type check and strict lint passed. Independent source/config/security review
  found no confirmed remaining candidate issue; the reviewer did not run tests or
  accept residuals. A follow-up test now resolves basic-ftp from its actual get-uri
  consumer and passed. Earlier failing FTP-fixture runs are not passes.
- Ordinary no-Redis suite:132files/1183passed/23 optional Redis skips.
  Both suites exited0 against isolated `ziyrak_r3_test_20261015`, with both
  database URLs pinned together. Redis used a task-owned loopback container on6381.
- Actual assembled build/start/recovery/stop already passed all17 browser scripts
  on R1 candidate63247f6. Ownership checks confirmed no recorded process remained
  alive after shutdown. Dependency changes are not a new browser/provider claim.

## Concrete residual risk decision required

PLAN R3 requires confirmed in-scope risks resolved **or explicitly accepted**.
Neither remaining finding has a published fixed version in the inspected audit.
Do not use npm's suggested Next downgrade as a repair or record owner acceptance
without an actual answer.

| Residual | Inspected boundary and proposed temporary controls |
| --- | --- |
| extract-zip2.0.1 and its Puppeteer dependency chain | Archive extraction can write through unsafe symlinks. Ordinary automatic provisioning defaults off; use trusted existing/system browser executables. Do not re-enable archive installation or arbitrary browser mirrors without separate inspection. Manual provisioning still exposes this risk. WhatsApp's feature gate does not itself protect installation. |
| braces3.0.3 through Next lint tooling | Inspected use handles trusted repository lint/rootDir patterns; no customer-controlled path identified. Full Docker node_modules includes this tooling, so it is not claimed absent from the artifact. Keep these patterns repository-controlled; review any new untrusted pattern boundary. |

Proposed decision: temporarily accept only these stated residuals under the
controls above; reopen when an upstream patch appears or provisioning/input
boundaries change. The owner may instead require dependency replacement before
R3 closes. Neither option authorizes production deployment or a live restart.
Primary advisories: [extract-zip path traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv),
[extract-zip symlink writes](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3),
[braces resource exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

No production migration is part of R3. Exact-commit remote CI remains required
before any separately authorized merge. Local checks cannot establish that status.
