-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "instanceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "buildSha" TEXT NOT NULL DEFAULT 'unknown',

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("instanceId")
);
