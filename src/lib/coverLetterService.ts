import type { PrismaClient } from "@prisma/client";
import { generateLetterBody, letterFacts, letterTitle, parseTone, plain, type LetterOptions } from "./coverLetterGen";

/** The Prisma calls cover letters need (the real client, or an in-memory fake in tests). */
export type LetterDb = Pick<PrismaClient, "coverLetter" | "resume" | "user">;
export type LetterAi = ((prompt: string) => Promise<string | null>) | null;

export type GenerateInput = {
  tone?: unknown;
  targetRole?: string | null;
  targetCompany?: string | null;
  jobDescription?: string | null;
};

function clip(v: string | null | undefined, max: number): string | null {
  const t = plain(v ?? "").slice(0, max);
  return t || null;
}

export function letterOptions(input: GenerateInput): LetterOptions {
  return {
    tone: parseTone(input.tone),
    targetRole: clip(input.targetRole, 120),
    targetCompany: clip(input.targetCompany, 120),
    jobDescription: input.jobDescription ? String(input.jobDescription).replace(/<[^>]*>/g, "").slice(0, 8000).trim() || null : null,
  };
}

/** Creates or refreshes the cover letter linked to a resume (one letter per resume). */
export async function generateAndSaveLetter(
  db: LetterDb,
  ai: LetterAi,
  args: { userId: string; resume: { id: string; title: string; content: unknown }; input: GenerateInput }
) {
  const user = await db.user.findUnique({ where: { id: args.userId }, select: { name: true, email: true } });
  const opts = letterOptions(args.input);
  const facts = letterFacts(args.resume.content, user?.name, user?.email);
  const { body, source } = await generateLetterBody(facts, opts, ai ?? undefined);
  const data = {
    body,
    tone: opts.tone,
    targetRole: opts.targetRole ?? null,
    targetCompany: opts.targetCompany ?? null,
    jobDescription: opts.jobDescription ?? null,
    source,
    generatedAt: new Date(),
    resumeUpdatedAfter: false,
  };
  const existing = await db.coverLetter.findUnique({ where: { resumeId: args.resume.id } });
  const title = letterTitle(facts, opts, args.resume.title);
  // Keep a title the user wrote; refresh our auto title so it follows the new role / company.
  const autoTitle = (t: string) => t.startsWith("Cover Letter \u2014 ") || t === "Untitled Cover Letter" || !t.trim();
  const letter = existing
    ? await db.coverLetter.update({ where: { id: existing.id }, data: autoTitle(existing.title) ? { ...data, title } : data })
    : await db.coverLetter.create({
        data: { ...data, userId: args.userId, resumeId: args.resume.id, title },
      });
  return { letter, source };
}
