import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { INVALID_UPLOADS_PER_HOUR, audioRoutes, isQuotaExemptRole, retryMinutes, type AudioBackend } from "./audio";
import { AudioError, type AudioJob } from "../lib/audio/service";
import { outputFor, parseProbe, sniffReject } from "../lib/audio/media";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-audio-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** Fake backend: real sniff + parseProbe rules, fake ffprobe (JSON chosen by file content). */
function fakeBackend(maxBytes = 1024 * 1024, uploadsPerHour = 10) {
  const jobs = new Map<string, AudioJob>();
  const svc: AudioBackend = {
    cfg: { maxBytes, uploadsPerHour },
    jobs,
    capabilities: (() => ({ ready: true, engine: "deepfilternet", limits: { maxBytes } })) as unknown as AudioBackend["capabilities"],
    async assertCanAccept(userId: string) {
      for (const j of jobs.values()) if (j.userId === userId && j.status === "queued") throw new AudioError(409, "JOB_IN_PROGRESS", "busy", undefined, { activeJobId: j.id, activeStatus: j.status });
    },
    activeJobFor(userId: string) {
      for (const j of jobs.values()) if (j.userId === userId && j.status === "queued") return j;
      return undefined;
    },
    newJobDir() {
      n += 1;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      return { id, dir: path.join(tmp, id) };
    },
    async probe(file: string) {
      const buf = fs.readFileSync(file);
      const reason = sniffReject(buf.subarray(0, 512));
      if (reason) throw new AudioError(415, "UNSUPPORTED_FILE", reason);
      const tag = buf.subarray(4, 12).toString("latin1");
      const raw =
        tag === "NOAUDIO!" ? { format: { format_name: "mov,mp4" }, streams: [{ codec_type: "video" }] }
        : tag === "LONGLONG" ? { format: { format_name: "mp3", duration: "700" }, streams: [{ codec_type: "audio", codec_name: "mp3" }] }
        : tag === "CORRUPT!" ? null
        : { format: { format_name: "mp3", duration: "5" }, streams: [{ codec_type: "audio", codec_name: "mp3", channels: 1, sample_rate: "44100" }] };
      const r = parseProbe(raw, 600);
      if (!r.ok && r.code === "TOO_LONG") throw new AudioError(422, "TOO_LONG", r.message, undefined, { durationSeconds: Math.round(r.duration ?? 0), maxSeconds: 600 });
      if (!r.ok) throw new AudioError(r.status, r.code, r.message);
      return r.info;
    },
    enqueue(a) {
      const job = {
        ...a,
        status: "queued",
        progress: 2,
        step: "Waiting",
        input: { ...a.info, name: a.name, sizeBytes: a.sizeBytes },
        spec: outputFor(a.output, a.info.codec, a.info.container, new Set(["libmp3lame"])),
        createdAt: Date.now(),
        abort: new AbortController(),
        estimateMs: 1000,
      } as unknown as AudioJob;
      jobs.set(job.id, job);
      return job;
    },
    position: () => 1,
    publicJob: ((job: AudioJob) => ({ id: job.id, status: job.status, mode: job.mode, strength: job.strength, output: job.output, input: job.input })) as unknown as AudioBackend["publicJob"],
    async remove(job: AudioJob) {
      jobs.delete(job.id);
      fs.rmSync(job.dir, { recursive: true, force: true });
    },
    filePath: (job: AudioJob, which: string) => path.join(job.dir, which === "result" ? `out.${job.spec.ext}` : `${which}.mp3`),
    stream: ((file: string, range?: { start: number; end: number }) => fs.createReadStream(file, range)) as AudioBackend["stream"],
  };
  return svc;
}

async function makeApp(svc = fakeBackend(), quotaExempt: (userId: string) => Promise<boolean> = async () => false) {
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 3 } });
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.headers["x-test-user"];
    if (!user) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    (request as unknown as { user: { userId: string } }).user = { userId: String(user) };
  });
  await app.register(audioRoutes, { service: svc, quotaExempt });
  await app.ready();
  return { app, svc };
}

const MP3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04]), Buffer.from("OKAUDIO!"), Buffer.alloc(200, 0xfb)]);
const tagged = (tag: string) => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04]), Buffer.from(tag), Buffer.alloc(200, 0xfb)]);

