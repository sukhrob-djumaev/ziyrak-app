import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md P2 / docs/p2-managed-ai-proposal-2026-10-22.md section 3 — durable
 * reserve/settle/release accounting against real Postgres.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import {
  reserveAllowance,
  settleReservation,
  releaseReservation,
  sweepExpiredReservations,
  getAllowanceUsage,
  periodStartFor,
} from "@/lib/ai/allowance";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let b: SeededBusiness;
const NOW = new Date("2026-10-15T12:00:00Z");

async function setLimits(businessId: string, generation: number, embedding = 1000, extra: object = {}) {
  await prisma.workspaceAiAllowance.upsert({
    where: { businessId },
    create: { businessId, generationLimitTokens: generation, embeddingLimitTokens: embedding, ...extra },
    update: { generationLimitTokens: generation, embeddingLimitTokens: embedding, ...extra },
  });
}

beforeAll(async () => {
  a = await seedBusiness("ai-allowance-a");
  b = await seedBusiness("ai-allowance-b");
});
afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});

describe("periodStartFor", () => {
  it("is the first instant of the UTC calendar month", () => {
    expect(periodStartFor(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("reserveAllowance", () => {
  it("fails with not_configured when the workspace has no allowance row", async () => {
    const r = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 10, idempotencyKey: "nc", now: NOW });
    expect(r).toEqual({ ok: false, reason: "not_configured" });
  });

  it("refuses a suspended workspace", async () => {
    await setLimits(a.businessId, 1000, 1000, { status: "suspended" });
    const r = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 10, idempotencyKey: "s", now: NOW });
    expect(r).toEqual({ ok: false, reason: "suspended" });
    await setLimits(a.businessId, 1000, 1000, { status: "active" });
  });

  it("refuses a request over the remaining allowance and records nothing", async () => {
    await setLimits(a.businessId, 100);
    const r = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 101, idempotencyKey: "over", now: NOW });
    expect(r).toEqual({ ok: false, reason: "exhausted" });
    expect(await prisma.aiUsageReservation.count({ where: { businessId: a.businessId, idempotencyKey: "over" } })).toBe(0);
  });

  it("is idempotent per key and never double reserves", async () => {
    await setLimits(a.businessId, 100);
    const first = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 60, idempotencyKey: "idem", now: NOW });
    const again = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 60, idempotencyKey: "idem", now: NOW });
    expect(first.ok && again.ok && first.reservationId === again.reservationId).toBe(true);
    const usage = await getAllowanceUsage(a.businessId, "generation", NOW);
    expect(usage.reserved).toBe(60);
  });

  it("refuses to reuse an idempotency key whose attempt already finished", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    await setLimits(a.businessId, 1000);
    const first = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 10, idempotencyKey: "reuse", now: NOW });
    if (!first.ok) throw new Error("reserve failed");
    await settleReservation(a.businessId, first.reservationId, 10);
    const again = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 10, idempotencyKey: "reuse", now: NOW });
    expect(again).toEqual({ ok: false, reason: "duplicate_attempt" });
  });

  it("never exceeds the limit under concurrent reservations", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: b.businessId } });
    await setLimits(b.businessId, 100);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveAllowance({ businessId: b.businessId, kind: "generation", tokens: 30, idempotencyKey: `c${i}`, now: NOW })
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const usage = await getAllowanceUsage(b.businessId, "generation", NOW);
    expect(usage.used + usage.reserved).toBeLessThanOrEqual(100);
  });

  it("keeps one workspace's exhaustion from affecting another", async () => {
    const r = await reserveAllowance({ businessId: a.businessId, kind: "embedding", tokens: 50, idempotencyKey: "iso", now: NOW });
    expect(r.ok).toBe(true);
    await setLimits(b.businessId, 0);
    const blocked = await reserveAllowance({ businessId: b.businessId, kind: "generation", tokens: 1, idempotencyKey: "iso-b", now: NOW });
    expect(blocked).toEqual({ ok: false, reason: "exhausted" });
  });

  it("limits generation and embedding independently", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    await setLimits(a.businessId, 10, 500);
    expect((await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 11, idempotencyKey: "g", now: NOW })).ok).toBe(false);
    expect((await reserveAllowance({ businessId: a.businessId, kind: "embedding", tokens: 400, idempotencyKey: "e", now: NOW })).ok).toBe(true);
  });

  it("starts a fresh allowance in a new period", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    await setLimits(a.businessId, 100);
    await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 100, idempotencyKey: "p1", now: NOW });
    const next = new Date("2026-11-01T00:00:00Z");
    expect((await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 100, idempotencyKey: "p2", now: next })).ok).toBe(true);
  });
});

