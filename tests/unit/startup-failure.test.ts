import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

/** L2.1 / F05: the real worker entrypoint refuses to start on an incomplete production configuration. */
describe("startup failure", () => {
  it("exits non-zero and lists the configuration problems, without printing secret values", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "production",
      JWT_SECRET: "sentinel-short-SECRETVALUE",
    };
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/worker.ts"], { encoding: "utf8", env, cwd: process.cwd(), timeout: 60_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(text).toMatch(/Invalid runtime configuration/);
    for (const key of ["DATABASE_URL", "JWT_SECRET", "SECRET_KEY_V<n>"]) expect(text).toContain(key);
    expect(text).not.toContain("SECRETVALUE");
  }, 90_000);

  it("the relaxed profile is the only production-mode exemption", () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", ZIYRAK_CONFIG_PROFILE: "relaxed" };
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/worker.ts"], { encoding: "utf8", env, cwd: process.cwd(), timeout: 30_000 });
    // It passes the contract and then fails later for its own reasons (no database), not with a contract error.
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/Invalid runtime configuration/);
  }, 60_000);
});
