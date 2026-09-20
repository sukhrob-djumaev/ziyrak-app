import { describe, it, expect, afterEach } from "vitest";
import { ESLint } from "eslint";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * PLAN.md §46.3 (Phase 3) acceptance criterion 2 / §5.7 — the
 * deliberate-violation test for the two module-dependency-direction rules
 * this phase adds to eslint.config.mjs: a `channels/` file must not import
 * from `ai/`, and an `ai/` file must not import a concrete
 * channel/messaging SDK directly. Same pattern as
 * `raw-prisma-lint.test.ts`'s own deliberate-violation test — write a
 * scratch file, confirm ESLint flags it, then remove the scratch file.
 */

const CHANNELS_SCRATCH_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  "channels",
  `__lint_scratch_channels_boundary_violation_${crypto.randomUUID()}__.ts`
);

const AI_SCRATCH_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  "ai",
  `__lint_scratch_ai_boundary_violation_${crypto.randomUUID()}__.ts`
);

function writeScratchFile(filePath: string, contents: string) {
  fs.writeFileSync(filePath, contents, "utf8");
}

afterEach(() => {
  for (const p of [CHANNELS_SCRATCH_PATH, AI_SCRATCH_PATH]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

describe("ESLint module-boundary rules (§46.3/§5.7)", () => {
  it("fails a channels/ file that imports from ai/ (§19.1 — a ChannelAdapter must emit events, not call ai/ directly)", async () => {
    writeScratchFile(
      CHANNELS_SCRATCH_PATH,
      `import { chat } from "@/lib/ai/engine";\n\nexport function leaksAcrossBoundary() {\n  return chat;\n}\n`
    );

    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([CHANNELS_SCRATCH_PATH]);
    const messages = results.flatMap((r) => r.messages);

    expect(
      messages.some((m) => m.ruleId === "no-restricted-imports"),
      `expected a no-restricted-imports violation, got: ${JSON.stringify(messages)}`
    ).toBe(true);
  });

  it("§46.5 — the Phase 3 temporary allowlist is gone: a previously-exempt, now-migrated channel file is held to the same rule as everything else", async () => {
    // whatsapp.ts (and every other real channel file) no longer imports
    // ai/ at all post-migration, so this asserts the CURRENT file is clean
    // — proving there is no remaining allowlist entry, not merely that
    // this one import happens not to trigger it.
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([path.join(process.cwd(), "src", "lib", "channels", "whatsapp.ts")]);
    const messages = results.flatMap((r) => r.messages);
    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(false);

    // And to prove that's because the *rule* has no exception (not because
    // this rule only ever applied to new files): a scratch violation placed
    // at whatsapp.ts's own former allowlisted path fails exactly like the
    // brand-new-file case above.
    writeScratchFile(
      CHANNELS_SCRATCH_PATH,
      `import { createNewConversation } from "@/lib/ai/engine";\n\nexport function leaksAcrossBoundary() {\n  return createNewConversation;\n}\n`
    );
    const scratchResults = await eslint.lintFiles([CHANNELS_SCRATCH_PATH]);
    const scratchMessages = scratchResults.flatMap((r) => r.messages);
    expect(scratchMessages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
  });

  it("fails an ai/ file that imports a concrete channel/messaging SDK directly (§5.7)", async () => {
    writeScratchFile(
      AI_SCRATCH_PATH,
      `import nodemailer from "nodemailer";\n\nexport function leaksAcrossBoundary() {\n  return nodemailer;\n}\n`
    );

    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([AI_SCRATCH_PATH]);
    const messages = results.flatMap((r) => r.messages);

    expect(
      messages.some((m) => m.ruleId === "no-restricted-imports"),
      `expected a no-restricted-imports violation, got: ${JSON.stringify(messages)}`
    ).toBe(true);
  });

  it("does not flag an ai/ file with no concrete-SDK import", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([
      path.join(process.cwd(), "src", "lib", "ai", "engine.ts"),
    ]);
    const messages = results.flatMap((r) => r.messages);

    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(false);
  });
});