function multipartBody(file: { name: string; data: Buffer } | null, fields: Record<string, string> = {}) {
  const boundary = "----rbAudioTest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(file.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(app: Awaited<ReturnType<typeof makeApp>>["app"], user: string | null, file: { name: string; data: Buffer } | null, fields?: Record<string, string>) {
  const body = multipartBody(file, fields);
  return app.inject({ method: "POST", url: "/audio/denoise", payload: Readable.from([body.payload]), headers: { ...body.headers, ...(user ? { "x-test-user": user } : {}) } });
}

test("audio routes: sign-in required on every route", async () => {
  const { app } = await makeApp();
  for (const [method, url] of [
    ["GET", "/audio/capabilities"],
    ["POST", "/audio/denoise"],
    ["GET", "/audio/jobs/00000000-0000-4000-8000-000000000001"],
    ["GET", "/audio/jobs/00000000-0000-4000-8000-000000000001/download"],
    ["GET", "/audio/jobs/00000000-0000-4000-8000-000000000001/preview?which=clean"],
    ["DELETE", "/audio/jobs/00000000-0000-4000-8000-000000000001"],
  ] as const) {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  const caps = await app.inject({ method: "GET", url: "/audio/capabilities", headers: { "x-test-user": "u1" } });
  assert.equal(caps.statusCode, 200);
  assert.equal(caps.json().engine, "deepfilternet");
  await app.close();
});

test("audio denoise: retired mode=voice (Voice clean) falls back to plain noise removal", async () => {
  const { app } = await makeApp();
  const res = await upload(app, "u-voice", { name: "old-client.mp3", data: MP3 }, { mode: "voice", strength: "80", output: "mp3" });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().job.mode, "noise");
  await app.inject({ method: "DELETE", url: `/audio/jobs/${res.json().jobId}`, headers: { "x-test-user": "u-voice" } });
  await app.close();
});

test("audio denoise: 202 + jobId, fields parsed and clamped, status for owner, 404 for others", async () => {
  const { app } = await makeApp();
  const res = await upload(app, "u1", { name: "talk.mp3", data: MP3 }, { mode: "conversation", strength: "100", output: "flac" });
  assert.equal(res.statusCode, 202, res.body);
  const body = res.json();
  assert.match(body.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(body.status, "queued");
  assert.equal(body.job.mode, "conversation");
  assert.equal(body.job.strength, 100);
  assert.equal(body.job.output, "flac");
  const own = await app.inject({ method: "GET", url: `/audio/jobs/${body.jobId}`, headers: { "x-test-user": "u1" } });
  assert.equal(own.statusCode, 200);
  const other = await app.inject({ method: "GET", url: `/audio/jobs/${body.jobId}`, headers: { "x-test-user": "u2" } });
  assert.equal(other.statusCode, 404);
  const otherDel = await app.inject({ method: "DELETE", url: `/audio/jobs/${body.jobId}`, headers: { "x-test-user": "u2" } });
  assert.equal(otherDel.statusCode, 404);
  const bad = await app.inject({ method: "GET", url: "/audio/jobs/not-a-uuid", headers: { "x-test-user": "u1" } });
  assert.equal(bad.statusCode, 404);
  // Not done yet → download/preview 409
  const dl = await app.inject({ method: "GET", url: `/audio/jobs/${body.jobId}/download`, headers: { "x-test-user": "u1" } });
  assert.equal(dl.statusCode, 409);
  // Second upload while one is active → 409
  const second = await upload(app, "u1", { name: "b.mp3", data: MP3 });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "JOB_IN_PROGRESS");
  // Round 26: the 409 names the active job, and GET /audio/jobs/active returns it (owner only).
  assert.equal(second.json().activeJobId, body.jobId);
  const act = await app.inject({ method: "GET", url: "/audio/jobs/active", headers: { "x-test-user": "u1" } });
  assert.equal(act.statusCode, 200);
  assert.equal(act.json().job.id, body.jobId);
  assert.equal(act.headers["cache-control"], "no-store");
  const actOther = await app.inject({ method: "GET", url: "/audio/jobs/active", headers: { "x-test-user": "u2" } });
  assert.equal(actOther.json().job, null);
  // DELETE cancels and removes files
  const del = await app.inject({ method: "DELETE", url: `/audio/jobs/${body.jobId}`, headers: { "x-test-user": "u1" } });
  assert.equal(del.statusCode, 200);
  const actAfter = await app.inject({ method: "GET", url: "/audio/jobs/active", headers: { "x-test-user": "u1" } });
  assert.equal(actAfter.json().job, null);
  // ...and the new upload is accepted right away.
  const third = await upload(app, "u1", { name: "c.mp3", data: MP3 });
  assert.equal(third.statusCode, 202, third.body);
  await app.inject({ method: "DELETE", url: `/audio/jobs/${third.json().jobId}`, headers: { "x-test-user": "u1" } });
  assert.equal(fs.existsSync(path.join(tmp, body.jobId)), false);
  const gone = await app.inject({ method: "GET", url: `/audio/jobs/${body.jobId}`, headers: { "x-test-user": "u1" } });
  assert.equal(gone.statusCode, 404);
  await app.close();
});

