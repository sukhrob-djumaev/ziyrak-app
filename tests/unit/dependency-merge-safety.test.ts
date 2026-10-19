import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
describe("patched Prisma configuration merge boundary", () => {
  it("does not exhaust the stack when both records contain recursive references", () => {
    const fromConfig = createRequire(require.resolve("@prisma/config"));
    const source =
      "const {deepmerge}=require(process.argv[1]);const a={};a.self=a;const b={};b.self=b;try{deepmerge(a,b)}catch(e){if(e instanceof RangeError){console.error(e.name);process.exit(1)}}process.stdout.write('bounded')";
    const result = spawnSync(process.execPath, ["-e", source, fromConfig.resolve("deepmerge-ts")], {
      timeout: 1500,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("bounded");
  });
});
