import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import * as conversations from "@/lib/conversations/service";
import { handleProcessInboundMessage } from "@/lib/conversations/inbound";
import { buildMessageReceivedEvent } from "@/lib/events/types";
vi.mock("@/lib/ai/engine", () => ({ chat: vi.fn().mockResolvedValue("Must never replay") }));
import { chat } from "@/lib/ai/engine";
import { deleteCustomerData, applyRetentionPolicy } from "@/lib/customers/gdpr";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { ToolRegistry } from "@/lib/tools/registry";
import { z } from "zod";
import * as scoped from "@/lib/tenancy/scoped-prisma";
let a: SeededBusiness, connections: string[];
beforeAll(async () => {
  a = await seedBusiness("p1-deletion");
  connections = await Promise.all(
    ["A", "B"].map(
      async (name) =>
        (
          await prisma.channelConnection.create({
            data: { businessId: a.businessId, type: "webchat", name, isActive: true },
          })
        ).id
    )
  );
});
afterAll(async () => {
  if (a) await cleanupBusiness(a.businessId);
});
async function fixture() {
  const customer = await prisma.customer.create({
    data: { businessId: a.businessId, name: "Synthetic private contact" },
  });
  const convs = await Promise.all(
    connections.map((connectionId) =>
      prisma.conversation.create({
        data: {
          businessId: a.businessId,
          customerId: customer.id,
          channel: "webchat",
          metadata: { channelConnectionId: connectionId },
        },
      })
    )
  );
  return { customer, convs };
}
async function action(conversationId: string, status = "scheduled") {
  return prisma.actionExecution.create({
    data: {
      businessId: a.businessId,
      conversationId,
      tool: "create_ticket",
      status,
      input: { privateContact: "synthetic-sensitive-contact" },
      result: { privateContact: "synthetic-sensitive-contact" },
      requestedBy: "system",
      idempotencyKey: crypto.randomUUID(),
    },
  });
}
describe("scoped deletion and retained action audit (real PG)", () => {
  it("workflow cancellation does not exempt cached private data from erasure", async () => {
    const customer = await prisma.customer.create({
      data: {
        businessId: a.businessId,
        name: "Cancelled subject",
        email: "cancelled@example.invalid",
      },
    });
    const connection = await prisma.channelConnection.create({
      data: { businessId: a.businessId, type: "email", name: "Cancelled fixture" },
    });
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "email",
      connectionId: connection.id,
      payload: {
        text: "Cancelled private payload",
        customerName: "Cancelled subject",
        customerContact: "CANCELLED@EXAMPLE.INVALID",
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "email",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "cancelled",
      },
    });
    const operation = await prisma.deliveryOperation.create({
      data: {
        businessId: a.businessId,
        operationKey: "receipt:" + receipt.id,
        receiptId: receipt.id,
        kind: "inbound",
        channel: "email",
        connectionId: connection.id,
        status: "cancelled",
        recipient: "CANCELLED@EXAMPLE.INVALID",
        response: "Cancelled private response",
        metadata: { privateText: "Cancelled private payload" },
      },
    });
    await deleteCustomerData(a.ctx, customer.id);
    expect(
      (await prisma.inboundEventReceipt.findUniqueOrThrow({ where: { id: receipt.id } }))
        .eventPayload
    ).toEqual({});
    const retired = await prisma.deliveryOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    expect(retired.recipient).toBe("");
    expect(retired.metadata).toEqual({});
    expect(retired.response).toBe("[REDACTED - GDPR]");
    expect(retired.retiredAt).not.toBeNull();
  });
  it.each([
    {
      channel: "email",
      identity: { email: "alice@example.invalid" },
      contact: "Alice@Example.invalid",
    },
    {
      channel: "whatsapp_cloud",
      identity: { whatsapp: "+15550009999@c.us" },
      contact: "15550009999",
    },
  ])(
    "contact-only $channel aliases are retired using customer identity equivalence",
    async ({ channel, identity, contact }) => {
      const customer = await prisma.customer.create({
        data: { businessId: a.businessId, name: "Synthetic alias", ...identity },
      });
      const connection = await prisma.channelConnection.create({
        data: { businessId: a.businessId, type: channel, name: "Alias fixture" },
      });
      const event = buildMessageReceivedEvent({
        businessId: a.businessId,
        channel,
        connectionId: connection.id,
        payload: {
          text: "Private alias event",
          customerName: "Synthetic alias",
          customerContact: contact,
        },
      });
      const receipt = await prisma.inboundEventReceipt.create({
        data: {
          businessId: a.businessId,
          source: channel,
          externalEventId: crypto.randomUUID(),
          eventType: event.type,
          correlationId: event.correlationId,
          eventPayload: JSON.parse(JSON.stringify(event)),
          processingStatus: "enqueued",
        },
      });
      await deleteCustomerData(a.ctx, customer.id);
      const retired = await prisma.inboundEventReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
      });
      expect(retired.processingStatus).toBe("cancelled");
      expect(retired.eventPayload).toEqual({});
      vi.mocked(chat).mockClear();
      await handleProcessInboundMessage(a.ctx, { businessId: a.businessId, receiptId: receipt.id });
      expect(chat).not.toHaveBeenCalled();
      expect(
        await prisma.customer.count({ where: { businessId: a.businessId, ...identity } })
      ).toBe(0);
    }
  );
  it("direct customer identity wins over another customer's normalized phone match", async () => {
    const erased = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Erase only this profile", phone: "+15550008888" },
    });
    const other = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Keep direct identity", whatsapp: "15550008888" },
    });
    const connection = await prisma.channelConnection.create({
      data: {
        businessId: a.businessId,
        type: "whatsapp_cloud",
        name: "Identity precedence fixture",
      },
    });
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "whatsapp_cloud",
      connectionId: connection.id,
      payload: {
        text: "Other customer's pending event",
        customerName: "Keep direct identity",
        customerContact: "15550008888",
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "whatsapp_cloud",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "enqueued",
      },
    });
    await deleteCustomerData(a.ctx, erased.id);
    expect(
      (await prisma.inboundEventReceipt.findUniqueOrThrow({ where: { id: receipt.id } }))
        .processingStatus
    ).toBe("enqueued");
    expect(await prisma.customer.findUnique({ where: { id: other.id } })).not.toBeNull();
  });
  it("retires alias receipts across multiple discovery and update batches", async () => {
    const customer = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Paged subject", email: "paged@example.invalid" },
    });
    const connection = await prisma.channelConnection.create({
      data: { businessId: a.businessId, type: "email", name: "Paged fixture" },
    });
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "email",
      connectionId: connection.id,
      payload: {
        text: "Paged private event",
        customerName: "Paged subject",
        customerContact: "PAGED@EXAMPLE.INVALID",
      },
    });
    const marker = crypto.randomUUID();
    await prisma.inboundEventReceipt.createMany({
      data: Array.from({ length: 121 }, (_, index) => ({
        businessId: a.businessId,
        source: "email",
        externalEventId: marker + ":" + index,
        eventType: event.type,
        correlationId: marker,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "enqueued",
      })),
    });
    await deleteCustomerData(a.ctx, customer.id);
    const rows = await prisma.inboundEventReceipt.findMany({ where: { correlationId: marker } });
    expect(rows).toHaveLength(121);
    expect(
      rows.every(
        (row) =>
          row.processingStatus === "cancelled" &&
          row.retiredAt &&
          JSON.stringify(row.eventPayload) === "{}"
      )
    ).toBe(true);
  });
  it("deleting one thread preserves another receipt for the same visitor and connection", async () => {
    const f = await fixture();
    const other = await prisma.conversation.create({
      data: {
        businessId: a.businessId,
        customerId: f.customer.id,
        channel: "webchat",
        customerContact: "same-thread-visitor",
        metadata: { channelConnectionId: connections[0] },
      },
    });
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "webchat",
      connectionId: connections[0],
      conversationId: other.id,
      payload: {
        text: "Other thread pending text",
        customerName: "Visitor",
        customerContact: "same-thread-visitor",
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "webchat",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "enqueued",
      },
    });
    await prisma.conversation.update({
      where: { id: f.convs[0].id },
      data: { customerContact: "same-thread-visitor" },
    });
    await conversations.remove(a.ctx, f.convs[0].id);
    expect(await prisma.conversation.findUnique({ where: { id: other.id } })).not.toBeNull();
    expect(
      (await prisma.inboundEventReceipt.findUniqueOrThrow({ where: { id: receipt.id } }))
        .processingStatus
    ).toBe("enqueued");
  });
  it("concurrent approval returns one execution and one conflict", async () => {
    const f = await fixture();
    const record = await action(f.convs[0].id, "pending_approval");
    const execute = vi.fn().mockResolvedValue({
      success: true,
      message: "Synthetic approved result",
      status: "succeeded",
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "create_ticket",
      description: "Synthetic approval",
      schema: z.object({}),
      execute,
    });
    let reads = 0,
      release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = scoped.getScopedPrisma;
    const spy = vi.spyOn(scoped, "getScopedPrisma").mockImplementation((ctx) => {
      const db = original(ctx);
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "actionExecution") return Reflect.get(target, property, receiver);
          return new Proxy(db.actionExecution, {
            get(delegate, operation, delegateReceiver) {
              if (operation !== "findUnique")
                return Reflect.get(delegate, operation, delegateReceiver);
              return async (...args: Parameters<typeof delegate.findUnique>) => {
                const found = await delegate.findUnique(...args);
                if (found?.id === record.id && found.status === "pending_approval") {
                  if (++reads === 2) release();
                  await bothRead;
                }
                return found;
              };
            },
          });
        },
      });
    });
    try {
      const outcomes = await Promise.allSettled([
        registry.approve(a.ctx, record.id),
        registry.approve(a.ctx, record.id),
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const denied = outcomes.find((result) => result.status === "rejected");
      expect(denied?.status === "rejected" ? denied.reason : undefined).toMatchObject({
        statusCode: 409,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("does not start a tool retired between recording and execution admission", async () => {
    const f = await fixture();
    const execute = vi
      .fn()
      .mockResolvedValue({ success: true, message: "Must not start", status: "succeeded" });
    const registry = new ToolRegistry();
    registry.register({
      name: "create_ticket",
      description: "Synthetic admission",
      schema: z.object({}),
      execute,
    });
    const original = scoped.getScopedPrisma;
    let erased = false;
    const spy = vi.spyOn(scoped, "getScopedPrisma").mockImplementation((ctx) => {
      const db = original(ctx);
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "actionExecution") return Reflect.get(target, property, receiver);
          return new Proxy(db.actionExecution, {
            get(delegate, operation, delegateReceiver) {
              if (operation !== "create") return Reflect.get(delegate, operation, delegateReceiver);
              return async (...args: Parameters<typeof delegate.create>) => {
                const record = await delegate.create(...args);
                if (!erased) {
                  erased = true;
                  await deleteCustomerData(a.ctx, f.customer.id);
                }
                return record;
              };
            },
          });
        },
      });
    });
    try {
      expect(
        await registry.execute(
          a.ctx,
          "create_ticket",
          {},
          { conversationId: f.convs[0].id, idempotencyKey: crypto.randomUUID() }
        )
      ).toMatchObject({ status: "cancelled" });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it("commits receipt-backed resolution without nested-transaction deadlock", async () => {
    const contact = "admitted-" + crypto.randomUUID();
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "webchat",
      connectionId: connections[0],
      payload: {
        text: "Synthetic admitted event",
        customerName: "Synthetic visitor",
        customerContact: contact,
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "webchat",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "enqueued",
      },
    });
    const { processInboundMessage } = await import("@/lib/conversations/inbound");
    const result = await processInboundMessage(a.ctx, event, { receiptId: receipt.id });
    expect(result.conversationId).toBeTruthy();
    expect(
      await prisma.conversation.findUnique({ where: { id: result.conversationId } })
    ).toMatchObject({ customerContact: contact });
    expect(
      await prisma.deliveryOperation.findFirst({ where: { receiptId: receipt.id } })
    ).toMatchObject({ conversationId: result.conversationId });
  });
  it("erasure during AI preparation rejects its late write and never saves a response", async () => {
    const f = await fixture();
    await prisma.conversation.update({
      where: { id: f.convs[0].id },
      data: { customerContact: "deferred-ai" },
    });
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      conversationId: f.convs[0].id,
      channel: "webchat",
      connectionId: connections[0],
      payload: {
        text: "Private delayed input",
        customerName: "Private visitor",
        customerContact: "deferred-ai",
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "webchat",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "enqueued",
      },
    });
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(chat).mockImplementationOnce(async (ctx, conversationId) => {
      enter();
      await released;
      await getScopedPrisma(ctx).message.create({
        data: {
          businessId: ctx.businessId,
          conversationId,
          role: "assistant",
          content: "Private delayed response",
        },
      });
      return "Private delayed response";
    });
    const { processInboundMessage } = await import("@/lib/conversations/inbound");
    const pending = processInboundMessage(a.ctx, event, { receiptId: receipt.id });
    const outcome = pending.then(
      () => false,
      () => true
    );
    await entered;
    try {
      await deleteCustomerData(a.ctx, f.customer.id);
    } finally {
      finish();
    }
    expect(await outcome).toBe(true);
    expect(await prisma.message.count({ where: { conversationId: f.convs[0].id } })).toBe(0);
    const operation = await prisma.deliveryOperation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });
    expect(operation.status).toBe("cancelled");
    expect(operation.response).toBe("[REDACTED - GDPR]");
  });
  it("rejects new transcript writes after soft erasure", async () => {
    const f = await fixture();
    await deleteCustomerData(a.ctx, f.customer.id);
    await expect(
      getScopedPrisma(a.ctx).message.create({
        data: {
          businessId: a.businessId,
          conversationId: f.convs[0].id,
          role: "assistant",
          content: "Cached private response after erasure",
        },
      })
    ).rejects.toThrow();
    expect(await prisma.message.count({ where: { conversationId: f.convs[0].id } })).toBe(0);
  });
  it("discards a deferred tool result and its private activity after erasure", async () => {
    const f = await fixture();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "create_ticket",
      description: "Synthetic deferred completion",
      schema: z.object({}),
      async execute() {
        enter();
        await released;
        return {
          success: true,
          message: "Private deferred result",
          data: { contact: "Private deferred result" },
          status: "succeeded",
        };
      },
    });
    const pending = registry.execute(
      a.ctx,
      "create_ticket",
      {},
      {
        conversationId: f.convs[0].id,
        idempotencyKey: crypto.randomUUID(),
      }
    );
    await entered;
    try {
      await deleteCustomerData(a.ctx, f.customer.id);
    } finally {
      finish();
    }
    expect(await pending).toMatchObject({ status: "cancelled" });
    const record = await prisma.actionExecution.findFirstOrThrow({
      where: { conversationId: f.convs[0].id },
    });
    expect(record.status).toBe("cancelled");
    expect(record.result).toEqual({});
    expect(
      await prisma.activityLog.count({
        where: { entityId: record.id, description: { contains: "Private deferred result" } },
      })
    ).toBe(0);
  });
  it("a cached erased receipt cannot create a new unbound delivery operation", async () => {
    const contact = "cached-erased-" + crypto.randomUUID();
    const customer = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Pending contact", phone: contact },
    });
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "webchat",
      connectionId: connections[0],
      payload: {
        text: "Private cached event",
        customerName: "Pending contact",
        customerContact: contact,
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "webchat",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "enqueued",
      },
    });
    await deleteCustomerData(a.ctx, customer.id);
    const { processInboundMessage } = await import("@/lib/conversations/inbound");
    await expect(processInboundMessage(a.ctx, event, { receiptId: receipt.id })).rejects.toThrow();
    expect(await prisma.deliveryOperation.count({ where: { receiptId: receipt.id } })).toBe(0);
    expect(
      await prisma.conversation.count({
        where: { businessId: a.businessId, customerContact: contact },
      })
    ).toBe(0);
  });
  it("erases contact-only receipts and operations before a conversation exists", async () => {
    const contact = "contact-only-" + crypto.randomUUID();
    const customer = await prisma.customer.create({
      data: {
        businessId: a.businessId,
        name: "Private contact",
        whatsapp: contact,
      },
    });
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "webchat",
      connectionId: connections[0],
      payload: {
        text: "Private pending text",
        customerName: "Private contact",
        customerContact: contact,
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "webchat",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "enqueued",
      },
    });
    const operation = await prisma.deliveryOperation.create({
      data: {
        businessId: a.businessId,
        operationKey: "receipt:" + receipt.id,
        kind: "inbound",
        channel: "webchat",
        connectionId: connections[0],
        receiptId: receipt.id,
        recipient: contact,
        metadata: { privateText: "Private pending text" },
        status: "preparing",
      },
    });
    await deleteCustomerData(a.ctx, customer.id);
    expect(
      await prisma.inboundEventReceipt.findUnique({ where: { id: receipt.id } })
    ).toMatchObject({ processingStatus: "cancelled", eventPayload: {} });
    const retired = await prisma.deliveryOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    expect(retired.status).toBe("cancelled");
    expect(retired.recipient).toBe("");
    expect(retired.metadata).toEqual({});
  });
  it("retention retires action work and deletes the conversation atomically", async () => {
    const f = await fixture(),
      pending = await action(f.convs[0].id);
    await prisma.conversation.update({
      where: { id: f.convs[0].id },
      data: {
        status: "closed",
        updatedAt: new Date("2020-01-01"),
      },
    });
    const message = await prisma.message.create({
      data: {
        businessId: a.businessId,
        conversationId: f.convs[0].id,
        role: "customer",
        content: "Retained private text",
      },
    });
    const result = await applyRetentionPolicy(a.ctx, 30);
    expect(result).toMatchObject({ conversationsDeleted: 1, messagesDeleted: 1 });
    expect(await prisma.message.findUnique({ where: { id: message.id } })).toBeNull();
    expect(await prisma.conversation.findUnique({ where: { id: f.convs[0].id } })).toBeNull();
    const retired = await prisma.actionExecution.findUniqueOrThrow({ where: { id: pending.id } });
    expect(retired).toMatchObject({ status: "cancelled", conversationId: null });
    expect(retired.input).toEqual({});
  });
  it("restricted profile write does not authorize whole-customer erasure across connections", async () => {
    const f = await fixture();
    const ctx = {
      ...a.ctx,
      resourceScope: {
        kind: "connections" as const,
        connectionIds: [connections[0]],
        customerProfileAccess: "write" as const,
      },
    };
    await expect(deleteCustomerData(ctx, f.customer.id, true)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(
      await prisma.conversation.count({ where: { id: { in: f.convs.map((c) => c.id) } } })
    ).toBe(2);
  });
  it("conversation deletion cancels pending action work, clears its data/reference and leaves other connection intact", async () => {
    const f = await fixture(),
      pending = await action(f.convs[0].id),
      other = await action(f.convs[1].id);
    const ctx = {
      ...a.ctx,
      resourceScope: {
        kind: "connections" as const,
        connectionIds: [connections[0]],
        customerProfileAccess: "none" as const,
      },
    };
    await conversations.remove(ctx, f.convs[0].id);
    const retired = await prisma.actionExecution.findUniqueOrThrow({ where: { id: pending.id } });
    expect(retired.input).toEqual({});
    expect(retired.result).toEqual({});
    expect(retired).toMatchObject({
      status: "cancelled",
      conversationId: null,
      input: {},
      result: {},
    });
    expect(await prisma.actionExecution.findUnique({ where: { id: other.id } })).toMatchObject({
      status: "scheduled",
      conversationId: f.convs[1].id,
    });
  });
  it("GDPR anonymization redacts all related action payloads while retaining completed effects status", async () => {
    const f = await fixture(),
      completed = await action(f.convs[0].id, "succeeded");
    await deleteCustomerData(a.ctx, f.customer.id, false);
    const retired = await prisma.actionExecution.findUniqueOrThrow({ where: { id: completed.id } });
    expect(retired.input).toEqual({});
    expect(retired.result).toEqual({});
    expect(retired).toMatchObject({
      status: "succeeded",
      input: {},
      result: {},
    });
  });
  it("soft erasure also removes private media, notes, ticket text and conversation summaries", async () => {
    const f = await fixture(),
      id = f.convs[0].id;
    await prisma.conversation.update({
      where: { id },
      data: {
        summary: "Private summary",
        metadata: {
          channelConnectionId: connections[0],
          privateContact: "Private summary",
        },
      },
    });
    const message = await prisma.message.create({
      data: {
        businessId: a.businessId,
        conversationId: id,
        role: "customer",
        content: "Private message",
        mediaUrl: "https://example.invalid/private-media",
        mediaType: "image",
        toolCalls: { privateArgument: "Private message" },
      },
    });
    await prisma.internalNote.create({
      data: { businessId: a.businessId, conversationId: id, content: "Private internal note" },
    });
    const ticket = await prisma.ticket.create({
      data: {
        businessId: a.businessId,
        conversationId: id,
        title: "Private title",
        description: "Private description",
        resolution: "Private resolution",
      },
    });
    await deleteCustomerData(a.ctx, f.customer.id);
    expect(await prisma.message.findUnique({ where: { id: message.id } })).toMatchObject({
      content: "[REDACTED - GDPR]",
      mediaUrl: null,
      mediaType: null,
    });
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toolCalls
    ).toEqual({});
    expect(await prisma.internalNote.count({ where: { conversationId: id } })).toBe(0);
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      title: "[REDACTED - GDPR]",
      description: "[REDACTED - GDPR]",
      resolution: "",
    });
    const shell = await prisma.conversation.findUniqueOrThrow({ where: { id } });
    expect(shell.summary).toBe("");
    expect(shell.metadata).toEqual({ channelConnectionId: connections[0] });
  });
  it("erasure removes private bound activity content while retaining actor and decision", async () => {
    const f = await fixture(),
      completed = await action(f.convs[0].id, "succeeded");
    const audit = await prisma.activityLog.create({
      data: {
        businessId: a.businessId,
        action: "tool.succeeded",
        entity: "action",
        entityId: completed.id,
        userId: a.ownerUserId,
        userName: "Actual actor",
        description: "Private cached result",
        metadata: {
          actorId: a.ownerUserId,
          decision: "confirmed",
          privateResult: "Private cached result",
        },
      },
    });
    await deleteCustomerData(a.ctx, f.customer.id, true);
    const retained = await prisma.activityLog.findUniqueOrThrow({ where: { id: audit.id } });
    expect(retained).toMatchObject({
      userId: a.ownerUserId,
      userName: "Actual actor",
      action: "tool.succeeded",
      description: "[REDACTED - GDPR]",
    });
    expect(retained.metadata).toEqual({ actorId: a.ownerUserId, decision: "confirmed" });
  });
  it("full customer erasure clears action references without claiming completed effects were undone", async () => {
    const f = await fixture(),
      completed = await action(f.convs[0].id, "succeeded");
    await deleteCustomerData(a.ctx, f.customer.id, true);
    const retired = await prisma.actionExecution.findUniqueOrThrow({ where: { id: completed.id } });
    expect(retired.input).toEqual({});
    expect(retired.result).toEqual({});
    expect(retired).toMatchObject({
      status: "succeeded",
      conversationId: null,
      input: {},
      result: {},
    });
  });
  it("hard deletion tombstones cached inbound work so a retry cannot restore erased data", async () => {
    const f = await fixture();
    const event = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "webchat",
      connectionId: connections[0],
      conversationId: f.convs[0].id,
      payload: {
        text: "Cached private text",
        customerName: "Private visitor",
        customerContact: "private-visitor",
      },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: a.businessId,
        source: "webchat",
        externalEventId: crypto.randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        eventPayload: JSON.parse(JSON.stringify(event)),
        processingStatus: "failed",
      },
    });
    await prisma.deliveryOperation.create({
      data: {
        businessId: a.businessId,
        operationKey: "receipt:" + receipt.id,
        kind: "inbound",
        channel: "webchat",
        connectionId: connections[0],
        conversationId: f.convs[0].id,
        receiptId: receipt.id,
        recipient: "private-visitor",
        status: "preparation_interrupted",
      },
    });
    await deleteCustomerData(a.ctx, f.customer.id, true);
    const retired = await prisma.inboundEventReceipt.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    expect(retired.processingStatus).toBe("cancelled");
    expect(retired.eventPayload).toEqual({});
    vi.mocked(chat).mockClear();
    await handleProcessInboundMessage(a.ctx, { businessId: a.businessId, receiptId: receipt.id });
    expect(chat).not.toHaveBeenCalled();
    expect(await prisma.conversation.findUnique({ where: { id: f.convs[0].id } })).toBeNull();
  });
});
