import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import jwt from "@fastify/jwt";
import { atsRoutes, type AtsRouteOptions } from "./ats";
import { DEVOPS_JD, STRONG_RESUME, WEAK_RESUME } from "../ats/advanced.fixture";

type Row = { id: string; userId: string; content: unknown };

function fakeDb() {
  const rows: Row[] = [
    { id: "r1", userId: "u1", content: STRONG_RESUME },
    { id: "r2", userId: "u1", content: WEAK_RESUME },
    { id: "r3", userId: "u2", content: STRONG_RESUME },
  ];
  return {
    resume: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const r = rows.find((x) => x.id === where.id && x.userId === where.userId);
        return r ? { id: r.id, content: r.content } : null;
      },
    },
  } as unknown as NonNullable<AtsRouteOptions["db"]>;
}

async function build(ai: AtsRouteOptions["ai"] = null) {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret-test-secret-test-secret" });
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
  await app.register(atsRoutes, { db: fakeDb(), ai });
  const auth = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, email: `${userId}@x.y`, role: "user" })}` });
  return { app, auth };
}

test("POST /ats/analyze and /ats/rewrite need a login (401)", async () => {
  const { app } = await build();
  const a = await app.inject({ method: "POST", url: "/ats/analyze", payload: { resumeId: "r1" } });
  assert.equal(a.statusCode, 401);
  const r = await app.inject({ method: "POST", url: "/ats/rewrite", payload: { resumeId: "r1", section: "experience", text: "Worked on things" } });
  assert.equal(r.statusCode, 401);
  const bad = await app.inject({ method: "POST", url: "/ats/analyze", headers: { authorization: "Bearer nope" }, payload: { resumeId: "r1" } });
  assert.equal(bad.statusCode, 401);
  await app.close();
});

test("analyze: saved resume by id, the editor's unsaved resume, and 404 for another user's resume", async () => {
  const { app, auth } = await build();
  const saved = await app.inject({ method: "POST", url: "/ats/analyze", headers: auth("u1"), payload: { resumeId: "r1", jobDescription: DEVOPS_JD } });
  assert.equal(saved.statusCode, 200);
  const result = saved.json().result;
  assert.equal(result.version, 2);
  assert.equal(result.score, result.layers.reduce((a: number, l: { score: number }) => a + l.score, 0));
  assert.equal(result.keywords.mode, "jd");
  assert.equal(result.boards.length, 5);
  assert.match(result.plainTextPreview, /^SARA MALIK\n/);

  const live = await app.inject({ method: "POST", url: "/ats/analyze", headers: auth("u1"), payload: { resumeId: "r1", resume: { content: WEAK_RESUME } } });
  assert.equal(live.statusCode, 200);
  assert.ok(live.json().result.score < result.score, "body resume (unsaved edits) wins over the saved copy");

  const noId = await app.inject({ method: "POST", url: "/ats/analyze", headers: auth("u1"), payload: { resume: { content: STRONG_RESUME } } });
  assert.equal(noId.statusCode, 200);
  assert.equal(noId.json().result.keywords.mode, "role");

  const other = await app.inject({ method: "POST", url: "/ats/analyze", headers: auth("u1"), payload: { resumeId: "r3" } });
  assert.equal(other.statusCode, 404);
  const empty = await app.inject({ method: "POST", url: "/ats/analyze", headers: auth("u1"), payload: {} });
  assert.equal(empty.statusCode, 400);
  const notJd = await app.inject({ method: "POST", url: "/ats/analyze", headers: auth("u1"), payload: { resumeId: "r1", jobDescription: "hello hello hello" } });
  assert.equal(notJd.statusCode, 422);
  assert.equal(notJd.json().code, "JD_REJECTED");
  await app.close();
});

test("optional AI keywords are merged only when they really appear in the JD", async () => {
  const { app, auth } = await build({ rewrite: null, keywords: async () => ["Incident management", "Quantum knitting"] });
  const res = await app.inject({
    method: "POST",
    url: "/ats/analyze",
    headers: auth("u1"),
    payload: { resumeId: "r1", jobDescription: `${DEVOPS_JD}\n- Incident management and on-call` },
  });
  const kw = res.json().result.keywords;
  assert.equal(kw.aiEnhanced, true);
  assert.ok([...kw.matched, ...kw.missing].includes("Incident Management"));
  assert.ok(![...kw.matched, ...kw.missing].some((k: string) => /quantum/i.test(k)));
  await app.close();
});

test("rewrite: deterministic fallback without Gemini, AI text when available, 404 / 400 guards", async () => {
  const plain = await build(null);
  const res = await plain.app.inject({
    method: "POST",
    url: "/ats/rewrite",
    headers: plain.auth("u1"),
    payload: { resumeId: "r2", section: "experience", text: "Responsible for managing the website", issueTitle: 'Weak phrase "responsible for"' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().source, "rule");
  assert.equal(res.json().text, "Managed the website, improving [key metric] by [X]%");
  assert.ok(res.json().changes.length >= 1);
  const other = await plain.app.inject({ method: "POST", url: "/ats/rewrite", headers: plain.auth("u1"), payload: { resumeId: "r3", section: "summary", text: "x" } });
  assert.equal(other.statusCode, 404);
  const bad = await plain.app.inject({ method: "POST", url: "/ats/rewrite", headers: plain.auth("u1"), payload: { resumeId: "r1", section: "nope", text: "x" } });
  assert.equal(bad.statusCode, 400);
  await plain.app.close();

  let prompt = "";
  const smart = await build({
    rewrite: async (p) => {
      prompt = p;
      return "Rebuilt the company website, lifting conversions by [X%]";
    },
    keywords: null,
  });
  const ai = await smart.app.inject({
    method: "POST",
    url: "/ats/rewrite",
    headers: smart.auth("u1"),
    payload: { resumeId: "r1", section: "experience", text: "Worked on the website", jobDescription: DEVOPS_JD },
  });
  assert.equal(ai.json().source, "ai");
  assert.equal(ai.json().text, "Rebuilt the company website, lifting conversions by [X%]");
  assert.match(prompt, /Target role: Senior DevOps Engineer/);
  assert.match(prompt, /Original:\nWorked on the website/);
  await smart.app.close();
});

test("legacy POST /ats/preview keeps working unchanged (no login, platform results)", async () => {
  const { app } = await build();
  const doc = { content: STRONG_RESUME, design: { columnLayout: "single" } };
  const all = await app.inject({ method: "POST", url: "/ats/preview", payload: { resume: doc } });
  assert.equal(all.statusCode, 200);
  assert.deepEqual(all.json().results.map((r: { platform: string }) => r.platform), ["indeed", "linkedin", "glassdoor"]);
  const one = await app.inject({ method: "POST", url: "/ats/preview", payload: { resume: doc, platform: "indeed" } });
  assert.equal(one.json().result.platform, "indeed");
  await app.close();
});
