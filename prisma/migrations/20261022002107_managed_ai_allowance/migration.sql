-- CreateTable
CREATE TABLE "AiServicePolicy" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "credentialRef" TEXT,
    "maxTokens" INTEGER NOT NULL DEFAULT 1024,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxPromptTokens" INTEGER NOT NULL DEFAULT 12000,
    "maxToolDepth" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiServicePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceAiAllowance" (
    "businessId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'managed',
    "status" TEXT NOT NULL DEFAULT 'active',
    "generationLimitTokens" INTEGER NOT NULL DEFAULT 500000,
    "embeddingLimitTokens" INTEGER NOT NULL DEFAULT 1000000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceAiAllowance_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "AiUsageReservation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "reservedTokens" INTEGER NOT NULL,
    "settledTokens" INTEGER,
    "state" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiServicePolicy_kind_version_key" ON "AiServicePolicy"("kind", "version");

-- CreateIndex
CREATE INDEX "AiUsageReservation_businessId_kind_periodStart_state_idx" ON "AiUsageReservation"("businessId", "kind", "periodStart", "state");

-- CreateIndex
CREATE INDEX "AiUsageReservation_state_expiresAt_idx" ON "AiUsageReservation"("state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageReservation_businessId_idempotencyKey_key" ON "AiUsageReservation"("businessId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "WorkspaceAiAllowance" ADD CONSTRAINT "WorkspaceAiAllowance_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageReservation" ADD CONSTRAINT "AiUsageReservation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
