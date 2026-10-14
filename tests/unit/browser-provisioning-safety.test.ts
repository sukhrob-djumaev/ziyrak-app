import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
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
      const config = path.join(packageDir, "lib/cjs/puppeteer/getConfiguration.js");
      const result = execFileSync(
        process.execPath,
        ["-e", "console.log(require(process.argv[1]).getConfiguration().skipDownload)", config],
        { cwd: packageDir, env, encoding: "utf8" }
      ).trim();
      expect(result).toBe("true");
    }
  );
});
