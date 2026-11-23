import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadAudioConfig } from "./config";
import { MemoryJobStore } from "./jobStore";
import { AudioService, type AudioJob } from "./service";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function make() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aud27-"));
  const svc = new AudioService({ ...loadAudioConfig({}), tmpDir: tmp, ffmpegPath: "ffmpeg-missing-for-test", ffprobePath: "ffprobe-missing-for-test" }, quiet, new MemoryJobStore());
  const refunds: string[] = [];
  svc.onQuotaRefund = (job) => refunds.push(job.id);
  return { svc, tmp, refunds, priv: svc as unknown as { queue: string[]; running: string | null } };
}

let n = 0;
function put(svc: AudioService, tmp: string, status: AudioJob["status"]): AudioJob {
  n += 1;
  const id = `27000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  mkdirSync(path.join(tmp, id), { recursive: true });
  const job = {
    id, userId: "owner", dir: path.join(tmp, id), status, progress: 40, step: "x", mode: "noise", strength: 80, output: "same",
    input: { name: "a.mp3", sizeBytes: 10, codec: "mp3", container: "mp3", duration: 60, channels: 1, sampleRate: 44100, streamIndex: 0, hasVideo: false },
    spec: { ext: "mp3", label: "MP3" }, createdAt: Date.now() - 1000, estimateMs: 1000, abort: new AbortController(),
  } as unknown as AudioJob;
  svc.jobs.set(id, job);
  return job;
}

test("round27 config: AUDIO_HOURLY_LIMIT sets the quota (default 10, old name still read)", () => {
  assert.equal(loadAudioConfig({}).uploadsPerHour, 10);
  assert.equal(loadAudioConfig({ AUDIO_HOURLY_LIMIT: "25" }).uploadsPerHour, 25);
  assert.equal(loadAudioConfig({ AUDIO_UPLOADS_PER_HOUR: "7" }).uploadsPerHour, 7);
  assert.equal(loadAudioConfig({ AUDIO_HOURLY_LIMIT: "30", AUDIO_UPLOADS_PER_HOUR: "7" }).uploadsPerHour, 30);
  assert.equal(loadAudioConfig({ AUDIO_HOURLY_LIMIT: "abc" }).uploadsPerHour, 10);
  assert.equal(loadAudioConfig({ AUDIO_HOURLY_LIMIT: "0" }).uploadsPerHour, 10);
});

test("round27 cancel (remove) of a queued / processing job refunds once; done / failed jobs do not", async () => {
  const { svc, tmp, refunds } = make();
  const q = put(svc, tmp, "queued");
  const p = put(svc, tmp, "denoising");
  const d = put(svc, tmp, "done");
  const f = put(svc, tmp, "failed");
  for (const j of [q, p, d, f]) await svc.remove(j);
  assert.deepEqual(refunds, [q.id, p.id]);
  svc.close();
});

test("round27 stale jobs are refunded exactly once", () => {
  const { svc, tmp, refunds, priv } = make();
  const s = put(svc, tmp, "queued"); // not in the queue -> stale
  assert.equal(svc.activeJobFor("owner"), undefined);
  assert.equal(s.status, "failed");
  assert.equal(svc.releaseStale("sweep"), 0);
  assert.deepEqual(refunds, [s.id]);
  assert.equal(priv.queue.length, 0);
  svc.close();
});

test("round27 a crash in processing is refunded; a throwing hook never breaks the pipeline", async () => {
  const { svc, tmp, refunds, priv } = make();
  const j = put(svc, tmp, "queued");
  priv.queue.push(j.id);
  (svc as unknown as { process: () => Promise<void> }).process = async () => {
    throw new Error("worker crashed");
  };
  await (svc as unknown as { pump: () => Promise<void> }).pump();
  assert.equal(j.status, "failed");
  assert.deepEqual(refunds, [j.id]);

  svc.onQuotaRefund = () => {
    throw new Error("hook bug");
  };
  const k = put(svc, tmp, "queued");
  await svc.remove(k);
  assert.equal(k.status, "canceled");
  svc.close();
});