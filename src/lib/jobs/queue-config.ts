import { PROCESS_INBOUND_MESSAGE_JOB, DELIVER_WEBHOOK_JOB } from "./job-types";

export interface JobQueueConfig {
  policy?: "standard" | "key_strict_fifo";
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
  expireInSeconds?: number;
}

/**
 * PLAN.md §25.2/§25.5/§31.1/§46.6 — per-job-type queue configuration. The
 * web process (`enqueue`/`schedule`) and the worker process (`start`)
 * both call `createQueue()` with this same table, so whichever side
 * creates a queue first (idempotent — `ON CONFLICT DO NOTHING`, verified
 * against pg-boss's real SQL) leaves it configured identically either way.
 *
 * `key_strict_fifo` (verified against pg-boss's real, installed
 * `QueuePolicy` type) is its purpose-built mechanism for "one active job
 * per key, later ones for the same key wait their turn in arrival order,
 * other keys process freely" — exactly §25.5's per-conversation-ordering
 * requirement, and the only queue that needs it.
 *
 * `deliver-webhook`'s retry settings replace the old fixed
 * [5s, 30s, 5min]/3-attempts array (`webhook-delivery.ts`, pre-Phase-6)
 * with pg-boss's own native retry/backoff (§25.2/§31.1) — not numerically
 * identical, but the same intent (bounded retries with growing delay).
 */
/** Total attempts (1 initial + retries) for a `deliver-webhook` job — matches the pre-Phase-6 `MAX_ATTEMPTS`. */
export const DELIVER_WEBHOOK_MAX_ATTEMPTS = 3;

export const QUEUE_CONFIG: Record<string, JobQueueConfig> = {
  [PROCESS_INBOUND_MESSAGE_JOB]: { policy: "key_strict_fifo" },
  [DELIVER_WEBHOOK_JOB]: {
    retryLimit: DELIVER_WEBHOOK_MAX_ATTEMPTS - 1,
    retryBackoff: true,
    retryDelay: 5,
    expireInSeconds: 30,
  },
};

export function resolveQueueConfig(jobType: string): Omit<JobQueueConfig, "policy"> & { policy: "standard" | "key_strict_fifo" } {
  const config = QUEUE_CONFIG[jobType] ?? {};
  return { policy: config.policy ?? "standard", ...config };
}
