import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
describe("repository browser provisioning boundary", () => {
  it.each(["root", "whatsapp-web"])(
    "skips %s automatic downloads without relying on operator environment",
    (placement) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("PUPPETEER_")) delete env[key];
      const paths =
        placement === "whatsapp-web"
          ? [path.dirname(require.resolve("whatsapp-web.js/package.json"))]
          : [process.cwd()];
      const packageDir = path.dirname(require.resolve("puppeteer/package.json", { paths }));
      const config = pathToFileURL(path.join(packageDir, "lib/puppeteer/getConfiguration.js")).href;
      const result = execFileSync(
        process.execPath,
        [
          "-e",
          "import(process.argv[1]).then((m) => m.getConfiguration()).then((c) => console.log(c.skipDownload))",
          config,
        ],
        { cwd: packageDir, env, encoding: "utf8" }
      ).trim();
      expect(result).toBe("true");
    }
  );
});

/**
 * R3: extract-zip (unpatched symlink write advisories) and the FTP proxy chain that previously
 * needed local patches entered only through Puppeteer 24's archive installer. Puppeteer 25 does not
 * use them. This keeps them, and a single Puppeteer copy, from silently returning.
 */
describe("browser dependency chain stays free of the unpatched archive extractor", () => {
  const lock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8"));
  const installed = Object.keys(lock.packages as Record<string, unknown>);
  it.each(["extract-zip", "get-uri", "basic-ftp"])("%s is not installed", (name) => {
    expect(installed.filter((key) => key.endsWith(`node_modules/${name}`))).toEqual([]);
  });
  it("has exactly one Puppeteer, shared with whatsapp-web.js", () => {
    expect(installed.filter((key) => key.endsWith("node_modules/puppeteer"))).toEqual([
      "node_modules/puppeteer",
    ]);
  });
});
