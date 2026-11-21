import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { atsCheck, coverLetter, improveText, rewriteShorter, tailorForJob } from "../ai/gemini";
import type { ResumeDocument } from "../shared";

const aiHits = new Map<string, number[]>();

/** BUG-1400: per signed-in user (not per IP), per route group, per minute. */
export const AI_LIMIT_PER_MINUTE = 20;

export function rateLimited(request: FastifyRequest, reply: FastifyReply, limit = AI_LIMIT_PER_MINUTE): boolean {
  const now = Date.now();
  const key = `${request.user?.userId || request.ip || "anon"}`;
  const recent = (aiHits.get(key) ?? []).filter((stamp) => now - stamp < 60_000);
  reply.header("X-RateLimit-Limit", String(limit));
  if (recent.length >= limit) {
    aiHits.set(key, recent);
    const retry = Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000));
    reply.header("X-RateLimit-Remaining", "0").header("Retry-After", String(retry));
    reply.code(429).send({ error: "Too many AI requests. Wait a minute and try again." });
    return true;
  }
  recent.push(now);
  aiHits.set(key, recent);
  reply.header("X-RateLimit-Remaining", String(limit - recent.length));
  return false;
}

export async function aiRoutes(app: FastifyInstance) {
  // BUG-1400: every AI route needs a signed-in user (it will spend model credits).
  app.addHook("onRequest", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return reply;
  });

  app.post("/ai/improve", async (request, reply) => {
    if (rateLimited(request, reply)) return;
    const body = z.object({ resume: z.any() }).parse(request.body);
    const suggestions = await improveText(body.resume as ResumeDocument);
    return { suggestions };
  });

  app.post("/ai/rewrite", async (request, reply) => {
    if (rateLimited(request, reply)) return;
    const body = z
      .object({
        text: z.string().min(1).max(4000),
        mode: z.enum(["shorter", "longer", "improve", "grammar"]).default("shorter"),
        variant: z.number().int().min(0).max(3).optional(),
      })
      .parse(request.body);
    const text = await rewriteShorter(body.text, body.mode, body.variant ?? 0);
    return { text };
  });

  app.post("/ai/ats-check", async (request, reply) => {
    if (rateLimited(request, reply)) return;
    const body = z
      .object({ resume: z.any(), jobDescription: z.string().min(1).max(20000) })
      .parse(request.body);
    const result = await atsCheck(body.resume as ResumeDocument, body.jobDescription);
    return { result };
  });

  app.post("/ai/cover-letter", async (request, reply) => {
    if (rateLimited(request, reply)) return;
    const body = z
      .object({ resume: z.any(), jobDescription: z.string().optional() })
      .parse(request.body);
    const bodyText = await coverLetter(body.resume as ResumeDocument, body.jobDescription);
    return { body: bodyText };
  });

  app.post("/ai/tailor", async (request, reply) => {
    if (rateLimited(request, reply)) return;
    const body = z
      .object({ resume: z.any(), jobDescription: z.string().min(1).max(20000) })
      .parse(request.body);
    const advice = await tailorForJob(body.resume as ResumeDocument, body.jobDescription);
    return { advice };
  });
}
