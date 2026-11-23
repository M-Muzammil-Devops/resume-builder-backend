import path from "node:path";

function num(v: string | undefined, fallback: number) {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Defaults: 100 MB, 20 minutes (override with AUDIO_MAX_MB / AUDIO_MAX_SECONDS). */
export const DEFAULT_MAX_MB = 100;
export const DEFAULT_MAX_SECONDS = 1200;

export function normalizeDevice(v: string | undefined): "cpu" | "cuda" | "auto" {
  const d = (v || "cpu").trim().toLowerCase();
  return d === "cuda" || d === "auto" ? d : "cpu";
}

export type AudioConfig = {
  ffmpegPath: string;
  ffprobePath: string;
  pythonPath: string;
  workerPath: string;
  rnnoiseModel: string;
  /** auto | deepfilternet | rnnoise | afftdn */
  engine: string;
  /** cpu (default) | cuda | auto. CUDA is used only when torch.cuda.is_available(); otherwise CPU + a warning. */
  device: string;
  tmpDir: string;
  maxBytes: number;
  maxSeconds: number;
  uploadsPerHour: number;
  ttlMs: number;
  maxQueue: number;
  minFreeBytes: number;
  /** A job still not finished this long after it started is stale: stopped, failed, lock released. */
  maxJobMs: number;
  workerIdleMs: number;
};

/** Audio tool settings. Every knob comes from env (names in README); paths never come from user input. */
export function loadAudioConfig(e: NodeJS.ProcessEnv = process.env): AudioConfig {
  const root = process.cwd();
  const workerDir = path.resolve(root, "audio-worker");
  const venvPython = path.join(workerDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return {
    ffmpegPath: e.FFMPEG_PATH || "ffmpeg",
    ffprobePath: e.FFPROBE_PATH || "ffprobe",
    pythonPath: e.AUDIO_PYTHON || venvPython,
    workerPath: e.AUDIO_WORKER || path.join(workerDir, "worker.py"),
    rnnoiseModel: e.AUDIO_RNNOISE_MODEL || path.join(workerDir, "models", "sh.rnnn"),
    engine: (e.AUDIO_ENGINE || "auto").toLowerCase(),
    device: normalizeDevice(e.AUDIO_DEVICE),
    tmpDir: path.resolve(root, e.AUDIO_TMP_DIR || "tmp/audio"),
    maxBytes: Math.round(num(e.AUDIO_MAX_MB, DEFAULT_MAX_MB) * 1024 * 1024),
    maxSeconds: num(e.AUDIO_MAX_SECONDS, DEFAULT_MAX_SECONDS),
    // Round 27: AUDIO_HOURLY_LIMIT (AUDIO_UPLOADS_PER_HOUR still read as the older name). Default 10.
    uploadsPerHour: Math.floor(num(e.AUDIO_HOURLY_LIMIT || e.AUDIO_UPLOADS_PER_HOUR, 10)),
    ttlMs: num(e.AUDIO_TTL_MINUTES, 60) * 60_000,
    maxQueue: num(e.AUDIO_MAX_QUEUE, 20),
    minFreeBytes: num(e.AUDIO_MIN_FREE_MB, 2048) * 1024 * 1024,
    // AUDIO_WORKER_IDLE_MIN: stop the python worker after this many idle minutes (default 10, 0 = never).
    workerIdleMs: Math.max(0, num(e.AUDIO_WORKER_IDLE_MIN, 10)) * 60_000,
    maxJobMs: num(e.AUDIO_MAX_JOB_MINUTES, 30) * 60_000,
  };
}
