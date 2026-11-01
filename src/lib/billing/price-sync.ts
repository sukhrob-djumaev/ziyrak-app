import { prisma } from "@/lib/prisma/raw-client";
import type { PaymentProvider } from "./providers/types";
import type { BillingMode } from "./providers";

/**
 * L5.1 - mirrors one published catalog version into the provider as a price. Immutable versions mean the price never
 * changes after creation; the provider idempotency key is the version id so a retried sync cannot create a second price.
 */
export async function syncVersionPrice(versionId: string, provider: PaymentProvider, mode: BillingMode): Promise<"synced" | "skipped"> {
  const v = await prisma.catalogVersion.findUnique({ where: { id: versionId }, include: { item: true } });
  if (!v || v.state === "draft" || v.priceMinor == null || !v.currency || (v.interval !== "month" && v.interval !== "year")) return "skipped";
  const key = { provider: provider.name, mode, versionId };
  const row = await prisma.providerPriceRef.upsert({ where: { provider_mode_versionId: key }, create: key, update: {} });
  if (row.state === "synced" && row.priceRef) return "synced";
  try {
    const out = await provider.syncPrice(
      { versionId, itemName: `${v.item.key} - ${v.name}`, amountMinor: v.priceMinor, currency: v.currency, interval: v.interval },
      `sync-price-${mode}-${versionId}`,
    );
    await prisma.providerPriceRef.update({ where: { id: row.id }, data: { state: "synced", productRef: out.productRef, priceRef: out.priceRef, syncedAt: new Date(), lastError: null, attempts: { increment: 1 } } });
    return "synced";
  } catch (e) {
    await prisma.providerPriceRef.update({ where: { id: row.id }, data: { state: "failed", lastError: String((e as Error).message).slice(0, 300), attempts: { increment: 1 } } });
    throw e;
  }
}
