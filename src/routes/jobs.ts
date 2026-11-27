import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { buildModel, matchJobTerms, type JobMatch, type Model } from "../ats/advanced";
import { JobFeedService, prismaFeedStore, type FeedJob } from "../jobs/feed";
import { LIVE_SOURCES, SOURCE_LABEL, type JobSource } from "../jobs/providers";

/**
 * Jobs + tracker. Batch 4: the feed is real live jobs (RemoteOK, Arbeitnow, Remotive, optional
 * JSearch / Jooble) cached in the Job table, scored against the user's resume with the ATS matcher.
 * Auto Apply endpoints below are unchanged.
 */

type Row = Record<string, any>;
type Table = {
  findMany(args?: unknown): Promise<Row[]>;
  findFirst(args: unknown): Promise<Row | null>;
  findUnique(args: unknown): Promise<Row | null>;
  create(args: unknown): Promise<Row>;
  update(args: unknown): Promise<Row>;
  upsert(args: unknown): Promise<Row>;
  delete(args: unknown): Promise<Row>;
  count(args: unknown): Promise<number>;
};
export type JobsDb = { job: Table; jobApplication: Table; resume: Table; autoApplyConfig: Table; autoApplyCredit: Table; coverLetter: Table };

export type JobRouteOptions = { db?: JobsDb; feed?: JobFeedService };

let defaultFeed: JobFeedService | null = null;
function getDefaultFeed(): JobFeedService {
  if (!defaultFeed) {
    defaultFeed = new JobFeedService({
      store: prismaFeedStore(prisma as unknown as Parameters<typeof prismaFeedStore>[0]),
      ttlMs: Math.max(5, Number(process.env.JOBS_CACHE_TTL_MIN) || 30) * 60_000,
      log: (msg) => console.warn(msg),
    });
  }
  return defaultFeed;
}

/** Per-user sliding-window limiter. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return true;
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return false;
  };
}

/** UI "Saved" is stored as the legacy "shortlist" stage so Auto Apply keeps working unchanged. */
const STAGES = ["recommended", "shortlist", "saved", "auto_apply", "applied", "interview", "offer", "rejected"] as const;
const stageField = z.enum(STAGES).transform((s) => (s === "saved" ? "shortlist" : s));
const ADVANCED = new Set(["applied", "interview", "offer", "rejected"]);

