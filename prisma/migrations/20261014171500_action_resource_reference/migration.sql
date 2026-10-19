-- AlterTable
ALTER TABLE "ActionExecution" ADD COLUMN     "authorizationSnapshot" JSONB,
ADD COLUMN     "legacyConversationId" TEXT;

-- Preserve invalid legacy references explicitly without attaching foreign data.
UPDATE "ActionExecution" a SET "legacyConversationId"=a."conversationId", "conversationId"=NULL,
 "status"=CASE WHEN a."status" IN ('requested','pending_approval','scheduled','running') THEN 'needs_review' ELSE a."status" END
 WHERE a."conversationId" IS NOT NULL AND NOT EXISTS
 (SELECT 1 FROM "Conversation" c WHERE c."id"=a."conversationId" AND c."businessId"=a."businessId");

-- AddForeignKey
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
