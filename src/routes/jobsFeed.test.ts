import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import jwt from "@fastify/jwt";
import { jobRoutes, type JobsDb } from "./jobs";
import { JobFeedService } from "../jobs/feed";
import { LIVE_ROUTES, memoryStore, mockFetch } from "../jobs/feed.fixture";
import { STRONG_RESUME, WEAK_RESUME } from "../ats/advanced.fixture";

type Row = Record<string, any> & { id: string };

function fakeDb(liveJobs: () => Row[]) {
  const resumes: Row[] = [
    { id: "r1", userId: "u1", title: "DevOps CV", content: STRONG_RESUME, isComplete: true, updatedAt: new Date("2026-11-20") },
    { id: "r2", userId: "u1", title: "Old draft", content: WEAK_RESUME, isComplete: false, updatedAt: new Date("2026-11-27") },
    { id: "r3", userId: "u2", title: "Theirs", content: STRONG_RESUME, isComplete: true, updatedAt: new Date() },
  ];
  const extraJobs: Row[] = [
    { id: "cat1", source: "catalog", title: "Demo Job", company: "Demo", department: "Engineering", applyUrl: "https://demo", keywords: [], niceKeywords: [] },
  ];
  const apps: Row[] = [];
  let n = 0;
  const allJobs = () => [...liveJobs(), ...extraJobs];
  const matches = (row: Row, where: Record<string, any> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "userId_jobId") return row.userId === v.userId && row.jobId === v.jobId;
      if (k === "applications") return apps.some((a) => a.jobId === row.id && matches(a, v.some));
      if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
      return row[k] === v;
    });
  const withInclude = (row: Row | undefined, include?: Record<string, any>) => {
    if (!row) return null;
    const out: Row = { ...row };
    if (include?.job) out.job = allJobs().find((j) => j.id === row.jobId) ?? null;
    if (include?.resume) {
      const r = resumes.find((x) => x.id === row.resumeId);
      out.resume = r ? { id: r.id, title: r.title } : null;
    }
    return out;
  };
  const pick = (row: Row | undefined, select?: Record<string, any>) =>
    !row ? null : select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
  const db = {
    resume: {
      findFirst: async ({ where, select }: any) => pick(resumes.find((r) => matches(r, where)), select),
      findMany: async ({ where, select }: any) =>
        resumes.filter((r) => matches(r, where)).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => pick(r, select)),
    },
    job: {
      findUnique: async ({ where }: any) => allJobs().find((j) => j.id === where.id) ?? null,
      findFirst: async ({ where }: any) => allJobs().find((j) => matches(j, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `cj${++n}`, ...data };
        extraJobs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(extraJobs.find((j) => j.id === where.id)!, data),
      delete: async ({ where }: any) => extraJobs.splice(extraJobs.findIndex((j) => j.id === where.id), 1)[0],
    },
    jobApplication: {
      findMany: async ({ where, select, include }: any) => apps.filter((a) => matches(a, where)).map((a) => (select ? pick(a, select) : withInclude(a, include))),
      findFirst: async ({ where, select, include }: any) => {
        const a = apps.find((x) => matches(x, where));
        return select ? pick(a, select) : withInclude(a, include);
      },
      findUnique: async ({ where }: any) => withInclude(apps.find((x) => matches(x, where))),
      create: async ({ data, include }: any) => {
        const row = { id: `a${++n}`, createdAt: new Date(), updatedAt: new Date(), notes: null, resumeId: null, atsMatch: null, appliedAt: null, followUpAt: null, ...data };
        apps.push(row);
        return withInclude(row, include);
      },
      upsert: async ({ where, create, update, include }: any) => {
        const ex = apps.find((x) => matches(x, where));
        if (ex) {
          Object.assign(ex, update, { updatedAt: new Date() });
          return withInclude(ex, include);
        }
        return db.jobApplication.create({ data: create, include });
      },
      update: async ({ where, data, include }: any) => {
        const ex = apps.find((x) => x.id === where.id)!;
        Object.assign(ex, data, { updatedAt: new Date() });
        return withInclude(ex, include);
      },
      delete: async ({ where }: any) => apps.splice(apps.findIndex((a) => a.id === where.id), 1)[0],
      count: async ({ where }: any) => apps.filter((a) => matches(a, where)).length,
    },
  };
  return { db: db as unknown as JobsDb, apps, extraJobs };
}

