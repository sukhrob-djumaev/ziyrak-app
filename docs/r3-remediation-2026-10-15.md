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

## Update 2026-10-21: Puppeteer 25 removes the unpatched archive extractor

Status: implemented and verified on branch `r3-puppeteer25` (commit `fcb2487`, based on main
`a34f8bf`); **not merged**. Needs owner approval to merge and an owner decision on the remaining
residual. No deployment, live restart or production migration.

**New fix path.** The 2026-10-15 record said neither finding had a fixed version. That is still
true for `extract-zip` (latest 2.0.1) and `braces` (latest 3.0.3), but Puppeteer 25's
`@puppeteer/browsers` 3.x no longer depends on `extract-zip`. npm's own suggested fixes
(downgrading `whatsapp-web.js` to 1.34.2 or `eslint-config-next` to 14.2.35) are downgrades and
are not used.

**Change.** `puppeteer` `^24.40.0` -> `^25.15.0` (devDependency, requires Node >= 22.12; the Docker
image is Node 22.23.2) and an override pointing `whatsapp-web.js`'s Puppeteer at the same
25.15.0. The `get-uri`/`basic-ftp` chain, which only existed through Puppeteer 24's proxy agent, is
gone with it; its two patched-dependency tests are replaced by a lockfile guard that fails if
`extract-zip`, `get-uri` or `basic-ftp` return or a second Puppeteer appears. `zod` stays at 4.3.6
(an exploratory exact pin was reverted: it was not the cause of anything).

**Audit (same commands as before, lockfile of `fcb2487`).** Production: 5 high -> **0**. Full
tree: 10 high -> **5 high**, all the `braces` -> micromatch -> fast-glob -> eslint-plugin-next ->
eslint-config-next lint-tooling chain, no fixed version published.

**Verification on `fcb2487`.**

| Check | Result |
| --- | --- |
| Typecheck, strict lint | clean |
| Unit suite, no Redis | 154 files / 1573 passed / 23 Redis-gated skips |
| Unit suite, Redis-backed | 154 files / 1595 passed / 1 intentional skip |
| Docker image (Node 22) | builds; offline non-root probe: user `nextjs`, Puppeteer 25.15.0, `extract-zip`/`get-uri`/`basic-ftp` absent, `zod` 4.3.6, `skipDownload` true; one pre-existing Dockerfile warning (JWT_SECRET build arg) |
| Full browser suite, 26 journeys, fresh empty database, frozen build, committed clean head | **26/26 passed (8 min)**, headless-shell mode |

**Harness changes (deliberate, recorded).** (1) Opt-in `ACC_HEADLESS=shell` (with `CHROMIUM_PATH`
at Chrome's headless shell, same Chrome 153): default behaviour unchanged. (2) Triple-click text
selection in J15, J20 and J24 replaced with explicit `focus()`+`select()`, because the headless
shell does not honour multi-click selection.

**Why shell mode.** Between 2026-10-20 evening and 2026-10-21, full runs in the default windowed
Chrome stalled at random journeys (J03, J11, J13, J15) with page-load timeouts and 180 s protocol
timeouts, on both the known-good Puppeteer 24 code (92ac544) and this candidate. The server,
Postgres (no lock waits, <= 44 connections) and Redis were healthy throughout. Contributing
conditions found: a runaway VS Code Dart language server (load average to 38; stopped by PID with
the owner's permission), a locked screen (`CGSSessionScreenIsLocked`), and macOS post-reboot
background indexing. A larger Postgres pool (`DATABASE_POOL_MAX=40`) did not fix it, and Chrome's
launch flags are equivalent between Puppeteer 24 and 25. The windowless shell, which does not depend
on a visible window, passed the whole suite. **Not tested:** the old code in shell mode, so "the
windowed browser was the unstable part" is the best-supported explanation, not a proven one.

**Limits.** `whatsapp-web.js` imports cleanly against Puppeteer 25 but no real WhatsApp Web session
was exercised. The default windowed-browser mode is no longer covered by the recorded run. Stand-in
AI only; no provider claim. Reviews were agent reviews, not human ones.

**Residual decision (owner).** After this change the only remaining finding is `braces` in lint
tooling: handles repository-controlled lint/rootDir patterns, no customer-controlled input, present
in the Docker node_modules (not claimed absent from the artifact). Proposed: accept temporarily
under the stated control (keep these patterns repository-controlled; review any untrusted pattern
boundary) and reopen when an upstream patch appears. The `extract-zip` residual from 2026-10-15 is
closed by this change if merged; if not merged, that residual and its controls stand as before.
