-- CreateTable
CREATE TABLE "InfrastructurePolicy" (
    "businessId" TEXT NOT NULL,
    "dataRegion" TEXT,
    "permittedAiProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permittedEmbeddingProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructurePolicy_pkey" PRIMARY KEY ("businessId")
);

-- AddForeignKey
ALTER TABLE "InfrastructurePolicy" ADD CONSTRAINT "InfrastructurePolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

