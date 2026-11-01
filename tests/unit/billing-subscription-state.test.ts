import { describe, expect, it } from "vitest";
import { applySnapshot, type LocalSubscriptionState, type ProviderSnapshot } from "@/lib/billing/subscription-state";

const T0 = new Date("2026-11-01T00:00:00Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const policy = { graceDays: 7 };
const snap = (over: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({
  providerStatus: "active",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: day(30),
  fetchedAt: day(0),
  ...over,
});
const start: LocalSubscriptionState = { status: "incomplete", graceEndsAt: null, lastFetchedAt: null };

describe("subscription state machine", () => {
  it("stays incomplete, with no access, until the provider reports it paid", () => {
    const r = applySnapshot(start, snap({ providerStatus: "incomplete" }), policy, day(0));
    expect(r.state.status).toBe("incomplete");
    expect(r.grantsAccess).toBe(false);
  });

  it("becomes active and grants access when paid", () => {
    const r = applySnapshot(start, snap(), policy, day(0));
    expect(r.state).toMatchObject({ status: "active", graceEndsAt: null });
    expect(r.grantsAccess).toBe(true);
  });

  it("marks cancel-at-period-end as canceling, still with access", () => {
    const r = applySnapshot(start, snap({ cancelAtPeriodEnd: true }), policy, day(0));
    expect(r.state.status).toBe("canceling");
    expect(r.grantsAccess).toBe(true);
  });

  it("sets the grace deadline once on the first failed payment and never extends it", () => {
    const active = applySnapshot(start, snap(), policy, day(0)).state;
    const first = applySnapshot(active, snap({ providerStatus: "past_due", fetchedAt: day(1) }), policy, day(1));
    expect(first.state.status).toBe("past_due");
    expect(first.state.graceEndsAt).toEqual(day(8));
    expect(first.grantsAccess).toBe(true);
    const again = applySnapshot(first.state, snap({ providerStatus: "past_due", fetchedAt: day(3) }), policy, day(3));
    expect(again.state.graceEndsAt).toEqual(day(8));
  });

  it("clears the grace deadline when payment recovers", () => {
    const pd = applySnapshot(start, snap({ providerStatus: "past_due" }), policy, day(0)).state;
    const r = applySnapshot(pd, snap({ fetchedAt: day(2) }), policy, day(2));
    expect(r.state).toMatchObject({ status: "active", graceEndsAt: null });
  });

  it("ends access when grace has elapsed while still unpaid and asks for the provider subscription to be cancelled", () => {
    const pd = applySnapshot(start, snap({ providerStatus: "past_due" }), policy, day(0)).state;
    const r = applySnapshot(pd, snap({ providerStatus: "past_due", fetchedAt: day(8) }), policy, day(8));
    expect(r.state.status).toBe("ended");
    expect(r.grantsAccess).toBe(false);
    expect(r.cancelAtProvider).toBe(true);
  });

  it("treats a provider-cancelled subscription as ended", () => {
    const r = applySnapshot(start, snap({ providerStatus: "canceled" }), policy, day(0));
    expect(r.state.status).toBe("ended");
    expect(r.grantsAccess).toBe(false);
    expect(r.cancelAtProvider).toBe(false);
  });

  it("never reactivates an ended subscription; a later 'active' snapshot raises an incident", () => {
    const ended = applySnapshot(start, snap({ providerStatus: "canceled" }), policy, day(0)).state;
    const r = applySnapshot(ended, snap({ fetchedAt: day(5) }), policy, day(5));
    expect(r.state.status).toBe("ended");
    expect(r.grantsAccess).toBe(false);
    expect(r.incident).toBe("paid_after_end");
  });

  it("ignores a snapshot fetched before the one already applied (out-of-order delivery)", () => {
    const active = applySnapshot(start, snap({ fetchedAt: day(5) }), policy, day(5)).state;
    const r = applySnapshot(active, snap({ providerStatus: "canceled", fetchedAt: day(4) }), policy, day(6));
    expect(r.state).toEqual(active);
    expect(r.stale).toBe(true);
  });

  it("is idempotent: the same snapshot applied twice gives the same state", () => {
    const s = snap({ providerStatus: "past_due" });
    const once = applySnapshot(start, s, policy, day(0));
    const twice = applySnapshot(once.state, s, policy, day(0));
    expect(twice.state).toEqual(once.state);
  });

  it("maps unknown provider statuses to no access rather than guessing", () => {
    const r = applySnapshot(start, snap({ providerStatus: "paused" }), policy, day(0));
    expect(r.grantsAccess).toBe(false);
  });
});
