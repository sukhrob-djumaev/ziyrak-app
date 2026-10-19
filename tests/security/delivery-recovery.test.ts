import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { ensureDelivery, recoverDelivery, dispatchDelivery } from "@/lib/conversations/delivery";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { createAuthenticatedRequest, createRequest } from "../helpers/request";
import { generateToken } from "@/lib/identity/auth";
import { deleteCustomerData } from "@/lib/customers/gdpr";
import { GET } from "@/app/api/deliveries/route";
import { POST } from "@/app/api/deliveries/[id]/recover/route";
let a: SeededBusiness, b: SeededBusiness;
let conversationId: string, connectionId: string;
beforeAll(async () => {
  a = await seedBusiness("delivery-security-a");
  b = await seedBusiness("delivery-security-b");
  const conn = await prisma.channelConnection.create({
    data: {
      businessId: a.businessId,
      type: "security_delivery",
      name: "A channel",
      isActive: true,
    },
  });
  connectionId = conn.id;
  const conv = await prisma.conversation.create({
    data: {
      businessId: a.businessId,
      channel: "security_delivery",
      customerContact: "synthetic-recipient",
      metadata: { channelConnectionId: conn.id },
    },
  });
  conversationId = conv.id;
});
afterAll(async () => {
  if (a) await cleanupBusiness(a.businessId);
  if (b) await cleanupBusiness(b.businessId);
});
async function uncertain() {
  const op = await ensureDelivery(a.ctx, {
    operationKey: randomUUID(),
    kind: "followup",
    conversationId,
    channel: "security_delivery",
    connectionId,
    recipient: "synthetic-recipient",
    response: "Saved reply",
  });
  return prisma.deliveryOperation.update({ where: { id: op.id }, data: { status: "unknown" } });
}
describe("delivery recovery permission and tenant boundaries", () => {
  it("refuses unauthenticated listing and recovery", async () => {
    expect((await GET(createRequest("/api/deliveries"))).status).toBe(401);
    expect(
      (
        await POST(createRequest("/api/deliveries/x/recover", { method: "POST", body: {} }), {
          params: Promise.resolve({ id: "x" }),
        })
      ).status
    ).toBe(401);
  });
  it("cannot list, read, update, dispatch or recover another tenant's operation", async () => {
    const op = await uncertain();
    const scoped = getScopedPrisma(b.ctx);
    const listed = await GET(
      createAuthenticatedRequest("/api/deliveries", generateToken(b.ownerUserId))
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(op.id);

    expect(await scoped.deliveryOperation.findUnique({ where: { id: op.id } })).toBeNull();
    expect((await scoped.deliveryOperation.findMany()).some((row) => row.id === op.id)).toBe(false);
    expect(
      (
        await scoped.deliveryOperation.updateMany({
          where: { id: op.id },
          data: { status: "ready" },
        })
      ).count
    ).toBe(0);
    await expect(dispatchDelivery(b.ctx, op.id)).rejects.toThrow();
    const req = createAuthenticatedRequest(
      "/api/deliveries/" + op.id + "/recover",
      generateToken(b.ownerUserId),
      {
        method: "POST",
        body: { decision: "cancel", reason: "Review completed safely", requestId: randomUUID() },
      }
    );
    expect((await POST(req, { params: Promise.resolve({ id: op.id }) })).status).toBe(404);
    expect(
      (await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } })).status
    ).toBe("unknown");
  });
  it("enforces current membership permissions on actual recovery routes", async () => {
    const op = await uncertain();
    const membership = await prisma.membership.findFirstOrThrow({
      where: { businessId: a.businessId, userId: a.ownerUserId },
    });
    const token = generateToken(a.ownerUserId);
    const request = () =>
      createAuthenticatedRequest("/api/deliveries/" + op.id + "/recover", token, {
        method: "POST",
        body: {
          decision: "cancel",
          reason: "Current permissions checked",
          requestId: randomUUID(),
        },
      });
    try {
      await prisma.membership.update({ where: { id: membership.id }, data: { role: "viewer" } });
      expect((await POST(request(), { params: Promise.resolve({ id: op.id }) })).status).toBe(403);
      await prisma.membership.delete({ where: { id: membership.id } });
      expect((await POST(request(), { params: Promise.resolve({ id: op.id }) })).status).toBe(403);
      expect((await GET(createAuthenticatedRequest("/api/deliveries", token))).status).toBe(403);
      expect(
        (await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } })).status
      ).toBe("unknown");
    } finally {
      await prisma.membership.upsert({
        where: { id: membership.id },
        create: membership,
        update: { role: membership.role },
      });
    }
  });
  it("database rejects cross-tenant conversation, receipt and action references", async () => {
    const foreignConv = await prisma.conversation.create({
      data: { businessId: b.businessId, channel: "security_delivery" },
    });
    const receipt = await prisma.inboundEventReceipt.create({
      data: {
        businessId: b.businessId,
        source: "security_delivery",
        externalEventId: randomUUID(),
        eventType: "message.received",
        correlationId: randomUUID(),
      },
    });
    const action = await prisma.actionExecution.create({
      data: {
        businessId: b.businessId,
        tool: "schedule_followup",
        input: {},
        requestedBy: "system",
        idempotencyKey: randomUUID(),
      },
    });
    for (const foreign of [
      { conversationId: foreignConv.id },
      { receiptId: receipt.id },
      { actionId: action.id },
    ])
      await expect(
        prisma.deliveryOperation.create({
          data: {
            businessId: a.businessId,
            operationKey: randomUUID(),
            kind: "inbound",
            channel: "security_delivery",
            connectionId,
            recipient: "synthetic",
            ...foreign,
          },
        })
      ).rejects.toThrow(/foreign key/i);
  });
  it("denies viewer and non-human recovery even with a valid workspace context", async () => {
    const op = await uncertain();
    const input = { decision: "cancel" as const, reason: "Reviewed", requestId: randomUUID() };
    await expect(recoverDelivery({ ...a.ctx, role: "viewer" }, op.id, input)).rejects.toMatchObject(
      { statusCode: 403 }
    );
    await expect(
      recoverDelivery({ ...a.ctx, actor: { kind: "system_job", jobId: "test-job" } }, op.id, input)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("requires duplication acknowledgment and prevents body/destination overrides", async () => {
    const op = await uncertain();
    const token = generateToken(a.ownerUserId);
    const req = (body: Record<string, unknown>) =>
      createAuthenticatedRequest("/api/deliveries/" + op.id + "/recover", token, {
        method: "POST",
        body,
      });
    const base = {
      decision: "resend",
      reason: "Provider outcome reviewed",
      requestId: randomUUID(),
    };
    expect((await POST(req(base), { params: Promise.resolve({ id: op.id }) })).status).toBe(400);
    expect(
      (
        await POST(
          req({
            ...base,
            acknowledgeDuplicateRisk: true,
            response: "Override",
            recipient: "someone-else",
          }),
          { params: Promise.resolve({ id: op.id }) }
        )
      ).status
    ).toBe(400);
    expect(
      (await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } })).status
    ).toBe("unknown");
  });
  it("erases cached delivery PII and stops unresolved replies during customer anonymization", async () => {
    const customer = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Synthetic private customer", phone: "+15550009999" },
    });
    const conv = await prisma.conversation.create({
      data: {
        businessId: a.businessId,
        customerId: customer.id,
        channel: "security_delivery",
        customerContact: "+15550009999",
        metadata: { channelConnectionId: connectionId },
      },
    });
    const op = await ensureDelivery(a.ctx, {
      operationKey: randomUUID(),
      kind: "followup",
      conversationId: conv.id,
      channel: "security_delivery",
      connectionId,
      recipient: "+15550009999",
      response: "Synthetic private reply",
    });
    await prisma.deliveryOperation.update({ where: { id: op.id }, data: { status: "unknown" } });
    await deleteCustomerData(a.ctx, customer.id);
    const saved = await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(saved.response).toBe("[REDACTED - GDPR]");
    expect(saved.recipient).toBe("");
    expect(saved.status).toBe("cancelled");
  });
  it("makes concurrent decisions compare-and-set and durably audits the real actor", async () => {
    const op = await uncertain();
    const results = await Promise.allSettled([
      recoverDelivery(a.ctx, op.id, {
        decision: "cancel",
        reason: "First operator",
        requestId: randomUUID(),
      }),
      recoverDelivery(a.ctx, op.id, {
        decision: "confirm_accepted",
        reason: "Verified provider acceptance",
        requestId: randomUUID(),
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const saved = await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(["cancelled", "accepted"]).toContain(saved.status);
    const audit = await prisma.activityLog.findMany({
      where: { businessId: a.businessId, entityId: op.id, action: "delivery.recovered" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(a.ownerUserId);
  });
});
