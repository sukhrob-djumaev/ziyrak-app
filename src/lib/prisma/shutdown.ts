import { prisma } from "@/lib/prisma/raw-client";
import { jobQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/observability/logger";

let isShuttingDown = false;

export function isGracefulShutdown(): boolean {
  return isShuttingDown;
}

/**
 * PLAN.md §25.3/§46.6 PR2 task 13 — the web process's own shutdown, not
 * the worker's (that's `src/worker.ts`'s own SIGTERM/SIGINT handlers,
 * since the worker is a separate deployable/process, §25.3). The web
 * process never runs a job-processing loop (`jobQueue.start()`'s `.work()`
 * registration is only ever called from `worker.ts`), so there is nothing
 * to drain here — but it does hold its own `PgBossJobQueue`'s connection
 * pool open (established the first time this process called `enqueue`/
 * `schedule`), which `jobQueue.stop()` closes cleanly alongside Prisma's.
 */
export function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Allow in-flight requests to complete (10s grace period)
    await new Promise((resolve) => setTimeout(resolve, 10000));

    try {
      await jobQueue.stop();
      logger.info("Job queue connection closed");
    } catch (error) {
      logger.error("Error closing job queue connection", error);
    }

    // Close database connection pool
    try {
      await prisma.$disconnect();
      logger.info("Database connections closed");
    } catch (error) {
      logger.error("Error closing database connections", error);
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
