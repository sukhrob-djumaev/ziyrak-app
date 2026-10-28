import { describe, it, expect } from "vitest";
import { composeEntitlements } from "@/lib/billing/entitlements";

const p = (id: string, grants: { capability: string; amount?: number }[], quantity = 1) => ({ id, versionId: `v-${id}`, quantity, grants });

describe("composeEntitlements", () => {
  it("grants a boolean capability while any source remains (removing one overlapping grant keeps the other)", () => {
    const both = composeEntitlements([p("a", [{ capability: "data.export" }]), p("b", [{ capability: "data.export" }])], []).effective.get("data.export")!;
    expect(both.granted).toBe(true);
    expect(both.provenance.map((s) => s.id)).toEqual(["a", "b"]);
    const onlyB = composeEntitlements([p("b", [{ capability: "data.export" }])], []).effective.get("data.export")!;
    expect(onlyB.granted).toBe(true);
    expect(composeEntitlements([], []).effective.get("data.export")).toBeUndefined();
  });
  it("sums quantity limits explicitly and multiplies by purchased quantity", () => {
    const e = composeEntitlements([p("base", [{ capability: "seats.members", amount: 5 }]), p("addon", [{ capability: "seats.members", amount: 2 }], 3)], []).effective.get("seats.members")!;
    expect(e.limit).toBe(11);
    expect(e.provenance).toHaveLength(2);
  });
  it("never grants a capability the registry does not know (retired key) and reports it", () => {
    const r = composeEntitlements([p("old", [{ capability: "channel.email" }, { capability: "data.export" }])], []);
    expect(r.effective.has("channel.email")).toBe(false);
    expect(r.ignored).toEqual(["channel.email"]);
    expect(r.effective.get("data.export")?.granted).toBe(true);
  });
  it("applies adjustments on top: a grant for an on/off key and extra amount for a limit, with provenance", () => {
    const r = composeEntitlements([p("base", [{ capability: "seats.members", amount: 5 }])], [
      { id: "x", capability: "webhooks.outbound", granted: true, amount: null },
      { id: "y", capability: "seats.members", granted: null, amount: 3 },
    ]).effective;
    expect(r.get("webhooks.outbound")?.granted).toBe(true);
    expect(r.get("seats.members")?.limit).toBe(8);
    expect(r.get("seats.members")?.provenance.map((s) => s.kind)).toEqual(["purchase", "adjustment"]);
  });
  it("an adjustment never removes what a purchase grants", () => {
    const r = composeEntitlements([p("base", [{ capability: "data.export" }])], [{ id: "z", capability: "data.export", granted: false, amount: null }]).effective;
    expect(r.get("data.export")?.granted).toBe(true);
  });
  it("a limit of nothing is not granted", () => {
    expect(composeEntitlements([], []).effective.get("seats.members")?.granted ?? false).toBe(false);
  });
});
