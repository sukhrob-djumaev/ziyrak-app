import { prisma } from "@/lib/prisma/raw-client";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { createHash } from "node:crypto";
import { readBillingPolicy } from "./policy";
import { applyProviderSnapshot, raiseIncident } from "./provider-apply";
import type { NormalizedEvent, PaymentProvider } from "./providers/types";

/**
 * L5.1 - webhook inbox and event processing (design Revisions 2-3). An event only says "look at this subscription";
 * state always comes from a fresh provider read, so duplicates, reordering and forged-but-validly-signed noise converge.
 */
export const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
]);

/** Inserts the verified event once. Returns the row and whether it was new; a duplicate must not enqueue again. */
export async function recordProviderEvent(provider: string, ev: NormalizedEvent, rawBody: Buffer): Promise<{ id: string; created: boolean }> {
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const existing = await prisma.providerEvent.findUnique({ where: { provider_eventRef: { provider, eventRef: ev.eventRef } }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  try {
    const row = await prisma.providerEvent.create({
      data: { provider, eventRef: ev.eventRef, type: ev.type, payloadHash, subscriptionRef: ev.subscriptionRef, customerRef: ev.customerRef, clientReference: ev.clientReference },
    });
    return { id: row.id, created: true };
  } catch (e) {
    // Lost the race to a concurrent delivery of the same event.
    const again = await prisma.providerEvent.findUnique({ where: { provider_eventRef: { provider, eventRef: ev.eventRef } }, select: { id: true } });
    if (again) return { id: again.id, created: false };
    throw e;
  }
}

async function resolveBusiness(provider: string, ev: { subscriptionRef: string | null; customerRef: string | null; clientReference: string | null }): Promise<{ businessId: string; operationId?: string } | null> {
  if (ev.subscriptionRef) {
    const s = await prisma.billingSubscription.findUnique({ where: { provider_subscriptionRef: { provider, subscriptionRef: ev.subscriptionRef } }, select: { businessId: true } });
    if (s) return { businessId: s.businessId };
  }
  if (ev.clientReference) {
    const op = await prisma.billingOperation.findUnique({ where: { id: ev.clientReference }, select: { id: true, businessId: true, kind: true } });
    if (op && op.kind === "checkout") return { businessId: op.businessId, operationId: op.id };
  }
  if (ev.customerRef) {
    const c = await prisma.billingCustomer.findUnique({ where: { provider_customerRef: { provider, customerRef: ev.customerRef } }, select: { businessId: true } });
    if (c) return { businessId: c.businessId };
  }
  return null;
}

export type ProcessResult = "processed" | "ignored" | "failed";

export async function processProviderEvent(
  eventId: string,
  deps: { provider: PaymentProvider; providerName: string; mode: "test" | "live"; now?: () => Date },
): Promise<ProcessResult> {
  const ev = await prisma.providerEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.state === "processed" || ev.state === "ignored") return ev?.state === "ignored" ? "ignored" : "processed";
  const done = (state: "processed" | "ignored" | "failed", error?: string) =>
    prisma.providerEvent.update({ where: { id: ev.id }, data: { state, error: error?.slice(0, 300) ?? null, attempts: { increment: 1 } } }).then(() => state);

  if (!HANDLED_EVENT_TYPES.has(ev.type) || !ev.subscriptionRef) return done("ignored");
  const target = await resolveBusiness(deps.providerName, ev);
  if (!target) {
    await prisma.$transaction((tx) => raiseIncident(tx, null, "unbound_ref", `event ${ev.eventRef} (${ev.type}) names an unknown subscription or customer`));
    return done("ignored");
  }
  const customer = await prisma.billingCustomer.findUnique({ where: { businessId: target.businessId } });
  if (customer && ev.customerRef && customer.customerRef !== ev.customerRef) {
    await prisma.$transaction((tx) => raiseIncident(tx, target.businessId, "unbound_ref", `event ${ev.eventRef} customer does not match the workspace customer`));
    return done("ignored");
  }

  let snap;
  try {
    snap = await deps.provider.getSubscription(ev.subscriptionRef);
  } catch (e) {
    // Retryable: the job runner re-runs us; the event stays "received".
    await prisma.providerEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, error: String((e as Error).message).slice(0, 300) } });
    throw e;
  }
  if (customer && snap.customerRef !== customer.customerRef) {
    await prisma.$transaction((tx) => raiseIncident(tx, target.businessId, "unbound_ref", `subscription ${snap.ref} belongs to a different customer`));
    return done("ignored");
  }

  const now = deps.now?.() ?? new Date();
  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await lockTenantWrites(tx, target.businessId);
      const policy = await readBillingPolicy(tx);
      return applyProviderSnapshot(tx, snap, { businessId: target.businessId, provider: deps.providerName, mode: deps.mode, graceDays: policy.graceDays, now, operationId: target.operationId });
    });
  } catch (e) {
    // A second paid subscription for a workspace that already has a live one hits the one-live-per-business index. Retrying
    // can never succeed, so stop and leave it for an operator (the customer was charged twice and needs a refund).
    if ((e as { code?: string }).code !== "P2002") throw e;
    // An abandoned checkout leaves an "incomplete" row that also occupies the index; it ends on its own, so retry instead of parking a real payment.
    const blocking = await prisma.billingSubscription.findFirst({ where: { businessId: target.businessId, status: { not: "ended" } }, select: { status: true } });
    if (blocking?.status === "incomplete") throw e;
    await prisma.$transaction((tx) => raiseIncident(tx, target.businessId, "double_paid", `subscription ${snap.ref} was paid but the workspace already has a live subscription`));
    return done("ignored", "second live subscription for workspace");
  }
  if (target.operationId && outcome.grantsAccess) {
    await prisma.billingOperation.update({ where: { id: target.operationId }, data: { state: "succeeded" } });
  }
  if (outcome.cancelAtProvider) {
    // Outside the workspace lock: grace has run out, so the provider subscription must stop billing too.
    await deps.provider.cancelSubscription({ ref: snap.ref, at: "now" }, `grace-expiry-${snap.ref}`);
  }
  return done("processed");
}
