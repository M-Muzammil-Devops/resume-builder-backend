import { registrationOpen } from "../lib/appSettings";
import { randomBytes } from "crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../prisma";
import { env } from "../config/env";
import { cacheDel } from "../lib/redis";
import { ephDel, ephGet, ephIncr, ephSet, ephTake } from "../lib/ephemeral";
import { hitLimit } from "../lib/loginGuard";
import { mailConfigured, sendMail } from "../lib/mailer";
import { magicCodeEmail, mailErrorMeta, noAccountEmail } from "../lib/emailTemplates";
import { revokeUserSessions } from "../lib/authTokens";
import { joinUrl } from "../lib/urls";
import {
  FACEBOOK_GRAPH,
  OAUTH_STATE_COOKIE,
  appSecretProof,
  authorizeUrl,
  googleProfileFromIdToken,
  isOAuthProvider,
  providerConfigured,
  randomToken,
  readCookie,
  redirectUri,
  safeNextPath,
  sha256,
  stateCookie,
  type OAuthConfig,
  type OAuthProvider,
  type ProviderProfile,
} from "../lib/oauth";
import {
  MAGIC_CODES_PER_EMAIL,
  MAGIC_CODE_MAX_ATTEMPTS,
  MAGIC_CODE_TTL_SECONDS,
  MAGIC_REQUESTS_PER_IP,
  MAGIC_WINDOW_SECONDS,
  generateMagicCode,
  hashMagicCode,
  magicCodeMatches,
  normalizeMagicCode,
} from "../lib/magicCode";
import { cleanName, emailField, normalizeEmail, provisionNewUser, publicAppUrl, sessionFor } from "./auth";

/**
 * SSO + passwordless sign-in.
 *  - GET  /auth/providers                 which buttons the sign-in page shows
 *  - GET  /auth/oauth/:provider/start     302 to Google / Facebook (state + nonce + PKCE in Redis)
 *  - GET  /auth/oauth/:provider/callback  server-side code exchange, link/create user, 302 to /auth/callback#code=…
 *  - POST /auth/oauth/exchange            one-time handoff code -> normal JWT + refresh session
 *  - POST /auth/magic/request             email a 6-digit code (10 min, hashed, 5 tries, rate limited)
 *  - POST /auth/magic/verify              code -> session (creates the account on the sign-up flow)
 */

const STATE_TTL = 600;
const HANDOFF_TTL = 120;
const GENERIC_MAGIC = "If that email can receive a code, it is on its way. Check your inbox.";

type StateRow = { provider: OAuthProvider; verifier: string; nonce: string; next: string; intent: string };
type MagicRow = { h: string; intent: "login" | "signup"; name?: string };

function oauthConfig(): OAuthConfig {
  return {
    googleClientId: env.googleClientId,
    googleClientSecret: env.googleClientSecret,
    facebookAppId: env.facebookAppId,
    facebookAppSecret: env.facebookAppSecret,
    redirectBase: env.oauthRedirectBase,
    apiPublicPath: env.apiPublicPath,
  };
}

/** nginx is the only way in (backend listens on loopback) and overwrites X-Real-IP. */
export function clientIp(request: FastifyRequest): string {
  const ip = request.ip || "";
  if (/^(127\.|::1$|::ffff:127\.)/.test(ip)) {
    const real = String(request.headers["x-real-ip"] || "").trim();
    if (real && real.length <= 64 && /^[0-9a-fA-F:.]+$/.test(real)) return real;
  }
  return ip;
}

function siteUrl(request: FastifyRequest) {
  return publicAppUrl(request) || env.oauthRedirectBase;
}

function failRedirect(request: FastifyRequest, reply: FastifyReply, code: string) {
  reply.header("Set-Cookie", stateCookie(oauthConfig(), null, true));
  return reply.redirect(`${joinUrl(siteUrl(request), "login")}?oauth_error=${encodeURIComponent(code)}`, 302);
}

async function recordLogin(request: FastifyRequest, userId: string) {
  try {
    await prisma.loginEvent.create({
      data: { userId, ip: clientIp(request), userAgent: String(request.headers["user-agent"] || "").slice(0, 300) },
    });
  } catch (err) {
    request.log.warn({ err }, "login event skipped");
  }
}

