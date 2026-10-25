import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const sh = readFileSync("scripts/loadtest/run.sh", "utf8");
const override = readFileSync("scripts/loadtest/compose.override.yml", "utf8");

describe("loadtest run.sh static safety (F08)", () => {
  it("has no name-based process killing", () => {
    expect(sh).not.toMatch(/\b(pkill|killall)\b/);
  });
  it("validates the disposable target before touching Docker, Prisma or processes", () => {
    const guard = sh.indexOf("db-target.cjs");
    expect(guard).toBeGreaterThan(-1);
    for (const act of ["docker ", "$COMPOSE", "prisma migrate", "llm-standin"]) {
      const first = sh.indexOf(act, sh.indexOf("set -e"));
      if (first > -1 && !act.startsWith("$") && act !== "docker ") expect(guard).toBeLessThan(first);
    }
    expect(guard).toBeLessThan(sh.indexOf("$COMPOSE build"));
    expect(guard).toBeLessThan(sh.indexOf("$COMPOSE up"));
  });
  it("passes both DB URLs to migrate and never reuses the shared ziyrak:local tag", () => {
    expect(sh).toMatch(/DIRECT_DATABASE_URL="\$DB_DIRECT" npx prisma migrate deploy/);
    expect(sh).not.toMatch(/docker images -q ziyrak:local/);
    expect(override).toMatch(/image: \$\{LOADTEST_IMAGE/);
  });
  it("uses an identified image tied to source identity", () => {
    expect(sh).toMatch(/LOADTEST_IMAGE=/);
    expect(sh).toMatch(/rev-parse HEAD/);
  });
  it("takes the run lock before arming the cleanup trap, so a refused run cannot tear down the owner", () => {
    const lock = sh.indexOf('mkdir "$lock"');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(sh.indexOf("trap cleanup"));
    expect(sh.indexOf('[ ! -e "$fence" ]')).toBeLessThan(sh.indexOf("trap cleanup"));
  });
  it("fails closed when the source tree identity cannot be computed", () => {
    expect(sh).toMatch(/Cannot compute the source tree identity/);
    expect(sh).not.toMatch(/git add -A >\/dev\/null 2>&1/);
  });
});