test("audio denoise: rejects too large, playlists, text/exe/zip, no audio, too long, corrupt, no file; cleans up", async () => {
  const { app } = await makeApp(fakeBackend(64 * 1024, 100));
  const big = await upload(app, "u1", { name: "big.wav", data: Buffer.concat([MP3, Buffer.alloc(70 * 1024, 1)]) });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().code, "FILE_TOO_LARGE");
  const m3u8 = await upload(app, "u1", { name: "list.m3u8", data: Buffer.from("#EXTM3U\nhttp://example.com/a.ts\n") });
  assert.equal(m3u8.statusCode, 415);
  const renamed = await upload(app, "u1", { name: "song.mp3", data: Buffer.from("#EXTM3U\nC:\\Windows\\win.ini\n") });
  assert.equal(renamed.statusCode, 415);
  const ffconcat = await upload(app, "u1", { name: "a.wav", data: Buffer.from("ffconcat version 1.0\nfile 'C:/Windows/win.ini'\n") });
  assert.equal(ffconcat.statusCode, 415);
  const exe = await upload(app, "u1", { name: "a.mp3", data: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 0)]) });
  assert.equal(exe.statusCode, 415);
  const zip = await upload(app, "u1", { name: "a.mp3", data: Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(100, 0)]) });
  assert.equal(zip.statusCode, 415);
  const noAudio = await upload(app, "u1", { name: "clip.mp4", data: tagged("NOAUDIO!") });
  assert.equal(noAudio.statusCode, 415);
  assert.equal(noAudio.json().code, "NO_AUDIO_STREAM");
  const long = await upload(app, "u1", { name: "long.mp3", data: tagged("LONGLONG") });
  assert.equal(long.statusCode, 422);
  assert.equal(long.json().code, "TOO_LONG");
  assert.equal(long.json().durationSeconds, 700);
  assert.equal(long.json().maxSeconds, 600);
  assert.match(long.json().error, /11:40 long/);
  const corrupt = await upload(app, "u1", { name: "x.mp3", data: tagged("CORRUPT!") });
  assert.equal(corrupt.statusCode, 422);
  const none = await upload(app, "u1", null, { mode: "noise" });
  assert.equal(none.statusCode, 400);
  const notMultipart = await app.inject({ method: "POST", url: "/audio/denoise", headers: { "x-test-user": "u1", "content-type": "application/json" }, payload: "{}" });
  assert.equal(notMultipart.statusCode, 415);
  // Every rejected upload removed its temp folder.
  const leftovers = fs.readdirSync(tmp).filter((d) => fs.existsSync(path.join(tmp, d, "input")));
  assert.equal(leftovers.length, 0);
  await app.close();
});

test("audio denoise: 11th upload in an hour → 429 with Retry-After", async () => {
  const svc = fakeBackend(1024 * 1024, 10);
  const { app } = await makeApp(svc);
  for (let i = 0; i < 10; i++) {
    const res = await upload(app, "u9", { name: `a${i}.mp3`, data: MP3 });
    assert.equal(res.statusCode, 202, `upload ${i}`);
    svc.jobs.forEach((j) => (j.status = "done"));
  }
  const res = await upload(app, "u9", { name: "a11.mp3", data: MP3 });
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers["retry-after"]) > 0);
  const otherUser = await upload(app, "u10", { name: "a.mp3", data: MP3 });
  assert.equal(otherUser.statusCode, 202);
  await app.close();
});

