import { registrationOpen } from "../lib/appSettings";
import { randomBytes } from "crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../prisma";
import { createSampleDevopsResume } from "../shared";
import { cacheDel } from "../lib/redis";
import { env } from "../config/env";
import {
  consumeAuthToken,
  invalidateAuthTokens,
  issueAuthToken,
  recentAuthToken,
  issueRefreshToken,
  revokeAccessJti,
  revokeRefreshToken,
  revokeUserSessions,
} from "../lib/authTokens";
import { clearLoginFailures, hitLimit, loginBlocked, recordLoginFailure } from "../lib/loginGuard";
import { sendMail } from "../lib/mailer";
import { mailErrorMeta, resetEmail, verifyEmail } from "../lib/emailTemplates";
import { PASSWORD_HINT, passwordError } from "../lib/passwordPolicy";
import { resolvePublicAppUrl } from "../lib/publicUrl";
import { joinUrl } from "../lib/urls";
import { hasAdminAccess } from "../lib/adminAuth";

const locationFields = {
  location: z.string().max(120).optional(),
  country: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
};

export const emailField = z
  .string()
  .trim()
  .max(254)
  .email()
  .refine((value) => {
    const domain = value.split("@")[1] || "";
    const parts = domain.split(".");
    return parts.length >= 2 && parts.every((part) => part.length > 0);
  }, "Enter a valid email");

