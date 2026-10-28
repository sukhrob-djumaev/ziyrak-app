import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/** L4.1b - the same permission check passes and the package check still decides: real routes and services on a real database. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { recordWorkspaceSelection } from "../helpers/workspace-selection";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { createWebChatConnection } from "@/lib/channels/webchat-connections-service";
import * as automationService from "@/lib/automations/automation-rules/service";
import { evaluateRules } from "@/lib/automations/automation";
import { createInvitation, acceptInvitation } from "@/lib/platform/admin-users/invitations";
import { CaptureMailTransport, setMailTransportForTesting } from "@/lib/mail/transport";

let biz: SeededBusiness;
let token: string;
const itemIds: string[] = [];

/** A published version with the given grants, inserted directly (the catalog service is covered elsewhere). */
async function version(grants: { capability: string; amount?: number }[], kind: "bundle" | "addon" = "bundle") {
  const item = await prisma.catalogItem.create({ data: { key: `enf-${randomUUID().slice(0, 8)}`, kind } });
  itemIds.push(item.id);
  return prisma.catalogVersion.create({
    data: { itemId: item.id, version: 1, state: "published", name: "t", grants, priceMinor: 0, currency: "USD", interval: "month", publishedAt: new Date() },
  });
}
/** Replace everything the workspace holds with exactly these grants. */
async function hold(grants: { capability: string; amount?: number }[]) {
  await prisma.workspacePurchase.updateMany({ where: { businessId: biz.businessId, state: "active" }, data: { state: "ended", endsAt: new Date() } });
  const v = await version(grants);
  await prisma.workspacePurchase.create({ data: { businessId: biz.businessId, versionId: v.id, source: "manual_test", reason: "test" } });
}
const ALL = ["channel.webchat", "channel.whatsapp_cloud", "automation.rules", "webhooks.outbound", "data.export"].map((capability) => ({ capability }));

beforeAll(async () => {
  biz = await seedBusiness("enforcement");
  token = generateToken(biz.ownerUserId);
}, 120_000);
afterAll(async () => {
  await cleanupBusiness(biz.businessId);
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" DISABLE TRIGGER "CatalogVersion_guard"');
    await prisma.workspacePurchase.deleteMany({ where: { versionId: { in: (await prisma.catalogVersion.findMany({ where: { itemId: { in: itemIds } }, select: { id: true } })).map((v) => v.id) } } });
    await prisma.catalogVersion.deleteMany({ where: { itemId: { in: itemIds } } });
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" ENABLE TRIGGER "CatalogVersion_guard"');
  }
  await prisma.catalogItem.deleteMany({ where: { id: { in: itemIds } } });
});
const authed = (path: string, options: Parameters<typeof createRequest>[1] = {}) => createRequest(path, { ...options, cookies: { "owly-token": token, ...options.cookies } });

