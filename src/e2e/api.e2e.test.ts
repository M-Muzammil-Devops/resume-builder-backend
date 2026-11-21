/**
 * Live API checks for BUG-065, BUG-066, BUG-200 (partially) and BUG-705.
 * Run against a deployed API:  RB_API_URL=https://<host>/rb-api npm run test:e2e
 * Export checks also need RB_TOKEN (access token) and RB_RESUME_ID.
 * Nothing here is hard-coded to a host; every check is skipped when its env is missing.
 */
import assert from "node:assert/strict";
import test from "node:test";

const API = (process.env.RB_API_URL || "").replace(/\/$/, "");
const TOKEN = process.env.RB_TOKEN || "";
const RESUME_ID = process.env.RB_RESUME_ID || "";
const LEAK = /verifyUrl|resetUrl|mailError|token=|SMTP|mail server/i;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, type: res.headers.get("content-type") || "", buf: Buffer.from(await res.arrayBuffer()) };
}

test("BUG-065 forgot-password: identical generic body for existing and unknown e-mail", { skip: !API || !process.env.RB_EXISTING_EMAIL }, async () => {
  const known = await post("/auth/forgot-password", { email: process.env.RB_EXISTING_EMAIL });
  const unknown = await post("/auth/forgot-password", { email: `nobody-${Date.now()}@example.invalid` });
  assert.equal(known.status, unknown.status);
  assert.equal(known.buf.toString(), unknown.buf.toString());
  assert.equal(LEAK.test(known.buf.toString()), false);
});

test("BUG-066 register / duplicate / unverified login / resend never leak verify links or mail errors", { skip: !API }, async () => {
  const email = `rb-e2e-${Date.now()}@example.invalid`;
  const password = "Qa-e2e-Passw0rd!";
  const responses = [
    await post("/auth/register", { email, password, name: "E2E" }),
    await post("/auth/register", { email, password, name: "E2E" }),
    await post("/auth/login", { email, password }),
    await post("/auth/resend-verification", { email }),
  ];
  for (const r of responses) assert.equal(LEAK.test(r.buf.toString()), false, r.buf.toString());
  assert.equal(responses[1].status, 409);
  assert.equal(responses[2].status, 403);
});

const EXPECT: Record<string, { type: RegExp; magic: (b: Buffer) => boolean }> = {
  pdf: { type: /^application\/pdf/, magic: (b) => b.subarray(0, 4).toString("latin1") === "%PDF" },
  docx: { type: /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/, magic: (b) => b.subarray(0, 2).toString("latin1") === "PK" },
  txt: { type: /^text\/plain/, magic: (b) => b.length > 0 && !b.subarray(0, 1).toString().startsWith("{") },
};

for (const format of ["pdf", "docx", "txt"]) {
  test(`BUG-705 POST /export/:id format=${format} returns 200 with the right type and magic bytes`, { skip: !API || !TOKEN || !RESUME_ID, timeout: 90000 }, async () => {
    const r = await post(`/export/${RESUME_ID}`, { format }, TOKEN);
    assert.equal(r.status, 200, r.buf.toString().slice(0, 300));
    assert.match(r.type, EXPECT[format].type);
    assert.ok(EXPECT[format].magic(r.buf));
    assert.equal(/Waiting for selector/.test(r.buf.toString("latin1").slice(0, 400)), false);
  });
}
