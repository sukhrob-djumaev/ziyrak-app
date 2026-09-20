-- AlterTable
ALTER TABLE "BusinessConfig" ADD COLUMN     "aiCredentialRef" TEXT,
ADD COLUMN     "embeddingCredentialRef" TEXT;

-- CreateTable
CREATE TABLE "AIInteractionLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIInteractionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIInteractionLog_businessId_createdAt_idx" ON "AIInteractionLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AIInteractionLog_conversationId_idx" ON "AIInteractionLog"("conversationId");

-- AddForeignKey
ALTER TABLE "AIInteractionLog" ADD CONSTRAINT "AIInteractionLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIInteractionLog" ADD CONSTRAINT "AIInteractionLog_businessId_conversationId_fkey" FOREIGN KEY ("businessId", "conversationId") REFERENCES "Conversation"("businessId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
