import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AudioConfig } from "./config";
import { CHUNK_SECONDS, DeepFilterWorker } from "./dfWorker";
import { RedisJobStore, toStored, type JobStore, type StoredJob } from "./jobStore";
import {
  RESTART_MESSAGE,
  bandProgress,
  decodeArgs,
  dfAttenLimit,
  encodeArgs,
  fallbackFilter,
  outputFor,
  parseMetrics,
  backgroundLevels,
  dryMix,
  pcmArgs,
  windowLevelsDb,
  parseProbe,
  peaksFromPcm,
  previewArgs,
  probeArgs,
  sniffReject,
  type EngineName,
  type JobState,
  type Mode,
  type OutputChoice,
  type OutputSpec,
  type ProbeInfo,
  measureArgs,
  parseProgressSeconds,
  tooLongMessage,
} from "./media";
import { run } from "./proc";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export type JobResult = {
  format: string;
  ext: string;
  sizeBytes: number;
  duration: number | null;
  engine: EngineName;
  device: string | null;
  noiseFloorBeforeDb: number | null;
  noiseFloorAfterDb: number | null;
  /** Most any frame was pulled down (DeepFilterNet cap), dB. */
  maxReductionDb?: number | null;
  lufs: number | null;
  fallbackNote: string | null;
  processingMs: number;
  peaks: { original: number[]; clean: number[] };
};

export type AudioJob = {
  id: string;
  userId: string;
  dir: string;
  status: JobState;
  progress: number;
  step: string;
  mode: Mode;
  strength: number;
  output: OutputChoice;
  input: ProbeInfo & { name: string; sizeBytes: number };
  spec: OutputSpec;
  result?: JobResult;
  error?: { code: string; message: string };
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  abort: AbortController;
  estimateMs: number;
  /** Chunked denoise progress (DeepFilterNet processes ~60 s chunks). */
  chunks?: { done: number; total: number };
  /** True when this job was restored from Redis after an API restart. */
  restored?: boolean;
};

export class AudioError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
    public details?: Record<string, number | string>
  ) {
    super(message);
  }
}