test("audio download + preview: headers, filename, range", async () => {
  const svc = fakeBackend();
  const { app } = await makeApp(svc);
  const res = await upload(app, "u1", { name: "Café talk!.mp3", data: MP3 }, { output: "mp3" });
  const id = res.json().jobId;
  const job = svc.jobs.get(id)!;
  job.status = "done";
  job.result = { format: "MP3", ext: "mp3" } as AudioJob["result"];
  fs.writeFileSync(path.join(job.dir, "out.mp3"), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(job.dir, "clean.mp3"), Buffer.alloc(500, 9));
  const dl = await app.inject({ method: "GET", url: `/audio/jobs/${id}/download`, headers: { "x-test-user": "u1" } });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers["content-type"], "audio/mpeg");
  assert.equal(dl.headers["x-content-type-options"], "nosniff");
  assert.equal(dl.headers["cache-control"], "private, no-store");
  assert.equal(String(dl.headers["content-disposition"]), "attachment; filename=\"Cafe talk_-clean.mp3\"; filename*=UTF-8''Caf%C3%A9%20talk_-clean.mp3");
  assert.equal(dl.rawPayload.length, 1000);
  const pv = await app.inject({ method: "GET", url: `/audio/jobs/${id}/preview?which=clean`, headers: { "x-test-user": "u1", range: "bytes=100-199" } });
  assert.equal(pv.statusCode, 206);
  assert.equal(pv.headers["content-range"], "bytes 100-199/500");
  assert.equal(pv.rawPayload.length, 100);
  const bad = await app.inject({ method: "GET", url: `/audio/jobs/${id}/preview?which=clean`, headers: { "x-test-user": "u1", range: "bytes=900-" } });
  assert.equal(bad.statusCode, 416);
  const orig = await app.inject({ method: "GET", url: `/audio/jobs/${id}/preview?which=original`, headers: { "x-test-user": "u1" } });
  assert.equal(orig.statusCode, 410);
  // BUG-1323: which must be exactly original|clean.
  for (const q of ["", "?which=", "?which=CLEAN", "?which=both", "?which=clean&which=original", "?which=../out.mp3"]) {
    const r = await app.inject({ method: "GET", url: `/audio/jobs/${id}/preview${q}`, headers: { "x-test-user": "u1" } });
    assert.equal(r.statusCode, 400, q);
    assert.equal(r.json().code, "BAD_WHICH");
  }
  await app.close();
});

test("BUG-1341: signed preview links stream with Range/206, ETag/304, private cache; bound to job + owner + expiry", async () => {
  const svc = fakeBackend();
  const { app } = await makeApp(svc);
  const res = await upload(app, "u1", { name: "talk.mp3", data: MP3 }, { mode: "conversation" });
  const id = res.json().jobId;
  const job = svc.jobs.get(id)!;
  assert.equal(job.mode, "conversation");
  const pending = await app.inject({ method: "GET", url: `/audio/jobs/${id}`, headers: { "x-test-user": "u1" } });
  assert.equal(pending.json().previews, undefined, "no links before done");
  job.status = "done";
  job.result = { format: "MP3", ext: "mp3" } as AudioJob["result"];
  fs.writeFileSync(path.join(job.dir, "clean.mp3"), Buffer.alloc(500, 9));
  fs.writeFileSync(path.join(job.dir, "original.mp3"), Buffer.alloc(300, 3));
  const st = await app.inject({ method: "GET", url: `/audio/jobs/${id}`, headers: { "x-test-user": "u1" } });
  const pv = st.json().previews;
  assert.match(pv.clean, new RegExp(`^/audio/p/${id}/clean/\\d+/[A-Za-z0-9_-]{43}$`));
  assert.ok(pv.expiresAt > Date.now() && pv.expiresAt <= Date.now() + 301_000);
  // No Bearer header needed: the signature is the auth.
  const full = await app.inject({ method: "GET", url: pv.clean });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["content-length"], "500");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.headers["cache-control"], "private, max-age=300");
  const etag = String(full.headers.etag);
  assert.match(etag, /^".+"$/);
  const part = await app.inject({ method: "GET", url: pv.clean, headers: { range: "bytes=0-99" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], "bytes 0-99/500");
  assert.equal(part.headers["content-length"], "100");
  const again = await app.inject({ method: "GET", url: pv.clean, headers: { "if-none-match": etag } });
  assert.equal(again.statusCode, 304);
  // IDOR: tampering with the job, track, expiry or signature → 404 (never reveals the job).
  const [, , , , , exp, sig] = pv.clean.split("/");
  const other = await upload(app, "u2", { name: "b.mp3", data: MP3 });
  const otherId = other.json().jobId;
  for (const url of [
    `/audio/p/${otherId}/clean/${exp}/${sig}`,
    `/audio/p/${id}/original/${exp}/${sig}`,
    `/audio/p/${id}/clean/${Number(exp) + 60}/${sig}`,
    `/audio/p/${id}/clean/${exp}/${sig.slice(0, -1)}A`,
    `/audio/p/${id}/result/${exp}/${sig}`,
  ]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 404, url);
  }
  // The Bearer preview route keeps its owner check.
  const notMine = await app.inject({ method: "GET", url: `/audio/jobs/${id}/preview?which=clean`, headers: { "x-test-user": "u2" } });
  assert.equal(notMine.statusCode, 404);
  await app.close();
});

