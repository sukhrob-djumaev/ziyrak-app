-- AlterTable
ALTER TABLE "WorkspacePurchase" ADD COLUMN     "subscriptionItemId" TEXT;

-- CreateTable
CREATE TABLE "ProviderPriceRef" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "productRef" TEXT,
    "priceRef" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderPriceRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCustomer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "customerRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subscriptionRef" TEXT NOT NULL,
    "customerRef" TEXT NOT NULL,
    "operationId" TEXT,
    "status" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "currency" TEXT NOT NULL,
    "lastFetchedAt" TIMESTAMP(3),
    "rev" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_status_check" CHECK ("status" IN ('incomplete','active','past_due','canceling','ended')),
    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscriptionItem" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'active',
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingSubscriptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOperation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "idemKey" TEXT NOT NULL,
    "quoteHash" TEXT NOT NULL,
    "sessionRef" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventRef" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingIncident" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BillingIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPriceRef_provider_mode_versionId_key" ON "ProviderPriceRef"("provider", "mode", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCustomer_businessId_key" ON "BillingCustomer"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCustomer_provider_customerRef_key" ON "BillingCustomer"("provider", "customerRef");

-- CreateIndex
CREATE INDEX "BillingSubscription_businessId_status_idx" ON "BillingSubscription"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_provider_subscriptionRef_key" ON "BillingSubscription"("provider", "subscriptionRef");

-- CreateIndex
CREATE INDEX "BillingSubscriptionItem_subscriptionId_state_idx" ON "BillingSubscriptionItem"("subscriptionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOperation_idemKey_key" ON "BillingOperation"("idemKey");

-- CreateIndex
CREATE INDEX "BillingOperation_businessId_state_idx" ON "BillingOperation"("businessId", "state");

-- CreateIndex
CREATE INDEX "ProviderEvent_state_receivedAt_idx" ON "ProviderEvent"("state", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEvent_provider_eventRef_key" ON "ProviderEvent"("provider", "eventRef");

-- CreateIndex
CREATE INDEX "BillingIncident_state_createdAt_idx" ON "BillingIncident"("state", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspacePurchase_subscriptionItemId_idx" ON "WorkspacePurchase"("subscriptionItemId");

-- AddForeignKey
ALTER TABLE "ProviderPriceRef" ADD CONSTRAINT "ProviderPriceRef_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "CatalogVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCustomer" ADD CONSTRAINT "BillingCustomer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscriptionItem" ADD CONSTRAINT "BillingSubscriptionItem_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BillingSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscriptionItem" ADD CONSTRAINT "BillingSubscriptionItem_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "CatalogVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOperation" ADD CONSTRAINT "BillingOperation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- One live subscription per workspace (design Rev 2): ended rows are history.
CREATE UNIQUE INDEX "BillingSubscription_one_live_per_business" ON "BillingSubscription"("businessId") WHERE "status" <> 'ended';
