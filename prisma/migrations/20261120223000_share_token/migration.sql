ALTER TABLE "Resume" ADD COLUMN IF NOT EXISTS "shareToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Resume_shareToken_key" ON "Resume"("shareToken");
