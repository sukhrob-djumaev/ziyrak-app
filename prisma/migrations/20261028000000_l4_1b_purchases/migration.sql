-- CreateTable
CREATE TABLE "WorkspacePurchase" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspacePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementAdjustment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "granted" BOOLEAN,
    "amount" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspacePurchase_businessId_state_idx" ON "WorkspacePurchase"("businessId", "state");

-- CreateIndex
CREATE INDEX "EntitlementAdjustment_businessId_expiresAt_idx" ON "EntitlementAdjustment"("businessId", "expiresAt");

-- AddForeignKey
ALTER TABLE "WorkspacePurchase" ADD CONSTRAINT "WorkspacePurchase_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspacePurchase" ADD CONSTRAINT "WorkspacePurchase_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "CatalogVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementAdjustment" ADD CONSTRAINT "EntitlementAdjustment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Shape checks.
ALTER TABLE "WorkspacePurchase" ADD CONSTRAINT "WorkspacePurchase_source_check" CHECK ("source" IN ('baseline', 'manual_test', 'provider'));
ALTER TABLE "WorkspacePurchase" ADD CONSTRAINT "WorkspacePurchase_state_check" CHECK ("state" IN ('active', 'ended'));
ALTER TABLE "WorkspacePurchase" ADD CONSTRAINT "WorkspacePurchase_quantity_check" CHECK ("quantity" >= 1 AND "quantity" <= 100000);
ALTER TABLE "WorkspacePurchase" ADD CONSTRAINT "WorkspacePurchase_ended_check" CHECK (("state" = 'ended') = ("endsAt" IS NOT NULL) OR "state" = 'active');
ALTER TABLE "EntitlementAdjustment" ADD CONSTRAINT "EntitlementAdjustment_shape_check" CHECK (("granted" IS NOT NULL AND "amount" IS NULL) OR ("granted" IS NULL AND "amount" IS NOT NULL AND "amount" >= 1));
-- The same version is held at most once at a time per workspace.
CREATE UNIQUE INDEX "WorkspacePurchase_one_active_version" ON "WorkspacePurchase"("businessId", "versionId") WHERE "state" = 'active';

-- Baseline bundle: exactly today's behaviour, not sold (price 0). Every existing workspace receives it, so nothing is
-- narrowed or billed. Later bundles are separate catalog items.
INSERT INTO "CatalogItem" ("id", "key", "kind") VALUES (gen_random_uuid()::text, 'legacy-baseline', 'bundle');
INSERT INTO "CatalogVersion" ("id", "itemId", "version", "state", "name", "description", "grants", "priceMinor", "currency", "interval", "rev", "publishedAt", "updatedAt")
SELECT gen_random_uuid()::text, i."id", 1, 'published', 'Legacy baseline', 'Everything available before packaging existed; granted to existing workspaces unchanged.',
  '[{"capability":"channel.webchat"},{"capability":"channel.whatsapp_cloud"},{"capability":"automation.rules"},{"capability":"webhooks.outbound"},{"capability":"data.export"},{"capability":"seats.members","amount":1000}]'::jsonb,
  0, 'USD', 'month', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CatalogItem" i WHERE i."key" = 'legacy-baseline';

INSERT INTO "WorkspacePurchase" ("id", "businessId", "versionId", "quantity", "source", "state", "reason")
SELECT gen_random_uuid()::text, b."id", v."id", 1, 'baseline', 'active', 'migration: existing workspace keeps current access'
FROM "Business" b CROSS JOIN (SELECT cv."id" FROM "CatalogVersion" cv JOIN "CatalogItem" ci ON ci."id" = cv."itemId" WHERE ci."key" = 'legacy-baseline' AND cv."version" = 1) v;