const isLive = (source: unknown) => LIVE_SOURCES.includes(source as JobSource);
const snippet = (s: string, n = 260) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n).replace(/\s+\S*$/, "")}…` : one;
};

const jobSelect = {
  id: true, title: true, company: true, location: true, remote: true, department: true, applyUrl: true,
  source: true, salary: true, tags: true, postedAt: true, active: true,
} as const;

export async function jobRoutes(app: FastifyInstance, opts: JobRouteOptions = {}) {
  const db = (opts.db ?? prisma) as unknown as JobsDb;
  const feedOf = () => opts.feed ?? getDefaultFeed();
  const refreshLimited = limiter(6, 10 * 60_000);
  const feedLimited = limiter(120, 60_000);

  /** Matches of one resume version against one feed version (LRU of 30). */
  const matchCache = new Map<string, Map<string, JobMatch>>();
  function matchesFor(key: string, model: Model, jobs: FeedJob[]): Map<string, JobMatch> {
    const hit = matchCache.get(key);
    if (hit) {
      matchCache.delete(key);
      matchCache.set(key, hit);
      return hit;
    }
    const out = new Map<string, JobMatch>();
    for (const j of jobs) out.set(j.id, matchJobTerms(model, j.keywords, j.niceKeywords, j.title));
    matchCache.set(key, out);
    while (matchCache.size > 30) matchCache.delete(matchCache.keys().next().value as string);
    return out;
  }

  /** The asked-for resume (must be the user's), else the newest finalized one, else the newest. */
  async function pickResume(userId: string, resumeId: string | undefined, reply: FastifyReply) {
    if (resumeId) {
      const r = await db.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true, title: true, content: true, updatedAt: true, isComplete: true } });
      if (!r) {
        reply.code(404).send({ error: "Resume not found" });
        return undefined;
      }
      return r;
    }
    const rows = await db.resume.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, title: true, content: true, updatedAt: true, isComplete: true },
    });
    return rows.find((r) => r.isComplete) ?? rows[0] ?? null;
  }

  async function matchFor(userId: string, resumeId: string | null | undefined, job: { id: string; keywords?: string[]; niceKeywords?: string[]; title: string }) {
    if (!resumeId) return null;
    const r = await db.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true, content: true } });
    if (!r) return undefined;
    return matchJobTerms(buildModel(r.content), job.keywords ?? [], job.niceKeywords ?? [], job.title).score;
  }

  const card = (j: FeedJob, m: JobMatch | null) => ({
    id: j.id,
    source: j.source,
    sourceLabel: SOURCE_LABEL[j.source],
    title: j.title,
    company: j.company,
    location: j.location,
    remote: j.remote,
    salary: j.salary,
    tags: j.tags.slice(0, 6),
    snippet: snippet(j.description),
    applyUrl: j.applyUrl,
    postedAt: j.postedAt ? j.postedAt.toISOString() : null,
    match: m ? { score: m.score, matched: m.matched.slice(0, 8), missing: m.missing.slice(0, 8), basis: m.basis } : null,
  });

  const feedQuery = z.object({
    resumeId: z.string().min(1).max(64).optional(),
    q: z.string().max(120).optional(),
    remote: z.enum(["true", "false", "1", "0"]).optional(),
    source: z.enum(LIVE_SOURCES as [JobSource, ...JobSource[]]).optional().or(z.literal("").transform(() => undefined)),
    location: z.string().max(80).optional(),
    sort: z.enum(["match", "newest"]).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  });

  // ---- Live feed (signed in) ------------------------------------------------
  app.get("/jobs/feed", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    if (feedLimited(userId)) return reply.code(429).send({ error: "Too many requests. Please wait a moment." });
    const parsed = feedQuery.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Check the filters and try again" });
    const q = parsed.data;
    const resume = await pickResume(userId, q.resumeId, reply);
    if (resume === undefined) return reply;
    const feed = feedOf();
    const all = await feed.list();
    const model = resume ? buildModel(resume.content) : null;
    const matches = resume && model ? matchesFor(`${resume.id}:${new Date(resume.updatedAt).getTime()}:${feed.version}`, model, all) : null;

    const needle = (q.q ?? "").trim().toLowerCase();
    const loc = (q.location ?? "").trim().toLowerCase();
    const remoteOnly = q.remote === "true" || q.remote === "1";
    let list = all.filter((j) => {
      if (q.source && j.source !== q.source) return false;
      if (remoteOnly && !j.remote) return false;
      if (loc && !j.location.toLowerCase().includes(loc) && !(loc === "remote" && j.remote)) return false;
      if (needle) {
        const hay = `${j.title} ${j.company} ${j.tags.join(" ")} ${j.keywords.join(" ")}`.toLowerCase();
        if (!needle.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const sort = q.sort ?? (matches ? "match" : "newest");
    const time = (j: FeedJob) => j.postedAt?.getTime() ?? 0;
    list = [...list].sort((a, b) =>
      sort === "match" && matches ? (matches.get(b.id)?.score ?? 0) - (matches.get(a.id)?.score ?? 0) || time(b) - time(a) : time(b) - time(a)
    );
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pages);
    const slice = list.slice((page - 1) * q.pageSize, page * q.pageSize);
    const tracked = slice.length
      ? await db.jobApplication.findMany({ where: { userId, jobId: { in: slice.map((j) => j.id) } }, select: { id: true, jobId: true, stage: true } })
      : [];
    const sources = LIVE_SOURCES.map((s) => ({ source: s, label: SOURCE_LABEL[s], count: all.filter((j) => j.source === s).length })).filter((s) => s.count > 0);
    return {
      jobs: slice.map((j) => card(j, matches?.get(j.id) ?? null)),
      total,
      page,
      pages,
      pageSize: q.pageSize,
      sort,
      resume: resume ? { id: resume.id, title: resume.title || "Untitled resume" } : null,
      sources,
      tracked: Object.fromEntries(tracked.map((t) => [t.jobId, { id: t.id, stage: t.stage }])),
      status: feed.status(),
    };
  });

  app.get("/jobs/feed/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };
    const { resumeId } = (request.query ?? {}) as { resumeId?: string };
    const feed = feedOf();
    let job: FeedJob | undefined = (await feed.list()).find((j) => j.id === id);
    if (!job) {
      // A listing that left the feed is still readable when the user tracks it.
      const row = await db.job.findFirst({ where: { id, applications: { some: { userId } } } });
      if (!row || !isLive(row.source)) return reply.code(404).send({ error: "Job not found" });
      job = {
        id: row.id, source: row.source, externalId: row.externalId ?? "", title: row.title, company: row.company, location: row.location,
        remote: row.remote, salary: row.salary ?? null, tags: row.tags ?? [], description: row.description, applyUrl: row.applyUrl,
        postedAt: row.postedAt ?? null, keywords: row.keywords ?? [], niceKeywords: row.niceKeywords ?? [], dedupeKey: row.dedupeKey ?? "", fetchedAt: row.fetchedAt ?? null,
      } as FeedJob;
    }
    const resume = await pickResume(userId, resumeId || undefined, reply);
    if (resume === undefined) return reply;
    const m = resume ? matchJobTerms(buildModel(resume.content), job.keywords, job.niceKeywords, job.title) : null;
    const tracked = await db.jobApplication.findFirst({ where: { userId, jobId: job.id }, select: { id: true, stage: true } });
    return {
      job: { ...card(job, m), description: job.description, tags: job.tags, match: m },
      resume: resume ? { id: resume.id, title: resume.title || "Untitled resume" } : null,
      tracked: tracked ?? null,
    };
  });

  app.post("/jobs/refresh", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (refreshLimited(request.user.userId)) return reply.code(429).send({ error: "You refreshed a lot just now. Please wait a few minutes." });
    const feed = feedOf();
    const providers = await feed.refresh({ force: true });
    return { providers, status: feed.status(), nextRefreshInSec: feed.nextRefreshInSec() };
  });

  // ---- Legacy public list (now live jobs only; no seeded demo jobs) ----------
  app.get("/jobs", async (request) => {
    const q = request.query as { search?: string; department?: string; remote?: string };
    const needle = (q.search ?? "").trim().toLowerCase().slice(0, 120);
    const all = await feedOf().list();
    const jobs = all
      .filter((j) => (q.remote === "true" ? j.remote : true))
      .filter((j) => (q.department ? j.tags.some((t) => t.toLowerCase() === q.department!.toLowerCase()) : true))
      .filter((j) => (needle ? `${j.title} ${j.company} ${j.description}`.toLowerCase().includes(needle) : true))
      .slice(0, 100)
      .map((j) => ({
        id: j.id, title: j.title, company: j.company, location: j.location, remote: j.remote,
        department: j.tags[0] ?? SOURCE_LABEL[j.source], description: snippet(j.description, 1200), applyUrl: j.applyUrl,
        keywords: [...j.keywords, ...j.niceKeywords].slice(0, 12), source: j.source, postedAt: j.postedAt,
      }));
    return { jobs };
  });

  app.get("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await db.job.findUnique({ where: { id } });
    // Custom tracker cards are private to their owner.
    if (!job || job.source === "custom" || job.department === "Custom") return reply.code(404).send({ error: "Not found" });
    return { job };
  });

  // ---- Tracker ---------------------------------------------------------------
  const trackerInclude = {
    job: { select: { ...jobSelect, description: false } },
    resume: { select: { id: true, title: true } },
  } as const;

  app.get("/tracker", { preHandler: [app.authenticate] }, async (request) => {
    const apps = await db.jobApplication.findMany({
      where: { userId: request.user.userId },
      include: trackerInclude,
      orderBy: { updatedAt: "desc" },
    });
    return { applications: apps };
  });

  async function ownedResumeId(userId: string, resumeId: string | null | undefined, reply: FastifyReply): Promise<string | null | undefined | false> {
    if (resumeId === undefined || resumeId === null || resumeId === "") return resumeId === "" ? null : resumeId;
    const r = await db.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true } });
    if (!r) {
      reply.code(404).send({ error: "Resume not found" });
      return false;
    }
    return r.id;
  }

  async function track(request: FastifyRequest, reply: FastifyReply, mode: "save" | "apply") {
    const userId = request.user.userId;
    const parsed = z
      .object({
        jobId: z.string().min(1).max(64),
        stage: stageField.optional(),
        notes: z.string().max(2000).optional(),
        resumeId: z.string().min(1).max(64).optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Pick a job first" });
    const body = parsed.data;
    const job = await db.job.findUnique({ where: { id: body.jobId } });
    if (!job || job.source === "custom" || job.department === "Custom") return reply.code(404).send({ error: "Job not found" });
    const resumeId = await ownedResumeId(userId, body.resumeId, reply);
    if (resumeId === false) return reply;
    const atsMatch = resumeId ? await matchFor(userId, resumeId, job as { id: string; title: string }) : undefined;
    const existing = await db.jobApplication.findUnique({ where: { userId_jobId: { userId, jobId: body.jobId } } });
    let stage: string;
    if (mode === "apply") stage = existing && ["interview", "offer"].includes(existing.stage) ? existing.stage : "applied";
    else stage = body.stage ?? (existing ? existing.stage : "shortlist");
    const appliedAt = existing?.appliedAt ?? (ADVANCED.has(stage) && stage !== "rejected" ? new Date() : null);
    const data = {
      stage,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(resumeId ? { resumeId } : {}),
      ...(typeof atsMatch === "number" ? { atsMatch } : {}),
      appliedAt,
    };
    const application = await db.jobApplication.upsert({
      where: { userId_jobId: { userId, jobId: body.jobId } },
      create: { userId, jobId: body.jobId, ...data },
      update: data,
      include: trackerInclude,
    });
    return { application, ...(mode === "apply" ? { applyUrl: job.applyUrl } : {}), created: !existing };
  }

  app.post("/tracker", { preHandler: [app.authenticate] }, (request, reply) => track(request, reply, "save"));
  app.post("/tracker/apply", { preHandler: [app.authenticate] }, (request, reply) => track(request, reply, "apply"));

  app.post("/tracker/custom", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(120),
        company: z.string().trim().min(1).max(120),
        stage: stageField.default("shortlist"),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a job title and company" });
    const job = await db.job.create({
      data: {
        title: parsed.data.title,
        company: parsed.data.company,
        location: "",
        remote: false,
        department: "Custom",
        description: "Added from the job tracker",
        applyUrl: "",
        keywords: [],
        source: "custom",
      },
    });
    const application = await db.jobApplication.create({
      data: {
        userId: request.user.userId,
        jobId: job.id,
        stage: parsed.data.stage,
        ...(parsed.data.stage === "applied" ? { appliedAt: new Date() } : {}),
      },
      include: trackerInclude,
    });
    return { application };
  });

  const dateField = z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/), z.null()])
    .transform((v) => (v === null ? null : new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v)))
    .refine((d) => d === null || !Number.isNaN(d.getTime()), "Invalid date");

  app.patch("/tracker/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.userId;
    const parsed = z
      .object({
        stage: stageField.optional(),
        notes: z.string().max(2000).nullable().optional(),
        title: z.string().trim().min(1).max(120).optional(),
        company: z.string().trim().min(1).max(120).optional(),
        followUpAt: dateField.optional(),
        resumeId: z.string().max(64).nullable().optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Check the tracker card and try again" });
    const body = parsed.data;
    const existing = await db.jobApplication.findFirst({ where: { id, userId }, include: { job: true } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const custom = existing.job.source === "custom" || existing.job.department === "Custom";
    if ((body.title || body.company) && custom) {
      await db.job.update({
        where: { id: existing.jobId },
        data: { ...(body.title ? { title: body.title } : {}), ...(body.company ? { company: body.company } : {}) },
      });
    }
    let resumePatch: Record<string, unknown> = {};
    if (body.resumeId !== undefined) {
      const rid = await ownedResumeId(userId, body.resumeId, reply);
      if (rid === false) return reply;
      const score = rid && !custom ? await matchFor(userId, rid, existing.job as { id: string; title: string }) : null;
      resumePatch = { resumeId: rid ?? null, atsMatch: typeof score === "number" ? score : null };
    }
    const stage = body.stage;
    const application = await db.jobApplication.update({
      where: { id },
      data: {
        ...(stage ? { stage } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.followUpAt !== undefined ? { followUpAt: body.followUpAt } : {}),
        ...(stage === "applied" && !existing.appliedAt ? { appliedAt: new Date() } : {}),
        ...resumePatch,
      },
      include: trackerInclude,
    });
    return { application };
  });

  app.delete("/tracker/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await db.jobApplication.findFirst({
      where: { id, userId: request.user.userId },
      include: { job: true },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await db.jobApplication.delete({ where: { id } });
    if (existing.job.source === "custom" || existing.job.department === "Custom") {
      const stillUsed = await db.jobApplication.count({ where: { jobId: existing.jobId } });
      if (stillUsed === 0) await db.job.delete({ where: { id: existing.jobId } });
    }
    return { ok: true };
  });

  app.get("/auto-apply", { preHandler: [app.authenticate] }, async (request) => {
    const [config, credits] = await Promise.all([
      db.autoApplyConfig.findUnique({ where: { userId: request.user.userId } }),
      db.autoApplyCredit.findUnique({ where: { userId: request.user.userId } }),
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

    const config = await db.autoApplyConfig.upsert({
      where: { userId: request.user.userId },
      create: { userId: request.user.userId, ...body },
      update: body,
    });
    return { config };
  });

  app.post("/auto-apply/run", { preHandler: [app.authenticate] }, async (request) => {
    const credits = await db.autoApplyCredit.upsert({
      where: { userId: request.user.userId },
      create: { userId: request.user.userId, remaining: 50 },
      update: {},
    });

    const shortlisted = await db.jobApplication.findMany({
      where: {
        userId: request.user.userId,
        stage: { in: ["shortlist", "auto_apply"] },
      },
      take: Math.min(5, credits.remaining),
    });

    let applied = 0;
    for (const row of shortlisted) {
      if (credits.remaining - applied <= 0) break;
      await db.jobApplication.update({
        where: { id: row.id },
        data: { stage: "applied" },
      });
      applied += 1;
    }

    const updated = await db.autoApplyCredit.update({
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
    const letters = await db.coverLetter.findMany({
      where: { userId: request.user.userId },
      orderBy: { updatedAt: "desc" },
      include: { resume: { select: { id: true, title: true, isComplete: true, updatedAt: true } } },
    });
    return { coverLetters: letters };
  });
}
