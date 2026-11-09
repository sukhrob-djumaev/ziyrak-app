import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

const files = walk("src").map((f) => ({ f, s: readFileSync(f, "utf8") }));

describe("static a11y guards", () => {
  it("every fixed inset-0 overlay file declares a dialog role", () => {
    const bad = files
      .filter(({ s }) => /fixed inset-0/.test(s) && !/role="(alert)?dialog"/.test(s))
      .map(({ f }) => f);
    expect(bad).toEqual([]);
  });

  it("icon-only buttons have an accessible name", () => {
    const bad: string[] = [];
    for (const { f, s } of files) {
      for (const m of s.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const [, attrs, body] = m;
        const text = body.replace(/<[A-Z][A-Za-z]*\b[^>]*\/>/g, "").trim();
        if (!text && /<[A-Z][A-Za-z]*\b/.test(body) && !/aria-label|title=/.test(attrs)) {
          bad.push(`${f}:${s.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
