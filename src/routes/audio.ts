import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { prisma } from "../prisma";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AudioError, type AudioJob, type AudioService } from "../lib/audio/service";
import { makePreviewSigner, PREVIEW_TTL_SECONDS, type PreviewTrack } from "../lib/audio/previewToken";
import { BLOCKED_EXTENSIONS, cleanUploadName, contentDisposition, extOf, parseMode, parseRange, parseStrength, type Mode, type OutputChoice } from "../lib/audio/media";

/** The subset of AudioService the routes use (tests pass a fake). */
export type AudioBackend = Pick<
  AudioService,
  "capabilities" | "assertCanAccept" | "activeJobFor" | "newJobDir" | "probe" | "enqueue" | "publicJob" | "remove" | "filePath" | "stream" | "jobs" | "position" | "onQuotaRefund"
> & { cfg: { maxBytes: number; uploadsPerHour: number } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOUR = 3_600_000;
const MINUTE = 60_000;

function send(reply: FastifyReply, err: AudioError) {
  if (err.retryAfter) reply.header("Retry-After", String(err.retryAfter));
  return reply.code(err.status).send({ error: err.message, code: err.code, ...(err.details ?? {}) });
}

/** Max rejected uploads (400/413/415/422) per user per hour before 429 (abuse guard; generous on purpose). */
export const INVALID_UPLOADS_PER_HOUR = 60;

/**
 * Sliding window that only PEEKS (check) or RECORDS (hit) - BUG-1322: the upload quota is checked
 * after validation and only accepted jobs are recorded, so a 413/415/422 is never hidden behind 429.
 */
function makeWindow(windowMs: number) {
  const hits = new Map<string, Array<{ t: number; id?: string }>>();
  const recent = (key: string, now: number) => (hits.get(key) ?? []).filter((h) => now - h.t < windowMs);
  return {
    /** Seconds until a slot frees up, or 0 when under the limit. */
    check(key: string, limit: number): number {
      const now = Date.now();
      const list = recent(key, now);
      hits.set(key, list);
      return list.length >= limit ? Math.max(1, Math.ceil((windowMs - (now - list[0].t)) / 1000)) : 0;
    },
    /** Record one hit (optionally tagged with a job id so it can be refunded). Returns the count in the window. */
    hit(key: string, id?: string) {
      const now = Date.now();
      const list = recent(key, now);
      list.push({ t: now, id });
      hits.set(key, list);
      return list.length;
    },
    /** Round 27: give a job's slot back (canceled / stale / failed on the server). True when one was removed. */
    refund(key: string, id: string): boolean {
      const list = hits.get(key);
      const i = list ? list.findIndex((h) => h.id === id) : -1;
      if (!list || i < 0) return false;
      list.splice(i, 1);
      return true;
    },
  };
}

/** Round 27: roles that skip the hourly audio quota (role is read from the database, never the JWT). */
export const QUOTA_EXEMPT_ROLES = new Set(["admin", "owner"]);
export function isQuotaExemptRole(role: string | null | undefined): boolean {
  return typeof role === "string" && QUOTA_EXEMPT_ROLES.has(role.trim().toLowerCase());
}

/** "~N min" until the quota frees a slot (always at least 1). */
export function retryMinutes(retryAfterSeconds: number): number {
  return Math.max(1, Math.ceil(retryAfterSeconds / 60));
}

async function roleIsExempt(userId: string): Promise<boolean> {
  const { prisma } = await import("../prisma");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return isQuotaExemptRole(user?.role);
}

/** Sliding-window limiter per user (own key space; not shared with the AI limiter). */
function makeLimiter(windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, limit: number, reply: FastifyReply): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    reply.header("X-RateLimit-Limit", String(limit));
    if (recent.length >= limit) {
      hits.set(key, recent);
      const retry = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      reply.header("X-RateLimit-Remaining", "0").header("Retry-After", String(retry));
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    reply.header("X-RateLimit-Remaining", String(limit - recent.length));
    return false;
  };
}

