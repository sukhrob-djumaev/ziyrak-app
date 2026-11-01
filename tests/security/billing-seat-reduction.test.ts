import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.2 - lowering a seat limit below current usage: the owner chooses who stays, nobody is picked for them, and inaction lapses the reduction. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { scheduleReduction, applyDueReductions, seatConflict, chooseStayers } from "@/lib/billing/changes";
import { restoreMember } from "@/lib/billing/member-seats";
import { applyProviderSnapshot } from "@/lib/billing/provider-apply";
import { entitledLimit } from "@/lib/billing/entitlements";
import type { PaymentProvider, ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `bs-${Date.now()}`;
const periodEnd = new Date(Date.now() + 10 * 86_400_000);
const after = new Date(periodEnd.getTime() + 60_000);
let seat = "", bundle = "";
const businesses: string[] = [];
let cur = { ref: "", qty: 4 };

const snapshot = (): ProviderSubscription => ({
  ref: cur.ref, customerRef: `${cur.ref}-cus`, status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd, currency: "MYR", metadata: {}, fetchedAt: new Date(),
  items: [{ itemRef: "si_b", priceRef: `${tag}-bundle-p`, quantity: 1 }, ...(cur.qty > 0 ? [{ itemRef: "si_s", priceRef: `${tag}-seat-p`, quantity: cur.qty }] : [])],
});
const getSubscription = vi.fn(async () => snapshot());
const changeSubscription = vi.fn(async (i: { lines: { quantity: number }[] }) => { cur.qty = i.lines[0].quantity; return snapshot(); });
const deps = { provider: { name: "stripe", getSubscription, changeSubscription } as unknown as PaymentProvider, mode: "test" as const };

async function version(key: string, kind: string, grants: unknown) {
  const item = await prisma.catalogItem.create({ data: { key: `${tag}-${key}`, kind } });
  const row = await prisma.catalogVersion.create({ data: { itemId: item.id, version: 1, state: "published", name: key, grants: grants as object, priceMinor: 5000, currency: "MYR", interval: "month", publishedAt: new Date() } });
  await prisma.providerPriceRef.create({ data: { versionId: row.id, provider: "stripe", mode: "test", priceRef: `${tag}-${key}-p`, state: "synced" } });
  return row.id;
}

/** A workspace with an owner and three members on a 4-seat add-on; returns membership ids by name. */
async function workspace(name: string) {
  const biz = (await prisma.business.create({ data: { name: `${tag}-${name}`, slug: `${tag}-${name}` } })).id;
  businesses.push(biz);
  const m: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  for (const [who, role] of [["owner", "owner"], ["a", "agent"], ["b", "agent"], ["c", "viewer"]] as const) {
    const u = await prisma.user.create({ data: { username: `${tag}-${name}-${who}`, password: "x" } });
    userIds[who] = u.id;
    m[who] = (await prisma.membership.create({ data: { businessId: biz, userId: u.id, role } })).id;
  }
  cur = { ref: `${tag}-${name}-sub`, qty: 4 };
  const sub = await prisma.billingSubscription.create({ data: { businessId: biz, provider: "stripe", subscriptionRef: cur.ref, customerRef: `${cur.ref}-cus`, status: "active", currency: "MYR", currentPeriodEnd: periodEnd } });
  await prisma.billingSubscriptionItem.create({ data: { subscriptionId: sub.id, versionId: bundle, quantity: 1 } });
  await prisma.billingSubscriptionItem.create({ data: { subscriptionId: sub.id, versionId: seat, quantity: 4 } });
  await prisma.$transaction((tx) => applyProviderSnapshot(tx, snapshot(), { businessId: biz, provider: "stripe", mode: "test", graceDays: 7, now: new Date() }));
  return { biz, m, userIds, actor: { businessId: biz, userId: userIds.owner } };
}
const seatItem = (biz: string) => prisma.billingSubscriptionItem.findFirstOrThrow({ where: { versionId: seat, subscription: { businessId: biz } } });
/** applyDueReductions scans every workspace, so park the other tests' schedules first. */
const only = (biz: string) => prisma.billingSubscriptionItem.updateMany({ where: { state: "scheduled_remove", subscription: { businessId: { in: businesses.filter((b) => b !== biz) } } }, data: { state: "active", pendingQuantity: null } });
const suspended = async (biz: string) => (await prisma.membership.findMany({ where: { businessId: biz, suspendedByPlanAt: { not: null } }, select: { id: true } })).map((r) => r.id).sort();

beforeAll(async () => {
  bundle = await version("bundle", "bundle", [{ capability: "channel.webchat" }]);
  seat = await version("seat", "addon", [{ capability: "seats.members", amount: 1 }]);
});
afterAll(async () => {
  for (const biz of businesses) {
    await prisma.workspacePurchase.deleteMany({ where: { businessId: biz } });
    await prisma.billingSubscription.deleteMany({ where: { businessId: biz } });
    await prisma.billingOperation.deleteMany({ where: { businessId: biz } });
    const members = await prisma.membership.findMany({ where: { businessId: biz }, select: { userId: true } });
    await prisma.business.deleteMany({ where: { id: biz } });
    await prisma.user.deleteMany({ where: { id: { in: members.map((x) => x.userId) } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: `${tag}-` } } });
  }
  await prisma.providerPriceRef.deleteMany({ where: { versionId: { in: [seat, bundle] } } });
});

