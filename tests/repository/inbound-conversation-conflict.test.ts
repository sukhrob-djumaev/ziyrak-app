import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * A Web Chat widget supplies its own conversation id. If that id already belongs
 * to ANOTHER business (a deliberate collision attempt — real ids are random
 * UUIDs), the worker used to hit a raw primary-key error, retry it, and log it
 * unreadably. It is now a clear, permanent, non-retried outcome that reveals
 * nothing about the other business, and the visitor's message is not stored.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { logger } from "@/lib/observability/logger";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import {
  resolveOrCreateConversation,
  handleProcessInboundMessage,
  ConversationIdUnavailableError,
} from "@/lib/conversations/inbound";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let b: SeededBusiness;
let foreignConversationId: string;
let connectionId: string;

const event = (businessId: string, conversationId: string) => ({
  id: `e-${Math.random()}`,
  type: "message.received",
  businessId,
  source: { channel: "webchat", connectionId },
  conversationId,
  occurredAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(),
  correlationId: "c1",
  payload: {
    customerName: "Visitor",
    customerContact: "visitor-1",
    text: "hello from a collision attempt",
  },
});

beforeAll(async () => {
  a = await seedBusiness("conflict-a");
  b = await seedBusiness("conflict-b");
  connectionId = (
    await prisma.channelConnection.create({
      data: {
        businessId: a.businessId,
        type: "webchat",
        name: "Collision fixture",
      },
    })
  ).id;
  const theirs = await getScopedPrisma(b.ctx).conversation.create({
    data: { businessId: b.businessId, channel: "webchat", customerName: "B's visitor" },
  });
  foreignConversationId = theirs.id;
});

afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});

describe("a Web Chat conversation id that belongs to another business", () => {
  it("resolveOrCreateConversation raises a specific, non-leaking error (not a raw database error)", async () => {
    const error = await resolveOrCreateConversation(
      a.ctx,
      event(a.businessId, foreignConversationId) as never
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ConversationIdUnavailableError);
    expect((error as Error).message).not.toContain(b.businessId);
    expect((error as Error).message).not.toContain(foreignConversationId);
  });

  it("the job completes without being retried, marks the receipt failed, stores nothing, and logs a readable warning", async () => {
    const ev = event(a.businessId, foreignConversationId);
    const { receiptId } = await registerInboundEvent(a.ctx, {
      source: "webchat",
      externalEventId: `ext-${Math.random()}`,
      eventType: "message.received",
      correlationId: "c1",
      event: ev as never,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(
      handleProcessInboundMessage(a.ctx, { businessId: a.businessId, receiptId })
    ).resolves.toBeUndefined(); // does not throw => the queue does not retry

    const receipt = await getScopedPrisma(a.ctx).inboundEventReceipt.findUnique({
      where: { id: receiptId },
    });
    expect(receipt?.processingStatus).toBe("failed");
    expect(await prisma.message.count({ where: { businessId: a.businessId } })).toBe(0);
    expect(
      await getScopedPrisma(b.ctx).conversation.count({ where: { id: foreignConversationId } })
    ).toBe(1); // untouched
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/conversation id/i),
      expect.objectContaining({ businessId: a.businessId, receiptId })
    );
    warn.mockRestore();
  });
});
