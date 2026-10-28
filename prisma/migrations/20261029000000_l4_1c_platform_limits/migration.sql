-- CreateTable
CREATE TABLE "PlatformLimit" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformLimit_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "PlatformLimit_value_check" CHECK ("value" >= 0)
);

-- CreateIndex
CREATE INDEX "AiUsageReservation_kind_periodStart_state_idx" ON "AiUsageReservation"("kind", "periodStart", "state");
