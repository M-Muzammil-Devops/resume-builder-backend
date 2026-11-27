import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { analyzeAllAts, analyzeAts, jobDescriptionRejection, type AtsPlatform } from "../ats/engine";
import { analyzeAdvancedAts, buildModel } from "../ats/advanced";
import { rewriteForAts, type RewriteAi } from "../ats/rewrite";
import { atsKeywordsAi, atsRewriteAi } from "../ai/gemini";
import { prisma } from "../prisma";
import type { ResumeDocument } from "../shared";

export type AtsRouteOptions = {
  /** Tests pass an in-memory store; production uses Prisma. */
  db?: Pick<PrismaClient, "resume">;
  /** null = never call Gemini (deterministic engine only). */
  ai?: { rewrite: RewriteAi; keywords: ((jd: string) => Promise<string[] | null>) | null } | null;
};

const analyzeBody = z
  .object({
    resumeId: z.string().min(1).max(64).optional(),
    /** The editor's current (maybe unsaved) resume; falls back to the saved one. */
    resume: z.object({ content: z.any() }).passthrough().optional(),
    jobDescription: z.string().max(20000).optional().nullable(),
    targetRole: z.string().max(120).optional().nullable(),
  })
  .refine((v) => v.resumeId || v.resume, "resumeId or resume is required");

const rewriteBody = z.object({
  resumeId: z.string().min(1).max(64),
  section: z.enum(["header", "summary", "experience", "education", "skills", "projects", "general"]),
  text: z.string().min(1).max(4000),
  jobDescription: z.string().max(20000).optional().nullable(),
  issueTitle: z.string().max(300).optional().nullable(),
});

/** Small per-user limiter so a stuck button cannot hammer Gemini. */
function limiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length > perMinute;
  };
}

const resumeSchema = z.object({
  resume: z.any(),
  platform: z.enum(["indeed", "linkedin", "glassdoor"]).optional(),
});

const MAX_SECTIONS = 40;
const MAX_BODY_CHARS = 120_000;

/** Fast, local ATS parse — no Gemini, no heavy CPU. Optional auth for sync; FE can run locally.
 *  Batch 3: + POST /ats/analyze (4-layer Advanced ATS Checker) and POST /ats/rewrite (Fix with AI), both JWT. */
export async function atsRoutes(app: FastifyInstance, opts: AtsRouteOptions = {}) {
  const db = (opts.db ?? prisma) as Pick<PrismaClient, "resume">;
  const ai = opts.ai === undefined ? { rewrite: atsRewriteAi as RewriteAi, keywords: atsKeywordsAi } : opts.ai;
  const analyzeLimited = limiter(60);
  const rewriteLimited = limiter(30);

  async function ownResume(userId: string, id: string) {
    return db.resume.findFirst({ where: { id, userId }, select: { id: true, content: true } });
  }

  app.post("/ats/analyze", { preHandler: [app.authenticate], bodyLimit: 512_000 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user.userId;
    if (analyzeLimited(userId)) return reply.code(429).send({ error: "Too many checks. Wait a minute and try again." });
    const parsed = analyzeBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Send resumeId or resume, and an optional job description." });
    const input = parsed.data;
    let content: unknown = input.resume?.content;
    if (input.resumeId) {
      const row = await ownResume(userId, input.resumeId);
      if (!row) return reply.code(404).send({ error: "Resume not found" });
      content ??= row.content;
    }
    if (!content || typeof content !== "object" || !Array.isArray((content as { sections?: unknown }).sections)) {
      return reply.code(400).send({ error: "resume.content.sections required" });
    }
    if ((content as { sections: unknown[] }).sections.length > MAX_SECTIONS) return reply.code(400).send({ error: "Too many sections" });
    const jd = (input.jobDescription ?? "").trim();
    if (jd) {
      const rejection = jobDescriptionRejection(jd);
      if (rejection) return reply.code(422).send({ error: rejection, code: "JD_REJECTED" });
    }
    let aiKeywords: string[] | null = null;
    if (jd && ai?.keywords) {
      try {
        aiKeywords = await ai.keywords(jd);
      } catch {
        aiKeywords = null;
      }
    }
    const result = analyzeAdvancedAts(content, { jobDescription: jd || null, targetRole: input.targetRole ?? null, aiKeywords });
    return { result };
  });

  app.post("/ats/rewrite", { preHandler: [app.authenticate], bodyLimit: 64_000 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user.userId;
    if (rewriteLimited(userId)) return reply.code(429).send({ error: "Too many rewrites. Wait a minute and try again." });
    const parsed = rewriteBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Send resumeId, section and text." });
    const row = await ownResume(userId, parsed.data.resumeId);
    if (!row) return reply.code(404).send({ error: "Resume not found" });
    const role = buildModel(row.content).headline || null;
    const result = await rewriteForAts({ ...parsed.data, role }, ai?.rewrite ?? null);
    return result;
  });

  app.post(
    "/ats/preview",
    { bodyLimit: 256_000 },
    async (request, reply) => {
      const raw = JSON.stringify(request.body ?? {});
      if (raw.length > MAX_BODY_CHARS) {
        return reply.code(413).send({ error: "Payload too large" });
      }

      const parsed = resumeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid resume payload" });
      }
      const doc = parsed.data.resume as ResumeDocument;
      if (!doc?.content?.sections || !Array.isArray(doc.content.sections)) {
        return reply.code(400).send({ error: "resume.content.sections required" });
      }
      if (doc.content.sections.length > MAX_SECTIONS) {
        return reply.code(400).send({ error: "Too many sections" });
      }

      if (parsed.data.platform) {
        return { result: analyzeAts(doc, parsed.data.platform as AtsPlatform) };
      }
      return { results: analyzeAllAts(doc) };
    }
  );
}
