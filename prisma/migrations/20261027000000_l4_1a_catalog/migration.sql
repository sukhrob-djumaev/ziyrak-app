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

-- Shape checks: nothing outside the lifecycle vocabulary, and a published/archived version is always fully priced with grants.
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_kind_check" CHECK ("kind" IN ('bundle', 'addon'));
ALTER TABLE "CatalogVersion" ADD CONSTRAINT "CatalogVersion_state_check" CHECK ("state" IN ('draft', 'published', 'archived'));
ALTER TABLE "CatalogVersion" ADD CONSTRAINT "CatalogVersion_interval_check" CHECK ("interval" IS NULL OR "interval" IN ('month', 'year'));
ALTER TABLE "CatalogVersion" ADD CONSTRAINT "CatalogVersion_sellable_check" CHECK (
  "state" = 'draft' OR (
    "priceMinor" IS NOT NULL AND "currency" IS NOT NULL AND "interval" IS NOT NULL AND "publishedAt" IS NOT NULL
    AND jsonb_typeof("grants") = 'array' AND jsonb_array_length("grants") > 0
    AND ("state" <> 'archived' OR "archivedAt" IS NOT NULL)
  )
);

-- Commercial terms are immutable once published: from draft only draft or published is reachable; from published only archived,
-- changing nothing but state, archivedAt and updatedAt; archived is final; non-drafts cannot be deleted or truncated.
CREATE FUNCTION "catalog_version_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."state" <> 'draft' THEN
      RAISE EXCEPTION 'A published or archived catalog version cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."state" = 'draft' THEN
    IF NEW."state" = 'archived' THEN
      RAISE EXCEPTION 'A draft cannot be archived' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" = 'published' AND NEW."state" = 'archived'
     AND NEW."id" = OLD."id" AND NEW."itemId" = OLD."itemId" AND NEW."version" = OLD."version" AND NEW."name" = OLD."name"
     AND NEW."description" = OLD."description" AND NEW."grants" = OLD."grants"
     AND NEW."priceMinor" IS NOT DISTINCT FROM OLD."priceMinor" AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
     AND NEW."interval" IS NOT DISTINCT FROM OLD."interval" AND NEW."rev" = OLD."rev"
     AND NEW."publishedAt" IS NOT DISTINCT FROM OLD."publishedAt" AND NEW."publishedBy" IS NOT DISTINCT FROM OLD."publishedBy"
     AND NEW."createdBy" IS NOT DISTINCT FROM OLD."createdBy" AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A published or archived catalog version is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CatalogVersion_guard" BEFORE UPDATE OR DELETE ON "CatalogVersion"
  FOR EACH ROW EXECUTE FUNCTION "catalog_version_guard"();

-- An item's key and kind never change (a bundle cannot become an add-on after being sold).
CREATE FUNCTION "catalog_item_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."key" <> OLD."key" OR NEW."kind" <> OLD."kind" OR NEW."id" <> OLD."id" THEN
    RAISE EXCEPTION 'A catalog item key and kind are permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CatalogItem_guard" BEFORE UPDATE ON "CatalogItem"
  FOR EACH ROW EXECUTE FUNCTION "catalog_item_guard"();

CREATE FUNCTION "catalog_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Catalog history cannot be truncated' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

-- contract-migration: guard trigger on a table created in this migration; it only blocks TRUNCATE and nothing in the previous release uses the table
CREATE TRIGGER "CatalogVersion_no_truncate" BEFORE TRUNCATE ON "CatalogVersion" FOR EACH STATEMENT EXECUTE FUNCTION "catalog_no_truncate"();
-- contract-migration: guard trigger on a table created in this migration; it only blocks TRUNCATE and nothing in the previous release uses the table
CREATE TRIGGER "CatalogItem_no_truncate" BEFORE TRUNCATE ON "CatalogItem" FOR EACH STATEMENT EXECUTE FUNCTION "catalog_no_truncate"();
