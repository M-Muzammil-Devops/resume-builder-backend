-- Batch 2: auto cover letter (additive only).
ALTER TABLE "CoverLetter" ADD COLUMN IF NOT EXISTS "tone" TEXT NOT NULL DEFAULT 'professional';
ALTER TABLE "CoverLetter" ADD COLUMN IF NOT EXISTS "targetRole" TEXT;
ALTER TABLE "CoverLetter" ADD COLUMN IF NOT EXISTS "targetCompany" TEXT;
ALTER TABLE "CoverLetter" ADD COLUMN IF NOT EXISTS "jobDescription" TEXT;
ALTER TABLE "CoverLetter" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "CoverLetter" ADD COLUMN IF NOT EXISTS "generatedAt" TIMESTAMP(3);
ALTER TABLE "CoverLetter" ADD COLUMN IF NOT EXISTS "resumeUpdatedAfter" BOOLEAN NOT NULL DEFAULT false;