describe("seat reduction below usage", () => {
  it("can be scheduled and shows the owner the conflict", async () => {
    const w = await workspace("conflict");
    const before = await entitledLimit(w.biz, "seats.members");
    await scheduleReduction(w.actor, { lines: [{ versionId: seat, quantity: 2 }] }, deps);
    expect((await seatItem(w.biz)).state).toBe("scheduled_remove");
    expect(await entitledLimit(w.biz, "seats.members")).toBe(before);
    const c = await seatConflict(w.biz, seat);
    expect(c).toMatchObject({ members: 4, openInvitations: 0, newLimit: before - 2, effectiveAt: periodEnd.toISOString(), chosen: null });
    expect(c.people.map((p) => p.membershipId).sort()).toEqual(Object.values(w.m).sort());
  });

  it("validates the owner's choice: owner kept, within the new limit, only this workspace's members", async () => {
    const w = await workspace("choose");
    await scheduleReduction(w.actor, { lines: [{ versionId: seat, quantity: 2 }] }, deps);
    const pick = (ids: string[]) => chooseStayers(w.actor, { versionId: seat, membershipIds: ids });
    await expect(pick([w.m.a, w.m.b])).rejects.toMatchObject({ statusCode: 400 });
    const other = await workspace("other");
    await expect(pick([w.m.owner, other.m.a])).rejects.toMatchObject({ statusCode: 400 });
    await expect(pick([w.m.owner, w.m.a, w.m.b, w.m.c])).rejects.toMatchObject({ statusCode: 409 });
    await pick([w.m.owner, w.m.a]);
    expect((await seatItem(w.biz)).pendingStayers).toMatchObject({ ids: [w.m.owner, w.m.a] });
    expect(await suspended(w.biz)).toEqual([]);
  });

  it("lapses when nobody was chosen: old quantity stays, nothing is suspended, the provider is not called", async () => {
    const w = await workspace("lapse");
    await scheduleReduction(w.actor, { lines: [{ versionId: seat, quantity: 2 }] }, deps);
    changeSubscription.mockClear();
    await only(w.biz);
    await applyDueReductions(deps, after);
    const it = await seatItem(w.biz);
    expect([it.state, it.quantity, it.pendingQuantity]).toEqual(["active", 4, null]);
    expect(changeSubscription).not.toHaveBeenCalled();
    expect(await suspended(w.biz)).toEqual([]);
  });

  it("applies a resolved choice: suspends exactly the unchosen, deletes nothing, blocks them from the workspace", async () => {
    const w = await workspace("apply");
    await scheduleReduction(w.actor, { lines: [{ versionId: seat, quantity: 2 }] }, deps);
    await chooseStayers(w.actor, { versionId: seat, membershipIds: [w.m.owner, w.m.a] });
    await only(w.biz);
    await applyDueReductions(deps, after);
    expect((await seatItem(w.biz)).quantity).toBe(2);
    expect(await suspended(w.biz)).toEqual([w.m.b, w.m.c].sort());
    expect(await prisma.membership.count({ where: { businessId: w.biz } })).toBe(4);
    const { resolveHumanContext } = await vi.importActual<typeof import("@/lib/identity/route-auth")>("@/lib/identity/route-auth");
    expect((await resolveHumanContext(w.userIds.b, w.biz)).ok).toBe(false);
  });

  it("a stored choice that no longer fits lapses instead of suspending anyone", async () => {
    const w = await workspace("stale");
    await scheduleReduction(w.actor, { lines: [{ versionId: seat, quantity: 2 }] }, deps);
    await chooseStayers(w.actor, { versionId: seat, membershipIds: [w.m.owner, w.m.a] });
    changeSubscription.mockClear();
    await prisma.membership.delete({ where: { id: w.m.a } });
    await only(w.biz);
    await applyDueReductions(deps, after);
    expect(changeSubscription).not.toHaveBeenCalled();
    expect(await suspended(w.biz)).toEqual([]);
  });

  it("a member who joined after the owner's choice is never suspended unseen: the choice lapses", async () => {
    const w = await workspace("late");
    await scheduleReduction(w.actor, { lines: [{ versionId: seat, quantity: 2 }] }, deps);
    await chooseStayers(w.actor, { versionId: seat, membershipIds: [w.m.owner, w.m.a] });
    await new Promise((r) => setTimeout(r, 20));
    const u = await prisma.user.create({ data: { username: `${tag}-late-d`, password: "x" } });
    w.userIds.d = u.id;
    await prisma.membership.create({ data: { businessId: w.biz, userId: u.id, role: "agent" } });
    changeSubscription.mockClear();
    await only(w.biz);
    await applyDueReductions(deps, after);
    expect(changeSubscription).not.toHaveBeenCalled();
    expect(await suspended(w.biz)).toEqual([]);
  });

  it("restoring a suspended member needs a free seat", async () => {
    const w = await workspace("restore");
    await scheduleReduction(w.actor, { lines: [{ versionId: seat, quantity: 2 }] }, deps);
    await chooseStayers(w.actor, { versionId: seat, membershipIds: [w.m.owner, w.m.a] });
    await only(w.biz);
    await applyDueReductions(deps, after);
    await expect(restoreMember({ businessId: w.biz }, w.m.b)).rejects.toMatchObject({ statusCode: 403 });
    cur.qty = 4;
    await prisma.$transaction((tx) => applyProviderSnapshot(tx, snapshot(), { businessId: w.biz, provider: "stripe", mode: "test", graceDays: 7, now: new Date() }));
    await restoreMember({ businessId: w.biz }, w.m.b);
    expect(await suspended(w.biz)).toEqual([w.m.c]);
  });
});
