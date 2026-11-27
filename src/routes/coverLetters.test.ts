import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import jwt from "@fastify/jwt";
import { coverLetterRoutes } from "./coverLetters";
import { resolveChromeExecutable } from "../lib/chrome";
import type { LetterDb } from "../lib/coverLetterService";
import { RESUME_CONTENT } from "../lib/coverLetterGen.fixture";

type Row = Record<string, unknown> & { id: string };

/** Minimal in-memory stand-in for the Prisma calls the cover-letter routes make. */
function fakeDb() {
  const users: Row[] = [
    { id: "u1", name: "Sara Malik", email: "sara@example.com" },
    { id: "u2", name: "Other", email: "other@example.com" },
  ];
  const resumes: Row[] = [
    { id: "r1", userId: "u1", title: "DevOps CV", content: RESUME_CONTENT, design: { pageSize: "A4" }, isComplete: true, updatedAt: new Date() },
    { id: "r2", userId: "u1", title: "Draft CV", content: RESUME_CONTENT, design: {}, isComplete: false, updatedAt: new Date() },
    { id: "r3", userId: "u2", title: "Theirs", content: RESUME_CONTENT, design: {}, isComplete: true, updatedAt: new Date() },
  ];
  const letters: Row[] = [];
  let n = 0;
  const match = (row: Row, where: Record<string, unknown> = {}) => Object.entries(where).every(([k, v]) => row[k] === v);
  const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
    row && select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row ?? null;
  const table = (rows: Row[]) => ({
    findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => pick(rows.find((r) => match(r, where)), select),
    findUnique: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => pick(rows.find((r) => match(r, where)), select),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `cl${++n}`, createdAt: new Date(), updatedAt: new Date(), tone: "professional", resumeUpdatedAfter: false, ...data } as Row;
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
      row.updatedAt = new Date();
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => rows.splice(rows.findIndex((r) => r.id === where.id), 1)[0],
  });
  const db = { user: table(users), resume: table(resumes), coverLetter: table(letters) } as unknown as LetterDb;
  return { db, letters, resumes };
}

