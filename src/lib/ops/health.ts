import { timingSafeEqual } from "node:crypto";
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

/**
 * Probes are unauthenticated and each runs a database query, so a flood must not turn into a flood of queries:
 * concurrent callers share one in-flight probe and its result is reused for HEALTH_CACHE_MS (default 1.5 s, 0 = off).
 */
const cacheMs = () => {
  const raw = Number(process.env.HEALTH_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1_500;
};
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  const ttl = cacheMs();
  const hit = memo.get(key);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = run();
  if (ttl > 0) memo.set(key, { at: Date.now(), value });
  return value;
}

export function checkDatabase(): Promise<DependencyState> {
  return shared("database", checkDatabaseNow);
}

async function checkDatabaseNow(): Promise<DependencyState> {
  try {
    await within(Promise.resolve(prisma.$queryRaw`SELECT 1`), PROBE_BUDGET_MS);
    return "ok";
  } catch {
    return "down";
  }
}

export function checkRedis(): Promise<DependencyState> {
  return shared("redis", checkRedisNow);
}

async function checkRedisNow(): Promise<DependencyState> {
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

/**
 * `includeDetail` is for authenticated operators only (see the route): build identity, worker and queue facts and
 * memory are useful to an attacker (version fingerprinting, activity volume), so the public answer is just status
 * and dependency states.
 */
export async function detail(includeDetail = false) {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  // Worker and queue facts need the database; with it down they are simply unknown.
  const worker = database === "ok" ? await readWorkerStatus().catch(() => null) : null;
  const base = {
    ready: database === "ok",
    // "degraded" = serving, but an operator should look (Redis down, workers stale or absent).
    status: database === "ok" && redis !== "down" && worker?.state === "ok" ? "ok" : "degraded",
    services: { database, redis, worker: worker?.state ?? "unknown" },
  };
  if (!includeDetail) return base;
  const queue = database === "ok" ? await readQueueSignals() : "unknown";
  const mem = process.memoryUsage();
  return {
    ...base,
    build: buildIdentity(),
    environment: process.env.NODE_ENV || "development",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    worker,
    queue,
    memory: { rssMb: Math.round(mem.rss / 1024 / 1024), heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024) },
  };
}

/** Constant-time check of the operator token. No token configured means nobody gets the detail. */
export function detailAllowed(presented: string | null): boolean {
  const expected = process.env.HEALTH_DETAIL_TOKEN;
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
