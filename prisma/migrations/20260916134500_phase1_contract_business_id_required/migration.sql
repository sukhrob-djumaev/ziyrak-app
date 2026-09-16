-- DropForeignKey
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_businessId_fkey";

-- DropIndex
DROP INDEX "ApiKey_key_idx";

-- DropIndex
DROP INDEX "ApiKey_key_key";

-- DropIndex
DROP INDEX "Customer_email_idx";

-- DropIndex
DROP INDEX "Customer_phone_idx";

-- DropIndex
DROP INDEX "Customer_whatsapp_idx";

-- DropIndex
DROP INDEX "Tag_name_key";

-- AlterTable
ALTER TABLE "ActivityLog" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ApiKey" DROP COLUMN "key",
DROP COLUMN "lastUsed",
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ALTER COLUMN "businessId" SET NOT NULL,
ALTER COLUMN "keyHash" SET NOT NULL,
ALTER COLUMN "keyPrefix" SET NOT NULL,
ALTER COLUMN "role" SET NOT NULL,
ALTER COLUMN "role" SET DEFAULT 'agent';

-- AlterTable
ALTER TABLE "AutomationRule" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BusinessHours" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CallLog" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Campaign" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CannedResponse" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Category" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ConversationTag" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Customer" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomerNote" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Department" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Flow" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InternalNote" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KnowledgeEntry" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Message" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SLARule" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Schedule" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Tag" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TeamMember" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Webhook" ALTER COLUMN "businessId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WebhookDelivery" ALTER COLUMN "businessId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "ActivityLog_businessId_idx" ON "ActivityLog"("businessId");

-- CreateIndex
CREATE INDEX "ApiKey_keyPrefix_idx" ON "ApiKey"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_businessId_id_key" ON "ApiKey"("businessId", "id");

-- CreateIndex
CREATE INDEX "AutomationRule_businessId_idx" ON "AutomationRule"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessHours_businessId_key" ON "BusinessHours"("businessId");

-- CreateIndex
CREATE INDEX "CallLog_businessId_idx" ON "CallLog"("businessId");

-- CreateIndex
CREATE INDEX "Campaign_businessId_idx" ON "Campaign"("businessId");

-- CreateIndex
CREATE INDEX "CannedResponse_businessId_idx" ON "CannedResponse"("businessId");

-- CreateIndex
CREATE INDEX "Category_businessId_idx" ON "Category"("businessId");

-- CreateIndex
CREATE INDEX "Conversation_businessId_idx" ON "Conversation"("businessId");

-- CreateIndex
CREATE INDEX "ConversationTag_businessId_idx" ON "ConversationTag"("businessId");

-- CreateIndex
CREATE INDEX "Customer_businessId_email_idx" ON "Customer"("businessId", "email");

-- CreateIndex
CREATE INDEX "Customer_businessId_phone_idx" ON "Customer"("businessId", "phone");

-- CreateIndex
CREATE INDEX "Customer_businessId_whatsapp_idx" ON "Customer"("businessId", "whatsapp");

-- CreateIndex
CREATE INDEX "CustomerNote_businessId_idx" ON "CustomerNote"("businessId");

-- CreateIndex
CREATE INDEX "Department_businessId_idx" ON "Department"("businessId");

-- CreateIndex
CREATE INDEX "Flow_businessId_idx" ON "Flow"("businessId");

-- CreateIndex
CREATE INDEX "InternalNote_businessId_idx" ON "InternalNote"("businessId");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_businessId_idx" ON "KnowledgeEntry"("businessId");

-- CreateIndex
CREATE INDEX "Message_businessId_idx" ON "Message"("businessId");

-- CreateIndex
CREATE INDEX "SLARule_businessId_idx" ON "SLARule"("businessId");

-- CreateIndex
CREATE INDEX "Schedule_businessId_idx" ON "Schedule"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_businessId_name_key" ON "Tag"("businessId", "name");

-- CreateIndex
CREATE INDEX "TeamMember_businessId_idx" ON "TeamMember"("businessId");

-- CreateIndex
CREATE INDEX "Ticket_businessId_idx" ON "Ticket"("businessId");

-- CreateIndex
CREATE INDEX "Webhook_businessId_idx" ON "Webhook"("businessId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_businessId_idx" ON "WebhookDelivery"("businessId");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SLARule" ADD CONSTRAINT "SLARule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CannedResponse" ADD CONSTRAINT "CannedResponse_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessHours" ADD CONSTRAINT "BusinessHours_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

