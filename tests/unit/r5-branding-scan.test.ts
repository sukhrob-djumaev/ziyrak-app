import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The previous product name must not appear in any tracked text file or path.
 * The word is assembled at runtime so this file does not match its own scan.
 */
const OLD = ["ow", "ly"].join("");
const WORD = new RegExp(`(?<![a-z])${OLD}`, "i");
const SKIP = /\.(png|jpe?g|gif|ico|woff2?|pdf|webp)$/i;

describe("branding scan", () => {
  it("has no previous-name text or filenames anywhere in the repository", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const hits: string[] = [];
    for (const f of files) {
      if (WORD.test(f)) hits.push(`filename ${f}`);
      if (SKIP.test(f)) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (WORD.test(line)) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
