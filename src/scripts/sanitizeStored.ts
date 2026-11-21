import { prisma } from "../prisma";
import { cleanResumeValue } from "../lib/resumeContent";
import { sanitizeValue } from "../lib/sanitizeHtml";

async function main() {
  const rows = await prisma.resume.findMany({ select: { id: true, content: true } });
  let changed = 0;
  for (const row of rows) {
    const next = cleanResumeValue(sanitizeValue(row.content));
    if (JSON.stringify(next) === JSON.stringify(row.content)) continue;
    await prisma.resume.update({ where: { id: row.id }, data: { content: next as object } });
    changed += 1;
  }
  console.log(`Sanitized ${changed} of ${rows.length} resumes.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
