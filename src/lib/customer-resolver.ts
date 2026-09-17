import { logger } from "@/lib/logger";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
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
 * explicitly and uses getScopedPrisma(ctx) throughout, so this is
 * structurally safe for whichever business `ctx` represents today (the
 * Default Business only, per the channel adapters' own guard — see
 * default-business.ts's getDefaultBusinessContext()) and remains correct
 * with zero further changes once Phase 5 passes a real per-connection ctx.
 */
export async function resolveCustomer(
  ctx: TenantContext,
  channel: string,
  customerContact: string,
  customerName: string
): Promise<string> {
  const db = getScopedPrisma(ctx);

  if (!customerContact) {
    return createCustomer(ctx, customerName, channel, customerContact);
  }

  // Step 1: Direct field match by channel
  const directMatch = await findByChannelField(ctx, channel, customerContact);
  if (directMatch) {
    await updateExistingCustomer(ctx, directMatch.id, channel, customerContact, customerName);
    return directMatch.id;
  }

  // Step 2: Normalized phone match (for phone/whatsapp channels)
  if (channel === "phone" || channel === "whatsapp") {
    const normalized = normalizePhone(customerContact);
    if (normalized.length >= 7) {
      const phoneMatch = await db.customer.findFirst({
        where: {
          OR: [
            { phone: { contains: normalized } },
            { whatsapp: { contains: normalized } },
          ],
        },
      });
      if (phoneMatch) {
        await updateExistingCustomer(ctx, phoneMatch.id, channel, customerContact, customerName);
        return phoneMatch.id;
      }
    }
  }

  // Step 3: Cross-field fallback (search all contact fields)
  const crossMatch = await db.customer.findFirst({
    where: {
      OR: [
        { email: { equals: customerContact, mode: "insensitive" } },
        { phone: customerContact },
        { whatsapp: customerContact },
      ],
    },
  });
  if (crossMatch) {
    await updateExistingCustomer(ctx, crossMatch.id, channel, customerContact, customerName);
    return crossMatch.id;
  }

  // Step 4: Auto-create new customer
  return createCustomer(ctx, customerName, channel, customerContact);
}

async function findByChannelField(ctx: TenantContext, channel: string, contact: string) {
  const db = getScopedPrisma(ctx);
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
    default:
      return null;
  }
}

async function createCustomer(
  ctx: TenantContext,
  name: string,
  channel: string,
  contact: string
): Promise<string> {
  const db = getScopedPrisma(ctx);
  const customer = await db.customer.create({
    data: {
      businessId: ctx.businessId,
      name: name || "Unknown",
      firstContact: new Date(),
      lastContact: new Date(),
      ...(channel === "email" ? { email: contact } : {}),
      ...(channel === "whatsapp" ? { whatsapp: contact } : {}),
      ...(channel === "phone" ? { phone: contact } : {}),
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
  name: string
): Promise<void> {
  const db = getScopedPrisma(ctx);
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
