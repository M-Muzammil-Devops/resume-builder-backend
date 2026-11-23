import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadAudioConfig } from "./config";
import { MemoryJobStore, type StoredJob } from "./jobStore";
import { AudioError, AudioService, type AudioJob } from "./service";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;

function make() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aud26-"));
  const svc = new AudioService({ ...loadAudioConfig({}), tmpDir: tmp, ffmpegPath: "ffmpeg-missing-for-test", ffprobePath: "ffprobe-missing-for-test" }, quiet, new MemoryJobStore());
  return { svc, tmp, priv: svc as unknown as { queue: string[]; running: string | null; ffmpegOk: boolean; ffprobeOk: boolean } };
}

let n = 0;
function put(svc: AudioService, tmp: string, status: StoredJob["status"], extra: Partial<AudioJob> = {}): AudioJob {
  n += 1;
  const id = `26000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  mkdirSync(path.join(tmp, id), { recursive: true });
  const job = {
    id,
    userId: "owner",
    dir: path.join(tmp, id),
    status,
    progress: 40,
    step: "x",
    mode: "noise",
    strength: 80,
    output: "same",
    input: { name: "sharafat-voice-karachi.mp4", sizeBytes: 10, codec: "aac", container: "mov", duration: 942, channels: 1, sampleRate: 44100, streamIndex: 0, hasVideo: true },
    spec: { ext: "mp3", label: "MP3" },
    createdAt: Date.now() - 1000,
    estimateMs: 1000,
    abort: new AbortController(),
    ...extra,
  } as unknown as AudioJob;
  svc.jobs.set(id, job);
  return job;
}

test("round26 max job time: 30 min default, AUDIO_MAX_JOB_MINUTES overrides", () => {
  assert.equal(loadAudioConfig({}).maxJobMs, 30 * MIN);
  assert.equal(loadAudioConfig({ AUDIO_MAX_JOB_MINUTES: "45" }).maxJobMs, 45 * MIN);
});

test("round26 terminal states never hold the active slot", () => {
  const { svc, tmp } = make();
  for (const st of ["done", "failed", "canceled"] as const) put(svc, tmp, st);
  assert.equal(svc.activeJobFor("owner"), undefined);
  svc.close();
});

test("round26 a genuinely queued / running job is active; orphans and over-time jobs are stale and released", () => {
  const { svc, tmp, priv } = make();
  // queued and really in the queue → active
  const q = put(svc, tmp, "queued");
  priv.queue.push(q.id);
  assert.equal(svc.activeJobFor("owner")?.id, q.id);
  // queued but waiting longer than 2 x max → stale
  q.createdAt = Date.now() - 61 * MIN;
  assert.equal(svc.activeJobFor("owner"), undefined);
  assert.equal(q.status, "failed");
  assert.equal(q.error?.code, "JOB_STALE");
  assert.equal(priv.queue.includes(q.id), false);

  // "queued" but nobody will ever run it (not in the queue) → stale
  const lost = put(svc, tmp, "queued");
  assert.equal(svc.activeJobFor("owner"), undefined);
  assert.equal(lost.status, "failed");

  // processing but not the job the queue is running (left over from a crash) → stale
  const orphan = put(svc, tmp, "denoising", { startedAt: Date.now() - MIN });
  assert.equal(svc.activeJobFor("owner"), undefined);
  assert.equal(orphan.status, "failed");

  // the running job → active; past 30 min → stale, aborted
  const run = put(svc, tmp, "denoising", { startedAt: Date.now() - 5 * MIN });
  priv.running = run.id;
  assert.equal(svc.activeJobFor("owner")?.id, run.id);
  run.startedAt = Date.now() - 31 * MIN;
  assert.equal(svc.activeJobFor("owner"), undefined);
  assert.equal(run.abort.signal.aborted, true);
  assert.equal(run.status, "failed");
  assert.equal(svc.publicJob(run).error?.code, "JOB_STALE");
  priv.running = null;
  svc.close();
});

test("round26 409 names the active job (id, status, progress, file name)", async () => {
  const { svc, tmp, priv } = make();
  priv.ffmpegOk = true;
  priv.ffprobeOk = true;
  const q = put(svc, tmp, "queued");
  priv.queue.push(q.id);
  await assert.rejects(svc.assertCanAccept("owner"), (e: unknown) => {
    assert.ok(e instanceof AudioError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "JOB_IN_PROGRESS");
    assert.match(e.message, /earlier file is still processing/);
    assert.equal(e.details?.activeJobId, q.id);
    assert.equal(e.details?.activeStatus, "queued");
    assert.equal(e.details?.activeName, "sharafat-voice-karachi.mp4");
    return true;
  });
  assert.equal(svc.activeJobFor("someone-else"), undefined);
  svc.close();
});

test("round26 a crash in processing ends in 'failed' and frees the slot", async () => {
  const { svc, tmp } = make();
  const { id, dir } = svc.newJobDir();
  mkdirSync(dir, { recursive: true });
  const job = svc.enqueue({ id, dir, userId: "owner", name: "a.mp3", sizeBytes: 1, info: put(svc, tmp, "done").input as never, mode: "noise", strength: 80, output: "same" });
  for (let i = 0; i < 50 && job.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.status, "failed");
  assert.equal(svc.activeJobFor("owner"), undefined);
  svc.close();
});

test("round26 startup: restored jobs that are not really queued are released", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aud26r-"));
  const store = new MemoryJobStore();
  const id = "26aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  mkdirSync(path.join(tmp, id), { recursive: true }); // queued, but its upload is gone
  await store.save({
    id, userId: "owner", dir: path.join(tmp, id), status: "queued", progress: 2, step: "x", mode: "noise", strength: 80, output: "same",
    input: { name: "x.mp3", sizeBytes: 1, codec: "mp3", container: "mp3", duration: 5, channels: 1, sampleRate: 44100, streamIndex: 0, hasVideo: false },
    spec: { ext: "mp3", label: "MP3" } as StoredJob["spec"], createdAt: Date.now() - 1000, estimateMs: 1000,
  });
  const svc = new AudioService({ ...loadAudioConfig({}), tmpDir: tmp, ffmpegPath: "ffmpeg-missing-for-test", ffprobePath: "ffprobe-missing-for-test" }, quiet, store);
  await svc.restore(); // the queued job comes back (its folder exists) but its upload is gone
  const j = svc.jobs.get(id);
  // restore() only resumes queued jobs whose input exists, so this one is not in the queue:
  assert.equal(svc.releaseStale("startup"), j && j.status !== "failed" ? 1 : 0);
  assert.equal(svc.activeJobFor("owner"), undefined);
  svc.close();
});

test("round26 capabilities list the conversation mode", () => {
  const { svc } = make();
  assert.deepEqual(svc.capabilities().modes, ["noise", "conversation"]);
  svc.close();
});
