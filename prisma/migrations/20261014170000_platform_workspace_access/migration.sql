-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('super_admin', 'operator');

-- CreateEnum
CREATE TYPE "ResourceScopeMode" AS ENUM ('workspace', 'connections', 'unclassified');

-- CreateEnum
CREATE TYPE "ApiKeyScopeOrigin" AS ENUM ('unclassified', 'legacy_workspace', 'issuer');

-- CreateEnum
CREATE TYPE "CustomerProfileAccess" AS ENUM ('none', 'read', 'write');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "customerProfileAccess" "CustomerProfileAccess" NOT NULL DEFAULT 'none',
ADD COLUMN     "issuedByUserId" TEXT,
ADD COLUMN     "scopeMode" "ResourceScopeMode" NOT NULL DEFAULT 'unclassified',
ADD COLUMN     "scopeOrigin" "ApiKeyScopeOrigin" NOT NULL DEFAULT 'unclassified';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "customerProfileAccess" "CustomerProfileAccess" NOT NULL DEFAULT 'write',
ADD COLUMN     "scopeMode" "ResourceScopeMode" NOT NULL DEFAULT 'workspace';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "platformRole" "PlatformRole";

-- CreateTable
CREATE TABLE "PlatformControl" (
    "id" TEXT NOT NULL,
    "superAdminUserId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipConnectionScope" (
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,

    CONSTRAINT "MembershipConnectionScope_pkey" PRIMARY KEY ("businessId","membershipId","connectionId")
);

-- CreateTable
CREATE TABLE "ApiKeyConnectionScope" (
    "businessId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyConnectionScope_pkey" PRIMARY KEY ("businessId","apiKeyId","connectionId")
);

-- CreateTable
CREATE TABLE "PlatformAssignment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "allowedOperations" TEXT[],
    "scopeMode" "ResourceScopeMode" NOT NULL,
    "customerProfileAccess" "CustomerProfileAccess" NOT NULL DEFAULT 'none',
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentConnectionScope" (
    "businessId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,

    CONSTRAINT "AssignmentConnectionScope_pkey" PRIMARY KEY ("businessId","assignmentId","connectionId")
);

-- CreateTable
CREATE TABLE "SupportGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "requestId" TEXT NOT NULL,
    "allowedOperations" TEXT[],
    "scopeMode" "ResourceScopeMode" NOT NULL,
    "customerProfileAccess" "CustomerProfileAccess" NOT NULL DEFAULT 'none',
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrantConnectionScope" (
    "businessId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,

    CONSTRAINT "GrantConnectionScope_pkey" PRIMARY KEY ("businessId","grantId","connectionId")
);

-- CreateTable
CREATE TABLE "PlatformAccessAudit" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "businessId" TEXT,
    "workspaceId" TEXT,
    "grantId" TEXT,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAccessAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformControl_superAdminUserId_key" ON "PlatformControl"("superAdminUserId");

-- CreateIndex
CREATE INDEX "PlatformAssignment_operatorUserId_businessId_idx" ON "PlatformAssignment"("operatorUserId", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAssignment_businessId_operatorUserId_id_key" ON "PlatformAssignment"("businessId", "operatorUserId", "id");

-- CreateIndex
CREATE INDEX "SupportGrant_actorUserId_businessId_expiresAt_idx" ON "SupportGrant"("actorUserId", "businessId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportGrant_businessId_id_key" ON "SupportGrant"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportGrant_actorUserId_requestId_key" ON "SupportGrant"("actorUserId", "requestId");

-- CreateIndex
CREATE INDEX "PlatformAccessAudit_actorUserId_createdAt_idx" ON "PlatformAccessAudit"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAccessAudit_businessId_createdAt_idx" ON "PlatformAccessAudit"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_businessId_id_key" ON "Membership"("businessId", "id");

-- AddForeignKey
ALTER TABLE "PlatformControl" ADD CONSTRAINT "PlatformControl_superAdminUserId_fkey" FOREIGN KEY ("superAdminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipConnectionScope" ADD CONSTRAINT "MembershipConnectionScope_businessId_membershipId_fkey" FOREIGN KEY ("businessId", "membershipId") REFERENCES "Membership"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipConnectionScope" ADD CONSTRAINT "MembershipConnectionScope_businessId_connectionId_fkey" FOREIGN KEY ("businessId", "connectionId") REFERENCES "ChannelConnection"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyConnectionScope" ADD CONSTRAINT "ApiKeyConnectionScope_businessId_apiKeyId_fkey" FOREIGN KEY ("businessId", "apiKeyId") REFERENCES "ApiKey"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyConnectionScope" ADD CONSTRAINT "ApiKeyConnectionScope_businessId_connectionId_fkey" FOREIGN KEY ("businessId", "connectionId") REFERENCES "ChannelConnection"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAssignment" ADD CONSTRAINT "PlatformAssignment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAssignment" ADD CONSTRAINT "PlatformAssignment_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentConnectionScope" ADD CONSTRAINT "AssignmentConnectionScope_businessId_operatorUserId_assign_fkey" FOREIGN KEY ("businessId", "operatorUserId", "assignmentId") REFERENCES "PlatformAssignment"("businessId", "operatorUserId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentConnectionScope" ADD CONSTRAINT "AssignmentConnectionScope_businessId_connectionId_fkey" FOREIGN KEY ("businessId", "connectionId") REFERENCES "ChannelConnection"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportGrant" ADD CONSTRAINT "SupportGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportGrant" ADD CONSTRAINT "SupportGrant_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportGrant" ADD CONSTRAINT "SupportGrant_businessId_actorUserId_assignmentId_fkey" FOREIGN KEY ("businessId", "actorUserId", "assignmentId") REFERENCES "PlatformAssignment"("businessId", "operatorUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantConnectionScope" ADD CONSTRAINT "GrantConnectionScope_businessId_grantId_fkey" FOREIGN KEY ("businessId", "grantId") REFERENCES "SupportGrant"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantConnectionScope" ADD CONSTRAINT "GrantConnectionScope_businessId_connectionId_fkey" FOREIGN KEY ("businessId", "connectionId") REFERENCES "ChannelConnection"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAccessAudit" ADD CONSTRAINT "PlatformAccessAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAccessAudit" ADD CONSTRAINT "PlatformAccessAudit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAccessAudit" ADD CONSTRAINT "PlatformAccessAudit_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "SupportGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Explicit classification preserves legitimate previously-created bounded agent/viewer keys.
-- Unexpected elevated roles are not converted into new authority.
UPDATE "ApiKey" SET "scopeMode"='workspace', "scopeOrigin"='legacy_workspace', "customerProfileAccess"='write'
 WHERE "role" IN ('agent','viewer');
UPDATE "ApiKey" SET "isActive"=false, "scopeMode"='unclassified', "scopeOrigin"='unclassified'
 WHERE "role" NOT IN ('agent','viewer');
CREATE UNIQUE INDEX "User_single_super_admin" ON "User" ("platformRole") WHERE "platformRole"='super_admin';
ALTER TABLE "PlatformControl" ADD CONSTRAINT "PlatformControl_singleton" CHECK ("id"='authority');
