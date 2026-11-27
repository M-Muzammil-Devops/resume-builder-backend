import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { coverLetter } from "../ai/gemini";
import { planSaveError } from "../lib/planAccess";
import { resumeLimitError } from "./userDashboard";
import { redactPublicContent } from "../lib/publicResume";
import { publicError } from "../lib/httpErrors";
import { storedResumeContent as storedContent, storedResumeDesign } from "../lib/resumeContent";
import { MAX_FIELD_CHARS, designError, oversizedField, oversizedHeaderField, photoUrlError } from "../lib/resumeSchema";

/** BUG-1402: one over-long field is a 400, never silently stored or truncated. */
export function tooLongError(input: { content?: unknown; design?: unknown }): string | null {
  const header = oversizedHeaderField(input.content);
  if (header) return `${header.path} is too long (max ${header.max} characters).`;
  const hit = oversizedField(input.content, MAX_FIELD_CHARS, "content") || oversizedField(input.design, 200, "design");
  return hit ? `${hit} is too long (max ${hit.startsWith("design") ? 200 : MAX_FIELD_CHARS} characters).` : null;
}
import type { ResumeDocument } from "../shared";

const SHARE_DAYS = new Set([7, 30]);

export function parseShareBody(
  body: unknown
): { enabled: boolean; expiresInDays: number | null } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid share settings." };
  const enabled = (body as { enabled?: unknown }).enabled;
  const raw = (body as { expiresInDays?: unknown }).expiresInDays;
  if (typeof enabled !== "boolean") return { error: "enabled must be true or false." };
  if (raw == null) return { enabled, expiresInDays: null };
  if (typeof raw !== "number" || !Number.isInteger(raw) || !SHARE_DAYS.has(raw)) {
    return { error: "expiresInDays must be 7, 30, or empty." };
  }
  return { enabled, expiresInDays: raw };
}

