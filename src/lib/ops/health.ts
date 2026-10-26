import { prisma } from "@/lib/prisma/raw-client";
import { getSharedRedis, redisUrl } from "@/lib/redis/client";
import { readQueueSignals, readWorkerStatus } from "./worker-heartbeat";

/**
 * L2.1 / F04: liveness and readiness are different questions.
 * - live: the process can answer at all. No dependency is consulted, so a database outage never restarts web pods.
 * - ready: this replica can do its job. Only the database gates it. Redis loss degrades to per-process limits and
 *   still serves, and external provider incidents are never part of readiness (they would turn a provider outage
 *   into a restart/eviction storm); both are reported for operators but do not fail the probe.
 */
export type DependencyState = "ok" | "down" | "not_configured";

const PROBE_BUDGET_MS = 2_000;
const startedAt = Date.now();

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("probe timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function checkDatabase(): Promise<DependencyState> {
  try {
    await within(Promise.resolve(prisma.$queryRaw`SELECT 1`), PROBE_BUDGET_MS);
    return "ok";
  } catch {
    return "down";
  }
}

export async function checkRedis(): Promise<DependencyState> {
  if (!redisUrl()) return "not_configured";
  try {
    const client = await within(getSharedRedis(), PROBE_BUDGET_MS);
    if (!client) return "down";
    await within(client.ping(), PROBE_BUDGET_MS);
    return "ok";
  } catch {
    return "down";
  }
}

/** Build identity injected by the image build (Dockerfile ARG) so an operator can tell what is deployed. */
export function buildIdentity() {
  return { sha: process.env.APP_BUILD_SHA || "unknown", version: process.env.npm_package_version || process.env.APP_VERSION || "unknown" };
}

export async function readiness() {
  const database = await checkDatabase();
  return { ready: database === "ok", checks: { database } };
}

export async function detail() {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  // Worker and queue facts need the database; with it down they are simply unknown.
  const worker = database === "ok" ? await readWorkerStatus().catch(() => null) : null;
  const queue = database === "ok" ? await readQueueSignals() : "unknown";
  const mem = process.memoryUsage();
  return {
    ready: database === "ok",
    // "degraded" = serving, but an operator should look (Redis down, workers stale or absent).
    status: database === "ok" && redis !== "down" && worker?.state === "ok" ? "ok" : "degraded",
    build: buildIdentity(),
    environment: process.env.NODE_ENV || "development",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    services: { database, redis, worker: worker?.state ?? "unknown" },
    worker,
    queue,
    memory: { rssMb: Math.round(mem.rss / 1024 / 1024), heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024) },
  };
}
