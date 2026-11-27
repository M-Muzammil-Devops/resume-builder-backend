import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { publicError } from "../lib/httpErrors";
import { getAdminSettings } from "../lib/appSettings";
import { exportLimitFor, exportPlanOf, getExportSettings, startOfUtcMonth } from "../lib/exportSettings";
import { profileSteps, resumeReadiness, starterTexts, startOfNextUtcMonth } from "../lib/dashboardSummary";
import { storedResumeContent, storedResumeDesign } from "../lib/resumeContent";
import { planSaveError } from "../lib/planAccess";

/** Resumes an account may keep: Free = admin setting (0 = unlimited), Pro and admins = unlimited. */
export async function resumeLimitFor(role: string | null | undefined, billingPlan: string | null | undefined): Promise<number> {
  if (exportPlanOf(role, billingPlan) !== "free") return 0;
  try {
    return (await getAdminSettings()).freeLimits.maxResumes;
  } catch {
    return 1;
  }
}

/** 402 message when a new resume would pass the plan limit, else null. */
export async function resumeLimitError(user: { userId: string; role?: string }): Promise<string | null> {
  if (user.role === "admin") return null;
  const account = await prisma.user.findUnique({ where: { id: user.userId }, select: { plan: true } });
  const limit = await resumeLimitFor(user.role, account?.plan);
  if (!limit) return null;
  const count = await prisma.resume.count({ where: { userId: user.userId } });
  if (count < limit) return null;
  return `Your Free plan includes ${limit} resume${limit === 1 ? "" : "s"}. Upgrade to Pro, or delete one to make room.`;
}

function iso(d: Date | null | undefined) {
  return d ? d.toISOString() : null;
}

