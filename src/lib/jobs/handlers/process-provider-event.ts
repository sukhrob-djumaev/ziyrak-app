import { jobQueue } from "@/lib/jobs/queue";
import { PROCESS_PROVIDER_EVENT_JOB, type ProcessProviderEventPayload } from "@/lib/jobs/job-types";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { processProviderEvent } from "@/lib/billing/provider-events";

/** L5.1 - control-plane handler: applies one stored provider event. A thrown error retries under the queue's settings. */
jobQueue.registerHandler<ProcessProviderEventPayload>(PROCESS_PROVIDER_EVENT_JOB, async (_ctx, payload) => {
  const provider = getPaymentProvider();
  if (!provider) return;
  await processProviderEvent(payload.eventId, { provider, providerName: provider.name, mode: billingMode() });
});