describe("settle, release and recovery", () => {
  it("settles to the actual usage, freeing the unused part of the reservation", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    await setLimits(a.businessId, 100);
    const r = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 80, idempotencyKey: "st", now: NOW });
    if (!r.ok) throw new Error("reserve failed");
    await settleReservation(a.businessId, r.reservationId, 30);
    const usage = await getAllowanceUsage(a.businessId, "generation", NOW);
    expect(usage).toMatchObject({ used: 30, reserved: 0 });
  });

  it("charges actual usage above the reservation (provider reported more)", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    const r = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 10, idempotencyKey: "more", now: NOW });
    if (!r.ok) throw new Error("reserve failed");
    await settleReservation(a.businessId, r.reservationId, 25);
    expect((await getAllowanceUsage(a.businessId, "generation", NOW)).used).toBe(25);
  });

  it("settling twice does not double charge", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    const r = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 10, idempotencyKey: "twice", now: NOW });
    if (!r.ok) throw new Error("reserve failed");
    await settleReservation(a.businessId, r.reservationId, 7);
    await settleReservation(a.businessId, r.reservationId, 9);
    expect((await getAllowanceUsage(a.businessId, "generation", NOW)).used).toBe(7);
  });

  it("release frees the reservation; releasing a settled one is a no-op", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    const r1 = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 40, idempotencyKey: "rel", now: NOW });
    const r2 = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 20, idempotencyKey: "rel2", now: NOW });
    if (!r1.ok || !r2.ok) throw new Error("reserve failed");
    await releaseReservation(a.businessId, r1.reservationId);
    await settleReservation(a.businessId, r2.reservationId, 20);
    await releaseReservation(a.businessId, r2.reservationId);
    expect(await getAllowanceUsage(a.businessId, "generation", NOW)).toMatchObject({ used: 20, reserved: 0 });
  });

  it("a crashed attempt stays charged at its reserved bound once swept as uncertain", async () => {
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    const r = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 50, idempotencyKey: "crash", now: NOW, ttlMs: 1000 });
    if (!r.ok) throw new Error("reserve failed");
    const later = new Date(NOW.getTime() + 60_000);
    expect(await sweepExpiredReservations(later)).toBeGreaterThanOrEqual(1);
    const row = await prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: r.reservationId } });
    expect(row.state).toBe("uncertain");
    expect(await getAllowanceUsage(a.businessId, "generation", NOW)).toMatchObject({ used: 50 });
    await settleReservation(a.businessId, r.reservationId, 5); // a late result may refine an uncertain one
    expect((await getAllowanceUsage(a.businessId, "generation", NOW)).used).toBe(5);
  });
});

describe("recurring reservation sweep job", () => {
  it("the job handler moves expired reservations to uncertain and leaves live ones", async () => {
    const { runAiReservationSweep } = await import("@/lib/jobs/handlers/sweep-ai-reservations");
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
    await setLimits(a.businessId, 1000);
    const dead = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 5, idempotencyKey: "dead", ttlMs: 1 });
    const live = await reserveAllowance({ businessId: a.businessId, kind: "generation", tokens: 5, idempotencyKey: "live", ttlMs: 3_600_000 });
    if (!dead.ok || !live.ok) throw new Error("reserve failed");
    await new Promise((r) => setTimeout(r, 20));
    await runAiReservationSweep();
    expect((await prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: dead.reservationId } })).state).toBe("uncertain");
    expect((await prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: live.reservationId } })).state).toBe("reserved");
  });
});
