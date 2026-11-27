import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { accessJtiRevoked } from "./lib/authTokens";
import { assertEnv, env } from "./config/env";
import { prisma } from "./prisma";
import { initRedis, redisStatus } from "./lib/redis";
import { ensureUploadDirs } from "./lib/uploads";
import { registerErrorHandler } from "./lib/httpErrors";
import { authRoutes } from "./routes/auth";
import { ssoRoutes } from "./routes/authSso";
import { resumeRoutes } from "./routes/resumes";
import { aiRoutes } from "./routes/ai";
import { templateRoutes } from "./routes/templates";
import { jobRoutes } from "./routes/jobs";
import { exportRoutes } from "./routes/export";
import { atsRoutes } from "./routes/ats";
import { companyRoutes } from "./routes/companies";
import { locationRoutes } from "./routes/locations";
import { adminRoutes, landingTemplateRoutes } from "./routes/admin";
import { coverLetterRoutes } from "./routes/coverLetters";
import { adminActivityRoutes, trackingRoutes } from "./routes/activity";
import { adminPdfRoutes, publicTemplateSettingsRoutes } from "./routes/adminPdf";
import { audioRoutes } from "./routes/audio";
import { contactRoutes } from "./routes/contact";
import { adminV2Routes } from "./routes/adminV2";
import { countRequest, startRequestStats, stopRequestStats } from "./lib/requestStats";
import { AudioService } from "./lib/audio/service";
import { loadAudioConfig } from "./lib/audio/config";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: string; email: string; role?: string; jti?: string; epoch?: number };
    user: { userId: string; email: string; role?: string; jti?: string; epoch?: number };
  }
}

async function main() {
  assertEnv();
  ensureUploadDirs();

  const app = Fastify({
    // request.ip = the client address nginx puts in X-Forwarded-For; only the loopback hop is trusted.
    trustProxy: env.trustProxy,
    logger: {
      level: env.logLevel,
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
    },
  });

  await initRedis(app.log);
  registerErrorHandler(app);

  // BUG-1403: API responses are never MIME-sniffed, and JSON (often per-user data) is never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    const type = String(reply.getHeader("content-type") || "");
    if (type.includes("application/json") && !reply.getHeader("cache-control")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  const allowedOrigins = new Set(
    [env.corsOrigin, env.appUrl, env.frontendUrl]
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter((value) => value && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(value) || value === env.corsOrigin)
  );
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 3 },
  });
  await app.register(fastifyStatic, {
    root: path.resolve(env.uploadDir),
    prefix: "/uploads/",
    decorateReply: false,
  });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    if (await accessJtiRevoked(request.user.jti)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { sessionEpoch: true, status: true },
    });
    if (!user || user.sessionEpoch !== (request.user.epoch ?? 0)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    // Admin Dashboard v2: suspended / deleted accounts lose API access at once.
    if (user.status !== "ACTIVE") {
      reply.code(401).send({ error: "Unauthorized", code: user.status === "SUSPENDED" ? "ACCOUNT_SUSPENDED" : "ACCOUNT_CLOSED" });
    }
  });

  app.addHook("onRequest", async (request) => {
    request.log.info(
      { method: request.method, url: request.url, reqId: request.id },
      "incoming"
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    countRequest(reply.statusCode, request.url);
    request.log.info(
      {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: reply.elapsedTime,
      },
      "completed"
    );
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  // SSO (Google / Facebook) + email magic code. Buttons show per GET /auth/providers.
  await app.register(ssoRoutes);
  await app.register(resumeRoutes);
  await app.register(aiRoutes);
  await app.register(templateRoutes);
  await app.register(jobRoutes);
  await app.register(exportRoutes);
  await app.register(atsRoutes);
  await app.register(companyRoutes);
  await app.register(locationRoutes);
  // All admin APIs live under /admin, behind the router-level adminGuard.
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(coverLetterRoutes);
  await app.register(landingTemplateRoutes);
  // Users & Activity, consent audit, page views, PDF/template control (admin routes are guarded).
  await app.register(adminActivityRoutes, { prefix: "/admin" });
  await app.register(adminPdfRoutes, { prefix: "/admin" });
  // Admin Dashboard v2: overview charts, system health, billing, manage team (RBAC).
  await app.register(adminV2Routes, { prefix: "/admin" });
  await app.register(trackingRoutes);
  await app.register(publicTemplateSettingsRoutes);
  await app.register(contactRoutes);

  // Audio Noise Remover (DeepFilterNet3 worker, ffmpeg fallbacks). Temp files live
  // outside uploads/ and are deleted after 1 hour. A missing ffmpeg only disables this tool.
  const audio = new AudioService(loadAudioConfig(), app.log);
  try {
    await audio.init();
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "audio tool init failed");
  }
  app.addHook("onClose", async () => audio.close());
  await app.register(audioRoutes, { service: audio });

  startRequestStats();
  app.addHook("onClose", async () => stopRequestStats());

  await app.listen({ port: env.apiPort, host: "0.0.0.0" });
  app.log.info(
    { port: env.apiPort, redis: redisStatus().active, uploads: env.uploadDir },
    `API listening on http://0.0.0.0:${env.apiPort}`
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", err: String(err), stack: (err as Error)?.stack }));
  process.exit(1);
});