function toDoc(row: {
  id: string;
  title: string;
  templateId: string;
  layoutKey: string;
  content: unknown;
  design: unknown;
  isComplete: boolean;
  shareEnabled?: boolean;
  shareToken?: string | null;
  shareExpiresAt?: Date | null;
  updatedAt: Date;
}): ResumeDocument & {
  shareEnabled?: boolean;
  shareToken?: string | null;
  shareExpiresAt?: string | null;
} {
  return {
    id: row.id,
    title: row.title,
    templateId: row.templateId,
    layoutKey: row.layoutKey as ResumeDocument["layoutKey"],
    content: storedContent(row.content) as ResumeDocument["content"],
    design: row.design as ResumeDocument["design"],
    isComplete: row.isComplete,
    shareEnabled: row.shareEnabled ?? false,
    shareToken: row.shareToken ?? null,
    shareExpiresAt: row.shareExpiresAt ? row.shareExpiresAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function resumeRoutes(app: FastifyInstance) {
  app.get("/resumes", { preHandler: [app.authenticate] }, async (request) => {
    const rows = await prisma.resume.findMany({
      where: { userId: request.user.userId },
      orderBy: { updatedAt: "desc" },
    });
    return { resumes: rows.map(toDoc) };
  });

  app.get("/resumes/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.resume.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!row) return reply.code(404).send({ error: "Not found" });
    return { resume: toDoc(row) };
  });

  app.post("/resumes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(100),
        templateId: z.string().min(1).max(100),
        layoutKey: z.string().min(1).max(100),
        content: z.object({ sections: z.array(z.unknown()) }).passthrough(),
        design: z.record(z.unknown()).optional(),
      })
      .safeParse(request.body);
    // BUG-1103: a bad body is a 400 with a short message, never a raw Prisma/Zod dump.
    if (!body.success) return reply.code(400).send(publicError(body.error).body);
    const tooLong = tooLongError(body.data);
    if (tooLong) return reply.code(400).send({ error: tooLong });
    const invalid = designError(body.data.design) || photoUrlError(body.data.content);
    if (invalid) return reply.code(400).send({ error: invalid });

    // Free plan: the "Resumes a Free account can keep" admin setting; Pro and admins are unlimited.
    const limited = await resumeLimitError(request.user);
    if (limited) return reply.code(402).send({ error: limited });
    const denied = planSaveError(request.user.role, { sections: [] }, body.data);
    if (denied) return reply.code(402).send({ error: denied });

    const row = await prisma.resume.create({
      data: {
        userId: request.user.userId,
        title: body.data.title,
        templateId: body.data.templateId,
        layoutKey: body.data.layoutKey,
        content: storedContent(body.data.content),
        design: storedResumeDesign(body.data.design),
      },
    });
    return { resume: toDoc(row) };
  });

  app.put("/resumes/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        title: z.string().max(200).optional(),
        templateId: z.string().max(100).optional(),
        layoutKey: z.string().max(100).optional(),
        content: z.any().optional(),
        design: z.any().optional(),
        isComplete: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(publicError(parsed.error).body);
    const body = parsed.data;
    const tooLong = tooLongError(body);
    if (tooLong) return reply.code(400).send({ error: tooLong });
    const invalid = designError(body.design) || photoUrlError(body.content);
    if (invalid) return reply.code(400).send({ error: invalid });

    const existing = await prisma.resume.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const denied = planSaveError(request.user.role, existing.content, body);
    if (denied) return reply.code(402).send({ error: denied });

    const row = await prisma.resume.update({
      where: { id },
      data: {
        title:
          body.title === undefined
            ? undefined
            : body.title.trim().slice(0, 100) || "Untitled Resume",
        templateId: body.templateId,
        layoutKey: body.layoutKey,
        content: body.content === undefined ? undefined : storedContent(body.content),
        design: body.design === undefined ? undefined : storedResumeDesign(body.design),
        isComplete: body.isComplete,
      },
    });
    return { resume: toDoc(row) };
  });

  app.delete("/resumes/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.resume.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await prisma.resume.delete({ where: { id } });
    return { ok: true };
  });

  app.patch("/resumes/:id/share", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseShareBody(request.body ?? {});
    if ("error" in body) return reply.code(400).send({ error: body.error });
    const existing = await prisma.resume.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const shareExpiresAt =
      body.enabled && body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null;
    const turningOn = body.enabled && !existing.shareEnabled;
    const shareToken = body.enabled
      ? turningOn || !existing.shareToken
        ? randomBytes(24).toString("base64url")
        : existing.shareToken
      : null;
    const row = await prisma.resume.update({
      where: { id },
      data: { shareEnabled: body.enabled, shareExpiresAt, shareToken },
    });
    return { resume: toDoc(row) };
  });

  app.get("/public/resumes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.resume.findFirst({ where: { shareToken: id, shareEnabled: true } });
    if (!row) return reply.code(404).send({ error: "This resume is not shared" });
    if (row.shareExpiresAt && row.shareExpiresAt.getTime() < Date.now()) {
      return reply.code(404).send({ error: "This share link has expired" });
    }
    return {
      resume: {
        id: row.id,
        title: row.title,
        templateId: row.templateId,
        layoutKey: row.layoutKey,
        content: redactPublicContent(storedContent(row.content)),
        design: row.design,
      },
    };
  });

  app.post("/resumes/:id/complete", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ jobDescription: z.string().optional() }).parse(request.body ?? {});

    const row = await prisma.resume.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!row) return reply.code(404).send({ error: "Not found" });

    const doc = toDoc(row);
    const letterBody = await coverLetter(doc, body.jobDescription);

    const updated = await prisma.resume.update({
      where: { id },
      data: { isComplete: true },
    });

    const letter = await prisma.coverLetter.upsert({
      where: { resumeId: id },
      create: {
        userId: request.user.userId,
        resumeId: id,
        title: `Cover Letter — ${row.title}`,
        body: letterBody,
      },
      update: { body: letterBody, title: `Cover Letter — ${row.title}` },
    });

    return { resume: toDoc(updated), coverLetter: letter };
  });
}
