import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";

/**
 * PLAN.md §25.5/§31.2/§33.4 items 2 & 6/§46.6 PR2 — Phase 6's own
 * acceptance tests against a REAL `PgBossJobQueue`, per §35's explicit
 * test-infrastructure policy ("FakeJobQueue for the default suite; a real
 * pg-boss instance against the CI Postgres container for Phase 6's
 * specific acceptance tests — pg-boss needs no separate service, uses the
 * same Postgres connection"). These construct their own `PgBossJobQueue`
 * directly against the test database, bypassing the shared `jobQueue`
 * singleton (which stays `FakeJobQueue` under `NODE_ENV=test`).
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { PROCESS_INBOUND_MESSAGE_JOB } from "@/lib/jobs/job-types";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

const TEST_DATABASE_URL = process.env.DATABASE_URL!;

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

let business: SeededBusiness;
let queue: PgBossJobQueue | undefined;

beforeAll(async () => {
  business = await seedBusiness("pgboss-acceptance");
});

afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

afterEach(async () => {
  if (queue) {
    await queue.stop();
    queue = undefined;
  }
});

describe("PgBossJobQueue — per-conversation ordering (§25.5/§33.4 item 2)", () => {
  it("strictly orders jobs sharing a conversation's singletonKey, while a different conversation processes concurrently", async () => {
    const events: string[] = [];
    const t0 = performance.now();
    const timeline = () => events.map((e, i) => `${i}:${e}`).join(" ");

    queue = new PgBossJobQueue(TEST_DATABASE_URL);
    queue.registerHandler<{ businessId: string; marker: string }>(PROCESS_INBOUND_MESSAGE_JOB, async (_ctx, payload) => {
      events.push(`start:${payload.marker}@${Math.round(performance.now() - t0)}ms`);
      if (payload.marker.startsWith("A")) {
        // Deliberately slow — and longer than pg-boss's 2 s polling interval, so
        // B1 is picked up by some poll while A1 is still running no matter where
        // the polls fall relative to the enqueues (500 ms made this CI-load flaky).
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }
      events.push(`end:${payload.marker}@${Math.round(performance.now() - t0)}ms`);
    });
    await queue.start();

    const conversationA = `${business.businessId}:conv-a`;
    const conversationB = `${business.businessId}:conv-b`;

    await queue.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "A1" }, { singletonKey: conversationA });
    await queue.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "A2" }, { singletonKey: conversationA });
    await queue.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "B1" }, { singletonKey: conversationB });

    await waitUntil(() => events.filter((e) => e.startsWith("end:")).length === 3, 15000);

    const at = (prefix: string) => events.findIndex((e) => e.startsWith(prefix));
    const a1Start = at("start:A1");
    const a1End = at("end:A1");
    const a2Start = at("start:A2");
    const b1Start = at("start:B1");

    expect(a1Start).toBeGreaterThanOrEqual(0);
    // Strict same-key ordering: A2 never starts until A1 has fully finished.
    expect(a1End).toBeLessThan(a2Start);
    // Cross-key concurrency: B1 starts while A1's slow handler is still running,
    // proving conversation B was never blocked behind conversation A.
    expect(b1Start, `B1 must start while A1 runs; timeline: ${timeline()}`).toBeLessThan(a1End);
  }, 30000);
});

describe("PgBossJobQueue — retry executes the side effect exactly once (§31.2/§33.4 item 6)", () => {
  it("a job that fails transiently and is retried by pg-boss produces its side effect exactly once", async () => {
    const jobType = `test-retry-job-${Date.now()}`;
    let attempts = 0;
    let sideEffects = 0;

    queue = new PgBossJobQueue(TEST_DATABASE_URL);
    queue.registerHandler(jobType, async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("simulated transient failure");
      }
      sideEffects++; // only the attempt that doesn't throw ever counts as "delivered"
    });
    await queue.start();

    await queue.enqueue(jobType, { businessId: business.businessId });

    await waitUntil(() => sideEffects === 1, 15000);
    // Give any further (incorrect) redelivery a real window to show up before asserting.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(attempts).toBe(2); // one failure, one successful retry
    expect(sideEffects).toBe(1); // never duplicated
  }, 25000);
});

describe("PgBossJobQueue — work queued before a worker exists is not lost, and runs exactly once (§25.3 restart safety)", () => {
  it("a job enqueued with no worker running is picked up exactly once by a freshly started queue instance", async () => {
    const jobType = `test-restart-job-${Date.now()}`;
    let processed = 0;

    // Simulates the web process enqueuing work before any worker has ever
    // started for this job type — enqueue-only, no handler, never started.
    const enqueueOnly = new PgBossJobQueue(TEST_DATABASE_URL);
    await enqueueOnly.enqueue(jobType, { businessId: business.businessId });
    await enqueueOnly.stop();

    // Simulates the worker process starting (or restarting) afterward.
    queue = new PgBossJobQueue(TEST_DATABASE_URL);
    queue.registerHandler(jobType, async () => {
      processed++;
    });
    await queue.start();

    await waitUntil(() => processed === 1, 15000);
    await new Promise((resolve) => setTimeout(resolve, 2000)); // watch for a duplicate delivery
    expect(processed).toBe(1);
  }, 25000);
});

// PLAN.md §46.8 — more concurrent conversations than one worker's local
// concurrency (10), so a single worker cannot take everything and the second
// one must compete.
const MULTI_WORKER_CONVERSATIONS = 14;
const MULTI_WORKER_MESSAGES = 4;

/**
 * PLAN.md §25.5/§46.8 — ordering and exactly-once pickup with TWO competing
 * worker instances (each its own PgBossJobQueue, pool and pollers) on one real
 * Postgres: the in-process counterpart of the multi-process harness in
 * scripts/loadtest/. Lives in this file so it runs sequentially with the
 * other suites that share the default pg-boss queues.
 */
