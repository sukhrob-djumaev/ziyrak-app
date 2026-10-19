import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import type { TenantContext } from "@/lib/tenancy/context";
let a: SeededBusiness, b: SeededBusiness;
beforeEach(async () => {
  a = await seedBusiness("provider-a");
  b = await seedBusiness("provider-b");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
  await prisma.user.deleteMany({ where: { id: { in: [a.ownerUserId, b.ownerUserId] } } });
});
async function fixture() {
  const connection = await prisma.channelConnection.create({
    data: {
      businessId: a.businessId,
      type: "webchat",
      name: "Synthetic provider source",
      isActive: true,
    },
  });
  const otherConnection = await prisma.channelConnection.create({
    data: {
      businessId: a.businessId,
      type: "webchat",
      name: "Other same-type source",
      isActive: true,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      businessId: a.businessId,
      channel: "webchat",
      customerContact: "synthetic-visitor",
      metadata: { channelConnectionId: connection.id },
    },
  });
  const event = buildMessageReceivedEvent({
    businessId: a.businessId,
    channel: "webchat",
    connectionId: connection.id,
    externalId: randomUUID(),
    conversationId: conversation.id,
    payload: {
      text: "Synthetic request",
      customerName: "Synthetic",
      customerContact: conversation.customerContact,
    },
  });
  const receipt = await prisma.inboundEventReceipt.create({
    data: {
      businessId: a.businessId,
      source: event.source.channel,
      externalEventId: event.source.externalId!,
      eventType: event.type,
      correlationId: event.correlationId,
      eventPayload: JSON.parse(JSON.stringify(event)),
    },
  });
  const delivery = await prisma.deliveryOperation.create({
    data: {
      businessId: a.businessId,
      operationKey: "receipt:" + receipt.id,
      kind: "inbound",
      receiptId: receipt.id,
      conversationId: conversation.id,
      connectionId: connection.id,
      channel: "webchat",
      recipient: conversation.customerContact,
      status: "preparing",
    },
  });
  const target = { conversationId: conversation.id, connectionId: connection.id };
  const ctx: TenantContext = {
    businessId: a.businessId,
    role: null,
    actor: { kind: "ai_agent", conversationId: conversation.id, model: "stand-in" },
    dataConnection: "shared-default",
    resourceScope: { kind: "workspace", customerProfileAccess: "write" },
    workBinding: {
      conversationId: conversation.id,
      receiptId: receipt.id,
      deliveryOperationId: delivery.id,
    },
  };
  const worker: TenantContext = {
    ...ctx,
    actor: { kind: "system_job", jobId: randomUUID(), jobType: "send-followup" },
  };
  return {
    connection,
    otherConnection,
    conversation,
    event,
    receipt,
    delivery,
    target,
    ctx,
    worker,
  };
}
const api = () => import("@/lib/tenancy/deferred-provider-origin");
describe("explicit deferred provider lineage, real isolated Postgres; no adapter call", () => {
  it("captures the real preparing/received lifecycle and refreshes despite unrelated member removal or uncertain inbound reply", async () => {
    const { captureDeferredProvider, refreshDeferredProvider } = await api(),
      x = await fixture();
    const saved = await captureDeferredProvider(x.ctx, x.target);
    expect(saved).toEqual({
      version: 1,
      businessId: a.businessId,
      origin: {
        kind: "provider_inbound",
        receiptId: x.receipt.id,
        deliveryOperationId: x.delivery.id,
        ...x.target,
      },
    });
    await prisma.membership.deleteMany({
      where: { businessId: a.businessId, userId: a.ownerUserId },
    });
    for (const [processingStatus, status] of [
      ["received", "sending"],
      ["needs_review", "unknown"],
      ["failed", "preparation_interrupted"],
      ["failed", "rejected"],
      ["processed", "accepted"],
    ]) {
      await prisma.inboundEventReceipt.update({
        where: { id: x.receipt.id },
        data: { processingStatus },
      });
      await prisma.deliveryOperation.update({ where: { id: x.delivery.id }, data: { status } });
      expect(await refreshDeferredProvider(x.worker, saved, x.target)).toEqual(saved);
    }
  });
  it("never infers provider origin from a bare AI actor or falls back after a human/support origin", async () => {
    const { captureDeferredProvider } = await api(),
      x = await fixture();
    const member = await prisma.membership.findFirstOrThrow({
      where: { businessId: a.businessId, userId: a.ownerUserId },
    });
    for (const ctx of [
      { ...x.ctx, workBinding: undefined },
      {
        ...x.ctx,
        authorization: {
          kind: "membership" as const,
          userId: a.ownerUserId,
          membershipId: member.id,
        },
      },
      {
        ...x.ctx,
        authorization: {
          kind: "support" as const,
          userId: a.ownerUserId,
          grantId: randomUUID(),
          allowedOperations: ["messages:read"],
        },
      },
      { ...x.ctx, actor: { kind: "user" as const, userId: a.ownerUserId } },
    ])
      await expect(captureDeferredProvider(ctx, x.target)).rejects.toMatchObject({
        statusCode: 403,
      });
  });
  it("rejects wrong receipt/delivery/work/AI parents and same-type connection substitution", async () => {
    const { captureDeferredProvider, refreshDeferredProvider } = await api(),
      x = await fixture(),
      saved = await captureDeferredProvider(x.ctx, x.target);
    for (const binding of [
      { receiptId: randomUUID() },
      { deliveryOperationId: randomUUID() },
      { conversationId: randomUUID() },
    ])
      await expect(
        captureDeferredProvider(
          { ...x.ctx, workBinding: { ...x.ctx.workBinding, ...binding } },
          x.target
        )
      ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      captureDeferredProvider(
        { ...x.ctx, actor: { kind: "ai_agent", conversationId: randomUUID(), model: "stand-in" } },
        x.target
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      refreshDeferredProvider(x.worker, saved, { ...x.target, connectionId: x.otherConnection.id })
    ).rejects.toMatchObject({ statusCode: 403 });
    await prisma.deliveryOperation.update({
      where: { id: x.delivery.id },
      data: { connectionId: x.otherConnection.id },
    });
    await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("rejects forged envelope linkage, contacts, event type and correlation without accepting arbitrary receipt rows", async () => {
    const { captureDeferredProvider, refreshDeferredProvider } = await api(),
      x = await fixture(),
      saved = await captureDeferredProvider(x.ctx, x.target);
    for (const event of [
      { ...x.event, businessId: b.businessId },
      { ...x.event, type: "not.message" },
      { ...x.event, correlationId: randomUUID() },
      { ...x.event, conversationId: randomUUID() },
      { ...x.event, source: { ...x.event.source, externalId: randomUUID() } },
      { ...x.event, source: { ...x.event.source, connectionId: x.otherConnection.id } },
      { ...x.event, payload: { ...x.event.payload, customerContact: "other-visitor" } },
    ]) {
      await prisma.inboundEventReceipt.update({
        where: { id: x.receipt.id },
        data: { eventPayload: JSON.parse(JSON.stringify(event)) },
      });
      await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
        statusCode: 403,
      });
    }
  });
  it("rejects delivery classification, operation key, recipient and unknown states", async () => {
    const { captureDeferredProvider, refreshDeferredProvider } = await api(),
      x = await fixture(),
      saved = await captureDeferredProvider(x.ctx, x.target);
    for (const changes of [
      { kind: "followup" },
      { operationKey: "event:legacy" },
      { recipient: "other-visitor" },
      { status: "future-unknown" },
      { status: "cancelled" },
    ]) {
      await prisma.deliveryOperation.update({ where: { id: x.delivery.id }, data: changes });
      await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
        statusCode: 403,
      });
      await prisma.deliveryOperation.update({
        where: { id: x.delivery.id },
        data: {
          kind: "inbound",
          operationKey: "receipt:" + x.receipt.id,
          recipient: x.conversation.customerContact,
          status: "preparing",
        },
      });
    }
    await prisma.inboundEventReceipt.update({
      where: { id: x.receipt.id },
      data: { processingStatus: "future-unknown" },
    });
    await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("rejects retired/cancelled resources, inactive connection/workspace and missing ownership stamp", async () => {
    const { captureDeferredProvider, refreshDeferredProvider } = await api(),
      x = await fixture(),
      saved = await captureDeferredProvider(x.ctx, x.target);
    for (const model of [
      prisma.inboundEventReceipt,
      prisma.deliveryOperation,
      prisma.conversation,
    ]) {
      const id =
        model === prisma.inboundEventReceipt
          ? x.receipt.id
          : model === prisma.deliveryOperation
            ? x.delivery.id
            : x.conversation.id;
      await model.update({ where: { id }, data: { retiredAt: new Date() } });
      await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
        statusCode: 403,
      });
      await model.update({ where: { id }, data: { retiredAt: null } });
    }
    await prisma.inboundEventReceipt.update({
      where: { id: x.receipt.id },
      data: { processingStatus: "cancelled" },
    });
    await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.inboundEventReceipt.update({
      where: { id: x.receipt.id },
      data: { processingStatus: "received" },
    });
    await prisma.channelConnection.update({
      where: { id: x.connection.id },
      data: { isActive: false },
    });
    await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.channelConnection.update({
      where: { id: x.connection.id },
      data: { isActive: true },
    });
    await prisma.conversation.update({ where: { id: x.conversation.id }, data: { metadata: {} } });
    await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.conversation.update({
      where: { id: x.conversation.id },
      data: { metadata: { channelConnectionId: x.connection.id } },
    });
    await prisma.business.update({ where: { id: a.businessId }, data: { status: "suspended" } });
    await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("rejects strict snapshot corruption and foreign workspace references", async () => {
    const { captureDeferredProvider, refreshDeferredProvider } = await api(),
      x = await fixture(),
      saved = await captureDeferredProvider(x.ctx, x.target);
    for (const input of [
      null,
      {},
      { ...saved, version: 2 },
      { ...saved, businessId: b.businessId },
      { ...saved, role: "owner" },
      { ...saved, origin: { ...saved.origin, token: "not-allowed" } },
    ])
      await expect(refreshDeferredProvider(x.worker, input, x.target)).rejects.toMatchObject({
        statusCode: 403,
      });
    await expect(
      refreshDeferredProvider({ ...x.worker, businessId: b.businessId }, saved, x.target)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("provider capture and worker refresh boundaries", () => {
  it("accepts an authenticated normalized envelope without a pre-existing conversation locator", async () => {
    const { captureDeferredProvider } = await api(),
      x = await fixture();
    const event = { ...x.event };
    delete event.conversationId;
    await prisma.inboundEventReceipt.update({
      where: { id: x.receipt.id },
      data: { eventPayload: JSON.parse(JSON.stringify(event)) },
    });
    expect((await captureDeferredProvider(x.ctx, x.target)).origin.conversationId).toBe(
      x.conversation.id
    );
  });
  it("requires worker-only refresh, preparing-only capture and an inbound delivery without action lineage", async () => {
    const { captureDeferredProvider, refreshDeferredProvider } = await api(),
      x = await fixture(),
      saved = await captureDeferredProvider(x.ctx, x.target);
    for (const ctx of [
      x.ctx,
      { ...x.worker, role: "owner" },
      {
        ...x.worker,
        authorization: {
          kind: "membership" as const,
          userId: a.ownerUserId,
          membershipId: "not-worker",
        },
      },
      {
        ...x.worker,
        authorization: {
          kind: "delegated_job" as const,
          allowedOperations: ["messages:create"],
          origin: { kind: "api_key" as const, apiKeyId: "not-provider" },
        },
      },
    ])
      await expect(refreshDeferredProvider(ctx, saved, x.target)).rejects.toMatchObject({
        statusCode: 403,
      });
    await prisma.deliveryOperation.update({
      where: { id: x.delivery.id },
      data: { status: "sending" },
    });
    await expect(captureDeferredProvider(x.ctx, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await refreshDeferredProvider(x.worker, saved, x.target)).toEqual(saved);
    const action = await prisma.actionExecution.create({
      data: {
        businessId: a.businessId,
        conversationId: x.conversation.id,
        tool: "schedule_followup",
        input: {},
        requestedBy: "synthetic",
        idempotencyKey: randomUUID(),
      },
    });
    await prisma.deliveryOperation.update({
      where: { id: x.delivery.id },
      data: { status: "preparing", actionId: action.id },
    });
    await expect(refreshDeferredProvider(x.worker, saved, x.target)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
