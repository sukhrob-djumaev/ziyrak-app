# Dependency policy (L1.2 / F01)

- **Cadence:** Dependabot opens grouped weekly PRs (`.github/dependabot.yml`): Next + eslint-config-next together,
  Prisma components together, test tooling together, and security patches together. CI must pass on each; a group
  that changes runtime behaviour also needs the focused suites for the area (validation/mail for Zod/Nodemailer,
  `tests/security` for the HTTP dispatcher).
- **Contract:** `tests/unit/dependency-contract.test.ts` fails when Prisma components or Next/eslint-config-next
  diverge, or when an `overrides` entry is not installed (stale) or does not resolve to its pinned version.
- **Audit:** run the full `npm audit` (not `--omit=dev`) and record the counts with the date.
  2026-10-25 after L1.2: 0 high/critical; 2 moderate, both `vitest`/`@vitest/mocker` (dev-only test runner;
  fix is the 4.x to 5.x major, deferred to the `test-tooling` group PR). Before: 1 high (zod), 5 moderate.
- **Override removal conditions** (remove when the upstream range no longer needs it; the contract test flags unused ones):
  `utf7>semver 5.7.2`, `prisma>mysql2 3.24.6`, `@prisma/config>deepmerge-ts 8.0.2`, `esbuild 0.28.2`,
  `whatsapp-web.js>puppeteer 25.15.0`: drop each once the parent's own dependency range resolves to a non-vulnerable
  version without it. `get-uri>basic-ftp` was removed 2026-10-25 (no longer in the tree).
