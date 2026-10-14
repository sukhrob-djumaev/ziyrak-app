import { logger } from "@/lib/observability/logger";
import { getScopedPrisma, type ScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * Normalize a phone number for consistent matching.
 * Strips WhatsApp suffixes (@c.us, @s.whatsapp.net) and non-digit chars (except leading +).
 */
export function normalizePhone(input: string): string {
  const cleaned = input.replace(/@(c\.us|s\.whatsapp\.net)$/, "");
  return cleaned.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
}

/**
 * Resolve a customer identity across channels.
 * Finds or creates a Customer record based on contact info.
 * Returns the customerId for linking to conversations.
 *
 * Phase 2 runtime-isolation audit finding: every lookup here used to go
 * through the raw, unscoped client — so an inbound message to one
 * business's channel could match and update *another* business's
 * Customer record purely by matching phone/email. Now takes `ctx`
 * explicitly and uses getScopedPrisma(ctx) throughout, so this was already
 * structurally safe for whichever business `ctx` represented — as of
 * Phase 5 (§46.5), every real channel adapter resolves that `ctx` from a
 * genuine per-`ChannelConnection` lookup (`identity/channel-credential-
 * auth.ts`), not the Default-Business-only shim this comment used to
 * describe; no change was needed here to make that upgrade safe.
 */
export async function resolveCustomer(
  ctx: TenantContext,
  channel: string,
  customerContact: string,
  customerName: string,
  repository?: Pick<ScopedPrisma, "customer">
): Promise<string> {
  const db = repository ?? getScopedPrisma(ctx);

  // PLAN.md §20.2/§46.7 — a Meta Cloud conversation's channel is
  // "whatsapp_cloud" (that is what routes replies/follow-ups to the right
  // adapter and connection), but for *identifying the customer* it is just
  // WhatsApp: the same person messaging over the legacy adapter, a CSV
  // import, or a phone call must resolve to the same Customer row.
  channel = channel === "whatsapp_cloud" ? "whatsapp" : channel;

  if (!customerContact) {
    return createCustomer(ctx, customerName, channel, customerContact, db);
  }

  const existing = await findExistingCustomer(ctx, channel, customerContact, db);
  if (existing) {
    await updateExistingCustomer(ctx, existing.id, channel, customerContact, customerName, db);
    return existing.id;
  }
  return createCustomer(ctx, customerName, channel, customerContact, db);
}

/** Read-only identity lookup shared by admission and receipt erasure. Preserve
 * the existing phase order and normalization so erasure never uses a broader
 * target-only matcher or mutates another customer's profile while discovering.
 */
export async function findExistingCustomer(
  ctx: TenantContext,
  channel: string,
  customerContact: string,
  repository?: Pick<ScopedPrisma, "customer">
) {
  const db = repository ?? getScopedPrisma(ctx);
  channel = channel === "whatsapp_cloud" ? "whatsapp" : channel;
  if (!customerContact) return null;
  const direct = await findByChannelField(ctx, channel, customerContact, db);
  if (direct) return direct;
  if (channel === "phone" || channel === "whatsapp") {
    const normalized = normalizePhone(customerContact);
    if (normalized.length >= 7) {
      const phone = await db.customer.findFirst({
        where: {
          OR: [{ phone: { contains: normalized } }, { whatsapp: { contains: normalized } }],
        },
      });
      if (phone) return phone;
    }
  }
  return db.customer.findFirst({
    where: {
      OR: [
        { email: { equals: customerContact, mode: "insensitive" } },
        { phone: customerContact },
        { whatsapp: customerContact },
      ],
    },
  });
}

async function findByChannelField(
  ctx: TenantContext,
  channel: string,
  contact: string,
  repository: Pick<ScopedPrisma, "customer">
) {
  const db = repository ?? getScopedPrisma(ctx);
  switch (channel) {
    case "email":
      return db.customer.findFirst({
        where: { email: { equals: contact, mode: "insensitive" } },
      });
    case "whatsapp":
      return db.customer.findFirst({
        where: { whatsapp: contact },
      });
    case "phone":
      return db.customer.findFirst({
        where: { phone: contact },
      });
    case "webchat":
      // No dedicated column (Customer only has email/phone/whatsapp) — the
      // widget's persistent visitor id (distinct from any one
      // conversationId, §20.4/§46.5's acceptance-audit correction) is
      // matched via the generic `metadata` JSON field instead, the same
      // JSON-path-query pattern already used for `ChannelConnection.config`.
      return db.customer.findFirst({
        where: { metadata: { path: ["webchatVisitorId"], equals: contact } },
      });
    default:
      return null;
  }
}

async function createCustomer(
  ctx: TenantContext,
  name: string,
  channel: string,
  contact: string,
  repository: Pick<ScopedPrisma, "customer">
): Promise<string> {
  const db = repository ?? getScopedPrisma(ctx);
  const customer = await db.customer.create({
    data: {
      businessId: ctx.businessId,
      name: name || "Unknown",
      firstContact: new Date(),
      lastContact: new Date(),
      ...(channel === "email" ? { email: contact } : {}),
      ...(channel === "whatsapp" ? { whatsapp: contact } : {}),
      ...(channel === "phone" ? { phone: contact } : {}),
      ...(channel === "webchat" ? { metadata: { webchatVisitorId: contact } } : {}),
    },
  });

  logger.info("Auto-created customer from channel contact", {
    businessId: ctx.businessId,
    customerId: customer.id,
    channel,
  });

  return customer.id;
}

async function updateExistingCustomer(
  ctx: TenantContext,
  customerId: string,
  channel: string,
  contact: string,
  name: string,
  repository: Pick<ScopedPrisma, "customer">
): Promise<void> {
  const db = repository ?? getScopedPrisma(ctx);
  const update: Record<string, unknown> = {
    lastContact: new Date(),
  };

  // Backfill empty channel fields
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { name: true, email: true, phone: true, whatsapp: true },
  });

  if (!customer) return;

  if (channel === "email" && !customer.email) update.email = contact;
  if (channel === "whatsapp" && !customer.whatsapp) update.whatsapp = contact;
  if (channel === "phone" && !customer.phone) update.phone = contact;

  // Update name if current is "Unknown" and we have a better one
  if (customer.name === "Unknown" && name && name !== "Unknown") {
    update.name = name;
  }

  await db.customer.update({
    where: { id: customerId },
    data: update,
  });
}
