import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

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

    queue = new PgBossJobQueue(TEST_DATABASE_URL);
    queue.registerHandler<{ businessId: string; marker: string }>(PROCESS_INBOUND_MESSAGE_JOB, async (_ctx, payload) => {
      events.push(`start:${payload.marker}`);
      if (payload.marker.startsWith("A")) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // deliberately slow
      }
      events.push(`end:${payload.marker}`);
    });
    await queue.start();

    const conversationA = `${business.businessId}:conv-a`;
    const conversationB = `${business.businessId}:conv-b`;

    await queue.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "A1" }, { singletonKey: conversationA });
    await queue.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "A2" }, { singletonKey: conversationA });
    await queue.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: business.businessId, marker: "B1" }, { singletonKey: conversationB });

    await waitUntil(() => events.filter((e) => e.startsWith("end:")).length === 3, 15000);

    const a1Start = events.indexOf("start:A1");
    const a1End = events.indexOf("end:A1");
    const a2Start = events.indexOf("start:A2");
    const b1Start = events.indexOf("start:B1");

    expect(a1Start).toBeGreaterThanOrEqual(0);
    // Strict same-key ordering: A2 never starts until A1 has fully finished.
    expect(a1End).toBeLessThan(a2Start);
    // Cross-key concurrency: B1 starts while A1's slow handler is still running,
    // proving conversation B was never blocked behind conversation A.
    expect(b1Start).toBeLessThan(a1End);
  }, 20000);
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
