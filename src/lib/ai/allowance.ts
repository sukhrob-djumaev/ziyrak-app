import { prisma } from "@/lib/prisma/raw-client";

/**
 * PLAN.md P2 / docs/p2-managed-ai-proposal-2026-10-22.md section 3 — durable
 * token allowance accounting. Every potentially billable attempt reserves a
 * conservative bound first; the reservation is settled to actual usage,
 * released when provider failed before billing, or kept charged as
 * `uncertain` when the outcome is unknown. Counters are derived by summing
 * reservation rows under a row lock on the workspace's allowance row, so
 * there is no separate counter to drift. Caps are not exact invoices.
 */

export type AllowanceKind = "generation" | "embedding";

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "not_configured" | "suspended" | "exhausted" };

export interface ReserveInput {
  businessId: string;
  kind: AllowanceKind;
  tokens: number;
  idempotencyKey: string;
  now?: Date;
  /** Reservation lifetime before an unfinished attempt is swept to `uncertain`. */
  ttlMs?: number;
}

export const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;

export function periodStartFor(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export async function reserveAllowance(input: ReserveInput): Promise<ReserveResult> {
  const now = input.now ?? new Date();
  const periodStart = periodStartFor(now);
  const tokens = Math.max(0, Math.ceil(input.tokens));

  return prisma.$transaction(async (tx) => {
    // Serializes every reservation for this workspace across web/worker processes.
    const locked = await tx.$queryRaw<
      { status: string; generationLimitTokens: number; embeddingLimitTokens: number }[]
    >`SELECT "status", "generationLimitTokens", "embeddingLimitTokens" FROM "WorkspaceAiAllowance" WHERE "businessId" = ${input.businessId} FOR UPDATE`;
    const allowance = locked[0];
    if (!allowance) return { ok: false, reason: "not_configured" } as const;

    const existing = await tx.aiUsageReservation.findUnique({
      where: { businessId_idempotencyKey: { businessId: input.businessId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return { ok: true, reservationId: existing.id } as const;

    if (allowance.status !== "active") return { ok: false, reason: "suspended" } as const;

    const limit = input.kind === "generation" ? allowance.generationLimitTokens : allowance.embeddingLimitTokens;
    const charged = await chargedTokens(tx, input.businessId, input.kind, periodStart);
    if (charged + tokens > limit) return { ok: false, reason: "exhausted" } as const;

    const row = await tx.aiUsageReservation.create({
      data: {
        businessId: input.businessId,
        kind: input.kind,
        periodStart,
        reservedTokens: tokens,
        state: "reserved",
        idempotencyKey: input.idempotencyKey,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS)),
      },
    });
    return { ok: true, reservationId: row.id } as const;
  });
}

type Tx = Pick<typeof prisma, "aiUsageReservation">;

async function chargedTokens(tx: Tx, businessId: string, kind: string, periodStart: Date): Promise<number> {
  const rows = await tx.aiUsageReservation.findMany({
    where: { businessId, kind, periodStart, state: { not: "released" } },
    select: { state: true, reservedTokens: true, settledTokens: true },
  });
  return rows.reduce((sum, r) => sum + (r.state === "settled" ? (r.settledTokens ?? r.reservedTokens) : r.reservedTokens), 0);
}

/** Settles to the provider-reported usage. Idempotent: only a `reserved` or `uncertain` row can settle. */
export async function settleReservation(businessId: string, reservationId: string, actualTokens: number): Promise<void> {
  await prisma.aiUsageReservation.updateMany({
    where: { id: reservationId, businessId, state: { in: ["reserved", "uncertain"] } },
    data: { state: "settled", settledTokens: Math.max(0, Math.ceil(actualTokens)) },
  });
}

/** Frees a reservation when the provider failed before any billable work. A settled or uncertain row is untouched. */
export async function releaseReservation(businessId: string, reservationId: string): Promise<void> {
  await prisma.aiUsageReservation.updateMany({
    where: { id: reservationId, businessId, state: "reserved" },
    data: { state: "released" },
  });
}

/** Keeps the reserved bound charged for an attempt whose outcome is unknown (timeout, crash). */
export async function markReservationUncertain(businessId: string, reservationId: string): Promise<void> {
  await prisma.aiUsageReservation.updateMany({
    where: { id: reservationId, businessId, state: "reserved" },
    data: { state: "uncertain" },
  });
}

/** Sweeps expired unfinished reservations (worker crash) to `uncertain`; they stay charged. */
export async function sweepExpiredReservations(now: Date = new Date()): Promise<number> {
  const result = await prisma.aiUsageReservation.updateMany({
    where: { state: "reserved", expiresAt: { lt: now } },
    data: { state: "uncertain" },
  });
  return result.count;
}

export interface AllowanceUsage {
  /** Settled measurements plus uncertain bounds. */
  used: number;
  /** Open reservations (estimates, not measurements). */
  reserved: number;
  limit: number | null;
}

export async function getAllowanceUsage(businessId: string, kind: AllowanceKind, now: Date = new Date()): Promise<AllowanceUsage> {
  const periodStart = periodStartFor(now);
  const [rows, allowance] = await Promise.all([
    prisma.aiUsageReservation.findMany({
      where: { businessId, kind, periodStart, state: { not: "released" } },
      select: { state: true, reservedTokens: true, settledTokens: true },
    }),
    prisma.workspaceAiAllowance.findUnique({ where: { businessId } }),
  ]);
  let used = 0;
  let reserved = 0;
  for (const r of rows) {
    if (r.state === "reserved") reserved += r.reservedTokens;
    else used += r.state === "settled" ? (r.settledTokens ?? r.reservedTokens) : r.reservedTokens;
  }
  const limit = allowance ? (kind === "generation" ? allowance.generationLimitTokens : allowance.embeddingLimitTokens) : null;
  return { used, reserved, limit };
}
