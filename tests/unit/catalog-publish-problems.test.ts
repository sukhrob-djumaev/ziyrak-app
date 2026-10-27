import { describe, it, expect } from "vitest";
import { publishProblems, type Terms } from "@/lib/billing/catalog";
import { CAPABILITIES } from "@/lib/billing/capabilities";

const ok: Terms = { name: "Inbox", description: "", grants: [{ capability: "channel.webchat" }], priceMinor: 1900, currency: "USD", interval: "month" };

describe("catalog publish validation", () => {
  it("accepts a priced bundle of implemented capabilities", () => expect(publishProblems(ok)).toEqual([]));
  it("accepts a free offer priced at 0", () => expect(publishProblems({ ...ok, priceMinor: 0 })).toEqual([]));
  it("rejects a capability the product does not implement", () => {
    expect(publishProblems({ ...ok, grants: [{ capability: "channel.email" }] }).join()).toMatch(/not a capability the product implements/);
    expect(publishProblems({ ...ok, grants: [{ capability: "alerts.keyword" }] })).not.toEqual([]);
  });
  it("rejects an amount on an on/off capability, a duplicate grant and an empty bundle", () => {
    expect(publishProblems({ ...ok, grants: [{ capability: "channel.webchat", amount: 3 }] }).join()).toMatch(/takes no amount/);
    expect(publishProblems({ ...ok, grants: [{ capability: "data.export" }, { capability: "data.export" }] }).join()).toMatch(/twice/);
    expect(publishProblems({ ...ok, grants: [] }).join()).toMatch(/at least one/i);
  });
  it("requires a complete price", () => {
    for (const bad of [{ priceMinor: null }, { currency: null }, { interval: null }]) expect(publishProblems({ ...ok, ...bad }).join()).toMatch(/price, currency and interval/);
  });
  it("registry lists no Email, Phone or alert capability", () => {
    expect(CAPABILITIES.map((c) => c.key).join()).not.toMatch(/email|phone|alert|sms/);
  });
});
