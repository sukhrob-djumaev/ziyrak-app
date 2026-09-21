import { z } from "zod";
import { prisma as rawPrisma } from "@/lib/prisma/raw-client";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { getSecretResolver, type EncryptedSecret, type ChannelCredential } from "@/lib/secrets";
import type { TenantContext } from "@/lib/tenancy/context";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §6 (`identity/` owns "channel-credential auth"), §7.7/§14.3/§46.5
 * — resolving *which business* an identity-less inbound webhook belongs to,
 * before any `TenantContext` exists to scope a query with. This is the
 * `ChannelConnection` counterpart to `route-auth.ts`'s `authenticateApiKey`
 * (same reason for touching the raw client pre-`ctx`: you cannot look up
 * the tenant with a client that requires already knowing the tenant), which
 * is why this file sits in the same raw-client-import allowlist entry as
 * `route-auth.ts` in `eslint.config.mjs`.
 *
 * Each channel adapter calls exactly one of the `findConnectionBy*`
 * functions below (matching its own provider's identifying field), then
 * `resolveChannelCredential()` to decrypt+validate that connection's stored
 * credential, then `buildChannelCredentialContext()` to get a real
 * `TenantContext` scoped to the resolved business — never
 * `getDefaultBusinessContext()` (§46.2's transitional shim, which this
 * phase's adapters stop calling entirely).
 */

export interface ResolvedConnection {
  businessId: string;
  connectionId: string;
}

/**
 * Generic "resolve the one active ChannelConnection of this type whose
 * `config` JSON has this field set to this value" lookup — the shared shape
 * behind every provider-identifier-keyed resolution (Twilio's `To`/dialed
 * number, Meta's `phone_number_id`, §7.7/§19.2/§46.7).
 */
export async function findConnectionByConfigField(
  type: string,
  field: string,
  value: string
): Promise<ResolvedConnection | null> {
  if (!value) return null;
  const matches = await rawPrisma.channelConnection.findMany({
    where: {
      type,
      isActive: true,
      config: { path: [field], equals: value },
    },
    take: 2,
  });
  // Fail closed on ambiguity (PLAN.md §7.7/§46.7): if two active connections
  // ever claim the same provider identifier, routing an inbound message to
  // an arbitrary one of them would hand one business another's customer
  // traffic. Nobody receiving it is the safe failure; save-time checks
  // (`isConfigFieldClaimedByOtherBusiness`) exist to keep this from arising.
  if (matches.length > 1) {
    logger.error("Ambiguous ChannelConnection resolution — refusing to route", { type, field });
    return null;
  }
  const connection = matches[0];
  return connection ? { businessId: connection.businessId, connectionId: connection.id } : null;
}

/**
 * True when a connection of `type` belonging to a *different* business
 * already claims this provider identifier (e.g. a Meta `phone_number_id`).
 * Cross-tenant by nature, so it lives here with the other pre-`ctx` lookups.
 */
export async function isConfigFieldClaimedByOtherBusiness(
  type: string,
  field: string,
  value: string,
  businessId: string
): Promise<boolean> {
  const other = await rawPrisma.channelConnection.findFirst({
    where: { type, businessId: { not: businessId }, config: { path: [field], equals: value } },
    select: { id: true },
  });
  return other !== null;
}

/** Twilio's `To` (SMS) / dialed number (Phone) is the provider identifier both channels share (§19.2). */
export async function findConnectionByPhoneNumber(
  type: "sms" | "phone",
  phoneNumber: string
): Promise<ResolvedConnection | null> {
  return findConnectionByConfigField(type, "phoneNumber", phoneNumber);
}

/** Telegram/WhatsApp-Web/Email/WebChat resolve by a connection id the caller already has (a URL segment, or an allowlisted business's own connection). */
export async function findConnectionById(type: string, connectionId: string): Promise<ResolvedConnection | null> {
  const connection = await rawPrisma.channelConnection.findFirst({
    where: { id: connectionId, type, isActive: true },
  });
  return connection ? { businessId: connection.businessId, connectionId: connection.id } : null;
}

export async function findActiveConnectionByType(type: string, businessId: string): Promise<ResolvedConnection | null> {
  const connection = await rawPrisma.channelConnection.findFirst({
    where: { type, businessId, isActive: true },
  });
  return connection ? { businessId: connection.businessId, connectionId: connection.id } : null;
}

/** A resolved connection's own non-secret `config` JSON (e.g. WebChat's `allowedOrigins`) — read before a `TenantContext` exists, same reason as every other lookup in this file. */
export async function findConnectionConfig(connectionId: string): Promise<unknown | null> {
  const connection = await rawPrisma.channelConnection.findUnique({ where: { id: connectionId } });
  return connection?.config ?? null;
}

async function decryptChannelCredential<T extends ChannelCredential>(
  ref: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  try {
    const encrypted = JSON.parse(ref) as EncryptedSecret;
    const plaintext = await getSecretResolver().decrypt(encrypted);
    return schema.parse(JSON.parse(plaintext));
  } catch (error) {
    logger.error("Failed to decrypt/validate channel credential:", error);
    return null;
  }
}

/** Loads and decrypts a resolved connection's own credential, typed per channel. Returns `null` if unconfigured or invalid — the caller must treat that as "rejected", never fall back to a shared/global credential. */
export async function resolveChannelCredential<T extends ChannelCredential>(
  connectionId: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const connection = await rawPrisma.channelConnection.findUnique({ where: { id: connectionId } });
  if (!connection?.credentialRef) return null;
  return decryptChannelCredential(connection.credentialRef, schema);
}

export async function encryptChannelCredential(credential: ChannelCredential): Promise<string> {
  const encrypted = await getSecretResolver().encrypt(JSON.stringify(credential));
  return JSON.stringify(encrypted);
}

/** The one, explicit `TenantContext` construction for an inbound request authenticated by channel credential rather than JWT/API key (§9.5/§14.4). */
export async function buildChannelCredentialContext(resolved: ResolvedConnection): Promise<TenantContext> {
  const placement = await resolveTenantPlacement(resolved.businessId);
  return {
    businessId: resolved.businessId,
    role: null,
    actor: { kind: "channel_credential", channelConnectionId: resolved.connectionId },
    dataConnection: placement.dataConnection,
  };
}
