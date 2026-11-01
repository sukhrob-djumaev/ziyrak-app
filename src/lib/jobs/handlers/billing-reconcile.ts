import { jobQueue } from "@/lib/jobs/queue";
import { RECONCILE_BILLING_JOB } from "@/lib/jobs/job-types";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { reconcileSubscriptions } from "@/lib/billing/reconcile";

/** L5.2 - control-plane recurring job: ends expired grace and repairs subscription state from the provider. */
jobQueue.registerHandler(RECONCILE_BILLING_JOB, async () => {
  const provider = getPaymentProvider();
  if (!provider) return;
  await reconcileSubscriptions({ provider, mode: billingMode() });
});
