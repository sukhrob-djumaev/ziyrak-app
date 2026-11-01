import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

/** L5.1 payment hold: derived from the subscription rows, blocks the API except billing/account, stores inbound without replying, lifts on payment. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { paymentHold, paymentHoldDenied } from "@/lib/billing/payment-hold";
import { holdAllowsApiPath, holdAllowsPagePath } from "@/lib/billing/hold-paths";
import { processInboundMessage } from "@/lib/conversations/inbound";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import type { TenantContext } from "@/lib/tenancy/context";

const businessIds: string[] = [];
const userIds: string[] = [];

async function workspace() {
  const r = await provisionBusiness({
    businessName: "Hold Co",
    ownerUsername: `hd_${randomUUID().slice(0, 12)}`,
    ownerPassword: "Correct-horse-9",
    ownerEmail: `hd-${randomUUID()}@example.test`,
  });
  businessIds.push(r.businessId);
  userIds.push(r.userId);
  const ctx: TenantContext = {
    businessId: r.businessId,
    role: "owner",
    actor: { kind: "user", userId: r.userId },
    dataConnection: "shared-default",
    resourceScope: { kind: "workspace", customerProfileAccess: "write" },
  };
  return { ...r, ctx };
}
const sub = (businessId: string, status: string) =>
  prisma.billingSubscription.create({
    data: { businessId, provider: "stripe", subscriptionRef: `sub_${randomUUID()}`, customerRef: "cus_x", status, currency: "MYR" },
  });

afterAll(async () => {
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: businessIds } } });
  await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("payment hold state", () => {
  it("is not held without a subscription or while one is live", async () => {
    const w = await workspace();
    expect((await paymentHold(w.businessId)).held).toBe(false);
    await sub(w.businessId, "past_due");
    await sub(w.businessId, "ended");
    expect((await paymentHold(w.businessId)).held).toBe(false);
  });

  it("is held once every subscription has ended, with the retention date from policy, and lifts when a new one is live", async () => {
    const w = await workspace();
    await sub(w.businessId, "ended");
    const h = await paymentHold(w.businessId);
    expect(h.held).toBe(true);
    expect(h.retentionEndsAt!.getTime() - h.since!.getTime()).toBe(60 * 86_400_000);
    await sub(w.businessId, "active");
    expect((await paymentHold(w.businessId)).held).toBe(false);
  });

  it("never reads another workspace's subscription", async () => {
    const a = await workspace();
    const b = await workspace();
    await sub(a.businessId, "ended");
    expect((await paymentHold(b.businessId)).held).toBe(false);
  });
});

describe("hold API gate", () => {
  it("returns 402 for everything except billing, account and sign-in routes", async () => {
    const w = await workspace();
    await sub(w.businessId, "ended");
    for (const p of ["/api/conversations", "/api/settings/ai", "/api/channels", "/api/export", "/api/me-not"]) {
      const res = await paymentHoldDenied(w.businessId, p);
      expect(res?.status, p).toBe(402);
      expect((await res!.json()).error.code).toBe("PAYMENT_HOLD");
    }
    for (const p of ["/api/billing/quote", "/api/billing/checkout", "/api/auth/logout", "/api/me", "/api/workspaces"]) {
      expect(await paymentHoldDenied(w.businessId, p), p).toBeNull();
    }
  });

  it("lets a workspace that is not held through", async () => {
    const w = await workspace();
    expect(await paymentHoldDenied(w.businessId, "/api/conversations")).toBeNull();
  });

  it("path allow-lists match whole segments only", () => {
    expect(holdAllowsApiPath("/api/billing")).toBe(true);
    expect(holdAllowsApiPath("/api/billingx")).toBe(false);
    expect(holdAllowsPagePath("/billing")).toBe(true);
    expect(holdAllowsPagePath("/account/security")).toBe(true);
    expect(holdAllowsPagePath("/billing-extra")).toBe(false);
    expect(holdAllowsPagePath("/conversations")).toBe(false);
  });
});

describe("inbound during hold", () => {
  const event = (businessId: string, text: string) =>
    buildMessageReceivedEvent({
      businessId, channel: "api", connectionId: "internal-chat-api",
      payload: { text, customerName: "Visitor", customerContact: "visitor-1" },
    });

  it("stores the customer's message and sends no reply; replies resume after payment", async () => {
    const w = await workspace();
    await sub(w.businessId, "ended");
    const r = await processInboundMessage(w.ctx, event(w.businessId, "Are you open?"));
    expect(r.response).toBe("");
    expect(await prisma.message.count({ where: { conversation: { businessId: w.businessId }, role: "customer" } })).toBe(1);
    expect(await prisma.message.count({ where: { conversation: { businessId: w.businessId }, role: "assistant" } })).toBe(0);
    expect(await prisma.deliveryOperation.count({ where: { businessId: w.businessId } })).toBe(0);
  });
});
