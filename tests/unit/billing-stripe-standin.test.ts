import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";
import { createStripeProvider } from "@/lib/billing/providers/stripe/adapter";

/** The stand-in is test infrastructure; these tests pin the behaviour browser journeys rely on. */
const standin = createRequire(import.meta.url)("../../scripts/acceptance/stripe-standin.cjs") as typeof import("../../scripts/acceptance/stripe-standin.cjs");

const SECRET = "whsec_t";
const received: { type: string; id: string; verified: boolean }[] = [];
let hook: http.Server;
let base = "";
let control: (path: string, body?: object) => Promise<Record<string, unknown>>;
let provider: ReturnType<typeof createStripeProvider>;
let server: http.Server;

beforeAll(async () => {
  hook = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      const ev = JSON.parse(d);
      const header = String(req.headers["stripe-signature"]);
      const t = header.split(",")[0].slice(2);
      const expect_ = standin.sign(d, SECRET, Number(t));
      received.push({ type: ev.type, id: ev.id, verified: header === expect_ });
      res.end("ok");
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => hook.once("listening", r));
  const s = standin.createStripeStandin({ webhookUrl: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`, webhookSecret: SECRET });
  server = s.server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.setPublicUrl(base);
  provider = createStripeProvider({ secretKey: "sk_test_x", webhookSecrets: [SECRET], baseUrl: base });
  control = async (path, body = {}) => (await fetch(`${base}/__control/${path}`, { method: "POST", body: JSON.stringify(body) })).json();
});
afterAll(() => {
  server.close();
  hook.close();
});

async function checkout() {
  const { priceRef } = await provider.syncPrice({ versionId: "v", itemName: "Base", amountMinor: 19900, currency: "MYR", interval: "month" }, `v-${Math.random()}`);
  const { customerRef } = await provider.createCustomer({ businessId: "b1" }, `c-${Math.random()}`);
  const out = await provider.createCheckout(
    { businessId: "b1", operationId: "op1", customerRef, lines: [{ priceRef, quantity: 1 }], successUrl: "http://app/ok", cancelUrl: "http://app/no" },
    `op-${Math.random()}`,
  );
  return { ...out, customerRef };
}

describe("stripe stand-in", () => {
  it("rejects a live-looking key and replays idempotent requests", async () => {
    const bad = createStripeProvider({ secretKey: "sk_live_x", webhookSecrets: [], baseUrl: base });
    await expect(bad.createCustomer({ businessId: "b" }, "k")).rejects.toMatchObject({ kind: "rejected" });
    const a = await provider.createCustomer({ businessId: "b" }, "same");
    const b = await provider.createCustomer({ businessId: "b" }, "same");
    expect(a).toEqual(b);
  });

  it("completing a session creates an active subscription and delivers signed events in order", async () => {
    received.length = 0;
    const { sessionRef } = await checkout();
    const sub = (await control(`sessions/${sessionRef}/complete`)) as { id: string };
    const real = await provider.getSubscription(sub.id);
    expect(real.status).toBe("active");
    expect(received.map((e) => e.type)).toEqual(["checkout.session.completed", "customer.subscription.created", "invoice.paid"]);
    expect(received.every((e) => e.verified)).toBe(true);
  });

  it("holds, reverses, duplicates and drops events on request", async () => {
    const { sessionRef } = await checkout();
    received.length = 0;
    await control("config", { mode: "hold" });
    const sub = (await control(`sessions/${sessionRef}/complete`)) as { id: string };
    expect(received).toHaveLength(0);
    await control("config", { mode: "normal" });
    await control("flush", { reverse: true });
    expect(received.map((e) => e.type)).toEqual(["invoice.paid", "customer.subscription.created", "checkout.session.completed"]);

    received.length = 0;
    await control("config", { mode: "duplicate" });
    await control(`subscriptions/${sub.id}/invoice`, { paid: false });
    expect(received.map((e) => e.type)).toEqual(["invoice.payment_failed", "invoice.payment_failed"]);
    expect(received[0].id).toBe(received[1].id);
    expect((await provider.getSubscription(sub.id)).status).toBe("past_due");

    received.length = 0;
    await control("config", { mode: "drop" });
    await control(`subscriptions/${sub.id}/invoice`, { paid: true });
    expect(received).toHaveLength(0);
    expect((await provider.getSubscription(sub.id)).status).toBe("active");
    await control("config", { mode: "normal" });
  });

  it("supports cancel at period end and immediate cancel", async () => {
    const { sessionRef } = await checkout();
    const sub = (await control(`sessions/${sessionRef}/complete`)) as { id: string };
    expect((await provider.cancelSubscription({ ref: sub.id, at: "period_end" }, "c1")).cancelAtPeriodEnd).toBe(true);
    expect((await provider.cancelSubscription({ ref: sub.id, at: "now" }, "c2")).status).toBe("canceled");
  });

  it("serves a hosted pay page that completes and redirects to the success URL", async () => {
    const { url } = await checkout();
    expect(await (await fetch(url)).text()).toContain('id="pay"');
    const res = await fetch(url, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://app/ok");
  });
});
