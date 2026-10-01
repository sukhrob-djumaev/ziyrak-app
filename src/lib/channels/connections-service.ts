import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { Prisma } from "@/generated/prisma/client";
import { ChannelCredentialSchema, type ChannelCredential } from "@/lib/secrets";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { AppError } from "@/lib/observability/errors";
import { prepareMetaCloudConnection } from "./meta-whatsapp-setup";
import { logActivity } from "@/lib/observability/activity";
import { WHATSAPP_WEB_CHANNEL_TYPE, assertWhatsAppWebEligible } from "./whatsapp-web-eligibility";

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

const CHANNEL_TYPES = ["whatsapp", "whatsapp_cloud", "email", "phone", "sms", "telegram", "webchat"] as const;
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
  /** PLAN.md §10.3 — validated against the type-matching schema and encrypted before storage; never persisted or echoed back raw. */
  credential?: ChannelCredential;
}

async function resolveCredentialRef(type: string, credential: ChannelCredential | undefined): Promise<string | undefined> {
  if (!credential) return undefined;
  const validated = ChannelCredentialSchema.parse(credential);
  if (validated.type !== type) {
    throw new AppError(400, "VALIDATION_ERROR", `Credential type "${validated.type}" does not match connection type "${type}".`);
  }
  return encryptChannelCredential(validated);
}

/**
 * PLAN.md §20.2 — a "whatsapp" connection selects the dev/demo-only
 * `WhatsAppWebAdapter`, so only the designated business, on a deployment
 * with the feature enabled, may create or configure one. Checked before any
 * read or write, so a refused caller persists nothing.
 */
async function assertTypeConfigurable(ctx: TenantContext, type: string): Promise<void> {
  if (type === WHATSAPP_WEB_CHANNEL_TYPE) await assertWhatsAppWebEligible(ctx);
}

export async function upsertByType(ctx: TenantContext, type: string, rawInput: UpsertConnectionInput) {
  await assertTypeConfigurable(ctx, type);
  const db = getScopedPrisma(ctx);
  const existing = await db.channelConnection.findFirst({ where: { type } });

  // PLAN.md §46.7 — Meta Cloud's routing key (`config.phoneNumberId`) is
  // derived from an ownership-verified credential, never client-supplied.
  let input = rawInput;
  if (type === "whatsapp_cloud") {
    const prepared = await prepareMetaCloudConnection(ctx, rawInput, (existing?.config ?? undefined) as Record<string, unknown> | undefined);
    input = { ...rawInput, config: prepared.config };
  }

  const credentialRef = await resolveCredentialRef(type, input.credential);

  const saved = existing
    ? await db.channelConnection.update({
        where: { id: existing.id },
        data: {
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          ...(input.config !== undefined && { config: input.config as Prisma.InputJsonValue }),
          ...(input.status !== undefined && { status: input.status }),
          ...(credentialRef !== undefined && { credentialRef }),
        },
      })
    : await db.channelConnection.create({
        data: {
          businessId: ctx.businessId,
          type,
          name: type,
          isActive: input.isActive ?? false,
          config: (input.config ?? {}) as Prisma.InputJsonValue,
          status: input.status ?? "disconnected",
          ...(credentialRef !== undefined && { credentialRef }),
        },
      });

  await logActivity(ctx, "channel.configured", "channel", saved.id, `${type} channel settings saved`, undefined, { type, credentialChanged: credentialRef !== undefined });
  return saved;
}

/**
 * The caller's own WhatsApp Web connection row, created on first use — only
 * after the eligibility check, so `POST /api/channels/whatsapp` can never
 * leave an inactive row behind for a business the adapter would refuse.
 */
export async function getOrCreateWhatsAppWebConnection(ctx: TenantContext) {
  await assertTypeConfigurable(ctx, WHATSAPP_WEB_CHANNEL_TYPE);
  const db = getScopedPrisma(ctx);
  const existing = await db.channelConnection.findFirst({ where: { type: WHATSAPP_WEB_CHANNEL_TYPE } });
  if (existing) return existing;
  return db.channelConnection.create({
    data: { businessId: ctx.businessId, type: WHATSAPP_WEB_CHANNEL_TYPE, name: "WhatsApp Web", isActive: false, config: {} },
  });
}

export async function performAction(ctx: TenantContext, type: string, action: "connect" | "disconnect" | "test") {
  await assertTypeConfigurable(ctx, type);
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
