import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * `DELETE /api/customers/[id]/gdpr/delete` contract (acceptance-pass findings):
 * a customer that does not exist for the caller's business — including another
 * business's customer — is a 404 (not a 200 `{success:false}`), a request with no
 * body defaults to the safe action (anonymise, not hard delete) instead of a 500,
 * and a malformed body is a 400. Real Postgres + real auth.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import {
  seedBusiness,
  cleanupBusiness,
  addMember,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let a: SeededBusiness;
let b: SeededBusiness;
let ownerToken: string;
let viewerToken: string;

beforeAll(async () => {
  a = await seedBusiness("gdpr-a");
  b = await seedBusiness("gdpr-b");
  ownerToken = generateToken(a.ownerUserId);
  viewerToken = generateToken((await addMember(a.businessId, "viewer", "gdpr-viewer")).userId);
});

afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});

async function customerWithMessage(business: SeededBusiness, name: string) {
  const db = getScopedPrisma(business.ctx);
  const customer = await db.customer.create({
    data: {
      businessId: business.businessId,
      name,
      email: `${name.toLowerCase().replace(/\W/g, "")}@example.com`,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      businessId: business.businessId,
      channel: "webchat",
      customerId: customer.id,
      customerName: name,
    },
  });
  await db.message.create({
    data: {
      businessId: business.businessId,
      conversationId: conversation.id,
      role: "customer",
      content: "my secret detail",
    },
  });
  return { customer, conversation };
}

async function del(
  token: string,
  id: string,
  init: { rawBody?: string; body?: Record<string, unknown> } = {}
) {
  const { DELETE } = await import("@/app/api/customers/[id]/gdpr/delete/route");
  const request = createRequest(`/api/customers/${id}/gdpr/delete`, {
    method: "DELETE",
    body: init.body,
    cookies: { "owly-token": token },
  });
  if (init.rawBody !== undefined) {
    // createRequest only serialises objects; build the raw-body variant directly.
    const { NextRequest } = await import("next/server");
    const raw = new NextRequest(request.url, {
      method: "DELETE",
      body: init.rawBody,
      headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
    });
    return DELETE(raw, { params: Promise.resolve({ id }) });
  }
  return DELETE(request, { params: Promise.resolve({ id }) });
}

describe("DELETE /api/customers/[id]/gdpr/delete", () => {
  it("answers 404, and touches nothing, for another business's customer", async () => {
    const theirs = await customerWithMessage(b, "Other Tenant Customer");
    const response = await del(ownerToken, theirs.customer.id, { body: { hardDelete: true } });
    expect(response.status).toBe(404);
    expect(
      await getScopedPrisma(b.ctx).customer.findUnique({ where: { id: theirs.customer.id } })
    ).not.toBeNull();
    expect(
      await getScopedPrisma(b.ctx).message.count({
        where: { conversationId: theirs.conversation.id },
      })
    ).toBe(1);
  });

  it("answers 404 for an id that does not exist", async () => {
    expect((await del(ownerToken, "no-such-customer", { body: {} })).status).toBe(404);
  });

  it("with no body at all, anonymises (the safe default) instead of failing with 500", async () => {
    const mine = await customerWithMessage(a, "Anonymise Me");
    const response = await del(ownerToken, mine.customer.id, { rawBody: "" });
    expect(response.status).toBe(200);
    expect(await parseJsonResponse(response)).toMatchObject({ success: true });
    const message = await getScopedPrisma(a.ctx).message.findFirst({
      where: { conversationId: mine.conversation.id },
    });
    expect(message?.content).toBe("[REDACTED - GDPR]");
    // The customer record (the PII) is erased; the conversation survives as an anonymous shell.
    expect(
      await getScopedPrisma(a.ctx).customer.findUnique({ where: { id: mine.customer.id } })
    ).toBeNull();
    const shell = await getScopedPrisma(a.ctx).conversation.findUnique({
      where: { id: mine.conversation.id },
    });
    expect(shell).toMatchObject({ customerName: "Deleted User", customerId: null });
  });

  it("with hardDelete: true removes the customer and their conversations", async () => {
    const mine = await customerWithMessage(a, "Delete Me");
    const response = await del(ownerToken, mine.customer.id, { body: { hardDelete: true } });
    expect(response.status).toBe(200);
    expect(
      await getScopedPrisma(a.ctx).customer.findUnique({ where: { id: mine.customer.id } })
    ).toBeNull();
    expect(
      await getScopedPrisma(a.ctx).conversation.findUnique({ where: { id: mine.conversation.id } })
    ).toBeNull();
  });

  it("rejects a malformed body with 400 and does nothing", async () => {
    const mine = await customerWithMessage(a, "Keep Me");
    expect((await del(ownerToken, mine.customer.id, { rawBody: "{not json" })).status).toBe(400);
    expect((await del(ownerToken, mine.customer.id, { rawBody: '"a string"' })).status).toBe(400);
    expect(
      await getScopedPrisma(a.ctx).customer.findUnique({ where: { id: mine.customer.id } })
    ).not.toBeNull();
    const message = await getScopedPrisma(a.ctx).message.findFirst({
      where: { conversationId: mine.conversation.id },
    });
    expect(message?.content).toBe("my secret detail");
  });

  it("is refused for a role without customers:delete", async () => {
    const mine = await customerWithMessage(a, "Viewer Cannot");
    expect((await del(viewerToken, mine.customer.id, { body: { hardDelete: true } })).status).toBe(
      403
    );
  });
});
