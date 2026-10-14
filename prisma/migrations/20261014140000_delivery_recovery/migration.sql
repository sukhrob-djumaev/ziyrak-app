-- CreateTable
CREATE TABLE "DeliveryOperation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "receiptId" TEXT,
    "conversationId" TEXT,
    "actionId" TEXT,
    "channel" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "response" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "providerMessageId" TEXT,
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "recoveryLog" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryOperation_businessId_status_idx" ON "DeliveryOperation"("businessId", "status");

-- CreateIndex
CREATE INDEX "DeliveryOperation_businessId_conversationId_idx" ON "DeliveryOperation"("businessId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOperation_businessId_operationKey_key" ON "DeliveryOperation"("businessId", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEventReceipt_businessId_id_key" ON "InboundEventReceipt"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ActionExecution_businessId_id_key" ON "ActionExecution"("businessId", "id");

-- AddForeignKey
ALTER TABLE "DeliveryOperation" ADD CONSTRAINT "DeliveryOperation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOperation" ADD CONSTRAINT "DeliveryOperation_businessId_receiptId_fkey" FOREIGN KEY ("businessId", "receiptId") REFERENCES "InboundEventReceipt"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOperation" ADD CONSTRAINT "DeliveryOperation_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOperation" ADD CONSTRAINT "DeliveryOperation_businessId_actionId_fkey" FOREIGN KEY ("businessId", "actionId") REFERENCES "ActionExecution"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
