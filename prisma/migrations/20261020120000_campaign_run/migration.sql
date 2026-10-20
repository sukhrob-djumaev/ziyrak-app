-- AlterTable
ALTER TABLE "DeliveryOperation" ADD COLUMN     "campaignRunId" TEXT;

-- CreateTable
CREATE TABLE "CampaignRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "authorizationSnapshot" JSONB NOT NULL,
    "channel" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "targetCustomerIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CampaignRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignRun_businessId_campaignId_idx" ON "CampaignRun"("businessId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRun_businessId_id_key" ON "CampaignRun"("businessId", "id");

-- AddForeignKey
ALTER TABLE "DeliveryOperation" ADD CONSTRAINT "DeliveryOperation_businessId_campaignRunId_fkey" FOREIGN KEY ("businessId", "campaignRunId") REFERENCES "CampaignRun"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