test("strength: non-integer or out of 0..100 → 400 BAD_STRENGTH; nothing queued", async () => {
  const svc = fakeBackend();
  const { app } = await makeApp(svc);
  for (const strength of ["250", "-1", "50.5", "abc", "1e2"]) {
    const res = await upload(app, "u7", { name: "a.mp3", data: MP3 }, { strength });
    assert.equal(res.statusCode, 400, strength);
    assert.equal(res.json().code, "BAD_STRENGTH");
  }
  assert.equal(svc.jobs.size, 0);
  const ok = await upload(app, "u7", { name: "a.mp3", data: MP3 }, { strength: "0" });
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.json().job.strength, 0);
  await app.close();
});

test("BUG-1322: rejected uploads don't use the 10/hour quota; a 413 is never hidden behind 429", async () => {
  const svc = fakeBackend(64 * 1024, 10);
  const { app } = await makeApp(svc);
  const big = { name: "big.wav", data: Buffer.concat([MP3, Buffer.alloc(70 * 1024, 1)]) };
  for (let i = 0; i < 12; i++) assert.equal((await upload(app, "q1", big)).statusCode, 413, `413 #${i}`);
  assert.equal((await upload(app, "q1", { name: "x.mp3", data: tagged("CORRUPT!") })).statusCode, 422);
  // Ten valid uploads still fit.
  for (let i = 0; i < 10; i++) {
    const r = await upload(app, "q1", { name: `ok${i}.mp3`, data: MP3 });
    assert.equal(r.statusCode, 202, `valid #${i}`);
    svc.jobs.forEach((j) => (j.status = "done"));
  }
  // Quota full: an invalid file still gets its own error, a valid one gets 429.
  assert.equal((await upload(app, "q1", big)).statusCode, 413);
  const over = await upload(app, "q1", { name: "ok11.mp3", data: MP3 });
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().code, "RATE_LIMITED");
  await app.close();
});

test("BUG-1322: abuse guard after many rejected uploads (429 TOO_MANY_INVALID)", async () => {
  const svc = fakeBackend(64 * 1024, 10);
  const { app } = await makeApp(svc);
  const exe = { name: "a.mp3", data: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 0)]) };
  for (let i = 0; i < INVALID_UPLOADS_PER_HOUR; i++) assert.equal((await upload(app, "q2", exe)).statusCode, 415);
  const blocked = await upload(app, "q2", { name: "ok.mp3", data: MP3 });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().code, "TOO_MANY_INVALID");
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  assert.equal((await upload(app, "q3", { name: "ok.mp3", data: MP3 })).statusCode, 202);
  await app.close();
});

// ---------- Round 27: fair hourly quota ----------
const finishAll = (svc: AudioBackend) => svc.jobs.forEach((j) => (j.status = "done"));

