-- CreateTable
CREATE TABLE "BillingPolicy" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "graceDays" INTEGER NOT NULL,
    "trialDays" INTEGER NOT NULL,
    "holdRetentionDays" INTEGER NOT NULL,
    "currencies" TEXT[],
    "intervals" TEXT[],
    "refundPolicyText" TEXT NOT NULL DEFAULT '',
    "refundPolicyUrl" TEXT,
    "supportContact" TEXT NOT NULL DEFAULT '',
    "taxDisplay" TEXT NOT NULL DEFAULT 'none',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingPolicy_singleton_check" CHECK ("id" = 'default'),
    CONSTRAINT "BillingPolicy_grace_check" CHECK ("graceDays" BETWEEN 0 AND 30),
    CONSTRAINT "BillingPolicy_trial_check" CHECK ("trialDays" = 0),
    CONSTRAINT "BillingPolicy_retention_check" CHECK ("holdRetentionDays" BETWEEN 30 AND 365),
    CONSTRAINT "BillingPolicy_currencies_check" CHECK (cardinality("currencies") > 0),
    CONSTRAINT "BillingPolicy_intervals_check" CHECK (cardinality("intervals") > 0),
    CONSTRAINT "BillingPolicy_tax_check" CHECK ("taxDisplay" IN ('none', 'inclusive', 'exclusive'))
);
