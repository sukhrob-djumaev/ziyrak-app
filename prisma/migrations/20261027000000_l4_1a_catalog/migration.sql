-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVersion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "grants" JSONB NOT NULL DEFAULT '[]',
    "priceMinor" INTEGER,
    "currency" TEXT,
    "interval" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_key_key" ON "CatalogItem"("key");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVersion_itemId_version_key" ON "CatalogVersion"("itemId", "version");

-- AddForeignKey
ALTER TABLE "CatalogVersion" ADD CONSTRAINT "CatalogVersion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one open draft per item.
CREATE UNIQUE INDEX "CatalogVersion_one_draft_per_item" ON "CatalogVersion"("itemId") WHERE "state" = 'draft';

-- Commercial terms are immutable once published: only published -> archived may change, and only the state/archive columns.
CREATE FUNCTION "catalog_version_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."state" <> 'draft' THEN
      RAISE EXCEPTION 'A published or archived catalog version cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."state" = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD."state" = 'published' AND NEW."state" = 'archived'
     AND NEW."itemId" = OLD."itemId" AND NEW."version" = OLD."version" AND NEW."name" = OLD."name"
     AND NEW."description" = OLD."description" AND NEW."grants" = OLD."grants"
     AND NEW."priceMinor" IS NOT DISTINCT FROM OLD."priceMinor" AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
     AND NEW."interval" IS NOT DISTINCT FROM OLD."interval" AND NEW."publishedAt" IS NOT DISTINCT FROM OLD."publishedAt"
     AND NEW."publishedBy" IS NOT DISTINCT FROM OLD."publishedBy" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A published or archived catalog version is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CatalogVersion_guard" BEFORE UPDATE OR DELETE ON "CatalogVersion"
  FOR EACH ROW EXECUTE FUNCTION "catalog_version_guard"();
