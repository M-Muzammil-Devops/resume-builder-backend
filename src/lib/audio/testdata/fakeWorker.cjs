// Test double for audio-worker/worker.py: same JSON-lines protocol, no model.
// Each job reports `chunks` progress lines `delayMs` apart, then a result.
const readline = require("node:readline");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
process.stderr.write("[audio-worker] WARNING: AUDIO_DEVICE=cuda but torch.cuda.is_available() is False; falling back to CPU\n");
out({ type: "ready", device: "cpu", sr: 48000 });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const job = JSON.parse(line);
  const [chunks, delayMs] = String(job.input).split(":").map(Number);
  for (let i = 1; i <= chunks; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    out({ type: "progress", id: job.id, done: i, total: chunks, chunkSeconds: job.chunk_seconds, overlap: job.overlap_seconds });
  }
  out({ type: "result", id: job.id, ok: true, seconds: 0.1, chunks });
});