export async function audioRoutes(app: FastifyInstance, opts: { service: AudioBackend; quotaExempt?: (userId: string) => Promise<boolean> }) {
  const svc = opts.service;
  const accepted = makeWindow(HOUR);
  const invalid = makeWindow(HOUR);
  // Round 27: only completed jobs keep their quota slot.
  svc.onQuotaRefund = (job) => {
    accepted.refund(job.userId, job.id);
  };
  // Admin / owner bypass, cached 60 s per user; a lookup error means "not exempt".
  const exemptLookup = opts.quotaExempt ?? roleIsExempt;
  const exemptCache = new Map<string, { v: boolean; exp: number }>();
  async function isExempt(userId: string): Promise<boolean> {
    const hit = exemptCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = await exemptLookup(userId).catch(() => false);
    exemptCache.set(userId, { v, exp: Date.now() + 60_000 });
    return v;
  }
  const pollLimiter = makeLimiter(MINUTE);

  const signer = makePreviewSigner();
  const PUBLIC_PREVIEW = "/audio/p/:id/:which/:exp/:sig";

  // Every audio route needs a signed-in user, except the signed preview link (its signature is the auth).
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions?.url === PUBLIC_PREVIEW) return;
    await app.authenticate(request, reply);
    if (reply.sent) return reply;
  });

  /** Own job or 404 (never 403, so ids cannot be probed). */
  function ownJob(request: FastifyRequest, reply: FastifyReply): AudioJob | null {
    const { id } = request.params as { id: string };
    const job = UUID.test(id) ? svc.jobs.get(id) : undefined;
    if (!job || job.userId !== request.user.userId) {
      reply.code(404).send({ error: "Not found", code: "NOT_FOUND" });
      return null;
    }
    return job;
  }

  app.get("/audio/capabilities", async () => svc.capabilities());

  app.post("/audio/denoise", async (request, reply) => {
    const userId = request.user.userId;
    if (!request.isMultipart()) return reply.code(415).send({ error: "Send the file as multipart/form-data.", code: "NOT_MULTIPART" });
    // Abuse guard only: many REJECTED uploads in an hour. Valid uploads are counted after validation.
    const invalidRetry = invalid.check(userId, INVALID_UPLOADS_PER_HOUR);
    if (invalidRetry) {
      reply.header("Retry-After", String(invalidRetry));
      return reply.code(429).send({ error: "Too many files were rejected in the last hour. Please try again later.", code: "TOO_MANY_INVALID" });
    }
    try {
      await svc.assertCanAccept(userId);
    } catch (err) {
      if (err instanceof AudioError) return send(reply, err);
      throw err;
    }
    /** A rejected upload: counts toward the invalid-attempt guard only (never the 10/hour quota). */
    const reject = (err: AudioError) => {
      if (err.status === 400 || err.status === 413 || err.status === 415 || err.status === 422) invalid.hit(userId);
      return send(reply, err);
    };

    const { id, dir } = svc.newJobDir();
    const input = path.join(dir, "input");
    const fields: Record<string, string> = {};
    let name = "";
    let sizeBytes = 0;
    let gotFile = false;
    await fs.mkdir(dir, { recursive: true });
    const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    try {
      const parts = request.parts({ limits: { fileSize: svc.cfg.maxBytes, files: 1, fields: 8, fieldSize: 200 } });
      for await (const part of parts) {
        if (part.type === "file") {
          if (gotFile || part.fieldname !== "file") {
            part.file.resume();
            continue;
          }
          gotFile = true;
          name = cleanUploadName(part.filename || "audio");
          if (BLOCKED_EXTENSIONS.has(extOf(name))) {
            part.file.resume();
            throw new AudioError(415, "UNSUPPORTED_FORMAT", "Playlists and text files are not supported. Upload the audio file itself.");
          }
          await pipeline(part.file, createWriteStream(input));
          if (part.file.truncated) throw new AudioError(413, "FILE_TOO_LARGE", `File is larger than ${Math.round(svc.cfg.maxBytes / 1024 / 1024)} MB.`);
        } else {
          fields[part.fieldname] = String(part.value ?? "").slice(0, 50);
        }
      }
      if (!gotFile) throw new AudioError(400, "NO_FILE", "Choose an audio or video file to upload.");
      sizeBytes = (await fs.stat(input)).size;
      if (sizeBytes === 0) throw new AudioError(422, "UNREADABLE_MEDIA", "The file is empty.");
    } catch (err) {
      await cleanup();
      if (err instanceof AudioError) return reject(err);
      const e = err as { code?: string; statusCode?: number };
      if (e?.code === "FST_REQ_FILE_TOO_LARGE" || e?.statusCode === 413) {
        return reject(new AudioError(413, "FILE_TOO_LARGE", `File is larger than ${Math.round(svc.cfg.maxBytes / 1024 / 1024)} MB.`));
      }
      if (e?.statusCode && e.statusCode < 500) return reject(new AudioError(400, "BAD_UPLOAD", "The upload could not be read. Please try again."));
      throw err;
    }

    // Retired "voice" (Voice clean) and unknown values fall back to plain noise removal (old clients keep working).
    const mode: Mode = parseMode(fields.mode);
    const output: OutputChoice = ["mp3", "wav", "flac"].includes(fields.output) ? (fields.output as OutputChoice) : "same";
    const strength = parseStrength(fields.strength, 80);
    if (strength === null) {
      await cleanup();
      return reject(new AudioError(400, "BAD_STRENGTH", "strength must be a whole number from 0 to 100."));
    }

    let info;
    try {
      info = await svc.probe(input);
    } catch (err) {
      await cleanup();
      if (err instanceof AudioError) return reject(err);
      throw err;
    }
    try {
      // A second upload may have slipped in while this one streamed.
      await svc.assertCanAccept(userId);
    } catch (err) {
      await cleanup();
      if (err instanceof AudioError) return send(reply, err);
      throw err;
    }
    // Valid file: now the hourly quota (only accepted jobs are counted; canceled / failed ones are refunded).
    if (!(await isExempt(userId))) {
      const limit = svc.cfg.uploadsPerHour;
      reply.header("X-RateLimit-Limit", String(limit));
      const quotaRetry = accepted.check(userId, limit);
      if (quotaRetry) {
        await cleanup();
        const mins = retryMinutes(quotaRetry);
        reply.header("X-RateLimit-Remaining", "0").header("Retry-After", String(quotaRetry));
        return reply.code(429).send({
          error: `You've reached ${limit} files this hour. Try again in ~${mins} min.`,
          code: "RATE_LIMITED",
          limit,
          retryAfterSeconds: quotaRetry,
          retryAfterMinutes: mins,
        });
      }
      reply.header("X-RateLimit-Remaining", String(limit - accepted.hit(userId, id)));
    }
    const job = svc.enqueue({ id, dir, userId, name, sizeBytes, info, mode, strength, output });
    // Admin Dashboard v2: audio job usage counter (best effort).
    void prisma.usageEvent.create({ data: { kind: "audio_job", userId } }).catch(() => undefined);
    request.log.info({ jobId: id, userId, codec: info.codec, container: info.container, duration: info.duration, sizeBytes, mode }, "audio job queued");
    return reply.code(202).send({ jobId: job.id, status: job.status, position: svc.position(job), job: svc.publicJob(job) });
  });

  /** Round 26: the caller's active (queued / processing) job, so any tab can resume tracking or cancel it. */
  app.get("/audio/jobs/active", async (request, reply) => {
    if (pollLimiter(request.user.userId, 120, reply)) return reply.code(429).send({ error: "Too many status checks. Slow down.", code: "RATE_LIMITED" });
    reply.header("Cache-Control", "no-store");
    const job = svc.activeJobFor(request.user.userId);
    return { job: job ? svc.publicJob(job) : null };
  });

  app.get("/audio/jobs/:id", async (request, reply) => {
    if (pollLimiter(request.user.userId, 120, reply)) return reply.code(429).send({ error: "Too many status checks. Slow down.", code: "RATE_LIMITED" });
    const job = ownJob(request, reply);
    if (!job) return;
    reply.header("Cache-Control", "no-store");
    const pub = svc.publicJob(job);
    if (job.status !== "done") return pub;
    // BUG-1341: fresh signed links on every status read (cheap HMAC); the player streams them directly.
    const o = signer.sign(job.id, "original", job.userId);
    const c = signer.sign(job.id, "clean", job.userId);
    return { ...pub, previews: { original: o.path, clean: c.path, expiresAt: o.exp * 1000, ttlSeconds: PREVIEW_TTL_SECONDS } };
  });

  /** Serve a preview file with Range/206, Content-Length, ETag (304) and a private cache. */
  async function sendPreview(request: FastifyRequest, reply: FastifyReply, job: AudioJob, which: PreviewTrack, cache: string) {
    if (job.status !== "done") return reply.code(409).send({ error: "The preview is not ready yet.", code: "NOT_READY" });
    const file = svc.filePath(job, which);
    const st = await fs.stat(file).catch(() => null);
    if (!st) return reply.code(410).send({ error: "This preview has expired.", code: "EXPIRED" });
    const range = parseRange(request.headers.range, st.size);
    if (range === "invalid") return reply.code(416).header("Content-Range", `bytes */${st.size}`).send({ error: "Bad range", code: "BAD_RANGE" });
    const etag = `"${job.id.slice(0, 8)}-${which}-${st.size}-${Math.round(st.mtimeMs)}"`;
    reply
      .header("Content-Type", "audio/mpeg")
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", cache)
      .header("ETag", etag)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", "inline");
    if (request.headers["if-none-match"] === etag && !range) return reply.code(304).send();
    if (range) {
      reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${st.size}`).header("Content-Length", String(range.end - range.start + 1));
      return reply.send(svc.stream(file, range));
    }
    reply.header("Content-Length", String(st.size));
    return reply.send(svc.stream(file));
  }

  // Signed, short-lived preview link (no Bearer header): the HMAC binds job + track + owner + expiry.
  app.get(PUBLIC_PREVIEW, async (request, reply) => {
    const p = request.params as { id: string; which: string; exp: string; sig: string };
    const notFound = () => reply.code(404).send({ error: "Not found", code: "NOT_FOUND" });
    if (!UUID.test(p.id) || (p.which !== "original" && p.which !== "clean") || !/^\d{9,11}$/.test(p.exp)) return notFound();
    const job = svc.jobs.get(p.id);
    if (!job) return notFound();
    const v = signer.verify(job.id, p.which, job.userId, Number(p.exp), p.sig);
    if (v === "bad") return notFound(); // never reveals that the job exists
    if (v === "expired") return reply.code(403).send({ error: "This preview link has expired. Reload to get a new one.", code: "LINK_EXPIRED" });
    return sendPreview(request, reply, job, p.which, `private, max-age=${PREVIEW_TTL_SECONDS}`);
  });

  app.get("/audio/jobs/:id/download", async (request, reply) => {
    const job = ownJob(request, reply);
    if (!job) return;
    if (job.status !== "done" || !job.result) return reply.code(409).send({ error: "The file is not ready yet.", code: "NOT_READY" });
    const file = svc.filePath(job, "result");
    const st = await fs.stat(file).catch(() => null);
    if (!st) return reply.code(410).send({ error: "This file has expired. Please process it again.", code: "EXPIRED" });
    reply
      .header("Content-Type", job.spec.contentType)
      .header("Content-Length", String(st.size))
      .header("Content-Disposition", contentDisposition(job.input.name, job.spec.ext))
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(svc.stream(file));
  });

  app.get("/audio/jobs/:id/preview", async (request, reply) => {
    const job = ownJob(request, reply);
    if (!job) return;
    // BUG-1323: exactly "original" or "clean"; anything else (missing, "CLEAN", arrays) is 400.
    const rawWhich = (request.query as { which?: unknown }).which;
    if (rawWhich !== "original" && rawWhich !== "clean") {
      return reply.code(400).send({ error: 'which must be "original" or "clean".', code: "BAD_WHICH" });
    }
    return sendPreview(request, reply, job, rawWhich, "private, max-age=300");
  });

  app.delete("/audio/jobs/:id", async (request, reply) => {
    const job = ownJob(request, reply);
    if (!job) return;
    await svc.remove(job);
    return { ok: true };
  });
}
