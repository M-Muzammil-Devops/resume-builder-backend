import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CHUNK_SECONDS, DeepFilterWorker, OVERLAP_SECONDS } from "./dfWorker";

const FAKE = path.join(__dirname, "testdata", "fakeWorker.cjs");
const logs: string[] = [];
const log = { info: () => undefined, warn: (_o: object, m?: string) => void logs.push(m || "") };

test("round23 chunked denoise: progress per chunk, inactivity timeout restarts on every chunk", async () => {
  const w = new DeepFilterWorker(process.execPath, FAKE, "cuda", log, []);
  try {
    const seen: string[] = [];
    // 4 chunks, 150 ms apart = 600 ms total, but the 400 ms limit only applies BETWEEN chunks.
    const r = await w.denoise("j1", "4:150", "out.wav", null, 400, undefined, (done, total) => seen.push(`${done}/${total}`));
    assert.equal(r.ok, true);
    assert.equal(r.chunks, 4);
    assert.deepEqual(seen, ["1/4", "2/4", "3/4", "4/4"]);
    assert.equal(w.device, "cpu");
    // The worker's CPU fallback warning reaches the API log.
    assert.ok(logs.some((m) => /falling back to CPU/.test(m)));
  } finally {
    w.stop();
  }
});

test("round23 chunked denoise: a stalled chunk still times out", async () => {
  const w = new DeepFilterWorker(process.execPath, FAKE, "cpu", log, []);
  try {
    const r = await w.denoise("j2", "2:500", "out.wav", null, 200);
    assert.deepEqual(r, { ok: false, error: "timeout" });
  } finally {
    w.stop();
  }
});

test("round23 chunk size ~60 s with a short crossfade overlap", () => {
  assert.equal(CHUNK_SECONDS, 60);
  assert.ok(OVERLAP_SECONDS > 0 && OVERLAP_SECONDS <= 1);
});

test("idle worker stops after idleMs, restarts lazily on the next job", async () => {
  const w = new DeepFilterWorker(process.execPath, FAKE, "cpu", log, [], 300);
  try {
    assert.equal(w.status(), "idle");
    const r1 = await w.denoise("i1", "1:10", "out.wav", null, 2000);
    assert.equal(r1.ok, true);
    assert.equal(w.status(), "ready");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(w.status(), "idle"); // stopped, memory freed
    const r2 = await w.denoise("i2", "1:10", "out.wav", null, 2000);
    assert.equal(r2.ok, true); // lazy restart
  } finally {
    w.stop();
  }
});
