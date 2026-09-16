-- AlterTable: Add metadata to KnowledgeEntry (for vector embeddings)
ALTER TABLE "KnowledgeEntry" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
