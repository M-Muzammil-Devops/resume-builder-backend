import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { __setRedisClientForTests } from "../redis";
import { DEFAULT_MAX_MB, DEFAULT_MAX_SECONDS, loadAudioConfig, normalizeDevice } from "./config";
import { JOB_KEY_PREFIX, JOB_TTL_SECONDS, MemoryJobStore, RedisJobStore, type StoredJob } from "./jobStore";
import { RESTART_MESSAGE, bandProgress, parseStrength, tooLongMessage } from "./media";
import { AudioService } from "./service";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

test("round23 limits: 100 MB and 20 min by default, both from env", () => {
  const def = loadAudioConfig({});
  assert.equal(DEFAULT_MAX_MB, 100);
  assert.equal(DEFAULT_MAX_SECONDS, 1200);
  assert.equal(def.maxBytes, 100 * 1024 * 1024);
  assert.equal(def.maxSeconds, 1200);
  const custom = loadAudioConfig({ AUDIO_MAX_MB: "25", AUDIO_MAX_SECONDS: "300" });
  assert.equal(custom.maxBytes, 25 * 1024 * 1024);
  assert.equal(custom.maxSeconds, 300);
  assert.equal(loadAudioConfig({ AUDIO_MAX_MB: "abc" }).maxBytes, 100 * 1024 * 1024);
  assert.equal(tooLongMessage(21 * 60 + 5, 1200), "This recording is 21:05 long. The limit is 20 minutes.");
});

test("round23 AUDIO_DEVICE: cpu by default, cuda/auto only when asked", () => {
  assert.equal(loadAudioConfig({}).device, "cpu");
  assert.equal(normalizeDevice(undefined), "cpu");
  assert.equal(normalizeDevice(" CUDA "), "cuda");
  assert.equal(normalizeDevice("auto"), "auto");
  assert.equal(normalizeDevice("gpu"), "cpu");
});

test("round23 progress bands and empty strength", () => {
  assert.equal(bandProgress(0, 20, 15, 82), 15);
  assert.equal(bandProgress(10, 20, 15, 82), 48.5);
  assert.equal(bandProgress(20, 20, 15, 82), 82);
  assert.equal(bandProgress(30, 20, 15, 82), 82);
  assert.equal(bandProgress(1, 0, 15, 82), 15);
  assert.equal(parseStrength(""), 80);
  assert.equal(parseStrength("   "), 80);
  assert.equal(parseStrength("1e2"), null);
});

function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    client: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, _mode?: string, ttl?: number) => {
        store.set(k, v);
        ttls.set(k, ttl ?? -1);
      },
      del: async (...ks: string[]) => void ks.forEach((k) => store.delete(k)),
      quit: async () => undefined,
      scan: async (_c: string, _m: string, pattern: string) => ["0", [...store.keys()].filter((k) => k.startsWith(pattern.replace(/\*$/, "")))] as [string, string[]],
    },
  };
}

function stored(dir: string, id: string, status: StoredJob["status"], extra: Partial<StoredJob> = {}): StoredJob {
  return {
    id,
    userId: "u1",
    dir: path.join(dir, id),
    status,
    progress: 40,
    step: "x",
    mode: "noise",
    strength: 80,
    output: "same",
    input: { name: "talk.mp3", sizeBytes: 10, codec: "mp3", container: "mp3", duration: 1140, channels: 1, sampleRate: 44100, streamIndex: 0, hasVideo: false },
    spec: { ext: "mp3", label: "MP3" } as StoredJob["spec"],
    createdAt: Date.now() - 1000,
    estimateMs: 1000,
    ...extra,
  };
}

test("round23 Redis job store: key prefix, 1 h TTL, load back", async () => {
  const r = fakeRedis();
  __setRedisClientForTests(r.client);
  try {
    const s = new RedisJobStore();
    assert.equal(s.persistent, true);
    const job = stored("/tmp/x", "11111111-1111-4111-8111-111111111111", "denoising");
    await s.save(job);
    const key = JOB_KEY_PREFIX + job.id;
    assert.equal(r.ttls.get(key), JOB_TTL_SECONDS);
    assert.equal(JOB_TTL_SECONDS, 3600);
    assert.equal((await s.loadAll())[0].status, "denoising");
    await s.remove(job.id);
    assert.equal(r.store.size, 0);
  } finally {
    __setRedisClientForTests(null);
  }
  assert.equal(new RedisJobStore().persistent, false);
  assert.deepEqual(await new RedisJobStore().loadAll(), []);
});

test("round23 restart: done jobs come back, running → failed 'please retry', queued → resumed", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aud-"));
  const store = new MemoryJobStore();
  const ids = {
    done: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    running: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    queued: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    gone: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    outside: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  };
  for (const id of Object.values(ids)) mkdirSync(path.join(tmp, id), { recursive: true });
  writeFileSync(path.join(tmp, ids.done, "out.mp3"), "x");
  writeFileSync(path.join(tmp, ids.running, "dec.wav"), "x");
  writeFileSync(path.join(tmp, ids.queued, "input"), "x");
  await store.save(stored(tmp, ids.done, "done", { progress: 100, finishedAt: Date.now() }));
  await store.save(stored(tmp, ids.running, "denoising", { chunks: { done: 7, total: 19 } }));
  await store.save(stored(tmp, ids.queued, "queued", { userId: "u2" }));
  await store.save(stored(tmp, ids.gone, "done")); // result file missing → dropped
  await store.save({ ...stored(tmp, ids.outside, "done"), dir: "/etc/somewhere" }); // never trusted

  const cfg = { ...loadAudioConfig({}), tmpDir: tmp };
  const svc = new AudioService(cfg, quiet, store);
  const counts = await svc.restore();
  assert.deepEqual(counts, { restored: 3, resumed: 1, failed: 1 });

  const done = svc.jobs.get(ids.done)!;
  assert.equal(done.status, "done");
  assert.equal(svc.publicJob(done).progress, 100);

  const running = svc.jobs.get(ids.running)!;
  assert.equal(running.status, "failed");
  assert.deepEqual(running.error, { code: "SERVER_RESTARTED", message: RESTART_MESSAGE });
  assert.match(RESTART_MESSAGE, /upload it again to retry/);
  assert.equal(existsSync(path.join(tmp, ids.running)), false);
  assert.equal(JSON.parse(store.data.get(ids.running)!).status, "failed"); // saved back

  const queued = svc.jobs.get(ids.queued)!;
  assert.equal(queued.status, "queued");
  assert.equal(svc.position(queued), 1);
  assert.ok(svc.activeJobFor("u2"));

  assert.equal(svc.jobs.has(ids.gone), false);
  assert.equal(svc.jobs.has(ids.outside), false);
  svc.close();
});

test("round23 job state is saved on enqueue and removed on delete", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aud-"));
  const store = new MemoryJobStore();
  const svc = new AudioService({ ...loadAudioConfig({}), tmpDir: tmp, ffmpegPath: "ffmpeg-missing-for-test" }, quiet, store);
  const { id, dir } = svc.newJobDir();
  mkdirSync(dir, { recursive: true });
  const job = svc.enqueue({
    id,
    dir,
    userId: "u1",
    name: "a.mp3",
    sizeBytes: 1,
    info: stored(tmp, id, "queued").input,
    mode: "noise",
    strength: 80,
    output: "same",
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(store.data.has(job.id));
  await svc.remove(job);
  assert.equal(store.data.has(job.id), false);
  svc.close();
});
