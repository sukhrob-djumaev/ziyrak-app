import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * L1.2 / F01: dependency components that must move together, and overrides that
 * must still be doing something. See docs/dependency-policy.md for removal rules.
 */
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")).packages as Record<string, { version?: string }>;
const versions = (name: string) =>
  Object.entries(lock)
    .filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
    .map(([, v]) => v.version as string);

describe("dependency contract (F01)", () => {
  it("keeps Prisma components on one version", () => {
    const set = new Set(["prisma", "@prisma/client", "@prisma/adapter-pg", "@prisma/config"].flatMap(versions));
    expect([...set]).toHaveLength(1);
  });

  it("keeps Next and eslint-config-next on one version", () => {
    expect(new Set([...versions("next"), ...versions("eslint-config-next")]).size).toBe(1);
  });

  it("declares ranges that the lock actually satisfies for the pinned components", () => {
    for (const name of ["prisma", "@prisma/client", "@prisma/adapter-pg"]) {
      const range = (pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]) as string;
      expect(range, name).toMatch(/^\^?\d+\.\d+\.\d+$/);
      expect(versions(name).every((v) => v.split(".")[0] === range.replace("^", "").split(".")[0])).toBe(true);
    }
  });

  it("has no stale override: every override target is resolved in the lock at the pinned version", () => {
    const flat = (o: Record<string, unknown>, out: Array<[string, string]> = []) => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") out.push([k, v]);
        else flat(v as Record<string, unknown>, out);
      }
      return out;
    };
    for (const [name, pinned] of flat(pkg.overrides)) {
      const found = versions(name);
      expect(found.length, `override "${name}" is not installed - remove it`).toBeGreaterThan(0);
      expect(found, name).toContain(pinned);
    }
  });
});
