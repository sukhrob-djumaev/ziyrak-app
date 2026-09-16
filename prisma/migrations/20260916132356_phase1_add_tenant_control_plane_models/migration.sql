-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "businessId" TEXT;

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantPlacement" (
    "businessId" TEXT NOT NULL,
    "databaseProfileId" TEXT NOT NULL DEFAULT 'shared-default',
    "storageProfileId" TEXT NOT NULL DEFAULT 'shared-default',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantPlacement_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "DatabaseProfile" (
    "id" TEXT NOT NULL,
    "connectionSecretRef" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'us',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatabaseProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageProfile" (
    "id" TEXT NOT NULL,
    "credentialSecretRef" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'us',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessConfig" (
    "businessId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL DEFAULT 'My Business',
    "businessDesc" TEXT NOT NULL DEFAULT '',
    "welcomeMessage" TEXT NOT NULL DEFAULT 'Hello! How can I help you today?',
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "language" TEXT NOT NULL DEFAULT 'auto',
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "embeddingProvider" TEXT,
    "maxTokens" INTEGER,
    "temperature" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessConfig_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "config" JSONB NOT NULL DEFAULT '{}',
    "credentialRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Business_slug_key" ON "Business"("slug");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_businessId_userId_key" ON "Membership"("businessId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "ChannelConnection_businessId_type_idx" ON "ChannelConnection"("businessId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_businessId_id_key" ON "ChannelConnection"("businessId", "id");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantPlacement" ADD CONSTRAINT "TenantPlacement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessConfig" ADD CONSTRAINT "BusinessConfig_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the control-plane "shared-default" profiles (PLAN.md §13.2 step 2b).
-- Every business without a Phase-9 override resolves to these two rows, which
-- point (via the SecretResolver boundary, §10.3/§7.6) at the exact same
-- Postgres connection / storage config the application already uses directly
-- today — no new physical infrastructure, no new secret, just a symbolic
-- reference so the control-plane/data-plane split (§7.4) is real in the
-- schema from Phase 1 onward. Idempotent: safe on a fresh (CI) database and
-- safe to re-run.
INSERT INTO "DatabaseProfile" ("id", "connectionSecretRef", "region")
VALUES ('shared-default', 'env:DATABASE_URL', 'us')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "StorageProfile" ("id", "credentialSecretRef", "bucket", "region")
VALUES ('shared-default', 'env:STORAGE_DEFAULT', 'shared-default', 'us')
ON CONFLICT ("id") DO NOTHING;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
