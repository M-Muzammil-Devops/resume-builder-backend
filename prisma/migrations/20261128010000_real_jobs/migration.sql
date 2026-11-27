-- Batch 4: real job feeds + tracker polish (additive only).
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'catalog';
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "salary" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "niceKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "postedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "fetchedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
UPDATE "Job" SET "source" = 'custom' WHERE "department" = 'Custom' AND "source" = 'catalog';
CREATE UNIQUE INDEX IF NOT EXISTS "Job_source_externalId_key" ON "Job"("source", "externalId");
CREATE INDEX IF NOT EXISTS "Job_source_active_idx" ON "Job"("source", "active");

CREATE TABLE IF NOT EXISTS "JobFeedState" (
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    CONSTRAINT "JobFeedState_pkey" PRIMARY KEY ("source")
);

ALTER TABLE "JobApplication" ADD COLUMN IF NOT EXISTS "resumeId" TEXT;
ALTER TABLE "JobApplication" ADD COLUMN IF NOT EXISTS "atsMatch" INTEGER;
ALTER TABLE "JobApplication" ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3);
ALTER TABLE "JobApplication" ADD COLUMN IF NOT EXISTS "followUpAt" TIMESTAMP(3);
UPDATE "JobApplication" SET "appliedAt" = "updatedAt" WHERE "stage" = 'applied' AND "appliedAt" IS NULL;
DO $$ BEGIN
  ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
