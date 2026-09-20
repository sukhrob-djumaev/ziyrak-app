import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { Prisma } from "@/generated/prisma/client";
import type { ZiyrakEvent } from "./types";

export interface RegisterInboundEventInput {
  source: string;
  externalEventId: string;
  eventType: string;
  correlationId: string;
  event: ZiyrakEvent;
}

export type RegisterInboundEventResult =
  | { isDuplicate: false; receiptId: string }
  | { isDuplicate: true; receiptId: string };

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * PLAN.md §17.4/§46.5 — the shared `InboundEventReceipt` dedup check every
 * channel adapter's `validateInbound()` runs before any `Customer`/
 * `Conversation` row is touched. `INSERT ... ON CONFLICT DO NOTHING`'s
 * atomicity (what actually closes the concurrent-redelivery race a naive
 * "check then insert" has) is expressed here as a Prisma `create()` whose
 * unique-constraint violation (P2002 on `@@unique([businessId, source,
 * externalEventId])`) is caught and treated as "already seen" — Prisma has
 * no native insert-or-ignore, and this is its documented equivalent.
 *
 * The full normalized event is stored on the receipt row (`eventPayload`)
 * so a job handler can reload it from just `{businessId, receiptId}` —
 * required for `FakeJobQueue` (this phase) to be a drop-in-compatible call
 * site for Phase 6's real `PgBossJobQueue`, which can only pass
 * JSON-serializable, DB-referenceable payloads across a process boundary.
 */
export async function registerInboundEvent(
  ctx: TenantContext,
  input: RegisterInboundEventInput
): Promise<RegisterInboundEventResult> {
  const db = getScopedPrisma(ctx);

  try {
    const receipt = await db.inboundEventReceipt.create({
      data: {
        businessId: ctx.businessId,
        source: input.source,
        externalEventId: input.externalEventId,
        eventType: input.eventType,
        correlationId: input.correlationId,
        eventPayload: input.event as unknown as Prisma.InputJsonValue,
      },
    });
    return { isDuplicate: false, receiptId: receipt.id };
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;

    const existing = await db.inboundEventReceipt.findUniqueOrThrow({
      where: {
        businessId_source_externalEventId: {
          businessId: ctx.businessId,
          source: input.source,
          externalEventId: input.externalEventId,
        },
      },
    });
    return { isDuplicate: true, receiptId: existing.id };
  }
}

/** Reloads the normalized event a receipt was created with — the job handler's only way to recover it (see module header). */
export async function loadReceiptEvent(ctx: TenantContext, receiptId: string): Promise<ZiyrakEvent> {
  const db = getScopedPrisma(ctx);
  const receipt = await db.inboundEventReceipt.findUniqueOrThrow({ where: { id: receiptId } });
  return receipt.eventPayload as unknown as ZiyrakEvent;
}

export async function markReceiptProcessed(ctx: TenantContext, receiptId: string, status: "processed" | "failed"): Promise<void> {
  const db = getScopedPrisma(ctx);
  await db.inboundEventReceipt.update({ where: { id: receiptId }, data: { processingStatus: status } });
}
