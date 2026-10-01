/**
 * PLAN.md §25.2/§46.6 — every job type name and its payload shape, in one
 * dependency-free module. Split out from `queue.ts` so `queue-policies.ts`
 * (which needs job-type names to build its policy map) and
 * `pgboss-job-queue.ts`/`worker.ts` (which need them to register handlers)
 * can all import them without creating an import cycle through the
 * `jobQueue` singleton itself.
 */

export const PROCESS_INBOUND_MESSAGE_JOB = "process-inbound-message";
export interface ProcessInboundMessagePayload {
  businessId: string;
  receiptId: string;
}

export const DELIVER_WEBHOOK_JOB = "deliver-webhook";
export interface DeliverWebhookPayload {
  businessId: string;
  webhookId: string;
  deliveryId: string;
}

export const SWEEP_SLA_BREACHES_JOB = "sweep-sla-breaches";
export interface SweepSlaBreachesPayload {
  businessId: string;
}

export const SWEEP_RETENTION_JOB = "sweep-retention";
export interface SweepRetentionPayload {
  businessId: string;
}

export const SEND_FOLLOWUP_JOB = "send-followup";
export interface SendFollowupPayload {
  businessId: string;
  conversationId: string;
  connectionId: string;
  channel: string;
  to: string;
  message: string;
  /** §24.3 — lets the handler update the same ActionExecution row the tool call created (requested/scheduled → running → succeeded/failed) once it actually runs. */
  idempotencyKey: string;
}

export const EXECUTE_CAMPAIGN_JOB = "execute-campaign";
export interface ExecuteCampaignPayload {
  businessId: string;
  campaignId: string;
}

/**
 * PLAN.md §25.2 ("Knowledge embedding indexing → `index-knowledge-entry`
 * job — non-blocking") — embeds one knowledge entry's *current* content
 * with its own business's configured `EmbeddingProvider`. Carries only ids:
 * the handler always re-reads the entry, so a job never embeds text that
 * was already replaced by the time it runs (`knowledge/indexing.ts`).
 */
export const INDEX_KNOWLEDGE_ENTRY_JOB = "index-knowledge-entry";
export interface IndexKnowledgeEntryPayload {
  businessId: string;
  entryId: string;
}
