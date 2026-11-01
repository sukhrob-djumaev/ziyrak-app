import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma/raw-client";
import { readBillingPolicy } from "./policy";
import { holdAllowsApiPath } from "./hold-paths";

type Db = Pick<Prisma.TransactionClient, "billingSubscription" | "billingPolicy">;

/**
 * L5.1 payment hold (docs/l5-payment-lifecycle-design.md Rev 3). A workspace is held when it has had a provider subscription
 * and none is live any more: the provider subscription ended (cancelled, or grace ran out unpaid). Derived from the
 * subscription rows alone, so a confirmed payment that opens a new live subscription lifts it with no extra step. It is
 * independent of operator suspension (`Business.status`), which payment never clears.
 */
export interface PaymentHold {
  held: boolean;
  since: Date | null;
  /** When the retention period (policy `holdRetentionDays`) ends. Displayed only; nothing is deleted automatically. */
  retentionEndsAt: Date | null;
}

export async function paymentHold(businessId: string, db: Db = prisma): Promise<PaymentHold> {
  const rows = await db.billingSubscription.findMany({ where: { businessId }, select: { status: true, updatedAt: true } });
  // An unpaid `incomplete` row (abandoned checkout, failed 3DS) grants nothing, so it neither starts nor lifts a hold.
  const grants = rows.some((r) => r.status !== "ended" && r.status !== "incomplete");
  if (!rows.some((r) => r.status === "ended") || grants) return { held: false, since: null, retentionEndsAt: null };
  const since = new Date(Math.max(...rows.filter((r) => r.status === "ended").map((r) => r.updatedAt.getTime())));
  const { holdRetentionDays } = await readBillingPolicy(db);
  return { held: true, since, retentionEndsAt: new Date(since.getTime() + holdRetentionDays * 86_400_000) };
}

export async function isPaymentHold(businessId: string, db?: Db): Promise<boolean> {
  return (await paymentHold(businessId, db)).held;
}

/** For `requireAuth`: null when the workspace may proceed, else the 402 to return. */
export async function paymentHoldDenied(businessId: string, pathname: string): Promise<NextResponse | null> {
  if (holdAllowsApiPath(pathname)) return null;
  if (!(await isPaymentHold(businessId))) return null;
  return NextResponse.json(
    { error: { code: "PAYMENT_HOLD", message: "This workspace is paused until payment is made. The workspace owner can resume it from Billing." } },
    { status: 402 }
  );
}
