/**
 * PLAN.md §25.3/§46.6 PR2 — the standalone worker entrypoint, a deliberate
 * separate deployable from the Next.js web process (`npm run worker`, its
 * own container/service in `docker-compose.yml`/Helm) from day one, so
 * Phase 8's "scale workers independently of web replicas" needs only a
 * deployment-config change, never an architectural one.
 *
 * Registers every job handler (via `jobs/bootstrap.ts`'s side-effect
 * import — the same one the web process uses for `enqueue`/`schedule`
 * registration safety), starts `jobQueue` (which, for the real
 * `PgBossJobQueue`, begins polling every registered queue), registers the
 * two recurring sweeps, and drains gracefully on SIGTERM/SIGINT.
 */
// Standalone entrypoint (not run through Next.js, which loads .env itself)
// — same convention prisma.config.ts already uses for the same reason.
import "dotenv/config";
import "@/lib/jobs/bootstrap";
// PLAN.md §46.7 acceptance-audit finding — registers every channel adapter
// so this process's own process-inbound-message job handler can actually
// find one to send the AI's reply back through (see channels/bootstrap.ts's
// own header for the full story).
import "@/lib/channels/bootstrap";
import { jobQueue } from "@/lib/jobs/queue";
import { SWEEP_SLA_BREACHES_JOB, SWEEP_RETENTION_JOB } from "@/lib/jobs/job-types";
import { prisma } from "@/lib/prisma/raw-client";
import { logger } from "@/lib/observability/logger";

// Standard 5-field cron (minute hour day month weekday), matching pg-boss's
// own `cron-parser`-backed schedule() — verified against its installed API,
// §46.6. No specific interval is fixed by PLAN.md §25.2 beyond "recurring"
// (SLA)/"e.g., daily" (retention); these are reasonable, adjustable
// defaults, not an architectural commitment.
const SLA_BREACH_SWEEP_CRON = "*/15 * * * *"; // every 15 minutes
const RETENTION_SWEEP_CRON = "0 3 * * *"; // daily at 03:00 UTC

async function main(): Promise<void> {
  await jobQueue.start();
  await jobQueue.scheduleRecurring(SWEEP_SLA_BREACHES_JOB, SLA_BREACH_SWEEP_CRON, async () => ({}));
  await jobQueue.scheduleRecurring(SWEEP_RETENTION_JOB, RETENTION_SWEEP_CRON, async () => ({}));
  logger.info("[worker] started", { slaBreachCron: SLA_BREACH_SWEEP_CRON, retentionCron: RETENTION_SWEEP_CRON });
}

let shuttingDown = false;

/**
 * PLAN.md §25.3 acceptance criterion — "the worker process can be stopped
 * and restarted without losing or duplicating in-flight work": drains
 * `jobQueue` (waits for in-flight handlers, stops fetching new jobs)
 * before exiting, mirroring `lib/prisma/shutdown.ts`'s existing pattern
 * for the web process.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`[worker] received ${signal}, draining in-flight jobs...`);
  try {
    await jobQueue.stop();
    logger.info("[worker] drained cleanly");
  } catch (error) {
    logger.error("[worker] error while draining", error);
  } finally {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  }
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

main().catch((error) => {
  logger.error("[worker] fatal startup error", error);
  process.exit(1);
});
