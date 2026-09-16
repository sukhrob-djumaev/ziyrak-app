-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "BusinessHours" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "CallLog" ADD COLUMN     "businessId" TEXT,
ADD COLUMN     "conversationId" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "CannedResponse" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "ConversationTag" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "CustomerNote" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Flow" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "InternalNote" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeEntry" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "SLARule" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "TeamMember" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "businessId" TEXT;
