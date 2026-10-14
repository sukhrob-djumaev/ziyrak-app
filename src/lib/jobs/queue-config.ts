import {
  PROCESS_INBOUND_MESSAGE_JOB,
  SEND_FOLLOWUP_JOB,
  RETRY_DELIVERY_JOB,
  DELIVER_WEBHOOK_JOB,
  INDEX_KNOWLEDGE_ENTRY_JOB,
} from "./job-types";

export interface JobQueueConfig {
  policy?: "standard" | "short" | "key_strict_fifo";
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
  expireInSeconds?: number;
  /** pg-boss heartbeat (>= 10 s): the worker refreshes it while a job runs, so a job whose worker died is failed/retried after this long instead of after `expireInSeconds`. */
  heartbeatSeconds?: number;
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

/**
 * `index-knowledge-entry` retries a *retryable* provider failure (rate
 * limit, timeout, 5xx — the handler rethrows only those) with growing
 * delay, so a short embedding-provider outage self-heals; until then the
 * entry stays retrievable by keyword. Non-retryable failures (bad key,
 * unsupported provider) complete the job instead of burning retries.
 *
 * Policy `short` (pg-boss: at most one *queued* job per singletonKey,
 * unlimited active): enqueues are keyed per entry, so repeated edits or
 * repeated reindex scans collapse into one waiting job, while an edit made
 * during an active embedding still queues a fresh one.
 */
export const INDEX_KNOWLEDGE_ENTRY_MAX_ATTEMPTS = 5;

/**
 * PLAN.md §46.8 known limit — a worker killed without draining (SIGKILL, OOM,
 * node loss) leaves its `process-inbound-message` job `active`, and
 * `key_strict_fifo` then holds that conversation until pg-boss's default
 * 15-minute expiry. With a heartbeat the live worker refreshes it every
 * half-interval for as long as the handler runs (so slow AI calls are never
 * cut short, unlike a short `expireInSeconds`), and a dead worker's job is
 * failed — and retried under the queue's existing retry settings — after this
 * long. Must be >= 10 (pg-boss).
 */
export const PROCESS_INBOUND_HEARTBEAT_SECONDS = 30;

export const QUEUE_CONFIG: Record<string, JobQueueConfig> = {
  [PROCESS_INBOUND_MESSAGE_JOB]: {
    policy: "key_strict_fifo",
    heartbeatSeconds: PROCESS_INBOUND_HEARTBEAT_SECONDS,
    retryLimit: 5,
    retryDelay: 10,
  },
  [SEND_FOLLOWUP_JOB]: { heartbeatSeconds: 30, retryLimit: 5, retryDelay: 10 },
  [RETRY_DELIVERY_JOB]: { heartbeatSeconds: 30, retryLimit: 5, retryDelay: 10 },
  [DELIVER_WEBHOOK_JOB]: {
    retryLimit: DELIVER_WEBHOOK_MAX_ATTEMPTS - 1,
    retryBackoff: true,
    retryDelay: 5,
    expireInSeconds: 30,
  },
  [INDEX_KNOWLEDGE_ENTRY_JOB]: {
    policy: "short",
    retryLimit: INDEX_KNOWLEDGE_ENTRY_MAX_ATTEMPTS - 1,
    retryBackoff: true,
    retryDelay: 5,
    expireInSeconds: 120,
  },
};

export function resolveQueueConfig(
  jobType: string
): Omit<JobQueueConfig, "policy"> & { policy: "standard" | "short" | "key_strict_fifo" } {
  const config = QUEUE_CONFIG[jobType] ?? {};
  return { policy: config.policy ?? "standard", ...config };
}