export async function userDashboardRoutes(app: FastifyInstance) {
  /** Everything the User Dashboard v2 shows, from the signed-in user's own rows only. */
  app.get("/user/dashboard-summary", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, plan: true, location: true, city: true, country: true, emailVerifiedAt: true, createdAt: true },
    });
    if (!user) return reply.code(401).send({ error: "Unauthorized" });

    const monthStart = startOfUtcMonth();
    const [resumes, coverLetterCount, pdfThisMonth, pdfEver, audioRows, exportRows, audioRecent, exportSettings, resumeLimit] = await Promise.all([
      prisma.resume.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, templateId: true, layoutKey: true, content: true, design: true, isComplete: true, createdAt: true, updatedAt: true },
      }),
      prisma.coverLetter.count({ where: { userId } }),
      prisma.exportEvent.count({ where: { userId, format: "pdf", createdAt: { gte: monthStart } } }),
      prisma.exportEvent.count({ where: { userId, format: "pdf" } }),
      prisma.audioJob.findMany({ where: { userId, status: "done", createdAt: { gte: monthStart } }, select: { durationSec: true } }).catch(() => []),
      prisma.exportEvent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, resumeId: true, format: true, pageSize: true, createdAt: true } }),
      prisma.audioJob
        .findMany({ where: { userId, status: "done" }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, mode: true, outputFormat: true, durationSec: true, createdAt: true } })
        .catch(() => []),
      getExportSettings(),
      resumeLimitFor(user.role, user.plan),
    ]);

    let audioLimit = 0;
    try {
      audioLimit = exportPlanOf(user.role, user.plan) === "free" ? (await getAdminSettings()).freeLimits.audioMinutesPerMonth : 0;
    } catch {
      audioLimit = 0;
    }

    const cards = resumes.map((r) => {
      const { score, checks, headline } = resumeReadiness(r.content, starterTexts(r.templateId));
      const design = (r.design && typeof r.design === "object" ? r.design : {}) as { accentColor?: unknown };
      return {
        id: r.id,
        title: r.title,
        headline,
        templateId: r.templateId,
        layoutKey: r.layoutKey,
        accentColor: typeof design.accentColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(design.accentColor) ? design.accentColor : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        isComplete: r.isComplete,
        score,
        status: r.isComplete || score >= 80 ? "ready" : "draft",
        missing: checks.filter((c) => !c.done).map((c) => c.label),
      };
    });

    const titles = new Map(resumes.map((r) => [r.id, r.title]));
    const downloads = [
      ...exportRows.map((e) => ({
        id: e.id,
        kind: "resume" as const,
        resumeId: e.resumeId && titles.has(e.resumeId) ? e.resumeId : null,
        title: (e.resumeId && titles.get(e.resumeId)) || "Deleted resume",
        format: e.format,
        pageSize: e.pageSize,
        createdAt: e.createdAt.toISOString(),
      })),
      ...audioRecent.map((a) => ({
        id: a.id,
        kind: "audio" as const,
        resumeId: null,
        title: `Cleaned audio${a.outputFormat ? ` (.${a.outputFormat})` : ""}`,
        format: a.outputFormat || "audio",
        pageSize: null,
        durationSec: a.durationSec ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6);

    const best = cards.reduce((m, c) => Math.max(m, c.score), 0);
    const profile = profileSteps({
      name: user.name,
      location: user.location || user.city || user.country,
      emailVerified: Boolean(user.emailVerifiedAt),
      resumeCount: resumes.length,
      bestScore: best,
      pdfExportsEver: pdfEver,
    });
    const audioSeconds = audioRows.reduce((sum, a) => sum + (a.durationSec ?? 0), 0);

    reply.header("Cache-Control", "no-store");
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan === "PRO" ? "PRO" : "FREE", createdAt: iso(user.createdAt) },
      profileCompletionPct: profile.pct,
      profileSteps: profile.steps,
      usage: {
        plan: exportPlanOf(user.role, user.plan) === "free" ? "FREE" : user.role === "admin" ? "ADMIN" : "PRO",
        resetsAt: startOfNextUtcMonth().toISOString(),
        pdfExportsUsed: pdfThisMonth,
        pdfExportsLimit: exportLimitFor(exportSettings, user.role, user.plan),
        audioMinutesUsed: Math.round((audioSeconds / 60) * 10) / 10,
        audioMinutesLimit: audioLimit,
        resumesUsed: resumes.length,
        resumesLimit: resumeLimit,
      },
      coverLetterCount,
      resumes: cards,
      downloads,
    };
  });

  /** Rename (title only). PUT /resumes/:id stays the full editor save. */
  app.patch("/resumes/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ title: z.string().max(200) }).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(publicError(body.error).body);
    const existing = await prisma.resume.findFirst({ where: { id, userId: request.user.userId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const row = await prisma.resume.update({
      where: { id },
      data: { title: body.data.title.trim().slice(0, 100) || "Untitled Resume" },
      select: { id: true, title: true, updatedAt: true },
    });
    return { resume: { id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString() } };
  });

  /** Server-side copy of the user's own resume (same plan limit as creating one). */
  app.post("/resumes/:id/duplicate", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = await prisma.resume.findFirst({ where: { id, userId: request.user.userId } });
    if (!source) return reply.code(404).send({ error: "Not found" });
    const limited = await resumeLimitError(request.user);
    if (limited) return reply.code(402).send({ error: limited });
    const denied = planSaveError(request.user.role, { sections: [] }, { templateId: source.templateId, content: source.content });
    if (denied) return reply.code(402).send({ error: denied });
    const row = await prisma.resume.create({
      data: {
        userId: request.user.userId,
        title: `${source.title} (copy)`.slice(0, 100),
        templateId: source.templateId,
        layoutKey: source.layoutKey,
        content: storedResumeContent(source.content),
        design: storedResumeDesign(source.design),
      },
      select: { id: true, title: true, templateId: true, layoutKey: true, isComplete: true, createdAt: true, updatedAt: true },
    });
    return { resume: { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } };
  });
}
