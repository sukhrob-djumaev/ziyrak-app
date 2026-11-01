import { describe, it, expect } from "vitest";
import { createStripeProvider } from "@/lib/billing/providers/stripe/adapter";
import { signStripePayload } from "@/lib/billing/providers/stripe/signature";
import { ProviderError } from "@/lib/billing/providers/types";

type Call = { url: string; method: string; headers: Record<string, string>; form: URLSearchParams };

function harness(reply: (c: Call) => { status?: number; body?: unknown } | "throw") {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, form: new URLSearchParams(String(init.body ?? "")) };
    calls.push(c);
    const r = reply(c);
    if (r === "throw") throw new Error("network");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const provider = createStripeProvider({ secretKey: "sk_test_x", webhookSecrets: ["whsec_a", "whsec_b"], baseUrl: "http://stripe.test", fetchImpl });
  return { provider, calls };
}

const sub = (extra: object = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  currency: "myr",
  cancel_at_period_end: false,
  metadata: { businessId: "b1" },
  items: { data: [{ id: "si_1", price: { id: "price_1" }, quantity: 2, current_period_end: 1_800_000_000 }] },
  ...extra,
});

describe("stripe adapter", () => {
  it("creates a product then a price with idempotency keys and a lower-case currency", async () => {
    const { provider, calls } = harness((c) => ({ body: { id: c.url.endsWith("products") ? "prod_1" : "price_1" } }));
    const out = await provider.syncPrice({ versionId: "v1", itemName: "Base", amountMinor: 19900, currency: "MYR", interval: "month" }, "ver:v1");
    expect(out).toEqual({ productRef: "prod_1", priceRef: "price_1" });
    expect(calls[0].headers.Authorization).toBe("Bearer sk_test_x");
    expect(calls[0].headers["Idempotency-Key"]).toBe("ver:v1:product");
    expect(calls[1].form.get("unit_amount")).toBe("19900");
    expect(calls[1].form.get("currency")).toBe("myr");
    expect(calls[1].form.get("recurring[interval]")).toBe("month");
  });

  it("builds a subscription checkout bound to the workspace with no trial and server URLs", async () => {
    const { provider, calls } = harness(() => ({ body: { id: "cs_1", url: "https://pay.test/cs_1" } }));
    const out = await provider.createCheckout(
      { businessId: "b1", operationId: "op1", customerRef: "cus_1", lines: [{ priceRef: "price_1", quantity: 2 }], successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" },
      "op:op1",
    );
    expect(out).toEqual({ url: "https://pay.test/cs_1", sessionRef: "cs_1" });
    const f = calls[0].form;
    expect(f.get("mode")).toBe("subscription");
    expect(f.get("client_reference_id")).toBe("op1");
    expect(f.get("line_items[0][price]")).toBe("price_1");
    expect(f.get("line_items[0][quantity]")).toBe("2");
    expect(f.get("subscription_data[metadata][businessId]")).toBe("b1");
    expect([...f.keys()].some((k) => k.includes("trial"))).toBe(false);
    expect(calls[0].headers["Idempotency-Key"]).toBe("op:op1");
  });

  it("normalizes a subscription read, including the item-level period end", async () => {
    const { provider, calls } = harness(() => ({ body: sub() }));
    const s = await provider.getSubscription("sub_1");
    expect(calls[0].method).toBe("GET");
    expect(s).toMatchObject({ ref: "sub_1", customerRef: "cus_1", status: "active", currency: "MYR", cancelAtPeriodEnd: false });
    expect(s.currentPeriodEnd.getTime()).toBe(1_800_000_000_000);
    expect(s.items).toEqual([{ itemRef: "si_1", priceRef: "price_1", quantity: 2 }]);
  });

  it("changes lines with pending_if_incomplete and encodes removals", async () => {
    const { provider, calls } = harness(() => ({ body: sub() }));
    await provider.changeSubscription({ ref: "sub_1", lines: [{ itemRef: "si_1", priceRef: "price_1", quantity: 3 }, { itemRef: "si_2", priceRef: "price_2", quantity: 1, remove: true }] }, "chg:1");
    const f = calls[0].form;
    expect(f.get("payment_behavior")).toBe("pending_if_incomplete");
    expect(f.get("items[0][quantity]")).toBe("3");
    expect(f.get("items[1][deleted]")).toBe("true");
    expect(f.has("items[1][price]")).toBe(false);
  });

  it("cancels at period end with POST and immediately with DELETE", async () => {
    const { provider, calls } = harness(() => ({ body: sub() }));
    await provider.cancelSubscription({ ref: "sub_1", at: "period_end" }, "c1");
    await provider.cancelSubscription({ ref: "sub_1", at: "now" }, "c2");
    expect(calls[0].form.get("cancel_at_period_end")).toBe("true");
    expect(calls[1].method).toBe("DELETE");
  });

  it("classifies failures: 4xx rejected; 5xx, 409, 429 and network errors unknown", async () => {
    const kinds: string[] = [];
    for (const status of [400, 402, 404, 409, 429, 500, 503]) {
      const { provider } = harness(() => ({ status, body: { error: { message: "no" } } }));
      kinds.push(await provider.getSubscription("s").catch((e: ProviderError) => e.kind));
    }
    expect(kinds).toEqual(["rejected", "rejected", "rejected", "unknown", "unknown", "unknown", "unknown"]);
    const { provider } = harness(() => "throw");
    await expect(provider.getSubscription("s")).rejects.toMatchObject({ kind: "unknown" });
  });

  it("rejects a response missing required fields as unknown, not as success", async () => {
    const { provider } = harness(() => ({ body: { id: "sub_1" } }));
    await expect(provider.getSubscription("sub_1")).rejects.toMatchObject({ kind: "unknown" });
  });

  describe("verifyWebhook", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const body = (o: object) => Buffer.from(JSON.stringify(o));
    const { provider } = harness(() => ({}));

    it("normalizes a signed event signed with either rotated secret", () => {
      const raw = body({ id: "evt_1", type: "checkout.session.completed", data: { object: { subscription: "sub_1", customer: "cus_1", client_reference_id: "op1" } } });
      for (const secret of ["whsec_a", "whsec_b"]) {
        expect(provider.verifyWebhook(raw, signStripePayload(raw, secret, now), now)).toEqual({
          eventRef: "evt_1",
          type: "checkout.session.completed",
          subscriptionRef: "sub_1",
          customerRef: "cus_1",
          clientReference: "op1",
        });
      }
    });

    it("takes the subscription ref from the object id for subscription events", () => {
      const raw = body({ id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_9", customer: "cus_9" } } });
      expect(provider.verifyWebhook(raw, signStripePayload(raw, "whsec_a", now), now).subscriptionRef).toBe("sub_9");
    });

    it("rejects a bad signature and a body altered after signing", () => {
      const raw = body({ id: "evt_3", type: "x", data: { object: {} } });
      const header = signStripePayload(raw, "whsec_other", now);
      expect(() => provider.verifyWebhook(raw, header, now)).toThrow(ProviderError);
      const good = signStripePayload(raw, "whsec_a", now);
      expect(() => provider.verifyWebhook(body({ id: "evt_3", type: "y", data: { object: {} } }), good, now)).toThrow(ProviderError);
    });
  });
});
