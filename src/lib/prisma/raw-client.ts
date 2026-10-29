import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/ziyrak?schema=public";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * PLAN.md §28.4 — the pool is sized explicitly, not left at the driver
 * default: `(postgres_max_connections / replica_count)` minus headroom for
 * the worker's own pool, per replica. Behind PgBouncer (transaction
 * pooling) this is the number of client connections one replica opens to
 * the pooler, not to Postgres.
 */
function poolMax(): number | undefined {
  const max = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "", 10);
  return Number.isFinite(max) && max > 0 ? max : undefined;
}

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString, max: poolMax() });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