async function build() {
  const mem = memoryStore();
  const { impl, calls } = mockFetch(LIVE_ROUTES);
  const feed = new JobFeedService({ store: mem.store, fetch: impl, env: {} as NodeJS.ProcessEnv });
  const fake = fakeDb(() => [...mem.jobs.values()] as unknown as Row[]);
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret-test-secret-test-secret" });
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
  await app.register(jobRoutes, { db: fake.db, feed });
  const auth = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, email: `${userId}@x.y`, role: "user" })}` });
  return { app, auth, fake, calls, feed };
}

test("jobs API: 401 without a token on feed, refresh and tracker routes", async () => {
  const { app } = await build();
  for (const [method, url] of [
    ["GET", "/jobs/feed"], ["GET", "/jobs/feed/x"], ["POST", "/jobs/refresh"], ["GET", "/tracker"],
    ["POST", "/tracker"], ["POST", "/tracker/apply"], ["PATCH", "/tracker/x"], ["DELETE", "/tracker/x"],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

test("GET /jobs/feed: live jobs with ATS match %, filters, sort, pagination, resume ownership", async () => {
  const { app, auth, calls } = await build();
  const res = await app.inject({ method: "GET", url: "/jobs/feed", headers: auth("u1") });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(calls.length, 3);
  assert.equal(body.total, 4);
  assert.equal(body.resume.id, "r1", "defaults to the newest finalized resume");
  assert.equal(body.sort, "match");
  assert.ok(body.jobs.every((j: any) => j.applyUrl.startsWith("https://") && ["remoteok", "arbeitnow", "remotive"].includes(j.source)));
  assert.ok(!body.jobs.some((j: any) => j.title === "Demo Job"), "no seeded / fake jobs in the feed");
  const scores = body.jobs.map((j: any) => j.match.score);
  assert.deepEqual(scores, [...scores].sort((a: number, b: number) => b - a), "sorted by match");
  const top = body.jobs[0];
  assert.match(top.title, /DevOps|Platform/);
  assert.ok(top.match.score >= 60, String(top.match.score));
  assert.ok(top.match.matched.length > 0);
  assert.equal(body.status.total, 4);
  assert.deepEqual(body.sources.map((s: any) => s.source), ["remoteok", "arbeitnow", "remotive"]);

  const weak = (await app.inject({ method: "GET", url: "/jobs/feed?resumeId=r2", headers: auth("u1") })).json();
  const strongDev = body.jobs.find((j: any) => j.title === "Senior DevOps Engineer").match.score;
  const weakDev = weak.jobs.find((j: any) => j.title === "Senior DevOps Engineer").match.score;
  assert.ok(weakDev < strongDev, `${weakDev} < ${strongDev}`);

  const f = (await app.inject({ method: "GET", url: "/jobs/feed?q=engineer&remote=true&sort=newest&pageSize=1&page=2", headers: auth("u1") })).json();
  assert.equal(f.pageSize, 1);
  assert.equal(f.page, 2);
  assert.equal(f.total, 2, "remote engineer jobs: DevOps (RemoteOK) + Frontend (Remotive)");
  assert.equal(f.jobs[0].title, "Frontend Engineer", "newest first: page 2 is the older one");
  const src = (await app.inject({ method: "GET", url: "/jobs/feed?source=arbeitnow&location=berlin", headers: auth("u1") })).json();
  assert.deepEqual(src.jobs.map((j: any) => j.company), ["Fiskaly GmbH"]);

  assert.equal((await app.inject({ method: "GET", url: "/jobs/feed?resumeId=r3", headers: auth("u1") })).statusCode, 404, "someone else's resume");
  assert.equal((await app.inject({ method: "GET", url: "/jobs/feed?sort=bogus", headers: auth("u1") })).statusCode, 400);
  const none = (await app.inject({ method: "GET", url: "/jobs/feed", headers: auth("u9") })).json();
  assert.equal(none.resume, null);
  assert.equal(none.jobs[0].match, null, "no resume -> no match %");
  assert.equal(none.sort, "newest");

  const detail = (await app.inject({ method: "GET", url: `/jobs/feed/${top.id}`, headers: auth("u1") })).json();
  assert.ok(detail.job.description.length > top.snippet.length - 5);
  assert.ok(Array.isArray(detail.job.match.missing));
  assert.equal(detail.tracked, null);
  assert.equal((await app.inject({ method: "GET", url: "/jobs/feed/nope", headers: auth("u1") })).statusCode, 404);
});

test("Save to Tracker + Apply & Track persist with resume and ATS match; tracker CRUD and ownership", async () => {
  const { app, auth, fake } = await build();
  const feed = (await app.inject({ method: "GET", url: "/jobs/feed", headers: auth("u1") })).json();
  const job = feed.jobs[0];

  const saved = await app.inject({ method: "POST", url: "/tracker", headers: auth("u1"), payload: { jobId: job.id, stage: "saved", resumeId: "r1" } });
  assert.equal(saved.statusCode, 200);
  const a = saved.json().application;
  assert.equal(a.stage, "shortlist", "UI 'Saved' is stored as the legacy shortlist stage");
  assert.equal(a.resumeId, "r1");
  assert.equal(a.atsMatch, job.match.score, "server-side match equals the feed's");
  assert.equal(a.appliedAt, null);
  assert.equal(saved.json().created, true);

  const applied = await app.inject({ method: "POST", url: "/tracker/apply", headers: auth("u1"), payload: { jobId: job.id, resumeId: "r1" } });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.json().application.id, a.id, "same tracker row is updated, not duplicated");
  assert.equal(applied.json().application.stage, "applied");
  assert.ok(applied.json().application.appliedAt instanceof Date || typeof applied.json().application.appliedAt === "string");
  assert.equal(applied.json().applyUrl, job.applyUrl);
  assert.equal(fake.apps.length, 1);

  const list = (await app.inject({ method: "GET", url: "/tracker", headers: auth("u1") })).json();
  assert.equal(list.applications.length, 1);
  assert.equal(list.applications[0].job.title, job.title);
  assert.deepEqual(list.applications[0].resume, { id: "r1", title: "DevOps CV" });
  const fresh = (await app.inject({ method: "GET", url: "/jobs/feed", headers: auth("u1") })).json();
  assert.deepEqual(fresh.tracked[job.id], { id: a.id, stage: "applied" });

  const patch = await app.inject({
    method: "PATCH", url: `/tracker/${a.id}`, headers: auth("u1"),
    payload: { stage: "interview", notes: "Call with Sam on Monday", followUpAt: "2026-12-02" },
  });
  assert.equal(patch.statusCode, 200);
  const p = patch.json().application;
  assert.equal(p.stage, "interview");
  assert.equal(p.notes, "Call with Sam on Monday");
  assert.equal(new Date(p.followUpAt).toISOString(), "2026-12-02T00:00:00.000Z");
  // Applying again later never downgrades an interview.
  const again = (await app.inject({ method: "POST", url: "/tracker/apply", headers: auth("u1"), payload: { jobId: job.id } })).json();
  assert.equal(again.application.stage, "interview");
  for (const stage of ["offer", "rejected", "saved"]) {
    const r = await app.inject({ method: "PATCH", url: `/tracker/${a.id}`, headers: auth("u1"), payload: { stage } });
    assert.equal(r.statusCode, 200, stage);
  }
  assert.equal((await app.inject({ method: "PATCH", url: `/tracker/${a.id}`, headers: auth("u1"), payload: { stage: "hired!" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/tracker/${a.id}`, headers: auth("u1"), payload: { followUpAt: "soon" } })).statusCode, 400);
  const relink = await app.inject({ method: "PATCH", url: `/tracker/${a.id}`, headers: auth("u1"), payload: { resumeId: "r2" } });
  assert.equal(relink.json().application.resume.id, "r2");
  assert.ok(relink.json().application.atsMatch < a.atsMatch, "match recomputed for the weaker resume");
  assert.equal((await app.inject({ method: "PATCH", url: `/tracker/${a.id}`, headers: auth("u1"), payload: { resumeId: "r3" } })).statusCode, 404);

  // Another user cannot see, edit, or delete it, nor use someone else's resume.
  assert.equal((await app.inject({ method: "GET", url: "/tracker", headers: auth("u2") })).json().applications.length, 0);
  assert.equal((await app.inject({ method: "PATCH", url: `/tracker/${a.id}`, headers: auth("u2"), payload: { stage: "offer" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/tracker/${a.id}`, headers: auth("u2") })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/tracker", headers: auth("u2"), payload: { jobId: job.id, resumeId: "r1" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/tracker/apply", headers: auth("u1"), payload: { jobId: "missing" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/tracker", headers: auth("u1"), payload: {} })).statusCode, 400);

  assert.equal((await app.inject({ method: "DELETE", url: `/tracker/${a.id}`, headers: auth("u1") })).statusCode, 200);
  assert.equal(fake.apps.length, 0);
});

test("custom tracker cards stay private; legacy GET /jobs lists only live jobs; refresh endpoint", async () => {
  const { app, auth, calls } = await build();
  const c = await app.inject({ method: "POST", url: "/tracker/custom", headers: auth("u1"), payload: { title: "Ops Lead", company: "Local Co", stage: "applied" } });
  assert.equal(c.statusCode, 200);
  const custom = c.json().application;
  assert.equal(custom.job.source, "custom");
  assert.ok(custom.appliedAt);
  assert.equal((await app.inject({ method: "GET", url: `/jobs/${custom.jobId}` })).statusCode, 404, "custom card not public");
  assert.equal((await app.inject({ method: "POST", url: "/tracker", headers: auth("u2"), payload: { jobId: custom.jobId } })).statusCode, 404);

  const legacy = (await app.inject({ method: "GET", url: "/jobs?search=engineer" })).json();
  assert.ok(legacy.jobs.length >= 2);
  assert.ok(legacy.jobs.every((j: any) => j.source !== "catalog" && j.source !== "custom" && j.applyUrl.startsWith("https://")));

  const r = await app.inject({ method: "POST", url: "/jobs/refresh", headers: auth("u1") });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().providers.length, 5);
  const before = calls.length;
  await app.inject({ method: "POST", url: "/jobs/refresh", headers: auth("u1") });
  assert.equal(calls.length, before, "refresh right after a fetch does not hit the providers again");
  for (let i = 0; i < 6; i += 1) await app.inject({ method: "POST", url: "/jobs/refresh", headers: auth("u3") });
  assert.equal((await app.inject({ method: "POST", url: "/jobs/refresh", headers: auth("u3") })).statusCode, 429);
});
