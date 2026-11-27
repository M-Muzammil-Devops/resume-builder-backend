import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";

export async function jobRoutes(app: FastifyInstance) {
  app.get("/jobs", async (request) => {
    const q = request.query as {
      search?: string;
      department?: string;
      remote?: string;
    };
    const jobs = await prisma.job.findMany({
      where: {
        AND: [
          q.search
            ? {
                OR: [
                  { title: { contains: q.search, mode: "insensitive" } },
                  { company: { contains: q.search, mode: "insensitive" } },
                  { description: { contains: q.search, mode: "insensitive" } },
                ],
              }
            : {},
          q.department ? { department: q.department } : {},
          q.remote === "true" ? { remote: true } : {},
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    return { jobs };
  });

  app.get("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Not found" });
    return { job };
  });

  app.get("/tracker", { preHandler: [app.authenticate] }, async (request) => {
    const apps = await prisma.jobApplication.findMany({
      where: { userId: request.user.userId },
      include: { job: true },
      orderBy: { updatedAt: "desc" },
    });
    return { applications: apps };
  });

  app.post("/tracker", { preHandler: [app.authenticate] }, async (request) => {
    const body = z
      .object({
        jobId: z.string(),
        stage: z.string().default("shortlist"),
        notes: z.string().optional(),
      })
      .parse(request.body);

    const appRow = await prisma.jobApplication.upsert({
      where: {
        userId_jobId: { userId: request.user.userId, jobId: body.jobId },
      },
      create: {
        userId: request.user.userId,
        jobId: body.jobId,
        stage: body.stage,
        notes: body.notes,
      },
      update: { stage: body.stage, notes: body.notes },
      include: { job: true },
    });
    return { application: appRow };
  });

  const stageField = z.enum(["recommended", "shortlist", "auto_apply", "applied", "interview"]);

  app.post("/tracker/custom", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(120),
        company: z.string().trim().min(1).max(120),
        stage: stageField.default("shortlist"),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a job title and company" });
    const job = await prisma.job.create({
      data: {
        title: parsed.data.title,
        company: parsed.data.company,
        location: "",
        remote: false,
        department: "Custom",
        description: "Added from the job tracker",
        applyUrl: "",
        keywords: [],
      },
    });
    const application = await prisma.jobApplication.create({
      data: {
        userId: request.user.userId,
        jobId: job.id,
        stage: parsed.data.stage,
      },
      include: { job: true },
    });
    return { application };
  });

  app.patch("/tracker/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        stage: stageField,
        notes: z.string().max(500).optional(),
        title: z.string().trim().min(1).max(120).optional(),
        company: z.string().trim().min(1).max(120).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Check the tracker card and try again" });
    const existing = await prisma.jobApplication.findFirst({
      where: { id, userId: request.user.userId },
      include: { job: true },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    if ((parsed.data.title || parsed.data.company) && existing.job.department === "Custom") {
      await prisma.job.update({
        where: { id: existing.jobId },
        data: {
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.company ? { company: parsed.data.company } : {}),
        },
      });
    }
    const application = await prisma.jobApplication.update({
      where: { id },
      data: { stage: parsed.data.stage, notes: parsed.data.notes },
      include: { job: true },
    });
    return { application };
  });

  app.delete("/tracker/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.jobApplication.findFirst({
      where: { id, userId: request.user.userId },
      include: { job: true },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await prisma.jobApplication.delete({ where: { id } });
    if (existing.job.department === "Custom") {
      const stillUsed = await prisma.jobApplication.count({ where: { jobId: existing.jobId } });
      if (stillUsed === 0) await prisma.job.delete({ where: { id: existing.jobId } });
    }
    return { ok: true };
  });

  app.get("/auto-apply", { preHandler: [app.authenticate] }, async (request) => {
    const [config, credits] = await Promise.all([
      prisma.autoApplyConfig.findUnique({ where: { userId: request.user.userId } }),
      prisma.autoApplyCredit.findUnique({ where: { userId: request.user.userId } }),
    ]);
    return {
      config: config ?? {
        roles: ["DevOps Engineer"],
        locations: ["Remote"],
        remote: true,
      },
      credits: credits ?? { remaining: 50, processing: 0, applied: 0 },
    };
  });

  app.put("/auto-apply", { preHandler: [app.authenticate] }, async (request) => {
    const body = z
      .object({
        roles: z.array(z.string()),
        locations: z.array(z.string()),
        remote: z.boolean(),
      })
      .parse(request.body);

    const config = await prisma.autoApplyConfig.upsert({
      where: { userId: request.user.userId },
      create: { userId: request.user.userId, ...body },
      update: body,
    });
    return { config };
  });

  app.post("/auto-apply/run", { preHandler: [app.authenticate] }, async (request) => {
    const credits = await prisma.autoApplyCredit.upsert({
      where: { userId: request.user.userId },
      create: { userId: request.user.userId, remaining: 50 },
      update: {},
    });

    const shortlisted = await prisma.jobApplication.findMany({
      where: {
        userId: request.user.userId,
        stage: { in: ["shortlist", "auto_apply"] },
      },
      take: Math.min(5, credits.remaining),
    });

    let applied = 0;
    for (const row of shortlisted) {
      if (credits.remaining - applied <= 0) break;
      await prisma.jobApplication.update({
        where: { id: row.id },
        data: { stage: "applied" },
      });
      applied += 1;
    }

    const updated = await prisma.autoApplyCredit.update({
      where: { userId: request.user.userId },
      data: {
        remaining: { decrement: applied },
        applied: { increment: applied },
        processing: 0,
      },
    });

    return {
      message: `Demo queue applied to ${applied} job(s). No external boards contacted.`,
      credits: updated,
      appliedCount: applied,
    };
  });

  app.get("/cover-letters", { preHandler: [app.authenticate] }, async (request) => {
    const letters = await prisma.coverLetter.findMany({
      where: { userId: request.user.userId },
      orderBy: { updatedAt: "desc" },
      include: { resume: { select: { id: true, title: true, isComplete: true, updatedAt: true } } },
    });
    return { coverLetters: letters };
  });
}
