import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma";
import { EXPORT_MIME, exportErrorBody } from "../lib/exportFormats";
import {
  cleanTitle,
  coverLetterCreate,
  coverLetterGenerate,
  coverLetterRegenerate,
  coverLetterUpdate,
  letterFileName,
} from "../lib/coverLetterInput";
import { publicError } from "../lib/httpErrors";
import { coverLetterAi } from "../ai/gemini";
import { letterDocx, letterFacts, letterHtml, letterText, type LetterDoc } from "../lib/coverLetterGen";
import { generateAndSaveLetter, type LetterAi, type LetterDb } from "../lib/coverLetterService";
import { pdfFromHtml } from "../lib/letterPdf";

export type CoverLetterRouteOptions = {
  /** Tests pass an in-memory store; production uses Prisma. */
  db?: LetterDb;
  pdf?: (html: string, pageSize: "A4" | "US Letter") => Promise<Buffer>;
  /** null = never call Gemini (template only). */
  ai?: LetterAi;
};

const RESUME_BRIEF = { id: true, title: true, isComplete: true, updatedAt: true } as const;

function pageSizeOf(design: unknown): "A4" | "US Letter" {
  return design && typeof design === "object" && (design as { pageSize?: unknown }).pageSize === "US Letter" ? "US Letter" : "A4";
}

