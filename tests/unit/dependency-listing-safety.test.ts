import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
describe("patched browser-proxy listing parser", () => {
  it("rejects an oversized malformed Unix listing within a bounded child process", () => {
    const source =
      "const {parseList}=require(process.argv[1]);try{parseList('-rw-r--r-- 1 '+'owner '.repeat(100000)+'invalid-size')}catch{}process.stdout.write('bounded')";
    const fromGetUri = createRequire(require.resolve("get-uri"));
    const result = spawnSync(process.execPath, ["-e", source, fromGetUri.resolve("basic-ftp")], {
      timeout: 1500,
      encoding: "utf8",
    });
    expect(result.error?.code).not.toBe("ETIMEDOUT");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("bounded");
  });
});
