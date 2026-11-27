-- Admin Dashboard v2 step 2: audio job log (additive only; Admin Settings reuse the existing AppSetting table).
CREATE TABLE IF NOT EXISTS "AudioJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "mode" TEXT NOT NULL,
    "strength" INTEGER,
    "outputFormat" TEXT,
    "inputExt" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "durationSec" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "engine" TEXT,
    "processingMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AudioJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AudioJob_createdAt_idx" ON "AudioJob"("createdAt");
CREATE INDEX IF NOT EXISTS "AudioJob_status_createdAt_idx" ON "AudioJob"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "AudioJob_userId_idx" ON "AudioJob"("userId");