async function build(store = fakeDb(), pdf?: (html: string) => Promise<Buffer>) {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret-test-secret-test-secret" });
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
  await app.register(coverLetterRoutes, { db: store.db, ai: null, ...(pdf ? { pdf } : {}) });
  const auth = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, email: `${userId}@x.y`, role: "user" })}` });
  return { app, auth, store };
}

test("generate from a finalized resume uses the template fallback without Gemini", async () => {
  const { app, auth, store } = await build();
  const res = await app.inject({
    method: "POST",
    url: "/cover-letters/generate",
    headers: auth("u1"),
    payload: { resumeId: "r1", tone: "concise", targetCompany: "Stripe", targetRole: "Platform Engineer" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.source, "template");
  assert.equal(body.coverLetter.resumeId, "r1");
  assert.equal(body.coverLetter.tone, "concise");
  assert.equal(body.coverLetter.targetCompany, "Stripe");
  assert.match(body.coverLetter.body, /Dear Stripe Hiring Team/);
  assert.match(body.coverLetter.body, /Sara Malik/);
  assert.equal(body.coverLetter.resumeUpdatedAfter, false);
  // Generating again updates the same letter (one per resume).
  store.letters[0].resumeUpdatedAfter = true;
  const again = await app.inject({ method: "POST", url: `/cover-letters/${body.coverLetter.id}/regenerate`, headers: auth("u1"), payload: { tone: "enthusiastic" } });
  assert.equal(again.statusCode, 200);
  assert.equal(store.letters.length, 1);
  assert.equal(again.json().coverLetter.tone, "enthusiastic");
  assert.equal(again.json().coverLetter.targetCompany, "Stripe", "stored target kept on regenerate");
  assert.equal(again.json().coverLetter.resumeUpdatedAfter, false);
  // Our auto title follows a new company; a title the user wrote is kept.
  const moved = await app.inject({ method: "POST", url: `/cover-letters/${body.coverLetter.id}/regenerate`, headers: auth("u1"), payload: { targetCompany: "Canva" } });
  assert.match(moved.json().coverLetter.title, /at Canva$/);
  store.letters[0].title = "My letter for Canva";
  const kept = await app.inject({ method: "POST", url: `/cover-letters/${body.coverLetter.id}/regenerate`, headers: auth("u1"), payload: { targetCompany: "Atlassian" } });
  assert.equal(kept.json().coverLetter.title, "My letter for Canva");
  await app.close();
});

test("a draft resume needs finalizing first; finalize:true does it in one call", async () => {
  const { app, auth, store } = await build();
  const blocked = await app.inject({ method: "POST", url: "/cover-letters/generate", headers: auth("u1"), payload: { resumeId: "r2" } });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, "RESUME_NOT_FINALIZED");
  const ok = await app.inject({ method: "POST", url: "/cover-letters/generate", headers: auth("u1"), payload: { resumeId: "r2", finalize: true } });
  assert.equal(ok.statusCode, 201);
  assert.equal(store.resumes.find((r) => r.id === "r2")!.isComplete, true);
  await app.close();
});

test("authorization: 401 without a token, 404 for another user's resume or letter", async () => {
  const { app, auth } = await build();
  assert.equal((await app.inject({ method: "POST", url: "/cover-letters/generate", payload: { resumeId: "r1" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/cover-letters/x/download?format=pdf" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/cover-letters/generate", headers: auth("u1"), payload: { resumeId: "r3" } })).statusCode, 404);
  const mine = await app.inject({ method: "POST", url: "/cover-letters/generate", headers: auth("u1"), payload: { resumeId: "r1" } });
  const id = mine.json().coverLetter.id;
  for (const [method, url] of [
    ["GET", `/cover-letters/${id}`],
    ["GET", `/cover-letters/${id}/download?format=docx`],
    ["GET", `/cover-letters/${id}/download?format=pdf`],
    ["POST", `/cover-letters/${id}/regenerate`],
    ["PATCH", `/cover-letters/${id}`],
    ["DELETE", `/cover-letters/${id}`],
  ] as const) {
    const res = await app.inject({ method, url, headers: auth("u2"), ...(method === "PATCH" ? { payload: { body: "x" } } : method === "POST" ? { payload: {} } : {}) });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
  await app.close();
});

test("download as DOCX (PK) and TXT, and 400 for unknown formats", async () => {
  const { app, auth } = await build();
  const id = (await app.inject({ method: "POST", url: "/cover-letters/generate", headers: auth("u1"), payload: { resumeId: "r1", targetRole: "SRE" } })).json().coverLetter.id;
  const docx = await app.inject({ method: "GET", url: `/cover-letters/${id}/download?format=docx`, headers: auth("u1") });
  assert.equal(docx.statusCode, 200);
  assert.equal(docx.rawPayload.subarray(0, 2).toString(), "PK");
  assert.match(String(docx.headers["content-type"]), /wordprocessingml/);
  assert.match(String(docx.headers["content-disposition"]), /^attachment; filename="Cover_Letter_.*\.docx"/);
  const txt = await app.inject({ method: "GET", url: `/cover-letters/${id}/download?format=txt`, headers: auth("u1") });
  assert.equal(txt.statusCode, 200);
  assert.match(txt.body, /^Sara Malik/);
  assert.equal((await app.inject({ method: "GET", url: `/cover-letters/${id}/download?format=exe`, headers: auth("u1") })).statusCode, 400);
  await app.close();
});

test("download as PDF returns application/pdf with a %PDF- body", async (t) => {
  const real = Boolean(resolveChromeExecutable());
  // Real Chrome when the machine has one; otherwise a stub renderer still checks the route contract.
  const stub = real ? undefined : async (html: string) => Buffer.from(`%PDF-1.4\n% ${html.length}\n%%EOF`);
  if (!real) t.diagnostic("Chrome not found: using a stub PDF renderer");
  const { app, auth } = await build(fakeDb(), stub);
  const id = (await app.inject({ method: "POST", url: "/cover-letters/generate", headers: auth("u1"), payload: { resumeId: "r1" } })).json().coverLetter.id;
  const pdf = await app.inject({ method: "GET", url: `/cover-letters/${id}/download?format=pdf`, headers: auth("u1") });
  assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.match(String(pdf.headers["content-disposition"]), /^attachment; filename=".*\.pdf"/);
  assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
  await app.close();
});
