-- BUG-315: cover letters are editable documents of their own.
-- resumeId becomes optional and deleting a resume keeps its letter (SET NULL).
ALTER TABLE "CoverLetter" DROP CONSTRAINT "CoverLetter_resumeId_fkey";
ALTER TABLE "CoverLetter" ALTER COLUMN "resumeId" DROP NOT NULL;
ALTER TABLE "CoverLetter" ADD CONSTRAINT "CoverLetter_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;
