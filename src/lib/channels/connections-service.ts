import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { Prisma } from "@/generated/prisma/client";

/**
 * PLAN.md §7.7/§16.2 — tenant-scoped `ChannelConnection` access for the
 * generic channel-configuration routes (`/api/channels`, `/api/channels/
 * [type]`), which previously read/wrote the legacy, non-tenant-owned
 * `Channel` model directly (a single global row per `type`, shared by every
 * business — a real cross-tenant leak, not just a stale data model).
 *
 * This preserves the existing "exactly one connection per type" UX contract
 * (multi-connection-per-type is real per §7.7, but building that UI is
 * Phase 5/`ChannelAdapter` scope, not this mechanical tenant-scoping fix) —
 * it just resolves "the" connection of a type as the caller's own business's
 * first one, instead of a single global row.
 */

const CHANNEL_TYPES = ["whatsapp", "email", "phone", "sms", "telegram"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export function isValidChannelType(type: string): type is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(type);
}

function emptyConnection(type: string) {
  return {
    id: null,
    type,
    isActive: false,
    config: {},
    status: "disconnected",
    createdAt: null,
    updatedAt: null,
  };
}

export async function listAll(ctx: TenantContext) {
  const db = getScopedPrisma(ctx);
  const connections = await db.channelConnection.findMany({ orderBy: { type: "asc" } });
  const byType = new Map(connections.map((c) => [c.type, c]));

  return CHANNEL_TYPES.map((type) => byType.get(type) ?? emptyConnection(type));
}

export async function getByType(ctx: TenantContext, type: string) {
  const db = getScopedPrisma(ctx);
  const connection = await db.channelConnection.findFirst({ where: { type } });
  return connection ?? emptyConnection(type);
}

export interface UpsertConnectionInput {
  isActive?: boolean;
  config?: Record<string, unknown>;
  status?: string;
}

export async function upsertByType(ctx: TenantContext, type: string, input: UpsertConnectionInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.channelConnection.findFirst({ where: { type } });

  if (existing) {
    return db.channelConnection.update({
      where: { id: existing.id },
      data: {
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.config !== undefined && { config: input.config as Prisma.InputJsonValue }),
        ...(input.status !== undefined && { status: input.status }),
      },
    });
  }

  return db.channelConnection.create({
    data: {
      businessId: ctx.businessId,
      type,
      name: type,
      isActive: input.isActive ?? false,
      config: (input.config ?? {}) as Prisma.InputJsonValue,
      status: input.status ?? "disconnected",
    },
  });
}

export async function performAction(ctx: TenantContext, type: string, action: "connect" | "disconnect" | "test") {
  const db = getScopedPrisma(ctx);
  const existing = await db.channelConnection.findFirst({ where: { type } });

  if (action === "disconnect") {
    if (!existing) {
      return db.channelConnection.create({
        data: { businessId: ctx.businessId, type, name: type, isActive: false, config: {}, status: "disconnected" },
      });
    }
    return db.channelConnection.update({ where: { id: existing.id }, data: { status: "disconnected" } });
  }

  const isConfigured = existing?.config && Object.keys(existing.config as object).length > 0;

  if (action === "connect") {
    if (!isConfigured) return { error: "Channel must be configured before connecting" as const };
    return db.channelConnection.update({ where: { id: existing!.id }, data: { status: "connected", isActive: true } });
  }

  if (action === "test") {
    if (!isConfigured) return { error: "Channel must be configured before testing" as const };
    return { success: true as const, connection: existing };
  }

  return { error: "Unknown action" as const };
}
