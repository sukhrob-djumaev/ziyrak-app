import { jobQueue } from "@/lib/jobs/queue";
import { SYNC_PROVIDER_PRICE_JOB, type SyncProviderPricePayload } from "@/lib/jobs/job-types";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { syncVersionPrice } from "@/lib/billing/price-sync";

/** L5.1 - control-plane handler: mirrors one published catalog version into the provider as a price. */
jobQueue.registerHandler<SyncProviderPricePayload>(SYNC_PROVIDER_PRICE_JOB, async (_ctx, payload) => {
  const provider = getPaymentProvider();
  if (!provider) return;
  await syncVersionPrice(payload.versionId, provider, billingMode());
});
