import { z } from "zod";
import { AppError } from "@/lib/observability/errors";
import { withPlatformControl } from "@/lib/platform/access/authority";
import { writePlatformAudit } from "@/lib/platform/access/audit";
import { SUPPORTED_BILLING_CURRENCIES, SUPPORTED_BILLING_INTERVALS, TAX_DISPLAY_MODES, readBillingPolicy } from "./policy";

/** L5.0 - super-admin management of the billing policy. Compare-and-set on `rev`; every change is audited with a reason. */
const saveInput = z
  .object({
    expectedRev: z.number().int().min(0),
    graceDays: z.number().int().min(0).max(30),
    trialDays: z.literal(0),
    holdRetentionDays: z.number().int().min(30).max(365),
    currencies: z.array(z.enum(SUPPORTED_BILLING_CURRENCIES)).min(1).max(SUPPORTED_BILLING_CURRENCIES.length),
    intervals: z.array(z.enum(SUPPORTED_BILLING_INTERVALS)).min(1).max(SUPPORTED_BILLING_INTERVALS.length),
    refundPolicyText: z.string().trim().max(2000),
    refundPolicyUrl: z
      .string()
      .trim()
      .max(500)
      .url()
      .refine((u) => new URL(u).protocol === "https:", "must be https")
      .nullable(),
    supportContact: z.string().trim().max(200),
    taxDisplay: z.enum(TAX_DISPLAY_MODES),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

const CONFLICT = "The billing policy changed since you opened it. Reload and try again";

export async function saveBillingPolicy(token: string, input: unknown) {
  const parsed = saveInput.safeParse(input);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid billing policy request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const { expectedRev, reason, ...values } = parsed.data;
  const data = { ...values, currencies: [...new Set(values.currencies)], intervals: [...new Set(values.intervals)] };
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const before = await readBillingPolicy(tx);
    if (before.rev !== expectedRev) throw new AppError(409, "CONFLICT", CONFLICT);
    if (expectedRev === 0) {
      // The primary key makes a concurrent first save a duplicate that is skipped, so exactly one creator wins.
      const created = await tx.billingPolicy.createMany({ data: { id: "default", ...data, rev: 1, updatedBy: actor.userId }, skipDuplicates: true });
      if (created.count !== 1) throw new AppError(409, "CONFLICT", CONFLICT);
    } else {
      const updated = await tx.billingPolicy.updateMany({
        where: { id: "default", rev: expectedRev },
        data: { ...data, rev: { increment: 1 }, updatedBy: actor.userId },
      });
      if (updated.count !== 1) throw new AppError(409, "CONFLICT", CONFLICT);
    }
    const after = await readBillingPolicy(tx);
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "billing.policy.save", reason, details: JSON.parse(JSON.stringify({ before, after })) });
    return after;
  });
}
