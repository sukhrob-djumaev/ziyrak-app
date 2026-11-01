import type { Prisma } from "@/generated/prisma/client";

/**
 * L5.0 - the platform billing policy (docs/l5-payment-lifecycle-design.md section 2). Values the owner changes in the
 * console without a deploy. A `BillingPolicy` row overrides these defaults; a missing row means revision 0.
 * Changing the policy never rewrites a published catalog version, a purchase or a past invoice.
 */
export const SUPPORTED_BILLING_CURRENCIES = ["MYR", "USD"] as const;
export const SUPPORTED_BILLING_INTERVALS = ["month", "year"] as const;
export const TAX_DISPLAY_MODES = ["none", "inclusive", "exclusive"] as const;

export interface BillingPolicy {
  rev: number;
  graceDays: number;
  /** Always 0 until a trial lifecycle is built and accepted; the console and the database both reject anything else. */
  trialDays: number;
  holdRetentionDays: number;
  currencies: string[];
  intervals: string[];
  refundPolicyText: string;
  refundPolicyUrl: string | null;
  supportContact: string;
  taxDisplay: (typeof TAX_DISPLAY_MODES)[number];
}

export const DEFAULT_BILLING_POLICY: Omit<BillingPolicy, "rev"> = {
  graceDays: 7,
  trialDays: 0,
  holdRetentionDays: 60,
  currencies: ["MYR"],
  intervals: ["month", "year"],
  refundPolicyText: "",
  refundPolicyUrl: null,
  supportContact: "",
  taxDisplay: "none",
};

type Reader = Pick<Prisma.TransactionClient, "billingPolicy">;

export async function readBillingPolicy(db: Reader): Promise<BillingPolicy> {
  const row = await db.billingPolicy.findUnique({ where: { id: "default" } });
  if (!row) return { ...DEFAULT_BILLING_POLICY, rev: 0 };
  return {
    rev: row.rev,
    graceDays: row.graceDays,
    trialDays: row.trialDays,
    holdRetentionDays: row.holdRetentionDays,
    currencies: row.currencies,
    intervals: row.intervals,
    refundPolicyText: row.refundPolicyText,
    refundPolicyUrl: row.refundPolicyUrl,
    supportContact: row.supportContact,
    taxDisplay: row.taxDisplay as BillingPolicy["taxDisplay"],
  };
}

/** Why a priced offer conflicts with the current policy. Unpriced drafts are reported elsewhere. */
export function policyProblemsForTerms(
  terms: { currency: string | null; interval: string | null },
  policy: Pick<BillingPolicy, "currencies" | "intervals">,
): string[] {
  const problems: string[] = [];
  if (terms.currency !== null && !policy.currencies.includes(terms.currency))
    problems.push(`Currency ${terms.currency} is not allowed by the billing policy (${policy.currencies.join(", ")}).`);
  if (terms.interval !== null && !policy.intervals.includes(terms.interval))
    problems.push(`The "${terms.interval}" interval is not allowed by the billing policy (${policy.intervals.join(", ")}).`);
  return problems;
}
