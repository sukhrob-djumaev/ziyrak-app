import { describe, it, expect } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Fixture timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}
function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "ziyrak-runtime-")),
    repo = path.join(base, "repo"),
    tree = path.join(base, "tree"),
    work = path.join(base, "run");
  mkdirSync(work);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src/fixture.ts"), "export const value=1;");
  execFileSync("git", ["-C", repo, "add", "src"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", "-q", tree, "HEAD"]);
  mkdirSync(path.join(tree, "scripts/acceptance"), { recursive: true });
  const script = path.join(tree, "scripts/acceptance/runtime.cjs");
  copyFileSync(path.join(process.cwd(), "scripts/acceptance/runtime.cjs"), script);
  mkdirSync(path.join(tree, "node_modules/next/dist/bin"), { recursive: true });
  writeFileSync(
    path.join(tree, "node_modules/next/dist/bin/next"),
    'require("fs").mkdirSync(".next",{recursive:true});require("fs").writeFileSync(".next/BUILD_ID","synthetic-build");'
  );
  mkdirSync(path.join(tree, "node_modules/tsx"), { recursive: true });
  writeFileSync(
    path.join(tree, "node_modules/tsx/package.json"),
    JSON.stringify({ name: "tsx", type: "module", exports: "./index.js" })
  );
  writeFileSync(path.join(tree, "node_modules/tsx/index.js"), "");
  writeFileSync(
    path.join(tree, "src/worker.ts"),
    'import fs from "node:fs";fs.writeFileSync(process.env.ACC_WORK_DIR+"/fixture-worker.pid",String(process.pid));setInterval(()=>{},1000);'
  );
  const db = "postgresql://fixture:fixture@127.0.0.1:1/ziyrak_acceptance_fixture";
  const env = {
    ...process.env,
    ACC_DB: db,
    DATABASE_URL: db,
    DIRECT_DATABASE_URL: db,
    ACC_WORK_DIR: work,
  };
  delete env.ACC_PSQL;
  execFileSync(process.execPath, [script, "build"], { cwd: tree, env, stdio: "pipe" });
  return { base, tree, work, script, env };
}
function command(f: ReturnType<typeof fixture>, code: string) {
  return execFileSync(process.execPath, ["-e", code], {
    cwd: f.tree,
    env: f.env,
    encoding: "utf8",
  }).trim();
}
describe("acceptance owned-process recovery", () => {
  it("invalidates build identity when a public widget asset changes", () => {
    const f = fixture();
    mkdirSync(path.join(f.tree, "public"));
    writeFileSync(path.join(f.tree, "public/widget.js"), "/* changed widget fixture */");
    expect(() => command(f, "require(" + JSON.stringify(f.script) + ").manifest()")).toThrow(
      /Build identity is missing\/stale/
    );
  });
  it("refuses browser verification when no owned application topology exists", () => {
    const f = fixture();
    const result = spawnSync(process.execPath, [f.script, "verify"], {
      cwd: f.tree,
      env: f.env,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
  });

  it("refuses a stale birth identity without signaling the live fixture child", async () => {
    const f = fixture();
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: f.tree,
        env: f.env,
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 150));
      command(f, "require(" + JSON.stringify(f.script) + ').record("fixture",' + child.pid + ")");
      const m = JSON.parse(readFileSync(path.join(f.work, "run.json"), "utf8"));
      m.processes.fixture.birth = "foreign birth";
      writeFileSync(path.join(f.work, "run.json"), JSON.stringify(m));
      const result = spawnSync(process.execPath, [f.script, "stop", "fixture"], {
        cwd: f.tree,
        env: f.env,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    } finally {
      child?.kill("SIGTERM");
    }
  });
  it("can stop its recorded child after source changes invalidate startup", async () => {
    const f = fixture();
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: f.tree,
        env: f.env,
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 150));
      command(f, "require(" + JSON.stringify(f.script) + ').record("fixture",' + child.pid + ")");
      writeFileSync(path.join(f.tree, "src/fixture.ts"), "export const value=2;");
      expect(() => command(f, "require(" + JSON.stringify(f.script) + ").manifest()")).toThrow(
        /Build identity is missing\/stale/
      );
      expect(
        spawnSync(process.execPath, [f.script, "stop", "fixture"], { cwd: f.tree, env: f.env })
          .status
      ).toBe(0);
      await waitFor(() => child!.exitCode !== null || child!.signalCode !== null);
    } finally {
      child?.kill("SIGTERM");
    }
  });
  it("cleans up the just-spawned worker when recording ownership fails", async () => {
    const f = fixture();
    writeFileSync(path.join(f.work, "ownership.lock"), "synthetic conflict");
    const result = spawnSync(process.execPath, [f.script, "start", "worker"], {
      cwd: f.tree,
      env: f.env,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const file = path.join(f.work, "fixture-worker.pid");
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8"));
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    }
    expect(existsSync(path.join(f.work, "run.json"))).toBe(false);
  });
  it("rejects a live database name and relative run directory before startup", () => {
    const f = fixture();
    const env = {
      ...f.env,
      ACC_DB: "postgresql://fixture:fixture@127.0.0.1:1/owly",
      DATABASE_URL: "",
      DIRECT_DATABASE_URL: "",
    };
    expect(spawnSync(process.execPath, [f.script, "verify"], { cwd: f.tree, env }).status).not.toBe(
      0
    );
    expect(
      spawnSync(process.execPath, [f.script, "verify"], {
        cwd: f.tree,
        env: { ...f.env, ACC_WORK_DIR: "relative-run" },
      }).status
    ).not.toBe(0);
    expect(
      spawnSync(process.execPath, [f.script, "verify"], {
        cwd: f.tree,
        env: { ...f.env, ACC_BASE_URL: "https://live.invalid" },
      }).status
    ).not.toBe(0);
  });
});
