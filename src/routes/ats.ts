import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { analyzeAllAts, analyzeAts, type AtsPlatform } from "../ats/engine";
import type { ResumeDocument } from "../shared";

const resumeSchema = z.object({
  resume: z.any(),
  platform: z.enum(["indeed", "linkedin", "glassdoor"]).optional(),
});

const MAX_SECTIONS = 40;
const MAX_BODY_CHARS = 120_000;

/** Fast, local ATS parse — no Gemini, no heavy CPU. Optional auth for sync; FE can run locally. */
export async function atsRoutes(app: FastifyInstance) {
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
