import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

/** L5.1 - webhook route: signature before any database work, bounded body, stored-then-queued, duplicates not requeued. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@/lib/jobs/queue", () => ({ jobQueue: { enqueue } }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma/raw-client";
import { POST } from "@/app/api/billing/webhook/route";
import { signStripePayload } from "@/lib/billing/providers/stripe/signature";
import { resetPaymentProviderForTests } from "@/lib/billing/providers";

const tag = `bw-${Date.now()}`;
const secret = "whsec_test_secret_for_route";
Object.assign(process.env, { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: secret });
const post = (body: string | Buffer, sig?: string) =>
  POST(new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body, headers: sig ? { "stripe-signature": sig } : {} }));
const event = (n: string) => Buffer.from(JSON.stringify({ id: `${tag}-${n}`, type: "customer.subscription.updated", data: { object: { id: `${tag}-sub`, customer: `${tag}-cus` } } }));

beforeEach(() => { enqueue.mockClear(); resetPaymentProviderForTests(); });
afterAll(async () => { await prisma.providerEvent.deleteMany({ where: { eventRef: { startsWith: tag } } }); });

describe("POST /api/billing/webhook", () => {
  it("rejects a bad signature without touching the database or the queue", async () => {
    const body = event("bad");
    expect((await post(body, "t=1,v1=00")).status).toBe(400);
    expect((await post(body)).status).toBe(400);
    expect(await prisma.providerEvent.count({ where: { eventRef: `${tag}-bad` } })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stores a signed event once and queues it once", async () => {
    const body = event("ok");
    const sig = signStripePayload(body, secret, new Date());
    expect((await (await post(body, sig)).json()).status).toBe("received");
    expect((await (await post(body, sig)).json()).status).toBe("duplicate");
    expect(await prisma.providerEvent.count({ where: { eventRef: `${tag}-ok` } })).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("answers 5xx when the event cannot be queued so the provider redelivers", async () => {
    enqueue.mockRejectedValueOnce(new Error("down"));
    const body = event("q");
    expect((await post(body, signStripePayload(body, secret, new Date()))).status).toBe(500);
  });

  it("rejects an oversized body", async () => {
    const big = Buffer.alloc(300 * 1024, 97);
    expect((await post(big, signStripePayload(big, secret, new Date()))).status).toBe(413);
  });

  it("is a 404 when no provider is configured", async () => {
    delete process.env.BILLING_PROVIDER;
    resetPaymentProviderForTests();
    expect((await post(event("off"))).status).toBe(404);
    process.env.BILLING_PROVIDER = "stripe";
  });
});
