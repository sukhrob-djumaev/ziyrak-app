import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * PLAN.md §44.2/§46.6 task 7 — the flow builder and plugin system are
 * deprecated from the tenant-facing dashboard: their API routes are
 * removed (this test), while the underlying logic (`src/lib/flows/
 * flow-builder.ts`, `src/lib/plugins.ts`) is retained per the instruction
 * not to discard working code without strong reason. Acceptance criterion
 * is explicit: "confirmed unreachable from any route/UI (grep-verified)."
 */

const SRC_ROOT = path.join(process.cwd(), "src");

function readAllSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readAllSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("Flow builder / plugin system deprecation (§44.2/§46.6 task 7)", () => {
  it("no route.ts exists under src/app/api/flows or src/app/api/admin/plugins", () => {
    expect(fs.existsSync(path.join(SRC_ROOT, "app", "api", "flows"))).toBe(false);
    expect(fs.existsSync(path.join(SRC_ROOT, "app", "api", "admin", "plugins"))).toBe(false);
  });

  it("no source file references the removed /api/flows or /api/admin/plugins routes", () => {
    // The two retained modules' own header comments document *why* they're
    // dormant, which necessarily names the routes that used to call them —
    // that's the documentation this test's neighbor asserts exists, not a
    // live reference. Every other file in src/ must have zero mentions.
    const selfDocumenting = new Set([
      path.join(SRC_ROOT, "lib", "flows", "flow-builder.ts"),
      path.join(SRC_ROOT, "lib", "plugins.ts"),
    ]);

    const offenders: string[] = [];
    for (const file of readAllSourceFiles(SRC_ROOT)) {
      if (selfDocumenting.has(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("api/flows") || content.includes("api/admin/plugins")) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no dashboard page references a Flows or Plugins nav entry/route", () => {
    const dashboardDir = path.join(SRC_ROOT, "app", "(dashboard)");
    const offenders: string[] = [];
    for (const file of readAllSourceFiles(dashboardDir)) {
      const content = fs.readFileSync(file, "utf8");
      if (/href=["']\/flows/.test(content) || /href=["']\/plugins/.test(content)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the underlying flow-builder and plugin logic modules are retained, not deleted", () => {
    expect(fs.existsSync(path.join(SRC_ROOT, "lib", "flows", "flow-builder.ts"))).toBe(true);
    expect(fs.existsSync(path.join(SRC_ROOT, "lib", "plugins.ts"))).toBe(true);
  });
});