/**
 * Find or create the user for a verified email. An account that was never verified may hold a
 * password chosen by someone else (pre-registration), so taking it over replaces that password
 * and ends every session.
 */
async function userForVerifiedEmail(
  request: FastifyRequest,
  email: string,
  name: string,
  allowCreate: boolean
) {
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    if (!existing.emailVerifiedAt) {
      const passwordHash = await bcrypt.hash(randomBytes(24).toString("base64url"), 10);
      await prisma.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date(), passwordHash } });
      const sessionEpoch = await revokeUserSessions(existing.id);
      return { user: { ...existing, emailVerifiedAt: new Date(), sessionEpoch }, created: false };
    }
    return { user: existing, created: false };
  }
  // Admin Settings: when new sign-ups are off, only existing accounts can sign in.
  if (!allowCreate) return { user: null, created: false };
  if (!(await registrationOpen())) return { user: null, created: false, closed: true };
  const user = await prisma.user.create({
    data: {
      email,
      // Passwordless account: a random password nobody knows. "Forgot password" can set a real one.
      passwordHash: await bcrypt.hash(randomBytes(24).toString("base64url"), 10),
      name: cleanName(name, email),
      role: "user",
      emailVerifiedAt: new Date(),
    },
  });
  await provisionNewUser(user.id, request.log);
  await cacheDel("admin:stats:v1");
  request.log.info({ userId: user.id }, "user created via passwordless/SSO");
  return { user, created: true };
}

async function finishLogin(app: FastifyInstance, request: FastifyRequest, user: { id: string }) {
  const fresh = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordLogin(request, fresh.id);
  await cacheDel("admin:stats:v1");
  return sessionFor(app, fresh);
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, status: res.status, body };
}

async function googleProfile(cfg: OAuthConfig, code: string, row: StateRow): Promise<ProviderProfile | null> {
  const token = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: redirectUri(cfg, "google"),
      grant_type: "authorization_code",
      code_verifier: row.verifier,
    }),
  });
  const idToken = typeof token.body?.id_token === "string" ? token.body.id_token : "";
  if (!token.ok || !idToken) return null;
  return googleProfileFromIdToken(idToken, { clientId: cfg.googleClientId, nonce: row.nonce });
}

async function facebookProfile(cfg: OAuthConfig, code: string): Promise<ProviderProfile | null> {
  const params = new URLSearchParams({
    client_id: cfg.facebookAppId,
    client_secret: cfg.facebookAppSecret,
    redirect_uri: redirectUri(cfg, "facebook"),
    code,
  });
  const token = await fetchJson(`${FACEBOOK_GRAPH}/oauth/access_token?${params}`);
  const accessToken = typeof token.body?.access_token === "string" ? token.body.access_token : "";
  if (!token.ok || !accessToken) return null;
  const me = await fetchJson(
    `${FACEBOOK_GRAPH}/me?${new URLSearchParams({
      fields: "id,name,email",
      access_token: accessToken,
      appsecret_proof: appSecretProof(accessToken, cfg.facebookAppSecret),
    })}`
  );
  const id = typeof me.body?.id === "string" ? me.body.id : "";
  if (!me.ok || !id) return null;
  const email = typeof me.body?.email === "string" ? me.body.email.trim().toLowerCase() : "";
  // Graph only returns `email` for an address the person confirmed with Facebook.
  return { providerUserId: id, email, emailVerified: Boolean(email), name: typeof me.body?.name === "string" ? me.body.name : "" };
}

