import { randomUUID } from "node:crypto";
import { closeSync, openSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/prisma/raw-client";
import { logger } from "@/lib/observability/logger";

/**
 * L2.1 / F11: a worker has no HTTP surface, so it proves it is alive two ways.
 * - a row per process in WorkerHeartbeat (what the web app reports and what fleet checks read), and
 * - a local file whose mtime a container probe can check without any network or database access.
 * A worker whose process dies, event loop stalls or database connection is lost stops refreshing both, so both go
 * stale. This does NOT prove jobs are being processed; queue age (readQueueSignals) is the signal for that.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_MS = 60_000;
export const defaultHeartbeatFile = () => process.env.WORKER_HEARTBEAT_FILE || join(tmpdir(), "ziyrak-worker-heartbeat");

function touch(file: string, now: Date): void {
  try {
    closeSync(openSync(file, "a"));
    utimesSync(file, now, now);
  } catch (error) {
    logger.warn("[worker] could not touch the heartbeat file", { error: String(error) });
  }
}

export async function beat(instanceId: string, startedAt: Date, now: Date = new Date(), file: string = defaultHeartbeatFile()): Promise<void> {
  const buildSha = process.env.APP_BUILD_SHA || "unknown";
  await prisma.workerHeartbeat.upsert({
    where: { instanceId },
    create: { instanceId, startedAt, lastSeenAt: now, buildSha },
    update: { lastSeenAt: now, buildSha },
  });
  // A crashed worker (SIGKILL, OOM) never removes its row; drop anything long dead so the table cannot grow.
  await prisma.workerHeartbeat.deleteMany({ where: { lastSeenAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } });
  touch(file, now); // after the database write: a worker that cannot reach the database must not look healthy
}

/** Starts refreshing the heartbeat; returns a function that stops it and removes this instance's row. */
export function startWorkerHeartbeat(options: { intervalMs?: number; file?: string; instanceId?: string } = {}) {
  const instanceId = options.instanceId ?? `${process.env.HOSTNAME || "worker"}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date();
  const run = () => beat(instanceId, startedAt, new Date(), options.file).catch((error) => logger.warn("[worker] heartbeat failed", { error: String(error) }));
  void run();
  const timer = setInterval(run, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await prisma.workerHeartbeat.deleteMany({ where: { instanceId } }).catch(() => undefined);
  };
}

export type WorkerState = "ok" | "stale" | "none";

/** Fleet view for the summary endpoint. Old rows (a crashed worker's) are ignored rather than trusted. */
export async function readWorkerStatus(now: Date = new Date()): Promise<{ state: WorkerState; instances: number; newestAgeSeconds: number | null }> {
  const rows = await prisma.workerHeartbeat.findMany({ select: { lastSeenAt: true }, orderBy: { lastSeenAt: "desc" }, take: 50 });
  if (!rows.length) return { state: "none", instances: 0, newestAgeSeconds: null };
  const age = now.getTime() - rows[0].lastSeenAt.getTime();
  const live = rows.filter((r) => now.getTime() - r.lastSeenAt.getTime() <= HEARTBEAT_STALE_MS).length;
  return { state: age <= HEARTBEAT_STALE_MS ? "ok" : "stale", instances: live, newestAgeSeconds: Math.max(0, Math.round(age / 1000)) };
}

/** Queue pressure from pg-boss's own tables. Unknown (never an error) when the schema is not there yet. */
export async function readQueueSignals(): Promise<{ oldestWaitingSeconds: number | null; failedLastHour: number; active: number } | "unknown"> {
  try {
    const rows = (await prisma.$queryRaw`
      SELECT
        EXTRACT(EPOCH FROM (now() - MIN(created_on) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now())))::float AS oldest,
        COUNT(*) FILTER (WHERE state = 'failed' AND completed_on > now() - interval '1 hour')::int AS failed,
        COUNT(*) FILTER (WHERE state = 'active')::int AS active
      FROM pgboss.job`) as Array<{ oldest: number | null; failed: number; active: number }>;
    const r = rows[0];
    return { oldestWaitingSeconds: r?.oldest == null ? null : Math.max(0, Math.round(r.oldest)), failedLastHour: r?.failed ?? 0, active: r?.active ?? 0 };
  } catch {
    return "unknown";
  }
}
