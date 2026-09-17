import crypto from "crypto";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

/**
 * PLAN.md §12/§13.2.9 — BusinessHours is a per-business row
 * (`@@unique([businessId])`), not the old `id: "default"` singleton every
 * business used to share. Lookups and creates below always key off
 * `businessId`; a brand-new business's row gets a fresh generated `id` —
 * the literal string `"default"` is reserved for the pre-migrated Default
 * Business's own row, backfilled in place by the Phase 1 migration, and
 * must never be reused for a second business (it would collide on the
 * primary key).
 */

export async function get(ctx: TenantContext) {
  const db = getScopedPrisma(ctx);
  let config = await db.businessHours.findUnique({ where: { businessId: ctx.businessId } });

  if (!config) {
    config = await db.businessHours.create({ data: { id: crypto.randomUUID(), businessId: ctx.businessId } });
  }

  return config;
}

export interface UpdateInput {
  enabled?: boolean;
  timezone?: string;
  monday?: string;
  tuesday?: string;
  wednesday?: string;
  thursday?: string;
  friday?: string;
  saturday?: string;
  sunday?: string;
  offlineMessage?: string;
}

export async function upsert(ctx: TenantContext, input: UpdateInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.businessHours.findUnique({ where: { businessId: ctx.businessId } });

  if (existing) {
    return db.businessHours.update({
      where: { businessId: ctx.businessId },
      data: {
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.timezone !== undefined && { timezone: input.timezone }),
        ...(input.monday !== undefined && { monday: input.monday }),
        ...(input.tuesday !== undefined && { tuesday: input.tuesday }),
        ...(input.wednesday !== undefined && { wednesday: input.wednesday }),
        ...(input.thursday !== undefined && { thursday: input.thursday }),
        ...(input.friday !== undefined && { friday: input.friday }),
        ...(input.saturday !== undefined && { saturday: input.saturday }),
        ...(input.sunday !== undefined && { sunday: input.sunday }),
        ...(input.offlineMessage !== undefined && { offlineMessage: input.offlineMessage }),
      },
    });
  }

  return db.businessHours.create({
    data: {
      id: crypto.randomUUID(),
      businessId: ctx.businessId,
      enabled: input.enabled ?? false,
      timezone: input.timezone ?? "UTC",
      monday: input.monday ?? "09:00-18:00",
      tuesday: input.tuesday ?? "09:00-18:00",
      wednesday: input.wednesday ?? "09:00-18:00",
      thursday: input.thursday ?? "09:00-18:00",
      friday: input.friday ?? "09:00-18:00",
      saturday: input.saturday ?? "",
      sunday: input.sunday ?? "",
      offlineMessage:
        input.offlineMessage ??
        "We are currently offline. We will get back to you during business hours.",
    },
  });
}