export function clientMeta(request: { headers: Record<string, unknown>; ip: string }) {
  const ua = String(request.headers["user-agent"] || "").slice(0, 300);
  return { ua, ip: request.ip };
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function cleanName(name: string | undefined, email: string) {
  const stripped = (name || "").replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim();
  return stripped.slice(0, 80) || email.split("@")[0];
}

function authInputError(error: z.ZodError) {
  const issue = error.issues[0];
  const field = issue?.path[0];
  if (field === "email") return "Enter a valid email";
  if (field === "name") return "Name must be 80 characters or less";
  if (field === "password") return issue?.message || PASSWORD_HINT;
  return issue?.message || "Check your details and try again";
}

export function publicAppUrl(request: FastifyRequest) {
  return resolvePublicAppUrl({
    appUrl: env.appUrl,
    fallback: env.frontendUrl,
    forwardedHost: String(request.headers["x-forwarded-host"] || ""),
    forwardedProto: String(request.headers["x-forwarded-proto"] || ""),
    host: String(request.headers.host || ""),
  });
}

const passwordField = z.string().max(128).superRefine((value, ctx) => {
  const message = passwordError(value);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

/**
 * BUG-1221: the admin console server guard reads the access token from this cookie.
 * It is set only by the API for an admin session: HttpOnly (no JS access), Secure,
 * SameSite=Strict, scoped to /admin pages, and living no longer than the access token.
 */
export const ADMIN_COOKIE = "rb_admin_at";
export function adminCookie(token: string | null): string {
  const base = `${ADMIN_COOKIE}=${token ? encodeURIComponent(token) : ""}; Path=/admin; HttpOnly; Secure; SameSite=Strict`;
  return token ? `${base}; Max-Age=900` : `${base}; Max-Age=0`;
}

const GENERIC_RESET = "If an account exists for that email, we sent a reset link.";

export async function provisionNewUser(userId: string, log: FastifyRequest["log"]) {
  try {
    await prisma.autoApplyCredit.create({
      data: { userId, remaining: 50 },
    });
    await prisma.autoApplyConfig.create({
      data: {
        userId,
        roles: ["DevOps Engineer", "SRE"],
        locations: ["Remote", "Pakistan"],
        remote: true,
      },
    });
  } catch (err) {
    log.warn({ err }, "auto-apply defaults skipped");
  }

  try {
    const sample = createSampleDevopsResume();
    await prisma.resume.create({
      data: {
        userId,
        title: sample.title,
        templateId: sample.templateId,
        layoutKey: sample.layoutKey,
        content: sample.content as object,
        design: sample.design as object,
      },
    });
  } catch (err) {
    log.warn({ err }, "sample resume skipped");
  }
}

/** Automatic resends (unverified login, repeat sign-up) wait this long after the last link. */
const AUTO_RESEND_MINUTES = 10;

/**
 * BUG-1407: `force` is for an explicit sign-up or "resend" click. Automatic triggers skip the
 * send while a recent link exists, so a login attempt never floods the inbox.
 */
async function sendVerification(
  request: FastifyRequest,
  user: { id: string; email: string },
  opts: { force?: boolean } = {}
) {
  if (!opts.force && (await recentAuthToken(user.id, "verify", AUTO_RESEND_MINUTES))) {
    request.log.info({ email: user.email }, "verification email skipped: recent link still valid");
    return { delivered: false, skipped: true };
  }
  const token = await issueAuthToken(user.id, "verify", 24);
  const link = `${joinUrl(publicAppUrl(request), "verify-email")}?token=${encodeURIComponent(token)}`;
  const mail = verifyEmail(link);
  try {
    const sent = await sendMail({ to: user.email, ...mail });
    request.log.info({ email: user.email, delivered: sent.delivered, messageId: sent.messageId, smtp: sent.response }, "verification email attempted");
    return { delivered: sent.delivered };
  } catch (err) {
    request.log.warn({ email: user.email, ...mailErrorMeta(err) }, "verification email failed");
    return { delivered: false };
  }
}

async function sendReset(request: FastifyRequest, user: { id: string; email: string }) {
  const token = await issueAuthToken(user.id, "reset", 1);
  const link = `${joinUrl(publicAppUrl(request), "reset-password")}?token=${encodeURIComponent(token)}`;
  const mail = resetEmail(link);
  try {
    const sent = await sendMail({ to: user.email, ...mail });
    request.log.info({ email: user.email, delivered: sent.delivered, messageId: sent.messageId, smtp: sent.response }, "reset email attempted");
    return { delivered: sent.delivered };
  } catch (err) {
    request.log.warn({ email: user.email, ...mailErrorMeta(err) }, "reset email failed");
    return { delivered: false };
  }
}

/** Thrown for suspended / deleted accounts; the error handler turns it into a 403 with this message. */
export function accountBlockedError(status: string) {
  return Object.assign(
    new Error(status === "SUSPENDED" ? "This account is suspended. Contact support to restore access." : "This account has been closed."),
    { statusCode: 403 }
  );
}

export async function sessionFor(app: FastifyInstance, user: { id: string; email: string; role: string; name: string | null; location?: string | null; country?: string | null; sessionEpoch?: number; status?: string }) {
  const status = user.status ?? (await prisma.user.findUnique({ where: { id: user.id }, select: { status: true } }))?.status ?? "ACTIVE";
  if (status !== "ACTIVE") throw accountBlockedError(status);
  const jti = randomBytes(9).toString("base64url");
  const token = app.jwt.sign(
    { userId: user.id, email: user.email, role: user.role, jti, epoch: user.sessionEpoch ?? 0 },
    { expiresIn: "15m" }
  );
  const refreshToken = await issueRefreshToken(user.id);
  return {
    token,
    refreshToken,
    expiresIn: 900,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      location: user.location ?? null,
      country: user.country ?? null,
    },
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    const { ip } = clientMeta(request);
    if (hitLimit(`register:${ip}`, 8, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Too many signups. Try again in 15 minutes." });
    }
    const parsed = z
      .object({
        email: emailField,
        password: passwordField,
        name: z.string().max(80).optional(),
        ...locationFields,
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: authInputError(parsed.error) });
    }
    const body = parsed.data;
    const email = normalizeEmail(body.email);

    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (existing) {
      if (!existing.emailVerifiedAt) {
        await sendVerification(request, existing);
        return reply.code(409).send({
          error: "Email already registered. Check your inbox to verify it.",
        });
      }
      return reply.code(409).send({ error: "Email already registered" });
    }

    if (!(await registrationOpen())) {
      return reply.code(403).send({ error: "New sign-ups are paused right now. Please try again later.", code: "REGISTRATION_CLOSED" });
    }
    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: cleanName(body.name, email),
        role: "user",
        location: body.location || body.city || null,
        country: body.country || null,
      },
    });

    await sendVerification(request, user, { force: true });
    await cacheDel("admin:stats:v1");
    request.log.info({ userId: user.id, email: user.email }, "user registered, awaiting verification");
    return reply.code(201).send({
      needsVerification: true,
      email: user.email,
      message: "Check your inbox to verify your email.",
    });
  });

  app.post("/auth/resend-verification", async (request, reply) => {
    const { ip } = clientMeta(request);
    const parsed = z.object({ email: emailField }).safeParse(request.body);
    const email = parsed.success ? normalizeEmail(parsed.data.email) : "";
    if (hitLimit(`resend:${email || ip}`, 5, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Too many requests. Try again in 15 minutes." });
    }
    if (email) {
      const user = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
      });
      if (user && !user.emailVerifiedAt) await sendVerification(request, user, { force: true });
    }
    return { ok: true };
  });

  app.post("/auth/verify-email", async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "This verification link is invalid or has expired" });
    }
    const row = await consumeAuthToken(parsed.data.token, "verify");
    if (!row) {
      return reply.code(400).send({ error: "This verification link is invalid or has expired" });
    }
    // One link verified the account; any other outstanding verify links stop working.
    await invalidateAuthTokens(row.userId, "verify");

    const user = await prisma.user.update({
      where: { id: row.userId },
      data: { emailVerifiedAt: new Date(), lastLoginAt: new Date() },
    });
    const resumeCount = await prisma.resume.count({ where: { userId: user.id } });
    if (resumeCount === 0) await provisionNewUser(user.id, request.log);

    const { ua, ip } = clientMeta(request);
    try {
      await prisma.loginEvent.create({
        data: { userId: user.id, ip, userAgent: ua },
      });
    } catch (err) {
      request.log.warn({ err }, "login event skipped");
    }

    request.log.info({ userId: user.id, email: user.email }, "email verified");
    return await sessionFor(app, user);
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = z.object({ refreshToken: z.string().min(20).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(401).send({ error: "Unauthorized" });
    const row = await consumeAuthToken(parsed.data.refreshToken, "refresh");
    if (!row) return reply.code(401).send({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { id: row.userId } });
    if (!user) return reply.code(401).send({ error: "Unauthorized" });
    return await sessionFor(app, user);
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.header("Set-Cookie", adminCookie(null));
    const parsed = z.object({ refreshToken: z.string().max(200).optional() }).safeParse(request.body ?? {});
    if (parsed.success && parsed.data.refreshToken) {
      await revokeRefreshToken(parsed.data.refreshToken);
    }
    try {
      await request.jwtVerify();
      if (request.user.jti) await revokeAccessJti(request.user.jti);
    } catch {
      /* an expired access token still revokes the refresh token above */
    }
    return { ok: true };
  });

  app.post("/auth/forgot-password", async (request, reply) => {
    const { ip } = clientMeta(request);
    if (hitLimit(`forgot:${ip}`, 5, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Too many reset requests. Try again in 15 minutes." });
    }
    const parsed = z.object({ email: emailField }).safeParse(request.body);
    // BUG-1406: a missing or malformed email is a 400; a valid one always gets the generic reply.
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid email" });
    {
      const email = normalizeEmail(parsed.data.email);
      const user = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
      });
      if (user) await sendReset(request, user);
    }
    return { ok: true, message: GENERIC_RESET };
  });

  app.post("/auth/reset-password", async (request, reply) => {
    const parsed = z
      .object({
        token: z.string().min(20),
        password: passwordField,
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: authInputError(parsed.error) || "Check your details and try again" });
    }
    const row = await consumeAuthToken(parsed.data.token, "reset");
    if (!row) {
      return reply.code(400).send({ error: "This reset link is invalid or has expired" });
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    await prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash },
    });
    await revokeUserSessions(row.userId);
    await invalidateAuthTokens(row.userId, "reset");
    request.log.info({ userId: row.userId }, "password reset");
    return { ok: true };
  });

  /**
   * One login flow for both doors. adminOnly=true is the admin console sign-in:
   * a correct password on a non-admin account gets 403 and no session at all.
   */
  const loginHandler = (adminOnly: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z
      .object({
        email: emailField,
        password: z.string().min(1).max(128),
        ...locationFields,
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: authInputError(parsed.error) });
    }
    const body = parsed.data;
    const email = normalizeEmail(body.email);
    const { ua, ip } = clientMeta(request);

    if (hitLimit(`login:${email}`, 20, 15 * 60 * 1000) || loginBlocked(email)) {
      return reply.code(429).send({ error: "Too many attempts. Try again in 15 minutes." });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      recordLoginFailure(email);
      request.log.warn({ email }, "login failed");
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    if (user.status !== "ACTIVE") {
      clearLoginFailures(email);
      request.log.warn({ userId: user.id, status: user.status }, "login refused: account not active");
      return reply.code(403).send({ error: accountBlockedError(user.status).message, code: `ACCOUNT_${user.status}` });
    }

    if (adminOnly && !(await hasAdminAccess(user))) {
      clearLoginFailures(email);
      request.log.warn({ userId: user.id }, "admin login refused: not an admin");
      return reply.code(403).send({
        error: "This account is not an admin. Use the user sign-in at /login.",
        code: "NOT_ADMIN",
      });
    }

    if (!user.emailVerifiedAt) {
      await sendVerification(request, user);
      return reply.code(403).send({
        error: "Verify your email before signing in. Check your inbox for the link.",
      });
    }

    clearLoginFailures(email);
    const now = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: now,
        ...(body.location ? { location: body.location } : {}),
        ...(body.country ? { country: body.country } : {}),
      },
    });
    try {
      await prisma.loginEvent.create({
        data: {
          userId: user.id,
          ip,
          country: body.country || user.country,
          city: body.city || null,
          userAgent: ua,
        },
      });
    } catch (err) {
      request.log.warn({ err }, "login event skipped");
    }

    await cacheDel("admin:stats:v1");
    request.log.info({ userId: user.id, role: user.role, adminOnly }, "user login");
    const session = await sessionFor(app, {
      ...user,
      location: body.location || user.location,
      country: body.country || user.country,
    });
    if (adminOnly) reply.header("Set-Cookie", adminCookie(session.token));
    return session;
  };

  app.post("/auth/login", loginHandler(false));
  app.post("/auth/admin/login", loginHandler(true));

  /** Re-issue the admin console cookie for the current (e.g. refreshed) admin access token. */
  app.post("/auth/admin/session", { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.userId }, select: { id: true, email: true, role: true, status: true } });
    if (!user || !(await hasAdminAccess(user))) {
      reply.header("Set-Cookie", adminCookie(null));
      return reply.code(403).send({ error: "Admin access required" });
    }
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    reply.header("Set-Cookie", adminCookie(token));
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: [app.authenticate] }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        location: true,
        country: true,
        lastLoginAt: true,
        emailVerifiedAt: true,
      },
    });
    return { user };
  });

  app.post("/auth/demo", async (request, reply) => {
    // Demo login is disabled unless SEED_DEMO_USER=true and DEMO_PASSWORD is set.
    if (!env.seedDemoUser || env.demoPassword.length < 8) return reply.code(404).send({ error: "Not found" });
    const email = "demo@resume.local";
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          passwordHash: await bcrypt.hash(env.demoPassword, 10),
          name: "Demo User",
          role: "user",
          emailVerifiedAt: new Date(),
          lastLoginAt: new Date(),
        },
      });
      await provisionNewUser(user.id, request.log);
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), emailVerifiedAt: user.emailVerifiedAt || new Date() },
      });
    }
    request.log.info({ userId: user.id }, "demo login");
    return await sessionFor(app, user);
  });

  app.patch("/auth/profile", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a name of 80 characters or less" });
    const user = await prisma.user.update({
      where: { id: request.user.userId },
      data: { name: cleanName(parsed.data.name, request.user.email) },
      select: { id: true, email: true, name: true, role: true },
    });
    return { user };
  });

  app.post("/auth/change-password", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = z
      .object({ currentPassword: z.string().min(1).max(128), password: passwordField })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: authInputError(parsed.error) });
    const user = await prisma.user.findUnique({ where: { id: request.user.userId } });
    if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      return reply.code(400).send({ error: "Current password is wrong" });
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    const sessionEpoch = await revokeUserSessions(user.id);
    return await sessionFor(app, { ...user, sessionEpoch });
  });

  app.delete("/auth/account", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = z.object({ password: z.string().min(1).max(128) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter your password to delete the account" });
    const user = await prisma.user.findUnique({ where: { id: request.user.userId } });
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return reply.code(400).send({ error: "Password is wrong" });
    }
    if (user.role === "admin") return reply.code(403).send({ error: "The admin account cannot be deleted here" });
    await prisma.user.delete({ where: { id: user.id } });
    return { ok: true };
  });
}
