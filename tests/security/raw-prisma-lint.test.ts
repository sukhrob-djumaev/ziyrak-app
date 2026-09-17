import { describe, it, expect, afterEach } from "vitest";
import { ESLint } from "eslint";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * PLAN.md §33.4 item 5 / §36 item 7 — the deliberate-violation test: add an
 * import of the raw Prisma client from an application module the allowlist
 * doesn't cover, confirm the ESLint rule (eslint.config.mjs, §8.3/§16.4)
 * fails it, then remove the scratch file. This is what makes "forgot the
 * tenant filter" a build-time lint failure instead of a silent runtime bug
 * (§8.1) — this test is what proves the rule actually fires, not just that
 * it's configured.
 */

// Unique per test run (not a fixed name) so this can never collide with a
// concurrently-running suite/process touching the same path.
const SCRATCH_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  `__lint_scratch_raw_prisma_violation_${crypto.randomUUID()}__.ts`
);

function writeScratchFile(contents: string) {
  fs.writeFileSync(SCRATCH_PATH, contents, "utf8");
}

afterEach(() => {
  if (fs.existsSync(SCRATCH_PATH)) fs.unlinkSync(SCRATCH_PATH);
});

describe("ESLint raw-Prisma-client import restriction (§8.3/§16.4/§33.4 item 4)", () => {
  it("fails a disallowed application module that imports the raw client directly", async () => {
    writeScratchFile(
      `import { prisma } from "@/lib/prisma/raw-client";\n\nexport function leaksTenantScoping() {\n  return prisma.customer.findMany();\n}\n`
    );

    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([SCRATCH_PATH]);
    const messages = results.flatMap((r) => r.messages);

    expect(
      messages.some((m) => m.ruleId === "no-restricted-imports"),
      `expected a no-restricted-imports violation, got: ${JSON.stringify(messages)}`
    ).toBe(true);
  });

  it("fails a disallowed module that dynamically imports the raw client (no-restricted-imports alone misses this)", async () => {
    writeScratchFile(
      `export async function leaksTenantScoping() {\n  const { prisma } = await import("@/lib/prisma/raw-client");\n  return prisma.customer.findMany();\n}\n`
    );

    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([SCRATCH_PATH]);
    const messages = results.flatMap((r) => r.messages);

    expect(
      messages.some((m) => m.ruleId === "no-restricted-syntax"),
      `expected a no-restricted-syntax violation for the dynamic import, got: ${JSON.stringify(messages)}`
    ).toBe(true);
  });

  it("does not flag the same import inside the allowlisted tenancy module", async () => {
    const allowlistedPath = path.join(
      process.cwd(),
      "src",
      "lib",
      "tenancy",
      `__lint_scratch_allowlisted_${crypto.randomUUID()}__.ts`
    );
    fs.writeFileSync(
      allowlistedPath,
      `import { prisma } from "@/lib/prisma/raw-client";\n\nexport function legitimateControlPlaneAccess() {\n  return prisma.business.findMany();\n}\n`,
      "utf8"
    );

    try {
      const eslint = new ESLint({ cwd: process.cwd() });
      const results = await eslint.lintFiles([allowlistedPath]);
      const messages = results.flatMap((r) => r.messages);

      expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(false);
    } finally {
      fs.unlinkSync(allowlistedPath);
    }
  });
});