export async function ssoRoutes(app: FastifyInstance) {
  app.get("/auth/providers", async () => {
    const cfg = oauthConfig();
    return {
      google: providerConfigured(cfg, "google"),
      facebook: providerConfigured(cfg, "facebook"),
      email: mailConfigured(),
    };
  });

  app.get("/auth/oauth/:provider/start", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const cfg = oauthConfig();
    if (!isOAuthProvider(provider) || !providerConfigured(cfg, provider)) {
      return reply.code(404).send({ error: "This sign-in option is not available" });
    }
    if (hitLimit(`oauth:${clientIp(request)}`, 30, 15 * 60 * 1000)) {
      return failRedirect(request, reply, "rate_limited");
    }
    const query = request.query as { next?: string; intent?: string };
    const state = randomToken(32);
    const row: StateRow = {
      provider,
      verifier: randomToken(48),
      nonce: randomToken(24),
      next: safeNextPath(query.next),
      intent: query.intent === "signup" ? "signup" : "login",
    };
    await ephSet(`auth:oauth:state:${sha256(state)}`, row, STATE_TTL);
    reply.header("Set-Cookie", stateCookie(cfg, state, true));
    reply.header("Cache-Control", "no-store");
    return reply.redirect(authorizeUrl(cfg, provider, { state, nonce: row.nonce, verifier: row.verifier }), 302);
  });

  app.get("/auth/oauth/:provider/callback", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const cfg = oauthConfig();
    if (!isOAuthProvider(provider) || !providerConfigured(cfg, provider)) return failRedirect(request, reply, "unavailable");
    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) return failRedirect(request, reply, "cancelled");
    const state = typeof query.state === "string" ? query.state : "";
    const code = typeof query.code === "string" ? query.code : "";
    if (!state || !code || state.length > 200 || code.length > 2048) return failRedirect(request, reply, "invalid");

    // One-time state, bound to the browser that started the flow (login-CSRF protection).
    const row = await ephTake<StateRow>(`auth:oauth:state:${sha256(state)}`);
    const cookieState = readCookie(request.headers.cookie, OAUTH_STATE_COOKIE);
    if (!row || row.provider !== provider || cookieState !== state) return failRedirect(request, reply, "expired");

    let profile: ProviderProfile | null = null;
    try {
      profile = provider === "google" ? await googleProfile(cfg, code, row) : await facebookProfile(cfg, code);
    } catch (err) {
      request.log.warn({ provider, err: err instanceof Error ? err.message : String(err) }, "oauth exchange failed");
    }
    if (!profile) return failRedirect(request, reply, "provider");

    const linked = await prisma.oAuthAccount.findUnique({
      where: { provider_providerUserId: { provider, providerUserId: profile.providerUserId } },
      include: { user: true },
    });
    let userId = linked?.userId;
    if (linked) {
      await prisma.oAuthAccount.update({ where: { id: linked.id }, data: { lastUsedAt: new Date() } });
    } else {
      if (!profile.email || !profile.emailVerified) return failRedirect(request, reply, "email");
      const found = await userForVerifiedEmail(request, normalizeEmail(profile.email), profile.name, true);
      if ("closed" in found && found.closed) return failRedirect(request, reply, "registration_closed");
      const user = found.user;
      if (!user) return failRedirect(request, reply, "email");
      await prisma.oAuthAccount.create({
        data: { provider, providerUserId: profile.providerUserId, userId: user.id, email: profile.email },
      });
      userId = user.id;
    }

    const handoff = randomToken(32);
    await ephSet(`auth:oauth:handoff:${sha256(handoff)}`, { userId }, HANDOFF_TTL);
    request.log.info({ userId, provider }, "oauth sign-in");
    reply.header("Set-Cookie", stateCookie(cfg, null, true));
    reply.header("Cache-Control", "no-store");
    // Fragment, not query: never reaches server logs or a Referer header.
    const fragment = new URLSearchParams({ code: handoff, ...(row.next ? { next: row.next } : {}) });
    return reply.redirect(`${joinUrl(siteUrl(request), "auth/callback")}#${fragment}`, 302);
  });

  app.post("/auth/oauth/exchange", async (request, reply) => {
    const parsed = z.object({ code: z.string().min(20).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "This sign-in link has expired. Try again." });
    const row = await ephTake<{ userId: string }>(`auth:oauth:handoff:${sha256(parsed.data.code)}`);
    if (!row) return reply.code(400).send({ error: "This sign-in link has expired. Try again." });
    const user = await prisma.user.findUnique({ where: { id: row.userId } });
    if (!user) return reply.code(400).send({ error: "This sign-in link has expired. Try again." });
    return finishLogin(app, request, user);
  });

  app.post("/auth/magic/request", async (request, reply) => {
    const parsed = z
      .object({
        email: emailField,
        intent: z.enum(["login", "signup"]).optional(),
        name: z.string().max(80).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid email" });
    if (!mailConfigured()) return reply.code(503).send({ error: "Email sign-in is not available right now." });
    const email = normalizeEmail(parsed.data.email);
    const intent = parsed.data.intent ?? "login";
    const ip = clientIp(request);
    const emailKey = sha256(email);

    const ipHits = await ephIncr(`auth:magic:ip:${sha256(ip)}`, MAGIC_WINDOW_SECONDS);
    if (ipHits > MAGIC_REQUESTS_PER_IP) {
      return reply.code(429).send({ error: "Too many code requests. Try again in 15 minutes." });
    }
    const emailHits = await ephIncr(`auth:magic:sent:${emailKey}`, MAGIC_WINDOW_SECONDS);
    if (emailHits > MAGIC_CODES_PER_EMAIL) {
      return reply.code(429).send({ error: "Too many codes for this email. Try again in 15 minutes." });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    let mail;
    if (!user && intent === "login") {
      // Same response either way; the inbox owner learns there is no account.
      mail = noAccountEmail(joinUrl(siteUrl(request), "register"));
    } else {
      const code = generateMagicCode();
      const row: MagicRow = {
        h: hashMagicCode(env.jwtSecret, email, code),
        intent: user ? "login" : "signup",
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
      };
      await ephSet(`auth:magic:code:${emailKey}`, row, MAGIC_CODE_TTL_SECONDS);
      await ephDel(`auth:magic:tries:${emailKey}`);
      mail = magicCodeEmail(code, { minutes: MAGIC_CODE_TTL_SECONDS / 60, newAccount: !user });
    }
    try {
      const sent = await sendMail({ to: email, ...mail });
      request.log.info({ delivered: sent.delivered, intent, messageId: sent.messageId, smtp: sent.response }, "magic code email attempted");
    } catch (err) {
      request.log.warn({ ...mailErrorMeta(err) }, "magic code email failed");
    }
    return { ok: true, message: GENERIC_MAGIC };
  });

  app.post("/auth/magic/verify", async (request, reply) => {
    const parsed = z.object({ email: emailField, code: z.string().max(20) }).safeParse(request.body);
    const invalid = "That code is wrong or has expired. Check the latest email or request a new code.";
    if (!parsed.success) return reply.code(400).send({ error: invalid });
    const email = normalizeEmail(parsed.data.email);
    const code = normalizeMagicCode(parsed.data.code);
    const emailKey = sha256(email);
    if (hitLimit(`magic-verify:${clientIp(request)}`, 30, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Too many attempts. Try again in 15 minutes." });
    }

    const row = await ephGet<MagicRow>(`auth:magic:code:${emailKey}`);
    if (!row) return reply.code(400).send({ error: invalid });
    const tries = await ephIncr(`auth:magic:tries:${emailKey}`, MAGIC_CODE_TTL_SECONDS);
    if (tries > MAGIC_CODE_MAX_ATTEMPTS) {
      await ephDel(`auth:magic:code:${emailKey}`, `auth:magic:tries:${emailKey}`);
      return reply.code(429).send({ error: "Too many wrong codes. Request a new code." });
    }
    if (!magicCodeMatches(env.jwtSecret, email, code, row.h)) {
      const left = MAGIC_CODE_MAX_ATTEMPTS - tries;
      if (left <= 0) await ephDel(`auth:magic:code:${emailKey}`, `auth:magic:tries:${emailKey}`);
      return reply.code(400).send({
        error: left > 0 ? `That code is wrong. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Request a new code.",
        attemptsLeft: Math.max(0, left),
      });
    }
    // Single use: a correct code is consumed before the session is issued.
    const taken = await ephTake<MagicRow>(`auth:magic:code:${emailKey}`);
    await ephDel(`auth:magic:tries:${emailKey}`);
    if (!taken || taken.h !== row.h) return reply.code(400).send({ error: invalid });

    const found = await userForVerifiedEmail(request, email, row.name || "", row.intent === "signup");
    if ("closed" in found && found.closed) {
      return reply.code(403).send({ error: "New sign-ups are paused right now. Please try again later.", code: "REGISTRATION_CLOSED" });
    }
    const { user, created } = found;
    if (!user) return reply.code(400).send({ error: invalid });
    request.log.info({ userId: user.id, created }, "magic code sign-in");
    const session = await finishLogin(app, request, user);
    return { ...session, created };
  });
}