const STEP_LABEL: Record<string, string> = {
  queued: "Waiting in queue",
  probing: "Analyzing format",
  denoising: "Removing noise",
  encoding: "Encoding",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

/** In-process audio job queue + pipeline. Concurrency 1 (one model, one GPU/CPU pool). */
export class AudioService {
  readonly jobs = new Map<string, AudioJob>();
  /**
   * Round 27: called once when a job ends WITHOUT a result for the user (canceled, stale, failed on the
   * server) so the routes give its hourly-quota slot back. Only completed jobs keep counting.
   */
  onQuotaRefund?: (job: AudioJob) => void;
  /** Called after each status change (queued, processing steps, done, failed, canceled); used for the admin job log. */
  onJobChange?: (job: AudioJob) => void;
  private queue: string[] = [];
  private running: string | null = null;
  private encoders = new Set<string>();
  private filters = new Set<string>();
  private ffmpegOk = false;
  private ffprobeOk = false;
  private sweeper: NodeJS.Timeout | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  /** Measured DeepFilterNet speed (audio seconds per wall second); refined after each job. */
  private dfSpeed = 18;
  readonly worker: DeepFilterWorker;

  readonly store: JobStore;
  private lastSaved = new Map<string, number>();

  constructor(readonly cfg: AudioConfig, private log: Log, store?: JobStore) {
    this.worker = new DeepFilterWorker(cfg.pythonPath, cfg.workerPath, cfg.device, log, ["-u"], cfg.workerIdleMs);
    this.store = store ?? new RedisJobStore();
  }

  /** Write job state to the store (Redis, 1 h TTL). Progress-only updates are throttled to 1/s. */
  persist(job: AudioJob, force = true) {
    const now = Date.now();
    if (!force && now - (this.lastSaved.get(job.id) ?? 0) < 1000) return Promise.resolve();
    this.lastSaved.set(job.id, now);
    if (force) this.notifyChange(job);
    return this.store.save(toStored(job)).catch((err) => this.log.warn({ jobId: job.id, err: String(err).slice(0, 200) }, "audio job save failed"));
  }

  /**
   * After a restart: finished jobs come back (status + downloads keep working), queued jobs whose upload is
   * still on disk are resumed, and jobs that were mid-processing are marked failed with a "please retry" message.
   */
  async restore(): Promise<{ restored: number; resumed: number; failed: number }> {
    let stored: StoredJob[] = [];
    try {
      stored = await this.store.loadAll();
    } catch {
      stored = [];
    }
    const counts = { restored: 0, resumed: 0, failed: 0 };
    const resume: AudioJob[] = [];
    for (const s of stored.sort((a, b) => a.createdAt - b.createdAt)) {
      // Only folders inside our tmp dir are trusted.
      if (path.dirname(path.resolve(s.dir)) !== path.resolve(this.cfg.tmpDir) || !/^[0-9a-f-]{36}$/.test(s.id)) continue;
      const job: AudioJob = { ...s, abort: new AbortController(), restored: true };
      if (job.status === "canceled") {
        await this.store.remove(job.id);
        continue;
      }
      if (job.status === "done") {
        if (!existsSync(this.filePath(job, "result"))) {
          await this.store.remove(job.id);
          continue;
        }
      } else if (job.status === "queued" && existsSync(path.join(job.dir, "input"))) {
        job.progress = 2;
        job.step = STEP_LABEL.queued;
        resume.push(job);
        counts.resumed++;
      } else if (job.status !== "failed") {
        job.status = "failed";
        job.step = STEP_LABEL.failed;
        job.error = { code: "SERVER_RESTARTED", message: RESTART_MESSAGE };
        job.finishedAt = Date.now();
        job.chunks = undefined;
        counts.failed++;
        await fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
        await this.persist(job);
      }
      this.jobs.set(job.id, job);
      counts.restored++;
    }
    for (const job of resume) {
      this.queue.push(job.id);
      await this.persist(job);
    }
    if (stored.length) this.log.info(counts, "audio jobs restored");
    return counts;
  }

  async init() {
    await fs.mkdir(this.cfg.tmpDir, { recursive: true });
    // Job state is kept in Redis (1 h). Restore it, then remove folders no restored job owns.
    await this.restore();
    // Round 26: nothing restored may hold a user's active slot unless it is really queued here.
    this.releaseStale("startup");
    await this.purgeAll();
    const enc = await run(this.cfg.ffmpegPath, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 });
    this.ffmpegOk = enc.code === 0;
    for (const m of enc.stdout.matchAll(/^\s*A[.\w]{5}\s+(\S+)/gm)) this.encoders.add(m[1]);
    const fil = await run(this.cfg.ffmpegPath, ["-hide_banner", "-filters"], { timeoutMs: 15_000 });
    for (const m of fil.stdout.matchAll(/^\s*[.\w]{2,3}\s+(\w+)\s+A->A/gm)) this.filters.add(m[1]);
    const probe = await run(this.cfg.ffprobePath, ["-version"], { timeoutMs: 15_000 });
    this.ffprobeOk = probe.code === 0;
    this.sweeper = setInterval(() => void this.sweep(), 5 * 60_000);
    this.sweeper.unref();
    if (this.queue.length) void this.pump();
    this.log.info(
      { ffmpeg: this.ffmpegOk, ffprobe: this.ffprobeOk, engine: this.preferredEngine(), encoders: this.encoders.size },
      "audio tool ready"
    );
    // The DeepFilterNet worker (~320 MB) starts lazily on the first job and stops after AUDIO_WORKER_IDLE_MIN idle minutes.
  }

  close() {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.worker.stop();
  }

  private wantDf() {
    return (this.cfg.engine === "auto" || this.cfg.engine === "deepfilternet") && this.worker.available();
  }

  private rnnoiseOk() {
    return this.filters.has("arnndn") && existsSync(this.cfg.rnnoiseModel);
  }

  preferredEngine(): EngineName {
    if (this.wantDf()) return "deepfilternet";
    if (this.cfg.engine !== "afftdn" && this.rnnoiseOk()) return "rnnoise";
    return "afftdn";
  }

  capabilities() {
    return {
      ready: this.ffmpegOk && this.ffprobeOk,
      engine: this.preferredEngine(),
      engines: {
        deepfilternet: this.worker.status(),
        device: this.worker.device,
        rnnoise: this.rnnoiseOk() ? "ready" : "unavailable",
        afftdn: this.filters.has("afftdn") ? "ready" : "unavailable",
      },
      limits: {
        maxBytes: this.cfg.maxBytes,
        maxMb: Math.round(this.cfg.maxBytes / 1024 / 1024),
        maxSeconds: this.cfg.maxSeconds,
        uploadsPerHour: this.cfg.uploadsPerHour,
        activeJobsPerUser: 1,
        retentionMinutes: Math.round(this.cfg.ttlMs / 60_000),
      },
      modes: ["noise", "conversation"],
      outputs: ["same", "mp3", "wav", "flac"],
      encoders: ["aac", "alac", "libmp3lame", "libopus", "libvorbis", "flac", "wmav2", "ac3", "eac3", "libopencore_amrnb", "pcm_s16le", "pcm_s16be"].filter((e) =>
        this.encoders.has(e)
      ),
      queue: { length: this.queue.length + (this.running ? 1 : 0) },
    };
  }

  /**
   * The user's one active job (queued or being processed), or undefined. There is no separate lock
   * key: "active" is always derived from the job's own state, so every terminal state (done, failed,
   * canceled, crash -> failed) releases it. A job that is not really running any more is stale and is
   * failed here, so it can never block the user (round 26):
   *  - processing but not the job the queue is running (orphan, e.g. a crashed pass), or running
   *    longer than maxJobMs (30 min default, AUDIO_MAX_JOB_MINUTES);
   *  - queued but not in the queue, or waiting longer than 2 x maxJobMs.
   */
  activeJobFor(userId: string, now = Date.now()): AudioJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.userId !== userId || AudioService.terminal(job)) continue;
      const stale = this.staleReason(job, now);
      if (stale) {
        this.expireStale(job, stale);
        continue;
      }
      return job;
    }
    return undefined;
  }

  static terminal(job: AudioJob) {
    return job.status === "done" || job.status === "failed" || job.status === "canceled";
  }

  /** Why a non-terminal job is stale, or null when it is genuinely queued / running. */
  staleReason(job: AudioJob, now = Date.now()): string | null {
    const max = this.cfg.maxJobMs;
    if (job.status === "queued") {
      if (!this.queue.includes(job.id) && this.running !== job.id) return "not in queue";
      if (now - job.createdAt > 2 * max) return "queued too long";
      return null;
    }
    if (this.running !== job.id) return "not running";
    if (now - (job.startedAt ?? job.createdAt) > max) return "running too long";
    return null;
  }

  /** Fail every non-terminal job that is not really queued / running (startup + sweep). Returns how many. */
  releaseStale(context: string, now = Date.now()): number {
    let n = 0;
    for (const job of [...this.jobs.values()]) {
      if (AudioService.terminal(job)) continue;
      const stale = this.staleReason(job, now);
      if (stale) {
        this.expireStale(job, `${context}: ${stale}`);
        n++;
      }
    }
    return n;
  }

  private expireStale(job: AudioJob, reason: string) {
    this.queue = this.queue.filter((id) => id !== job.id);
    job.abort.abort();
    job.chunks = undefined;
    this.fail(job, "JOB_STALE", "This file took too long and was stopped. Please upload it again.");
    this.log.warn({ jobId: job.id, userId: job.userId, reason }, "audio job stale: lock released");
    if (this.running !== job.id) void fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Pre-upload checks: tool ready, one active job, queue size, free disk. */
  async assertCanAccept(userId: string) {
    if (!this.ffmpegOk || !this.ffprobeOk) throw new AudioError(503, "TOOL_UNAVAILABLE", "The audio tool is not available right now. Please try again later.");
    const active = this.activeJobFor(userId);
    if (active) {
      throw new AudioError(409, "JOB_IN_PROGRESS", "Your earlier file is still processing. Wait for it to finish or cancel it.", undefined, {
        activeJobId: active.id,
        activeStatus: active.status,
        activeProgress: Math.round(active.progress),
        activeName: active.input.name,
      });
    }
    if (this.queue.length >= this.cfg.maxQueue) throw new AudioError(503, "QUEUE_FULL", "The audio queue is full. Please try again in a minute.", 60);
    try {
      const st = await fs.statfs(this.cfg.tmpDir);
      if (st.bavail * st.bsize < this.cfg.minFreeBytes) throw new AudioError(503, "LOW_DISK", "The server is busy right now. Please try again later.", 300);
    } catch (err) {
      if (err instanceof AudioError) throw err;
    }
  }

  newJobDir(): { id: string; dir: string } {
    const id: string = randomUUID();
    return { id, dir: path.join(this.cfg.tmpDir, id) };
  }

  /** Real audio length from a stream-copy packet scan (fast: no decoding). Null when unknown. */
  private async measureLength(file: string, streamIndex: number): Promise<number | null> {
    try {
      const res = await run(this.cfg.ffmpegPath, measureArgs(file, streamIndex), { timeoutMs: 30_000 });
      return parseProgressSeconds(res.stdout);
    } catch {
      return null;
    }
  }

  /** Sniff + ffprobe an uploaded file. Throws AudioError with a public message. */
  async probe(file: string): Promise<ProbeInfo> {
    const fh = await fs.open(file, "r");
    const head = Buffer.alloc(512);
    let read = 0;
    try {
      read = (await fh.read(head, 0, 512, 0)).bytesRead;
    } finally {
      await fh.close();
    }
    const reason = sniffReject(head.subarray(0, read));
    if (reason) throw new AudioError(415, "UNSUPPORTED_FILE", `${reason}. Upload an audio or video file.`);
    const res = await run(this.cfg.ffprobePath, probeArgs(file), { timeoutMs: 30_000 });
    let json: unknown = null;
    try {
      json = JSON.parse(res.stdout || "null");
    } catch {
      json = null;
    }
    if (res.code !== 0 && !json) throw new AudioError(422, "UNREADABLE_MEDIA", "We could not read this file. It may be damaged or not an audio/video file.");
    const parsed = parseProbe(json as Parameters<typeof parseProbe>[0], this.cfg.maxSeconds);
    if (parsed.ok) {
      if (parsed.info.duration !== null) return parsed.info;
      // N/A duration (e.g. streamed/fragmented MP4, WebM from a browser recorder): measure, never reject on unknown.
      const measured = await this.measureLength(file, parsed.info.streamIndex);
      if (measured !== null && measured > this.cfg.maxSeconds + 0.5) {
        throw new AudioError(422, "TOO_LONG", tooLongMessage(measured, this.cfg.maxSeconds), undefined, { durationSeconds: Math.round(measured), maxSeconds: this.cfg.maxSeconds });
      }
      return { ...parsed.info, duration: measured };
    }
    if (parsed.code === "TOO_LONG" && parsed.info) {
      // Header durations can be wrong (MP4 movie header, extra tracks). Measure the audio packets.
      const measured = await this.measureLength(file, parsed.info.streamIndex);
      this.log.info({ headerSeconds: parsed.duration, measuredSeconds: measured, container: parsed.info.container, codec: parsed.info.codec }, "audio duration check");
      if (measured !== null && measured <= this.cfg.maxSeconds + 0.5) return { ...parsed.info, duration: measured };
      const seconds = measured ?? parsed.duration ?? 0;
      throw new AudioError(422, "TOO_LONG", tooLongMessage(seconds, this.cfg.maxSeconds), undefined, { durationSeconds: Math.round(seconds), maxSeconds: this.cfg.maxSeconds });
    }
    throw new AudioError(parsed.status, parsed.code, parsed.message);
  }

  enqueue(args: {
    id: string;
    dir: string;
    userId: string;
    name: string;
    sizeBytes: number;
    info: ProbeInfo;
    mode: Mode;
    strength: number;
    output: OutputChoice;
  }): AudioJob {
    const spec = outputFor(args.output, args.info.codec, args.info.container, this.encoders, args.info.bitRateK ?? null);
    const seconds = args.info.duration ?? 60;
    const job: AudioJob = {
      id: args.id,
      userId: args.userId,
      dir: args.dir,
      status: "queued",
      progress: 2,
      step: STEP_LABEL.queued,
      mode: args.mode,
      strength: args.strength,
      output: args.output,
      input: { ...args.info, name: args.name, sizeBytes: args.sizeBytes },
      spec,
      createdAt: Date.now(),
      abort: new AbortController(),
      // Round 23 smoke: 19 min → DF ~52 s + decode/encode/previews ~20 s on this CPU.
      estimateMs: 3000 + (seconds / this.dfSpeed) * 1000 + seconds * 20,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    void this.persist(job);
    void this.pump();
    return job;
  }

  position(job: AudioJob): number {
    if (job.status !== "queued") return 0;
    const i = this.queue.indexOf(job.id);
    return i < 0 ? 0 : i + 1 + (this.running ? 1 : 0);
  }

  publicJob(job: AudioJob) {
    return {
      id: job.id,
      status: job.status,
      progress: Math.round(job.progress),
      step: job.step,
      position: this.position(job),
      mode: job.mode,
      strength: job.strength,
      output: job.output,
      input: {
        name: job.input.name,
        codec: job.input.codec,
        container: job.input.container,
        duration: job.input.duration,
        sizeBytes: job.input.sizeBytes,
        channels: job.input.channels,
        sampleRate: job.input.sampleRate,
        hasVideo: job.input.hasVideo,
      },
      outputFormat: job.spec.label,
      etaSeconds:
        job.status === "queued" || job.status === "done" || job.status === "failed" || job.status === "canceled"
          ? null
          : Math.max(1, Math.round(((job.startedAt ?? Date.now()) + job.estimateMs - Date.now()) / 1000)),
      chunks: job.chunks ?? null,
      result: job.result,
      error: job.error,
    };
  }

  /** Cancel (if running) and delete files now. */
  async remove(job: AudioJob) {
    this.queue = this.queue.filter((id) => id !== job.id);
    if (!["done", "failed"].includes(job.status)) {
      const wasCanceled = job.status === "canceled";
      job.status = "canceled";
      job.step = STEP_LABEL.canceled;
      if (!wasCanceled) this.refundQuota(job);
      this.notifyChange(job);
    }
    job.abort.abort();
    this.jobs.delete(job.id);
    this.lastSaved.delete(job.id);
    await this.store.remove(job.id).catch(() => undefined);
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  filePath(job: AudioJob, which: "result" | "original" | "clean") {
    if (which === "result") return path.join(job.dir, `out.${job.spec.ext}`);
    return path.join(job.dir, which === "original" ? "orig.mp3" : "clean.mp3");
  }

  stream(file: string, range?: { start: number; end: number }) {
    return createReadStream(file, range);
  }

  private async pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const job = this.jobs.get(next);
    if (!job) return void this.pump();
    this.running = job.id;
    try {
      await this.process(job);
      if (!AudioService.terminal(job)) this.fail(job, "PROCESSING_FAILED", "We could not clean this file. Please try another file.");
    } catch (err) {
      // A crash always ends in a terminal state (releases the user's active slot). Canceled / stale
      // jobs already are terminal and keep their own reason.
      if (!AudioService.terminal(job)) this.fail(job, "PROCESSING_FAILED", "We could not clean this file. Please try another file.", err);
    } finally {
      this.running = null;
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.progressTimer = null;
      if (job.status === "failed" || job.status === "canceled") {
        await fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (this.jobs.has(job.id)) await this.persist(job);
      void this.pump();
    }
  }

  private notifyChange(job: AudioJob) {
    try {
      this.onJobChange?.(job);
    } catch {
      /* the job log must never break the pipeline */
    }
  }

  private refundQuota(job: AudioJob) {
    try {
      this.onQuotaRefund?.(job);
    } catch {
      /* a quota hook must never break the pipeline */
    }
  }

  private fail(job: AudioJob, code: string, message: string, err?: unknown) {
    const wasTerminal = AudioService.terminal(job);
    job.status = "failed";
    job.step = STEP_LABEL.failed;
    job.error = { code, message };
    job.finishedAt = Date.now();
    if (!wasTerminal) this.refundQuota(job);
    void this.persist(job);
    this.log.warn({ jobId: job.id, userId: job.userId, code, err: err instanceof Error ? err.message.slice(0, 300) : undefined }, "audio job failed");
  }

  private set(job: AudioJob, status: JobState, progress: number) {
    if (job.abort.signal.aborted) throw new AudioError(499, "CANCELED", "Canceled");
    const changed = job.status !== status;
    job.status = status;
    job.step = STEP_LABEL[status] || status;
    job.progress = Math.max(job.progress, progress);
    void this.persist(job, changed);
  }

  /** Smoothly move progress toward `to` while a long step runs. */
  private creep(job: AudioJob, from: number, to: number, expectedMs: number) {
    if (this.progressTimer) clearInterval(this.progressTimer);
    const started = Date.now();
    this.progressTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / Math.max(500, expectedMs));
      const eased = 1 - Math.pow(1 - t, 2);
      job.progress = Math.max(job.progress, from + (to - from) * eased * 0.95);
    }, 400);
  }

  private async ff(job: AudioJob, args: string[], timeoutMs: number, cwd?: string, onStdout?: (text: string) => void) {
    const res = await run(this.cfg.ffmpegPath, args, { timeoutMs, signal: job.abort.signal, cwd, onStdout });
    if (res.aborted) throw new AudioError(499, "CANCELED", "Canceled");
    if (res.timedOut) throw new AudioError(504, "TIMEOUT", "Processing took too long.");
    if (res.code !== 0) throw new Error(`ffmpeg failed (${res.code}): ${res.stderr.trim().split(/\r?\n/).slice(-1)[0] || ""}`);
    return res;
  }

  private async measure(job: AudioJob, file: string, timeoutMs: number) {
    const res = await run(
      this.cfg.ffmpegPath,
      ["-nostdin", "-hide_banner", "-nostats", "-protocol_whitelist", "file,pipe", "-i", `file:${file}`, "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
      { timeoutMs, signal: job.abort.signal }
    );
    return parseMetrics(res.stderr);
  }

  private async pcm(job: AudioJob, file: string, timeoutMs: number): Promise<Buffer | null> {
    const res = await run(this.cfg.ffmpegPath, pcmArgs(file), { timeoutMs, signal: job.abort.signal, binary: true, maxBinary: 2 * 8000 * (this.cfg.maxSeconds + 5) });
    return res.code === 0 && res.stdoutBuf ? res.stdoutBuf : null;
  }

  private async process(job: AudioJob) {
    const started = Date.now();
    job.startedAt = started;
    const seconds = job.input.duration ?? 60;
    const timeoutMs = Math.max(120_000, seconds * 1500);
    const src = path.join(job.dir, "input");
    const dec = path.join(job.dir, "dec.wav");
    const den = path.join(job.dir, "den.wav");

    this.set(job, "probing", 6);
    await this.ff(job, decodeArgs(src, dec, job.input.streamIndex, this.cfg.maxSeconds, job.input.channels), timeoutMs);
    // The upload is no longer needed once decoded.
    await fs.rm(src, { force: true }).catch(() => undefined);
    this.set(job, "probing", 12);

    // Denoise: DeepFilterNet3 → RNNoise → afftdn.
    this.set(job, "denoising", 15);
    let engine: EngineName | null = null;
    const denoiseEnd = 82;
    // BUG-1340: capped, graded attenuation (6-18 dB; Keep all voices 8-12 dB + 10 % dry). Never unlimited.
    const attenDb = dfAttenLimit(job.strength, job.mode);
    const dry = dryMix(job.strength, job.mode);
    if (this.wantDf()) {
      // Real progress: one step per finished ~60 s chunk; between chunks the bar creeps toward the next boundary.
      const total = Math.max(1, Math.ceil(seconds / CHUNK_SECONDS));
      const chunkMs = (Math.min(seconds, CHUNK_SECONDS) / this.dfSpeed) * 1000;
      job.chunks = { done: 0, total };
      this.creep(job, 15, bandProgress(1, total, 15, denoiseEnd), 2000 + chunkMs);
      const r = await this.worker.denoise(job.id, dec, den, attenDb, timeoutMs, job.abort.signal, (done, n) => {
        job.chunks = { done, total: n };
        job.progress = Math.max(job.progress, bandProgress(done, n, 15, denoiseEnd));
        if (done < n) this.creep(job, job.progress, bandProgress(done + 1, n, 15, denoiseEnd), chunkMs);
        else if (this.progressTimer) clearInterval(this.progressTimer);
        void this.persist(job, false);
      }, dry);
      if (job.abort.signal.aborted) throw new AudioError(499, "CANCELED", "Canceled");
      if (r.ok && existsSync(den)) {
        engine = "deepfilternet";
        if (r.seconds && r.seconds > 0.2 && seconds > 1) this.dfSpeed = Math.max(2, Math.min(80, this.dfSpeed * 0.5 + (seconds / r.seconds) * 0.5));
      } else {
        this.log.warn({ jobId: job.id, err: (r.error || "").slice(0, 200) }, "deepfilternet failed, using fallback");
      }
    }
    if (!engine) {
      const fb: "rnnoise" | "afftdn" = this.cfg.engine !== "afftdn" && this.rnnoiseOk() ? "rnnoise" : "afftdn";
      this.creep(job, 15, denoiseEnd, 1000 + seconds * 30);
      const filter = fallbackFilter(fb, job.strength, path.basename(this.cfg.rnnoiseModel), job.mode);
      const args = ["-nostdin", "-hide_banner", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-i", `file:${dec}`, "-af", `${filter},aformat=sample_fmts=s16`, "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", `file:${den}`];
      // ffmpeg streams the file (flat memory); -progress reports how far it got → real %.
      args.splice(args.indexOf("-y"), 0, "-progress", "pipe:1", "-nostats");
      const onOut = (text: string) => {
        const done = parseProgressSeconds(text);
        if (done !== null && seconds > 0) job.progress = Math.max(job.progress, bandProgress(done, seconds, 15, denoiseEnd));
      };
      try {
        await this.ff(job, args, timeoutMs, fb === "rnnoise" ? path.dirname(this.cfg.rnnoiseModel) : undefined, onOut);
        engine = fb;
      } catch (err) {
        if (fb !== "rnnoise" || job.abort.signal.aborted) throw err;
        const args2 = [...args];
        // arnndn can emit NaN on its first frame; the s16 step above zeroes them. afftdn is the last resort.
        args2[args2.indexOf("-af") + 1] = `${fallbackFilter("afftdn", job.strength, undefined, job.mode)},aformat=sample_fmts=s16`;
        await this.ff(job, args2, timeoutMs, undefined, onOut);
        engine = "afftdn";
      }
    }
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.set(job, "denoising", denoiseEnd);

    // The denoised file is the final mix (the old "Voice clean" EQ + loudness pass was removed).
    const finalWav = den;

    this.set(job, "encoding", 86);
    let spec = job.spec;
    const out = () => path.join(job.dir, `out.${spec.ext}`);
    try {
      await this.ff(job, encodeArgs(finalWav, out(), spec, job.input.channels, job.input.sampleRate), timeoutMs);
    } catch (err) {
      if (spec.ext === "mp3" || job.abort.signal.aborted) throw err;
      // Encoder exists but refused this stream (rare) → MP3.
      spec = outputFor("mp3", "mp3", "mp3", this.encoders);
      spec = { ...spec, note: `Saved as MP3 (${job.spec.label} encode failed)` };
      job.spec = spec;
      await this.ff(job, encodeArgs(finalWav, out(), spec, job.input.channels, job.input.sampleRate), timeoutMs);
    }
    this.set(job, "encoding", 92);
    const srcK = job.input.bitRateK ?? null;
    await this.ff(job, previewArgs(dec, path.join(job.dir, "orig.mp3"), srcK), timeoutMs);
    await this.ff(job, previewArgs(finalWav, path.join(job.dir, "clean.mp3"), srcK), timeoutMs);
    this.set(job, "encoding", 96);
    // One ebur128 pass (loudness) on the result, and one 8 kHz PCM pass per file for peaks + background level.
    const after = await this.measure(job, finalWav, timeoutMs);
    const pcmOriginal = await this.pcm(job, dec, timeoutMs);
    const pcmClean = await this.pcm(job, finalWav, timeoutMs);
    const peaksOriginal = pcmOriginal ? peaksFromPcm(pcmOriginal, 160) : [];
    const peaksClean = pcmClean ? peaksFromPcm(pcmClean, 160) : [];
    const bg = pcmOriginal && pcmClean ? backgroundLevels(windowLevelsDb(pcmOriginal), windowLevelsDb(pcmClean)) : { beforeDb: null, afterDb: null };
    const st = await fs.stat(out());
    for (const f of [dec, den]) await fs.rm(f, { force: true }).catch(() => undefined);

    job.result = {
      format: spec.label,
      ext: spec.ext,
      sizeBytes: st.size,
      duration: job.input.duration,
      engine: engine!,
      device: engine === "deepfilternet" ? this.worker.device : null,
      noiseFloorBeforeDb: bg.beforeDb,
      noiseFloorAfterDb: bg.afterDb,
      maxReductionDb: engine === "deepfilternet" ? attenDb : null,
      lufs: after.lufs,
      fallbackNote: spec.note ?? null,
      processingMs: Date.now() - started,
      peaks: { original: peaksOriginal, clean: peaksClean },
    };
    job.status = "done";
    job.step = STEP_LABEL.done;
    job.progress = 100;
    job.finishedAt = Date.now();
    void this.persist(job);
    this.log.info(
      { jobId: job.id, userId: job.userId, codec: job.input.codec, duration: job.input.duration, engine, ms: job.result.processingMs, mode: job.mode },
      "audio job done"
    );
  }

  /** Delete finished jobs after the TTL, and any orphan folder older than the TTL. */
  async sweep(now = Date.now()) {
    this.releaseStale("sweep", now);
    for (const job of [...this.jobs.values()]) {
      const ref = job.finishedAt ?? job.createdAt;
      const terminal = ["done", "failed", "canceled"].includes(job.status);
      if ((terminal && now - ref > this.cfg.ttlMs) || now - job.createdAt > this.cfg.ttlMs * 3) await this.remove(job);
    }
    const entries = await fs.readdir(this.cfg.tmpDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || this.jobs.has(e.name)) continue;
      const full = path.join(this.cfg.tmpDir, e.name);
      const st = await fs.stat(full).catch(() => null);
      if (st && now - st.mtimeMs > this.cfg.ttlMs) await fs.rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async purgeAll() {
    const entries = await fs.readdir(this.cfg.tmpDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name) && !this.jobs.has(e.name)) {
        await fs.rm(path.join(this.cfg.tmpDir, e.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
