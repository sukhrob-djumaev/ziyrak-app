import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { Prisma } from "@/generated/prisma/client";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { generateWebChatToken } from "./webchat-adapter";
import { buildWebChatEmbedSnippet } from "./webchat-embed";
import { NotFoundError } from "@/lib/observability/errors";
import { logActivity } from "@/lib/observability/activity";

/**
 * PLAN.md §20.4/§46.7 — admin-authenticated CRUD for a business's own Web
 * Chat `ChannelConnection`s, deliberately separate from the generic
 * `/api/channels/[type]` (§7.7's "one connection per type" convenience
 * route): the widget token is a server-generated publishable credential
 * (`generateWebChatToken()`), never a client-supplied one — reusing the
 * generic `ChannelCredentialSchema`-based upsert would let a caller set an
 * arbitrary `widgetSecret`, defeating the point of a server-issued,
 * rotatable token. `capabilities.supportsMultipleConnections` (§7.7) is
 * honored here (list/create are not "the one connection of this type"),
 * even though the dashboard UI built in this phase surfaces only a minimal
 * single-connection view — the API itself does not artificially restrict
 * a business to one Web Chat widget.
 */

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export interface WebChatConnectionView {
  connectionId: string;
  name: string;
  isActive: boolean;
  allowedOrigins: string[];
  embedSnippet: string;
  createdAt: Date;
  updatedAt: Date;
}

function toView(connection: {
  id: string;
  name: string;
  isActive: boolean;
  config: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): Omit<WebChatConnectionView, "embedSnippet"> {
  const config = (connection.config ?? {}) as { allowedOrigins?: string[] };
  return {
    connectionId: connection.id,
    name: connection.name,
    isActive: connection.isActive,
    allowedOrigins: Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [],
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function listWebChatConnections(ctx: TenantContext): Promise<Omit<WebChatConnectionView, "embedSnippet">[]> {
  const db = getScopedPrisma(ctx);
  const connections = await db.channelConnection.findMany({ where: { type: "webchat" }, orderBy: { createdAt: "asc" } });
  return connections.map(toView);
}

/** Returns the token in the response exactly once — like an ApiKey's secret (§9.4), it is never retrievable again after this call. */
export async function createWebChatConnection(
  ctx: TenantContext,
  input: { name?: string; allowedOrigins: string[] }
): Promise<WebChatConnectionView & { token: string }> {
  const db = getScopedPrisma(ctx);
  const token = generateWebChatToken();
  const credentialRef = await encryptChannelCredential({ type: "webchat", widgetSecret: token });

  const connection = await db.channelConnection.create({
    data: {
      businessId: ctx.businessId,
      type: "webchat",
      name: input.name?.trim() || "Web Chat",
      isActive: true,
      config: { allowedOrigins: input.allowedOrigins } as Prisma.InputJsonValue,
      credentialRef,
    },
  });

  await logActivity(ctx, "channel.webchat.created", "channel", connection.id, "Web Chat widget created", undefined, { allowedOrigins: input.allowedOrigins });
  return {
    ...toView(connection),
    token,
    embedSnippet: buildWebChatEmbedSnippet({ appBaseUrl: appBaseUrl(), connectionId: connection.id, token }),
  };
}

export async function updateWebChatConnection(
  ctx: TenantContext,
  connectionId: string,
  patch: { name?: string; allowedOrigins?: string[]; isActive?: boolean }
): Promise<Omit<WebChatConnectionView, "embedSnippet">> {
  const db = getScopedPrisma(ctx);
  const existing = await db.channelConnection.findFirst({ where: { id: connectionId, type: "webchat" } });
  if (!existing) throw new NotFoundError("Web Chat connection");

  const existingConfig = (existing.config ?? {}) as { allowedOrigins?: string[] };
  const nextConfig = {
    allowedOrigins: patch.allowedOrigins ?? existingConfig.allowedOrigins ?? [],
  };

  const updated = await db.channelConnection.update({
    where: { id: connectionId },
    data: {
      ...(patch.name !== undefined && { name: patch.name.trim() || existing.name }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      config: nextConfig as Prisma.InputJsonValue,
    },
  });

  await logActivity(ctx, "channel.webchat.updated", "channel", connectionId, "Web Chat widget settings changed", undefined, { isActive: updated.isActive });
  return toView(updated);
}

/**
 * Rotates a connection's token: a fresh secret is generated and encrypted,
 * fully replacing `credentialRef` in the same update — the previous token
 * stops working the instant this commits (§20.4's "independently
 * rotatable/revocable ... without affecting any other channel or admin
 * credential"), since `resolveChannelCredential()` always decrypts whatever
 * is currently stored, never a cached/previous value.
 */
export async function rotateWebChatToken(ctx: TenantContext, connectionId: string): Promise<WebChatConnectionView & { token: string }> {
  const db = getScopedPrisma(ctx);
  const existing = await db.channelConnection.findFirst({ where: { id: connectionId, type: "webchat" } });
  if (!existing) throw new NotFoundError("Web Chat connection");

  const token = generateWebChatToken();
  const credentialRef = await encryptChannelCredential({ type: "webchat", widgetSecret: token });

  const updated = await db.channelConnection.update({ where: { id: connectionId }, data: { credentialRef } });
  await logActivity(ctx, "channel.webchat.token_rotated", "channel", connectionId, "Web Chat widget token rotated");

  return {
    ...toView(updated),
    token,
    embedSnippet: buildWebChatEmbedSnippet({ appBaseUrl: appBaseUrl(), connectionId: updated.id, token }),
  };
}
