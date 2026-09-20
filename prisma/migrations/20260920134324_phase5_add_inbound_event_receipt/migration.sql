-- CreateTable
CREATE TABLE "InboundEventReceipt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStatus" TEXT NOT NULL DEFAULT 'received',
    "correlationId" TEXT NOT NULL,
    "eventPayload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "InboundEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundEventReceipt_businessId_processingStatus_idx" ON "InboundEventReceipt"("businessId", "processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEventReceipt_businessId_source_externalEventId_key" ON "InboundEventReceipt"("businessId", "source", "externalEventId");

-- AddForeignKey
ALTER TABLE "InboundEventReceipt" ADD CONSTRAINT "InboundEventReceipt_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
