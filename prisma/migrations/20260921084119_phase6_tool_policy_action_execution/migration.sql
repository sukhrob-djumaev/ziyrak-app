-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "requiresReconfirmation" BOOLEAN NOT NULL DEFAULT false;

-- Data migration (PLAN.md §46.6 task 6): automation.evaluateRules() had zero
-- runtime callers before this phase. A rule that was already isActive when
-- this migration runs must not suddenly start taking real effect on live
-- conversations — flag every such pre-existing row so evaluateRules() skips
-- it until a business explicitly re-saves it in the dashboard. Rules created
-- after this migration keep the column's default (false, no reconfirmation
-- needed), since their creator already knows automation is live.
UPDATE "AutomationRule" SET "requiresReconfirmation" = true WHERE "isActive" = true;

-- CreateTable
CREATE TABLE "ToolPolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "enabledForTenant" BOOLEAN NOT NULL DEFAULT true,
    "allowedForAI" BOOLEAN NOT NULL DEFAULT false,
    "allowedForHumanRoles" JSONB NOT NULL DEFAULT '["agent","supervisor","admin","owner"]',
    "requiresHumanApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionExecution" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "input" JSONB NOT NULL,
    "result" JSONB,
    "conversationId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolPolicy_businessId_idx" ON "ToolPolicy"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolPolicy_businessId_tool_key" ON "ToolPolicy"("businessId", "tool");

-- CreateIndex
CREATE INDEX "ActionExecution_businessId_status_idx" ON "ActionExecution"("businessId", "status");

-- CreateIndex
CREATE INDEX "ActionExecution_businessId_conversationId_idx" ON "ActionExecution"("businessId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionExecution_businessId_idempotencyKey_key" ON "ActionExecution"("businessId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ToolPolicy" ADD CONSTRAINT "ToolPolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