test("round27: 429 says when to try again (~N min) and sends Retry-After", async () => {
  const svc = fakeBackend(64 * 1024, 2);
  const { app } = await makeApp(svc);
  for (let i = 0; i < 2; i++) {
    assert.equal((await upload(app, "r1", { name: `a${i}.mp3`, data: MP3 })).statusCode, 202);
    finishAll(svc);
  }
  const over = await upload(app, "r1", { name: "a3.mp3", data: MP3 });
  assert.equal(over.statusCode, 429);
  const body = over.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.match(body.error, /You've reached 2 files this hour\. Try again in ~\d+ min\./);
  assert.equal(body.limit, 2);
  assert.ok(body.retryAfterMinutes >= 1 && body.retryAfterMinutes <= 60);
  assert.ok(Number(over.headers["retry-after"]) > 0);
  await app.close();
});

test("round27: retryMinutes rounds up and is never 0", () => {
  assert.equal(retryMinutes(1), 1);
  assert.equal(retryMinutes(60), 1);
  assert.equal(retryMinutes(61), 2);
  assert.equal(retryMinutes(3599), 60);
});

test("round27: canceled / failed jobs give their quota slot back; completed ones keep it", async () => {
  const svc = fakeBackend(64 * 1024, 1);
  const { app } = await makeApp(svc);
  assert.equal(typeof svc.onQuotaRefund, "function");
  // 1st upload is canceled by the user -> refunded.
  const a = await upload(app, "r2", { name: "a.mp3", data: MP3 });
  assert.equal(a.statusCode, 202);
  const jobA = svc.jobs.get(a.json().jobId)!;
  jobA.status = "canceled";
  svc.onQuotaRefund!(jobA);
  // 2nd upload fails on the server -> refunded.
  const b = await upload(app, "r2", { name: "b.mp3", data: MP3 });
  assert.equal(b.statusCode, 202);
  const jobB = svc.jobs.get(b.json().jobId)!;
  jobB.status = "failed";
  svc.onQuotaRefund!(jobB);
  // 3rd upload completes -> counts.
  assert.equal((await upload(app, "r2", { name: "c.mp3", data: MP3 })).statusCode, 202);
  finishAll(svc);
  assert.equal((await upload(app, "r2", { name: "d.mp3", data: MP3 })).statusCode, 429);
  // Refunding the same job twice never frees an extra slot.
  svc.onQuotaRefund!(jobA);
  assert.equal((await upload(app, "r2", { name: "e.mp3", data: MP3 })).statusCode, 429);
  await app.close();
});

test("round27: admin / owner bypass the hourly quota; normal users do not", async () => {
  const svc = fakeBackend(64 * 1024, 1);
  const { app } = await makeApp(svc, async (userId) => userId === "boss");
  for (let i = 0; i < 4; i++) {
    const r = await upload(app, "boss", { name: `b${i}.mp3`, data: MP3 });
    assert.equal(r.statusCode, 202, `admin upload #${i}`);
    assert.equal(r.headers["x-ratelimit-limit"], undefined);
    finishAll(svc);
  }
  assert.equal((await upload(app, "pleb", { name: "p1.mp3", data: MP3 })).statusCode, 202);
  finishAll(svc);
  assert.equal((await upload(app, "pleb", { name: "p2.mp3", data: MP3 })).statusCode, 429);
  await app.close();
});

test("round27: a failing role lookup means no bypass (fail closed)", async () => {
  const svc = fakeBackend(64 * 1024, 1);
  const { app } = await makeApp(svc, async () => {
    throw new Error("db down");
  });
  assert.equal((await upload(app, "x1", { name: "a.mp3", data: MP3 })).statusCode, 202);
  finishAll(svc);
  assert.equal((await upload(app, "x1", { name: "b.mp3", data: MP3 })).statusCode, 429);
  await app.close();
});

test("round27: exempt roles are admin and owner (case-insensitive)", () => {
  for (const r of ["admin", "ADMIN", " Owner "]) assert.equal(isQuotaExemptRole(r), true, r);
  for (const r of ["user", "", null, undefined, "administrator"]) assert.equal(isQuotaExemptRole(r as string | null | undefined), false, String(r));
});