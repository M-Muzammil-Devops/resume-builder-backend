import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export type DenoiseResult = { ok: boolean; error?: string; seconds?: number; chunks?: number };
type Pending = { resolve: (v: DenoiseResult) => void; timer: NodeJS.Timeout; onProgress?: (done: number, total: number) => void; arm: () => void };

/** Chunk size and crossfade overlap sent to the worker (seconds). */
export const CHUNK_SECONDS = 60;
export const OVERLAP_SECONDS = 0.5;
type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

/**
 * Long-lived DeepFilterNet3 worker (audio-worker/worker.py). The model loads once; jobs are JSON lines
 * on stdin, results JSON lines on stdout. Spawned with an args array, no shell.
 * If it is missing or keeps crashing, callers fall back to the ffmpeg engines.
 */
export class DeepFilterWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<boolean> | null = null;
  private pending = new Map<string, Pending>();
  private failures = 0;
  private disabledUntil = 0;
  private killed = new WeakSet<object>();
  device: string | null = null;
  lastError: string | null = null;

  constructor(
    private python: string,
    private script: string,
    private deviceWanted: string,
    private log?: Log,
    /** Interpreter flags before the script (tests run a Node fake, which has no -u). */
    private interpreterArgs: string[] = ["-u"]
  ) {}

  available(): boolean {
    return existsSync(this.python) && existsSync(this.script) && Date.now() >= this.disabledUntil;
  }

  status(): "ready" | "starting" | "idle" | "unavailable" {
    if (!this.available()) return "unavailable";
    if (this.child && this.device) return "ready";
    if (this.child) return "starting";
    return "idle";
  }

  /** Start (or reuse) the worker. Resolves false when it cannot become ready. */
  start(): Promise<boolean> {
    if (this.ready) return this.ready;
    if (!this.available()) return Promise.resolve(false);
    this.ready = new Promise<boolean>((resolve) => {
      const child = spawn(this.python, [...this.interpreterArgs, this.script, "--device", this.deviceWanted], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
      this.child = child;
      let settled = false;
      const startTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.lastError = "worker start timeout";
          this.stop();
          resolve(false);
        }
      }, 180_000);
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        let msg: { type?: string; id?: string; device?: string; ok?: boolean; error?: string; seconds?: number; chunks?: number; done?: number; total?: number };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          this.device = msg.device || "cpu";
          this.failures = 0;
          this.log?.info({ engine: "deepfilternet", device: this.device }, "audio worker ready");
          if (!settled) {
            settled = true;
            clearTimeout(startTimer);
            resolve(true);
          }
          return;
        }
        if (msg.type === "progress" && msg.id) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          p.arm(); // each finished chunk restarts the inactivity timer
          if (typeof msg.done === "number" && typeof msg.total === "number" && msg.total > 0) p.onProgress?.(msg.done, msg.total);
          return;
        }
        if (msg.type === "result" && msg.id) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve({ ok: Boolean(msg.ok), error: msg.error, seconds: msg.seconds, chunks: msg.chunks });
        }
      });
      let errTail = "";
      child.stderr.on("data", (d: Buffer) => {
        const text = d.toString("utf8");
        errTail = (errTail + text).slice(-2000);
        // e.g. AUDIO_DEVICE=cuda without a CUDA build of torch: the worker falls back to CPU and says so.
        for (const m of text.matchAll(/\[audio-worker\] WARNING: ([^\r\n]+)/g)) this.log?.warn({ engine: "deepfilternet" }, m[1].slice(0, 300));
      });
      child.on("error", (err) => {
        this.lastError = err.message;
      });
      child.on("close", (code) => {
        if (this.child === child) {
          this.child = null;
          this.ready = null;
          this.device = null;
        }
        const tail = errTail.trim().split(/\r?\n/).slice(-1)[0] || "";
        this.lastError = `worker exited (${code}) ${tail}`.slice(0, 300);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: "worker exited" });
          this.pending.delete(id);
        }
        if (!settled) {
          settled = true;
          clearTimeout(startTimer);
          resolve(false);
        }
        if (this.killed.has(child)) return;
        this.failures += 1;
        // Back off after repeated crashes; the queue uses RNNoise meanwhile.
        if (this.failures >= 3) this.disabledUntil = Date.now() + 10 * 60_000;
        this.log?.warn({ engine: "deepfilternet", code, failures: this.failures }, "audio worker stopped");
      });
    });
    return this.ready;
  }

  /**
   * Denoise a 48 kHz WAV into another WAV, chunk by chunk. `timeoutMs` is an INACTIVITY limit:
   * it restarts after every finished chunk, so a 20-minute file is never cut off while it makes progress.
   */
  async denoise(
    id: string,
    input: string,
    output: string,
    attenLimDb: number | null,
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
    dryMix = 0
  ): Promise<DenoiseResult> {
    const ok = await this.start();
    if (!ok || !this.child) return { ok: false, error: this.lastError || "worker unavailable" };
    if (signal?.aborted) return { ok: false, error: "aborted" };
    return new Promise<DenoiseResult>((resolve) => {
      const onAbort = () => {
        // The worker processes one file at a time; killing it is the only way to stop it. It restarts lazily.
        this.stop();
      };
      const expire = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        this.stop();
        resolve({ ok: false, error: "timeout" });
      };
      const entry: Pending = {
        timer: setTimeout(expire, timeoutMs),
        onProgress,
        arm: () => {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(expire, timeoutMs);
        },
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
      };
      this.pending.set(id, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child!.stdin.write(
        JSON.stringify({ id, input, output, atten_lim_db: attenLimDb, dry_mix: dryMix, chunk_seconds: CHUNK_SECONDS, overlap_seconds: OVERLAP_SECONDS }) + "\n"
      );
    });
  }

  stop() {
    const c = this.child;
    this.child = null;
    this.ready = null;
    this.device = null;
    if (c) {
      this.killed.add(c);
      try {
        c.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}
