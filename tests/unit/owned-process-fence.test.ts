import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const fence = require("../../scripts/safety/owned-process.cjs");

type Id = { pid: number; birth: string; cwd: string; command: string } | null;
const dir = () => mkdtempSync(path.join(tmpdir(), "ziyrak-fence-"));
const mine: Id = { pid: 4242, birth: "Sun Oct 25 13:00:00 2026", cwd: "/w/run", command: "node scripts/acceptance/llm-standin.cjs" };

function setup(identityNow: () => Id) {
  const file = path.join(dir(), "owned.json");
  const signals: Array<[number, string]> = [];
  const deps = { identity: () => identityNow(), kill: (p: number, s: string) => void signals.push([p, s]) };
  return { file, signals, deps };
}

describe("owned process fence (F08)", () => {
  it("signals only the recorded process while identity still matches", () => {
    const t = setup(() => mine);
    fence.record(t.file, "run-1", mine, t.deps);
    fence.stopOwned(t.file, "run-1", t.deps);
    expect(t.signals).toEqual([[4242, "SIGTERM"]]);
  });
  it("sends no signal for a reused PID (changed birth), changed cwd, other command or other run", () => {
    for (const now of [
      { ...mine, birth: "Mon Oct 26 09:00:00 2026" },
      { ...mine, cwd: "/elsewhere" },
      { ...mine, command: "node server.js" },
    ]) {
      const t = setup(() => mine);
      fence.record(t.file, "run-1", mine, t.deps);
      expect(() => fence.stopOwned(t.file, "run-1", { ...t.deps, identity: () => now })).toThrow(/refus/i);
      expect(t.signals).toEqual([]);
    }
    const t = setup(() => mine);
    fence.record(t.file, "run-1", mine, t.deps);
    expect(() => fence.stopOwned(t.file, "run-2", t.deps)).toThrow(/run/i);
    expect(t.signals).toEqual([]);
  });
  it("does nothing without ownership record and when the process already exited", () => {
    const t = setup(() => null);
    fence.stopOwned(t.file, "run-1", t.deps);
    fence.record(t.file, "run-1", mine, { ...t.deps, identity: () => mine });
    fence.stopOwned(t.file, "run-1", { ...t.deps, alive: () => false });
    expect(t.signals).toEqual([]);
  });
  it("refuses to treat an unverifiable but live process as gone", () => {
    const t = setup(() => null);
    fence.record(t.file, "run-1", mine, { ...t.deps, identity: () => mine });
    expect(() => fence.stopOwned(t.file, "run-1", { ...t.deps, alive: () => true })).toThrow(/verify/);
    expect(t.signals).toEqual([]);
  });
  it("refuses to record an identity that cannot be proven", () => {
    const t = setup(() => null);
    expect(() => fence.record(t.file, "run-1", null, t.deps)).toThrow();
    expect(() => fence.record(t.file, "run-1", { ...mine, pid: 1 }, t.deps)).toThrow();
  });
});