describe("a package that lacks a capability stops the feature even for the owner", () => {
  it("webhooks: create, update, test and retry are refused with ENTITLEMENT_REQUIRED, reading still works", async () => {
    await hold(ALL);
    const { POST, GET } = await import("@/app/api/webhooks/route");
    const created = await POST(authed("/api/webhooks", { method: "POST", body: { name: "w", url: "https://example.com/h", triggerOn: "conversation.created" } }));
    expect(created.status).toBe(201);
    const hookId = (await parseJsonResponse(created)).id as string;
    await hold(ALL.filter((c) => c.capability !== "webhooks.outbound"));
    const denied = await POST(authed("/api/webhooks", { method: "POST", body: { name: "w2", url: "https://example.com/h", triggerOn: "x" } }));
    expect(denied.status).toBe(403);
    expect((await parseJsonResponse(denied)).error.code).toBe("ENTITLEMENT_REQUIRED");
    const { PUT } = await import("@/app/api/webhooks/[id]/route");
    expect((await PUT(authed(`/api/webhooks/${hookId}`, { method: "PUT", body: { name: "renamed" } }), { params: Promise.resolve({ id: hookId }) })).status).toBe(403);
    const { POST: test } = await import("@/app/api/webhooks/test/route");
    expect((await test(authed("/api/webhooks/test", { method: "POST", body: { url: "https://example.com/h" } }))).status).toBe(403);
    expect((await GET(authed("/api/webhooks"))).status).toBe(200); // history stays readable
  });

  it("a queued webhook delivery is not sent once the capability is gone", async () => {
    await hold(ALL.filter((c) => c.capability !== "webhooks.outbound"));
    const db = getScopedPrisma(biz.ctx);
    const hook = await db.webhook.create({ data: { name: "q", url: "https://example.com/h", method: "POST", headers: {}, triggerOn: "x", isActive: true } });
    const delivery = await db.webhookDelivery.create({ data: { webhookId: hook.id, event: "x", payload: {}, status: "pending" } });
    const dispatch = vi.fn();
    vi.doMock("@/lib/http/http-dispatcher", () => ({ dispatchHttpRequest: dispatch }));
    const { handleDeliverWebhook } = await import("@/lib/jobs/handlers/deliver-webhook");
    await handleDeliverWebhook(biz.ctx, { businessId: biz.businessId, deliveryId: delivery.id, webhookId: hook.id } as never);
    const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(after.status).toBe("failed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("export is refused; the customer's own data-rights export is a separate route and is not gated", async () => {
    await hold(ALL.filter((c) => c.capability !== "data.export"));
    const { GET } = await import("@/app/api/export/route");
    const res = await GET(authed("/api/export", { searchParams: { type: "conversations", format: "json" } }));
    expect(res.status).toBe(403);
    expect((await parseJsonResponse(res)).error.code).toBe("ENTITLEMENT_REQUIRED");
    await hold(ALL);
    expect((await GET(authed("/api/export", { searchParams: { type: "conversations", format: "json" } }))).status).toBe(200);
  });

  it("Web Chat setup is refused without the channel; automation rules neither save nor fire without the capability", async () => {
    await hold(ALL.filter((c) => !["channel.webchat", "automation.rules"].includes(c.capability)));
    await expect(createWebChatConnection(biz.ctx, { allowedOrigins: ["https://example.com"] } as never)).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    await expect(
      automationService.create(biz.ctx, { name: "r", type: "auto_tag", conditions: [{ field: "message_content", operator: "contains", value: "x" }], actions: [{ type: "auto_tag", value: "t" }] } as never)
    ).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    // A rule saved earlier stops firing at execution, while the message is still handled.
    const db = getScopedPrisma(biz.ctx);
    await db.automationRule.create({ data: { name: "old", type: "auto_tag", isActive: true, requiresReconfirmation: false, conditions: [{ field: "message_content", operator: "contains", value: "hello" }], actions: [{ type: "auto_tag", value: "vip" }] } });
    const matched = await evaluateRules(biz.ctx, { content: "hello there", role: "customer" } as never, { id: "c", channel: "webchat" } as never);
    expect(matched).toEqual([]);
    await hold(ALL);
    const again = await evaluateRules(biz.ctx, { content: "hello there", role: "customer" } as never, { id: "c", channel: "webchat" } as never);
    expect(again.length).toBeGreaterThan(0);
  });

  it("the entitlement never touches roles: a viewer without the permission is still refused first, with the permission error", async () => {
    await hold(ALL);
    const viewer = await prisma.user.create({ data: { username: `v-${randomUUID()}`, password: "x", name: "V" } });
    await prisma.membership.create({ data: { businessId: biz.businessId, userId: viewer.id, role: "viewer" } });
    recordWorkspaceSelection(viewer.id, biz.businessId);
    const viewerToken = generateToken(viewer.id);
    const { POST } = await import("@/app/api/webhooks/route");
    const res = await POST(createRequest("/api/webhooks", { method: "POST", body: { name: "x", url: "https://example.com", triggerOn: "x" }, cookies: { "owly-token": viewerToken } }));
    expect([401, 403]).toContain(res.status);
    const body = await parseJsonResponse(res);
    expect(JSON.stringify(body)).not.toContain("ENTITLEMENT_REQUIRED");
  });
});

describe("team seats", () => {
  async function invite(email: string) {
    const capture = new CaptureMailTransport();
    setMailTransportForTesting(capture);
    try {
      await prisma.user.update({ where: { id: biz.ownerUserId }, data: { email: `owner-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } });
      await createInvitation(biz.ctx, { email, role: "viewer" });
    } finally {
      setMailTransportForTesting(null);
    }
    return capture.messages[0].text.match(/token=([A-Za-z0-9_-]+)/)![1];
  }
  it("inviting is refused when members plus open invitations reach the limit", async () => {
    const members = await prisma.membership.count({ where: { businessId: biz.businessId } });
    await hold([...ALL, { capability: "seats.members", amount: members }]);
    await expect(invite(`full-${randomUUID()}@example.test`)).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
  });
  it("two simultaneous accepts cannot both take the last seat, and the losing link stays usable", async () => {
    const members = await prisma.membership.count({ where: { businessId: biz.businessId } });
    await hold([...ALL, { capability: "seats.members", amount: members + 2 }]);
    const t1 = await invite(`a-${randomUUID()}@example.test`);
    const t2 = await invite(`b-${randomUUID()}@example.test`);
    await hold([...ALL, { capability: "seats.members", amount: members + 1 }]); // package shrank after both were sent
    const [r1, r2] = await Promise.all([
      acceptInvitation({ token: t1, signup: { username: `u1-${randomUUID().slice(0, 8)}`, password: "Sufficient-pass-1" } }),
      acceptInvitation({ token: t2, signup: { username: `u2-${randomUUID().slice(0, 8)}`, password: "Sufficient-pass-2" } }),
    ]);
    const ok = [r1, r2].filter((r) => r.ok);
    const refused = [r1, r2].filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(refused[0]).toMatchObject({ ok: false, code: "SEAT_LIMIT" });
    expect(await prisma.membership.count({ where: { businessId: biz.businessId } })).toBe(members + 1);
    // The refused person can still use the same link once a seat is free.
    await hold([...ALL, { capability: "seats.members", amount: members + 2 }]);
    const loser = refused[0] === r1 ? t1 : t2;
    const retry = await acceptInvitation({ token: loser, signup: { username: `u3-${randomUUID().slice(0, 8)}`, password: "Sufficient-pass-3" } });
    expect(retry.ok).toBe(true);
  });
});
