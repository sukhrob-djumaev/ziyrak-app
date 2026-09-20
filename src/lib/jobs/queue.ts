import type { JobQueue } from "./types";
import { FakeJobQueue } from "./fake-job-queue";

/**
 * PLAN.md §25.1/§46.5 — the single `JobQueue` instance every webhook route
 * enqueues into and every handler registers against. Phase 6 swaps this
 * for `new PgBossJobQueue()` behind the same `JobQueue` interface — no call
 * site named here should need to change (§46.5's own risk note).
 */
export const jobQueue: JobQueue = new FakeJobQueue();

export const PROCESS_INBOUND_MESSAGE_JOB = "process-inbound-message";

export interface ProcessInboundMessagePayload {
  businessId: string;
  receiptId: string;
}
