import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma";
import { docxFromText, EXPORT_MIME } from "../lib/exportFormats";
import { cleanTitle, coverLetterCreate, coverLetterUpdate, letterFileName } from "../lib/coverLetterInput";
import { publicError } from "../lib/httpErrors";

/** BUG-315: create, open, edit, delete and download cover letters. */
export async function coverLetterRoutes(app: FastifyInstance) {
  async function ownResume(userId: string, resumeId: string | null | undefined) {
    if (!resumeId) return true;
    const row = await prisma.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true } });
    return Boolean(row);
  }

  app.post("/cover-letters", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = coverLetterCreate.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(publicError(parsed.error).body);
    const { title, body, resumeId } = parsed.data;
    if (!(await ownResume(request.user.userId, resumeId))) return reply.code(404).send({ error: "Resume not found" });
    if (resumeId) {
      const taken = await prisma.coverLetter.findUnique({ where: { resumeId }, select: { id: true } });
      if (taken) return reply.code(409).send({ error: "That resume already has a cover letter" });
    }
    const letter = await prisma.coverLetter.create({
      data: {
        userId: request.user.userId,
        resumeId: resumeId || null,
        title: cleanTitle(title),
        body: body ?? "",
      },
    });
    return reply.code(201).send({ coverLetter: letter });
  });

  app.get("/cover-letters/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const letter = await prisma.coverLetter.findFirst({ where: { id, userId: request.user.userId } });
    if (!letter) return reply.code(404).send({ error: "Not found" });
    return { coverLetter: letter };
  });

  async function update(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const parsed = coverLetterUpdate.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(publicError(parsed.error).body);
    const existing = await prisma.coverLetter.findFirst({ where: { id, userId: request.user.userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const { title, body, resumeId } = parsed.data;
    if (resumeId !== undefined && !(await ownResume(request.user.userId, resumeId))) {
      return reply.code(404).send({ error: "Resume not found" });
    }
    if (resumeId && resumeId !== existing.resumeId) {
      const taken = await prisma.coverLetter.findUnique({ where: { resumeId }, select: { id: true } });
      if (taken) return reply.code(409).send({ error: "That resume already has a cover letter" });
    }
    const letter = await prisma.coverLetter.update({
      where: { id },
      data: {
        title: title === undefined ? undefined : cleanTitle(title),
        body,
        resumeId: resumeId === undefined ? undefined : resumeId,
      },
    });
    return { coverLetter: letter };
  }

  app.put("/cover-letters/:id", { preHandler: [app.authenticate] }, update);
  app.patch("/cover-letters/:id", { preHandler: [app.authenticate] }, update);

  app.delete("/cover-letters/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.coverLetter.findFirst({ where: { id, userId: request.user.userId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await prisma.coverLetter.delete({ where: { id } });
    return { ok: true };
  });

  app.get("/cover-letters/:id/download", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const format = String((request.query as { format?: string }).format || "txt").toLowerCase();
    if (format !== "txt" && format !== "docx") return reply.code(400).send({ error: "Unsupported format" });
    const letter = await prisma.coverLetter.findFirst({ where: { id, userId: request.user.userId } });
    if (!letter) return reply.code(404).send({ error: "Not found" });
    const name = letterFileName(letter.title);
    const encoded = encodeURIComponent(name);
    const text = `${letter.title}\n\n${letter.body}`.trim();
    if (format === "txt") {
      return reply
        .header("Content-Type", EXPORT_MIME.txt)
        .header("Content-Disposition", `attachment; filename="${name}.txt"; filename*=UTF-8''${encoded}.txt`)
        .send(text);
    }
    const buffer = await docxFromText(text, { pageSize: "A4" });
    return reply
      .header("Content-Type", EXPORT_MIME.docx)
      .header("Content-Disposition", `attachment; filename="${name}.docx"; filename*=UTF-8''${encoded}.docx`)
      .send(buffer);
  });
}
