-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_customerId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationTag" DROP CONSTRAINT "ConversationTag_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationTag" DROP CONSTRAINT "ConversationTag_tagId_fkey";

-- DropForeignKey
ALTER TABLE "CustomerNote" DROP CONSTRAINT "CustomerNote_customerId_fkey";

-- DropForeignKey
ALTER TABLE "InternalNote" DROP CONSTRAINT "InternalNote_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "KnowledgeEntry" DROP CONSTRAINT "KnowledgeEntry_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "TeamMember" DROP CONSTRAINT "TeamMember_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_assignedToId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT "WebhookDelivery_webhookId_fkey";

-- CreateIndex
CREATE INDEX "CallLog_conversationId_idx" ON "CallLog"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_businessId_id_key" ON "Category"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_businessId_id_key" ON "Conversation"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_id_key" ON "Customer"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Department_businessId_id_key" ON "Department"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_businessId_id_key" ON "Tag"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_businessId_id_key" ON "TeamMember"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_businessId_id_key" ON "Webhook"("businessId", "id");

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_businessId_categoryId_fkey" FOREIGN KEY ("businessId", "categoryId") REFERENCES "Category"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_businessId_departmentId_fkey" FOREIGN KEY ("businessId", "departmentId") REFERENCES "Department"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_businessId_customerId_fkey" FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_businessId_departmentId_fkey" FOREIGN KEY ("businessId", "departmentId") REFERENCES "Department"("businessId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_businessId_assignedToId_fkey" FOREIGN KEY ("businessId", "assignedToId") REFERENCES "TeamMember"("businessId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_businessId_tagId_fkey" FOREIGN KEY ("businessId", "tagId") REFERENCES "Tag"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_businessId_teamMemberId_fkey" FOREIGN KEY ("businessId", "teamMemberId") REFERENCES "TeamMember"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_businessId_webhookId_fkey" FOREIGN KEY ("businessId", "webhookId") REFERENCES "Webhook"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_businessId_customerId_fkey" FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

