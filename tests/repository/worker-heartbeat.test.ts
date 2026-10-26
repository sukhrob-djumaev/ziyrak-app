import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** L2.1 / F11: worker liveness evidence on real Postgres. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { beat, readWorkerStatus, readQueueSignals, startWorkerHeartbeat, HEARTBEAT_STALE_MS } from "@/lib/ops/worker-heartbeat";

const ids: string[] = [];
const id = () => {
  const v = `test-worker-${randomUUID()}`;
  ids.push(v);
  return v;
};
afterAll(async () => {
  await prisma.workerHeartbeat.deleteMany({ where: { instanceId: { in: ids } } });
});

describe("worker heartbeat", () => {
  it("records a beat in the database and touches the probe file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "hb-")), "beat");
    const now = new Date();
    await beat(id(), new Date(Date.now() - 5000), now, file);
    expect(existsSync(file)).toBe(true);
    expect(Math.abs(statSync(file).mtimeMs - now.getTime())).toBeLessThan(2000);
  });

  it("reports ok for a fresh beat, stale for an old one, and none with no rows", async () => {
    await prisma.workerHeartbeat.deleteMany({});
    expect((await readWorkerStatus()).state).toBe("none");
    const a = id();
    const t0 = new Date();
    await beat(a, t0, t0, join(mkdtempSync(join(tmpdir(), "hb-")), "beat"));
    expect(await readWorkerStatus(new Date(t0.getTime() + 5_000))).toMatchObject({ state: "ok", instances: 1 });
    const later = new Date(t0.getTime() + HEARTBEAT_STALE_MS + 5_000);
    expect(await readWorkerStatus(later)).toMatchObject({ state: "stale", instances: 0 });
  });

  it("counts only live instances among several", async () => {
    await prisma.workerHeartbeat.deleteMany({});
    const t0 = new Date();
    const file = join(mkdtempSync(join(tmpdir(), "hb-")), "beat");
    await beat(id(), t0, new Date(t0.getTime() - HEARTBEAT_STALE_MS - 30_000), file); // a crashed worker's old row
    await beat(id(), t0, t0, file);
    await beat(id(), t0, t0, file);
    expect(await readWorkerStatus(new Date(t0.getTime() + 1000))).toMatchObject({ state: "ok", instances: 2 });
  });

  it("start/stop: a running worker appears and its row is removed on a clean stop", async () => {
    await prisma.workerHeartbeat.deleteMany({});
    const instanceId = id();
    const stop = startWorkerHeartbeat({ instanceId, intervalMs: 60_000, file: join(mkdtempSync(join(tmpdir(), "hb-")), "beat") });
    for (let i = 0; i < 50 && !(await prisma.workerHeartbeat.findUnique({ where: { instanceId } })); i++) await new Promise((r) => setTimeout(r, 100));
    expect((await readWorkerStatus()).state).toBe("ok");
    await stop();
    expect(await prisma.workerHeartbeat.findUnique({ where: { instanceId } })).toBeNull();
  });

  it("queue signals are either a well-formed summary or unknown, never an error", async () => {
    const signals = await readQueueSignals();
    if (signals !== "unknown") {
      expect(typeof signals.failedLastHour).toBe("number");
      expect(typeof signals.active).toBe("number");
    }
  });
});
