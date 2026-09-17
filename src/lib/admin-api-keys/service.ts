import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/errors";
import crypto from "crypto";

/** PLAN.md §16.2/§9.4 — application-service layer for "admin/api-keys". */

export interface ListParams {
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListParams) {
  const db = getScopedPrisma(ctx);
  const [keys, total] = await Promise.all([
    db.apiKey.findMany({ orderBy: { createdAt: "desc" }, skip: params.skip, take: params.take }),
    db.apiKey.count(),
  ]);
  return { keys, total };
}

/**
 * §9.4: keyPrefix is safe to display/search by, never the secret itself.
 * The full secret is generated here and returned exactly once, at creation
 * time — after this response, only its hash is ever stored.
 */
function generateApiKey(): { fullKey: string; keyPrefix: string; keyHash: string } {
  const secret = crypto.randomBytes(24).toString("base64url");
  const fullKey = `zy_live_${secret}`;
  const keyPrefix = fullKey.slice(0, 16);
  const keyHash = crypto.createHash("sha256").update(fullKey).digest("hex");
  return { fullKey, keyPrefix, keyHash };
}

export async function create(ctx: TenantContext, name: string) {
  const db = getScopedPrisma(ctx);
  const { fullKey, keyPrefix, keyHash } = generateApiKey();

  const apiKey = await db.apiKey.create({
    data: {
      businessId: ctx.businessId,
      name: name.trim(),
      keyPrefix,
      keyHash,
      // Capped below "owner" per §9.1/§9.4 — a leaked long-lived key must
      // never be able to reach owner-only actions (deleting the business).
      role: "agent",
    },
  });

  return { apiKey, fullKey };
}

export interface UpdateInput {
  name?: string;
  isActive?: boolean;
}

export async function update(ctx: TenantContext, id: string, input: UpdateInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.apiKey.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("API key");

  return db.apiKey.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.apiKey.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("API key");
  await db.apiKey.delete({ where: { id } });
}
