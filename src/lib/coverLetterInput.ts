import { z } from "zod";

/** Cover letters are plain text: tags are stripped, length is capped (BUG-315). */
function plainText(max: number) {
  return z
    .string()
    .max(max * 2)
    .transform((value) =>
      value
        .replace(/<[^>]*>/g, "")
        .replace(/\r\n/g, "\n")
        .slice(0, max)
    );
}

export const coverLetterCreate = z.object({
  title: plainText(120).optional(),
  body: plainText(10000).optional(),
  resumeId: z.string().min(1).max(64).nullable().optional(),
});

export const coverLetterUpdate = z
  .object({
    title: plainText(120).optional(),
    body: plainText(10000).optional(),
    resumeId: z.string().min(1).max(64).nullable().optional(),
    tone: z.enum(["professional", "concise", "enthusiastic"]).optional(),
    targetRole: plainText(120).nullable().optional(),
    targetCompany: plainText(120).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

export function cleanTitle(raw: string | undefined): string {
  return (raw || "").trim().slice(0, 120) || "Untitled Cover Letter";
}

export function letterFileName(title: string): string {
  return title.replace(/[^\w\s.-]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Cover Letter";
}

/** Batch 2: generate a letter from a resume (POST /cover-letters/generate). */
export const coverLetterGenerate = z.object({
  resumeId: z.string().min(1).max(64),
  tone: z.enum(["professional", "concise", "enthusiastic"]).optional(),
  targetRole: plainText(120).nullable().optional(),
  targetCompany: plainText(120).nullable().optional(),
  jobDescription: plainText(8000).nullable().optional(),
  /** Finalize the resume first (one-click "Finalize & Generate"). */
  finalize: z.boolean().optional(),
});

export const coverLetterRegenerate = z.object({
  tone: z.enum(["professional", "concise", "enthusiastic"]).optional(),
  targetRole: plainText(120).nullable().optional(),
  targetCompany: plainText(120).nullable().optional(),
  jobDescription: plainText(8000).nullable().optional(),
});