/** BUG-315 + Batch 2: create, generate from a finalized resume, edit, delete and download cover letters. */
export async function coverLetterRoutes(app: FastifyInstance, opts: CoverLetterRouteOptions = {}) {
  const db = (opts.db ?? prisma) as LetterDb;
  const renderPdf = opts.pdf ?? pdfFromHtml;
  const ai: LetterAi = opts.ai === undefined ? coverLetterAi : opts.ai;

  async function ownResume(userId: string, resumeId: string | null | undefined) {
    if (!resumeId) return true;
    const row = await db.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true } });
    return Boolean(row);
  }

  app.post("/cover-letters", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = coverLetterCreate.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(publicError(parsed.error).body);
    const { title, body, resumeId } = parsed.data;
    if (!(await ownResume(request.user.userId, resumeId))) return reply.code(404).send({ error: "Resume not found" });
    if (resumeId) {
      const taken = await db.coverLetter.findUnique({ where: { resumeId }, select: { id: true } });
      if (taken) return reply.code(409).send({ error: "That resume already has a cover letter" });
    }
    const letter = await db.coverLetter.create({
      data: {
        userId: request.user.userId,
        resumeId: resumeId || null,
        title: cleanTitle(title),
        body: body ?? "",
      },
    });
    return reply.code(201).send({ coverLetter: letter });
  });

  /** Batch 2: build (or rebuild) the letter for a finalized resume. `finalize: true` finalizes it first. */
  app.post("/cover-letters/generate", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = coverLetterGenerate.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(publicError(parsed.error).body);
    const input = parsed.data;
    const userId = request.user.userId;
    const resume = await db.resume.findFirst({
      where: { id: input.resumeId, userId },
      select: { id: true, title: true, content: true, isComplete: true },
    });
    if (!resume) return reply.code(404).send({ error: "Resume not found" });
    if (!resume.isComplete) {
      if (!input.finalize) {
        return reply.code(409).send({
          error: "Finalize this resume first",
          code: "RESUME_NOT_FINALIZED",
          message: "Cover letters are written from a finalized resume. Finalize it, then generate.",
        });
      }
      await db.resume.update({ where: { id: resume.id }, data: { isComplete: true } });
    }
    const { letter, source } = await generateAndSaveLetter(db, ai, { userId, resume, input });
    return reply.code(201).send({ coverLetter: letter, source, resume: { id: resume.id, isComplete: true } });
  });

  app.post("/cover-letters/:id/regenerate", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = coverLetterRegenerate.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(publicError(parsed.error).body);
    const userId = request.user.userId;
    const existing = await db.coverLetter.findFirst({ where: { id, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    if (!existing.resumeId) {
      return reply.code(409).send({ error: "Link a resume first", code: "NO_RESUME", message: "This letter is not linked to a resume." });
    }
    const resume = await db.resume.findFirst({
      where: { id: existing.resumeId, userId },
      select: { id: true, title: true, content: true, isComplete: true },
    });
    if (!resume) return reply.code(404).send({ error: "Resume not found" });
    const body = parsed.data;
    const { letter, source } = await generateAndSaveLetter(db, ai, {
      userId,
      resume,
      input: {
        tone: body.tone ?? existing.tone,
        targetRole: body.targetRole === undefined ? existing.targetRole : body.targetRole,
        targetCompany: body.targetCompany === undefined ? existing.targetCompany : body.targetCompany,
        jobDescription: body.jobDescription === undefined ? existing.jobDescription : body.jobDescription,
      },
    });
    return { coverLetter: letter, source };
  });

  app.get("/cover-letters/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const letter = await db.coverLetter.findFirst({
      where: { id, userId: request.user.userId },
      include: { resume: { select: RESUME_BRIEF } },
    });
    if (!letter) return reply.code(404).send({ error: "Not found" });
    return { coverLetter: letter };
  });

  async function update(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const parsed = coverLetterUpdate.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(publicError(parsed.error).body);
    const existing = await db.coverLetter.findFirst({ where: { id, userId: request.user.userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const { title, body, resumeId, tone, targetRole, targetCompany } = parsed.data;
    if (resumeId !== undefined && !(await ownResume(request.user.userId, resumeId))) {
      return reply.code(404).send({ error: "Resume not found" });
    }
    if (resumeId && resumeId !== existing.resumeId) {
      const taken = await db.coverLetter.findUnique({ where: { resumeId }, select: { id: true } });
      if (taken) return reply.code(409).send({ error: "That resume already has a cover letter" });
    }
    const letter = await db.coverLetter.update({
      where: { id },
      data: {
        title: title === undefined ? undefined : cleanTitle(title),
        body,
        resumeId: resumeId === undefined ? undefined : resumeId,
        tone,
        targetRole: targetRole === undefined ? undefined : targetRole?.trim() || null,
        targetCompany: targetCompany === undefined ? undefined : targetCompany?.trim() || null,
      },
    });
    return { coverLetter: letter };
  }

  app.put("/cover-letters/:id", { preHandler: [app.authenticate] }, update);
  app.patch("/cover-letters/:id", { preHandler: [app.authenticate] }, update);

  app.delete("/cover-letters/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await db.coverLetter.findFirst({ where: { id, userId: request.user.userId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await db.coverLetter.delete({ where: { id } });
    return { ok: true };
  });

  app.get("/cover-letters/:id/download", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const format = String((request.query as { format?: string }).format || "txt").toLowerCase();
    if (format !== "txt" && format !== "docx" && format !== "pdf") return reply.code(400).send({ error: "Unsupported format" });
    const userId = request.user.userId;
    const letter = await db.coverLetter.findFirst({ where: { id, userId } });
    if (!letter) return reply.code(404).send({ error: "Not found" });
    const resume = letter.resumeId
      ? await db.resume.findFirst({ where: { id: letter.resumeId, userId }, select: { content: true, design: true } })
      : null;
    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const doc: LetterDoc = {
      title: letter.title,
      body: letter.body,
      facts: letterFacts(resume?.content ?? null, user?.name, user?.email),
      targetCompany: letter.targetCompany,
      targetRole: letter.targetRole,
      date: letter.generatedAt ?? letter.updatedAt ?? new Date(),
      pageSize: pageSizeOf(resume?.design),
    };
    const name = letterFileName(letter.title);
    const base = /cover letter/i.test(name) ? name.replace(/\s+/g, "_") : `${name.replace(/\s+/g, "_")}_Cover_Letter`;
    const encoded = encodeURIComponent(base);
    const disposition = (ext: string) => `attachment; filename="${base}.${ext}"; filename*=UTF-8''${encoded}.${ext}`;
    if (format === "txt") {
      return reply.header("Content-Type", EXPORT_MIME.txt).header("Content-Disposition", disposition("txt")).send(letterText(doc));
    }
    if (format === "docx") {
      const buffer = await letterDocx(doc);
      return reply.header("Content-Type", EXPORT_MIME.docx).header("Content-Disposition", disposition("docx")).send(buffer);
    }
    try {
      const pdf = await renderPdf(letterHtml(doc), doc.pageSize ?? "A4");
      return reply.header("Content-Type", "application/pdf").header("Content-Disposition", disposition("pdf")).send(pdf);
    } catch (err) {
      request.log.error({ err }, "Cover letter PDF failed");
      return reply.code(500).send(exportErrorBody(err));
    }
  });
}
