/**
 * SSO against the real database with a mocked Google token endpoint:
 * start -> callback (state + cookie + nonce + PKCE) -> one-time handoff -> session,
 * linking by verified email, and the pre-registration takeover guard.
 * Run: npm run test:db   (uses DATABASE_URL; creates and deletes throwaway users)
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.OAUTH_REDIRECT_BASE = "https://rb.example";
process.env.APP_URL = "https://rb.example";

function idToken(claims: Record<string, unknown>) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

test("SSO: Google sign-in creates, then links, and hands off a normal session", { skip: !process.env.DATABASE_URL }, async () => {
  const Fastify = (await import("fastify")).default;
  const jwt = (await import("@fastify/jwt")).default;
  const { prisma } = await import("../prisma");
  const { ssoRoutes } = await import("../routes/authSso");
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret-test-secret-test-secret-123" });
  await app.register(ssoRoutes);

  const email = `rb-sso-${Date.now()}@example.invalid`;
  const sub = `sub-${Date.now()}`;
  const realFetch = globalThis.fetch;
  let lastBody = "";
  let nonce = "";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      lastBody = String(init?.body ?? "");
      const claims = { iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, nonce, sub, email, email_verified: true, name: "Sso User" };
      return new Response(JSON.stringify({ id_token: idToken(claims), access_token: "x" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  async function signIn() {
    const start = await app.inject({ method: "GET", url: "/auth/oauth/google/start?intent=login" });
    assert.equal(start.statusCode, 302);
    const loc = new URL(String(start.headers.location));
    const state = loc.searchParams.get("state")!;
    nonce = loc.searchParams.get("nonce")!;
    const cookie = String(start.headers["set-cookie"]).split(";")[0];
    // Without the browser cookie the state is refused (login CSRF).
    const cb = await app.inject({ method: "GET", url: `/auth/oauth/google/callback?code=c0de&state=${state}`, headers: { cookie } });
    assert.equal(cb.statusCode, 302);
    const target = String(cb.headers.location);
    assert.match(target, /^https:\/\/rb\.example\/auth\/callback#code=/);
    assert.match(lastBody, /code_verifier=/);
    const handoff = new URLSearchParams(target.split("#")[1]).get("code")!;
    const ex = await app.inject({ method: "POST", url: "/auth/oauth/exchange", payload: { code: handoff } });
    assert.equal(ex.statusCode, 200);
    const again = await app.inject({ method: "POST", url: "/auth/oauth/exchange", payload: { code: handoff } });
    assert.equal(again.statusCode, 400, "handoff code is single use");
    return ex.json() as { token: string; refreshToken: string; user: { id: string; email: string } };
  }

  try {
    // Replay of a state without its cookie fails.
    const start = await app.inject({ method: "GET", url: "/auth/oauth/google/start" });
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    const noCookie = await app.inject({ method: "GET", url: `/auth/oauth/google/callback?code=c&state=${state}` });
    assert.match(String(noCookie.headers.location), /oauth_error=expired/);

    // Pre-registered, unverified account with someone else's password: claimed, password replaced.
    const squatter = await prisma.user.create({ data: { email, passwordHash: "squatter-hash", role: "user" } });
    const first = await signIn();
    assert.equal(first.user.id, squatter.id);
    const after = await prisma.user.findUnique({ where: { id: squatter.id } });
    assert.ok(after?.emailVerifiedAt);
    assert.notEqual(after?.passwordHash, "squatter-hash");
    const link = await prisma.oAuthAccount.findFirst({ where: { provider: "google", providerUserId: sub } });
    assert.equal(link?.userId, squatter.id);

    // Second sign-in uses the stored link.
    const second = await signIn();
    assert.equal(second.user.id, squatter.id);
    assert.equal(await prisma.oAuthAccount.count({ where: { userId: squatter.id } }), 1);
  } finally {
    globalThis.fetch = realFetch;
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    await prisma.$disconnect();
  }
});
