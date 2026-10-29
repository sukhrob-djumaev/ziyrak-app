import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = process.cwd();
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ziyrak-safety-"));
  const log = path.join(dir, "calls.jsonl");
  const shim =
    "#!/bin/sh\n" +
    process.execPath +
    ' -e \'require("fs").appendFileSync(process.env.SHIM_LOG, JSON.stringify({name:process.env.SHIM_NAME,database:process.env.DATABASE_URL,direct:process.env.DIRECT_DATABASE_URL})+"\\n")\'\n';
  for (const name of ["nohup", "npx", "node", "pkill", "find", "sleep"]) {
    writeFileSync(
      path.join(dir, name),
      "#!/bin/sh\nSHIM_NAME=" + name + " " + shim.split("\n").slice(1).join("\n"),
      { mode: 0o755 }
    );
  }
  return {
    dir,
    log,
    env: {
      ...process.env,
      PATH: dir + ":" + process.env.PATH,
      SHIM_LOG: log,
      ACC_WORK_DIR: path.join(dir, "work"),
      ACC_DB: "postgresql://test:test@127.0.0.1:1/ziyrak_acceptance_safety",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:1/ziyrak_acceptance_safety",
      DIRECT_DATABASE_URL: "postgresql://test:test@127.0.0.1:1/ziyrak_acceptance_safety",
    },
  };
}
function calls(log: string) {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}
describe("acceptance environment safeguards (R3 prerequisite)", () => {
  it("refuses a mismatched direct database before launching a worker", async () => {
    const f = fixture();
    f.env.DIRECT_DATABASE_URL = "postgresql://test:test@127.0.0.1:1/ziyrak";
    const r = spawnSync("sh", ["scripts/acceptance/start-all.sh", "worker"], {
      cwd: root,
      env: f.env,
      encoding: "utf8",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.status).not.toBe(0);
    expect(calls(f.log)).toHaveLength(0);
  });
  it("does not kill browsers by process name or delete profile locks before a journey", () => {
    const f = fixture();
    spawnSync("sh", ["scripts/acceptance/run.sh", "synthetic.cjs"], {
      cwd: root,
      env: f.env,
      encoding: "utf8",
    });
    expect(calls(f.log).filter((c) => ["pkill", "find"].includes(c.name))).toEqual([]);
  });
});
