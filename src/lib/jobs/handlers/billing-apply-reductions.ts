import { jobQueue } from "@/lib/jobs/queue";
import { APPLY_DUE_REDUCTIONS_JOB } from "@/lib/jobs/job-types";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { applyDueReductions } from "@/lib/billing/changes";

/** L5.2 - control-plane recurring job: applies owner-scheduled removals/decreases whose period has ended. */
jobQueue.registerHandler(APPLY_DUE_REDUCTIONS_JOB, async () => {
  const provider = getPaymentProvider();
  if (!provider) return;
  await applyDueReductions({ provider, mode: billingMode() });
});
