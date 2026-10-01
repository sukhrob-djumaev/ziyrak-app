import type { JobQueue } from "./types";
import { FakeJobQueue } from "./fake-job-queue";
import { PgBossJobQueue } from "./pgboss-job-queue";

export {
  PROCESS_INBOUND_MESSAGE_JOB,
  type ProcessInboundMessagePayload,
  DELIVER_WEBHOOK_JOB,
  type DeliverWebhookPayload,
  SWEEP_SLA_BREACHES_JOB,
  type SweepSlaBreachesPayload,
  SWEEP_RETENTION_JOB,
  type SweepRetentionPayload,
  SEND_FOLLOWUP_JOB,
  type SendFollowupPayload,
  EXECUTE_CAMPAIGN_JOB,
  type ExecuteCampaignPayload,
  INDEX_KNOWLEDGE_ENTRY_JOB,
  type IndexKnowledgeEntryPayload,
} from "./job-types";

/**
 * PLAN.md §25.1/§46.6 — the single `JobQueue` instance every webhook route
 * enqueues into and every handler registers against. Real `PgBossJobQueue`
 * in every real environment (dev/prod); `FakeJobQueue` only under the test
 * suite (`NODE_ENV=test`, set once in `tests/setup.ts`), preserving §35's
 * explicit test-infrastructure policy — "FakeJobQueue for the default
 * suite; a real pg-boss instance... for Phase 6's specific acceptance
 * tests" — without every existing test file needing to mock this module.
 * Phase 6's own ordering/retry/restart acceptance tests construct their
 * own `PgBossJobQueue` directly against the test database rather than
 * using this singleton, exactly because they need the real thing.
 */
export const jobQueue: JobQueue =
  process.env.NODE_ENV === "test" ? new FakeJobQueue() : new PgBossJobQueue(process.env.DATABASE_URL!);
