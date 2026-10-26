-- CreateTable
CREATE TABLE "MfaSetupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaSetupCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaSetupCode_codeHash_key" ON "MfaSetupCode"("codeHash");

-- CreateIndex
CREATE INDEX "MfaSetupCode_userId_idx" ON "MfaSetupCode"("userId");

-- AddForeignKey
ALTER TABLE "MfaSetupCode" ADD CONSTRAINT "MfaSetupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
