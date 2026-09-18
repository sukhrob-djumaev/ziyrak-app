import { NotFoundError } from "@/lib/observability/errors";
import type { ScopedPrisma } from "./scoped-prisma";
import { TENANT_SCOPED_MODELS } from "./scoped-prisma";

type TenantModel = (typeof TENANT_SCOPED_MODELS)[number];

/**
 * PLAN.md §8.5 — layer 4: early, friendly validation. Explicitly
 * non-primary — layer 3 (the composite foreign keys, §8.4) is what actually
 * prevents a cross-tenant reference from being written; this only turns
 * that same rejection into a clean 404 in application code, before Postgres
 * would otherwise see the write and fail with a raw constraint-violation
 * error. Every service function that accepts a client-supplied foreign-key
 * id into a tenant-owned relation calls this before writing — see the
 * per-module `service.ts` files.
 *
 * `db` must already be a `getScopedPrisma(ctx)` client, so the lookup below
 * is itself tenant-filtered — a cross-tenant id and a nonexistent id are
 * both indistinguishable "not found" here, by construction (§33.3).
 */
export async function assertSameTenant(
  db: ScopedPrisma,
  model: TenantModel,
  id: string,
  resourceLabel: string = model
): Promise<void> {
  const row = await (db[model] as { findUnique: (args: { where: { id: string } }) => Promise<unknown> }).findUnique({
    where: { id },
  });
  if (!row) throw new NotFoundError(resourceLabel);
}
