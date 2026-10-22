import { jobQueue } from "@/lib/jobs/queue";
import { SWEEP_AI_RESERVATIONS_JOB } from "@/lib/jobs/job-types";
import { sweepExpiredReservations } from "@/lib/ai/allowance";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md P2 — recovers AI allowance reservations whose attempt never
 * finished (worker crash, lost response). They become `uncertain` and stay
 * charged at their reserved bound, so a crash can never refund spend.
 */
export async function runAiReservationSweep(): Promise<void> {
  const swept = await sweepExpiredReservations();
  if (swept > 0) logger.info("[sweep-ai-reservations] expired reservations marked uncertain", { swept });
}

jobQueue.registerHandler(SWEEP_AI_RESERVATIONS_JOB, async () => {
  await runAiReservationSweep();
});
