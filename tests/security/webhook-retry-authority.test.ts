import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/integrations/http-dispatcher", () => ({
  dispatchHttpRequest: vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" })),
}));
import { prisma } from "@/lib/prisma/raw-client";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";
import { jobQueue } from "@/lib/jobs/queue";
import { DELIVER_WEBHOOK_JOB, type DeliverWebhookPayload } from "@/lib/jobs/job-types";
import { handleDeliverWebhook } from "@/lib/jobs/handlers/deliver-webhook";
import { generateToken, verifyToken, revokeToken } from "@/lib/identity/auth";
import { retryDelivery } from "@/lib/integrations/webhook-delivery";
import { dispatchHttpRequest } from "@/lib/integrations/http-dispatcher";

/**
 * P1 manual webhook retry: the person who asks for a retry is saved with the job and rechecked
 * when the worker runs, so a queued retry cannot outlive that person's authority. Deliveries
 * queued by the system itself carry no requester and are unchanged.
 */
let a: SeededBusiness;
let queued: DeliverWebhookPayload[];
let webhookId: string;
let deliveryId: string;

beforeEach(async () => {
  a = await seedBusiness("webhook-retry");
  queued = [];
  vi.mocked(dispatchHttpRequest).mockClear();
  vi.spyOn(jobQueue, "enqueue").mockImplementation(async (type, payload) => {
    if (type === DELIVER_WEBHOOK_JOB) queued.push(payload as DeliverWebhookPayload);
    return "paused-webhook-fixture";
  });
  const webhook = await prisma.webhook.create({
    data: {
      businessId: a.businessId,
      name: "Synthetic hook",
      url: "https://example.invalid/hook",
      triggerOn: "ticket.created",
    },
  });
  webhookId = webhook.id;
  deliveryId = (
    await prisma.webhookDelivery.create({
      data: {
        businessId: a.businessId,
        webhookId,
        event: "ticket.created",
        payload: { synthetic: true },
        status: "failed",
        attempts: 3,
      },
    })
  ).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBusiness(a.businessId);
});

const worker = (): TenantContext => ({
  businessId: a.businessId,
  role: null,
  actor: { kind: "system_job", jobId: randomUUID(), jobType: DELIVER_WEBHOOK_JOB },
  dataConnection: "shared-default",
});
const delivery = () => prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });

describe("P1 manual webhook retry: requester authority", () => {
  it("saves the requester with the queued job and sends when they still hold authority", async () => {
    const admin = await addMember(a.businessId, "admin", "webhook-retrier");
    expect(await retryDelivery(admin.ctx, deliveryId)).toBe(true);
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued[0])).toContain(admin.userId);
    await handleDeliverWebhook(worker(), queued[0]);
    expect(dispatchHttpRequest).toHaveBeenCalledTimes(1);
    expect((await delivery()).status).toBe("delivered");
  });

  for (const [label, change] of [
    [
      "removed membership",
      (userId: string) =>
        prisma.membership.deleteMany({ where: { businessId: a.businessId, userId } }),
    ],
    [
      "demotion below webhooks:update",
      (userId: string) =>
        prisma.membership.updateMany({
          where: { businessId: a.businessId, userId },
          data: { role: "agent" },
        }),
    ],
    [
      "restriction to specific channels",
      async (userId: string) => {
        const connection = await prisma.channelConnection.create({
          data: { businessId: a.businessId, type: "test-webhook", name: "Line", isActive: true },
        });
        const m = await prisma.membership.findFirstOrThrow({
          where: { businessId: a.businessId, userId },
        });
        await prisma.membership.update({ where: { id: m.id }, data: { scopeMode: "connections" } });
        await prisma.membershipConnectionScope.create({
          data: { businessId: a.businessId, membershipId: m.id, connectionId: connection.id },
        });
      },
    ],
  ] as const) {
    it(`makes no request after ${label} between the retry and the worker`, async () => {
      const admin = await addMember(a.businessId, "admin", "webhook-retrier");
      await retryDelivery(admin.ctx, deliveryId);
      await change(admin.userId);
      await handleDeliverWebhook(worker(), queued[0]);
      expect(dispatchHttpRequest).not.toHaveBeenCalled();
      const row = await delivery();
      expect(row.status).toBe("failed");
      expect(row.lastError).toMatch(/no longer authorized/i);
    });
  }

  it("does not change deliveries queued by the system (no requester)", async () => {
    await handleDeliverWebhook(worker(), { businessId: a.businessId, webhookId, deliveryId });
    expect(dispatchHttpRequest).toHaveBeenCalledTimes(1);
    expect((await delivery()).status).toBe("delivered");
  });

  it("refuses a retry requested without a signed-in authorized person", async () => {
    await expect(retryDelivery(worker(), deliveryId)).rejects.toMatchObject({ statusCode: 403 });
    expect(queued).toHaveLength(0);
  });

  it("leaves the delivery untouched when the requester's identity cannot be saved", async () => {
    const admin = await addMember(a.businessId, "admin", "webhook-retrier");
    const broken: TenantContext = { ...admin.ctx, authorization: undefined };
    await expect(retryDelivery(broken, deliveryId)).rejects.toBeDefined();
    const row = await delivery();
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(queued).toHaveLength(0);
  });

  it("restores the delivery when the retry cannot be queued", async () => {
    const admin = await addMember(a.businessId, "admin", "webhook-retrier");
    vi.mocked(jobQueue.enqueue).mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(retryDelivery(admin.ctx, deliveryId)).rejects.toThrow("queue unavailable");
    const row = await delivery();
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
  });

  it("a denied retry job never overwrites a delivery that already succeeded", async () => {
    const admin = await addMember(a.businessId, "admin", "webhook-retrier");
    await retryDelivery(admin.ctx, deliveryId);
    await prisma.membership.deleteMany({
      where: { businessId: a.businessId, userId: admin.userId },
    });
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "delivered" },
    });
    await handleDeliverWebhook(worker(), queued[0]);
    expect((await delivery()).status).toBe("delivered");
  });

  it("still retries after the requester's session is revoked (schedules survive logout)", async () => {
    const admin = await addMember(a.businessId, "admin", "webhook-retrier");
    const token = generateToken(admin.userId);
    const session = verifyToken(token)!;
    const ctx: TenantContext = {
      ...admin.ctx,
      authorization: {
        kind: "membership",
        userId: admin.userId,
        membershipId: (admin.ctx.authorization as { membershipId: string }).membershipId,
        sessionJti: session.jti,
        sessionExpiresAt: session.exp,
      },
    };
    await retryDelivery(ctx, deliveryId);
    await revokeToken(token); // logout
    await handleDeliverWebhook(worker(), queued[0]);
    expect(dispatchHttpRequest).toHaveBeenCalledTimes(1);
    expect((await delivery()).status).toBe("delivered");
    await prisma.revokedToken.deleteMany({ where: { userId: admin.userId } });
  });
});
