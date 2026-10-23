import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * R5: active product surfaces carry no Owly/Owl branding. Retained compatibility identifiers
 * are listed explicitly; anything else matching fails. See docs/branding-compat.md.
 */
const SCANNED = ["src", "public", "README.md", "SECURITY.md", "CONTRIBUTING.md", "package.json"];
const ALLOWED = [
  /owly-token/, // session cookie name: renaming would sign everyone out (compat exception)
  /owly:/, // default Redis key prefix: renaming would orphan queues/cache (compat exception)
  /X-Owly-Signature/, // legacy webhook signature header, sent alongside X-Ziyrak-Signature
  /owly-theme|owly-onboarding-dismissed/, // legacy localStorage keys read once for migration
  /localhost:5432\/owly/, // default local database name (live DB rename is out of scope)
  /helm\/owly|cd owly$/, // Helm chart path and clone directory of the upstream repository
  /named `owly`|legacy `owly`/, // documentation that explains the retained names
  /hsperus\/owly|Hesper-Labs\/owly/i, // upstream repository provenance
];

describe("R5 branding scan", () => {
  it("has no unexplained Owly/Owl text or filenames in active surfaces", () => {
    const files = execFileSync("git", ["ls-files", "--", ...SCANNED], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const hits: string[] = [];
    for (const f of files) {
      if (/owl/i.test(f.replace(/knowledge/gi, ""))) hits.push(`filename ${f}`);
      if (/\.(png|jpg|ico|woff2?)$/.test(f)) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/\bowly|\bowl\b/i);
          if (m && !ALLOWED.some((r) => r.test(line))) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
