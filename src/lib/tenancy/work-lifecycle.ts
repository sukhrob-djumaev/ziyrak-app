import { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/observability/errors";
import type { TenantContext } from "./context";

const retirementContexts = new WeakSet<TenantContext>();
/** Internal lifecycle capability; JSON/request input cannot manufacture it.
 * The calling erasure service checks permission; repository scope still applies.
 */
export function retirementContext(ctx: TenantContext): TenantContext {
  const context = { ...ctx };
  retirementContexts.add(context);
  return context;
}
export function isRetirementContext(ctx: TenantContext) {
  return retirementContexts.has(ctx);
}
export class WorkRetiredError extends AppError {
  constructor() {
    super(409, "WORK_RETIRED", "This work was retired; cached data cannot be restored.");
  }
}
type Transaction = {
  $queryRaw: (query: Prisma.Sql) => Promise<unknown>;
};
/** All short scoped writes acquire this before row locks. It intentionally
 * serializes local writes within one business; no external call belongs inside.
 * Hash collisions only add serialization, never cross-tenant access.
 */
export async function lockTenantWrites(tx: Transaction, businessId: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(92841, hashtext(${businessId}))::text`
  );
}
