import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("form label association", () => {
  it("every <label> targets a control via htmlFor or wraps one", () => {
    const bad: string[] = [];
    for (const file of walk("src")) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
        const wraps = /<(input|select|textarea)\b|<[A-Z]\w*Input\b|<Select\b/.test(m[2]);
        if (!/htmlFor=/.test(m[1]) && !wraps) {
          const line = src.slice(0, m.index).split("\n").length;
          bad.push(`${file}:${line}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