interface Run {
  worker: string;
  marker: string;
  start: number;
  end: number;
}

describe("PgBossJobQueue — two competing workers (§25.5 at multi-replica scale)", () => {
  it("runs every job exactly once, strictly in order per conversation, while conversations overlap across workers", async () => {
    const runs: Run[] = [];
    const queues = ["worker-1", "worker-2"].map((worker) => {
      const queue = new PgBossJobQueue(TEST_DATABASE_URL);
      queue.registerHandler<{ businessId: string; marker: string }>(PROCESS_INBOUND_MESSAGE_JOB, async (_ctx, payload) => {
        const start = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 100));
        runs.push({ worker, marker: payload.marker, start, end: performance.now() });
      });
      return queue;
    });
    // A third instance that only enqueues, like the web tier.
    const producer = new PgBossJobQueue(TEST_DATABASE_URL);

    try {
      await Promise.all(queues.map((q) => q.start()));

      // Interleave conversations (c0m0, c1m0, ..., c0m1, ...) so same-key jobs
      // are separated by other keys' jobs, as real traffic would be.
      for (let m = 0; m < MULTI_WORKER_MESSAGES; m++) {
        for (let c = 0; c < MULTI_WORKER_CONVERSATIONS; c++) {
          const marker = `c${c}m${m}`;
          await producer.enqueue(
            PROCESS_INBOUND_MESSAGE_JOB,
            { businessId: business.businessId, marker },
            { singletonKey: `${business.businessId}:conv-${c}` }
          );
        }
      }

      const total = MULTI_WORKER_CONVERSATIONS * MULTI_WORKER_MESSAGES;
      await waitUntil(() => runs.length >= total, 45000);
      await new Promise((resolve) => setTimeout(resolve, 1500)); // a duplicate pickup would show up here

      // Exactly once.
      expect(runs).toHaveLength(total);
      expect(new Set(runs.map((r) => r.marker)).size).toBe(total);

      // Per conversation: in enqueue order, never overlapping.
      for (let c = 0; c < MULTI_WORKER_CONVERSATIONS; c++) {
        const mine = runs.filter((r) => r.marker.split("m")[0] === `c${c}`).sort((a, b) => a.start - b.start);
        expect(mine.map((r) => r.marker)).toEqual(Array.from({ length: MULTI_WORKER_MESSAGES }, (_, m) => `c${c}m${m}`));
        for (let i = 1; i < mine.length; i++) expect(mine[i].start).toBeGreaterThanOrEqual(mine[i - 1].end);
      }

      // Both workers really competed, and different conversations really ran in parallel.
      expect(new Set(runs.map((r) => r.worker)).size).toBe(2);
      const overlapping = runs.some((a) => runs.some((b) => a !== b && a.marker.split("m")[0] !== b.marker.split("m")[0] && a.start < b.end && b.start < a.end));
      expect(overlapping).toBe(true);
    } finally {
      await Promise.all([...queues, producer].map((q) => q.stop()));
    }
  }, 90000);
});

describe("PgBossJobQueue — a worker that dies mid-job does not block its conversation (§46.8 known limit)", () => {
  it("fails over a SIGKILLed worker's active job after its heartbeat lapses, and the next worker finishes the conversation in order", async () => {
    const ran: string[] = [];
    const key = `${business.businessId}:conv-dead-worker`;

    // A real separate process, so SIGKILL leaves the job `active` exactly as
    // an OOM/node loss does (an in-process pg-boss stop would release it).
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/hanging-worker.ts"], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let childOutput = "";
    child.stdout.on("data", (chunk) => (childOutput += String(chunk)));

    const survivor = new PgBossJobQueue(TEST_DATABASE_URL);
    survivor.registerHandler<{ businessId: string; marker: string }>(PROCESS_INBOUND_MESSAGE_JOB, async (_ctx, payload) => {
      ran.push(payload.marker);
    });

    try {
      await waitUntil(() => childOutput.includes("STARTED"), 30000);
      await survivor.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "A1" }, { singletonKey: key });
      await survivor.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "A2" }, { singletonKey: key });
      await waitUntil(() => childOutput.includes("TOOK_JOB"), 15000);

      child.kill("SIGKILL");
      await survivor.start();
      // Without a heartbeat this would wait out the 15-minute default expiry.
      await waitUntil(() => ran.length >= 2, 150000, 500);
      expect(ran).toEqual(["A1", "A2"]);
    } finally {
      child.kill("SIGKILL");
      await survivor.stop();
    }
  }, 180000);
});
