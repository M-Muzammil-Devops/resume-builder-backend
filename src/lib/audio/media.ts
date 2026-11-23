/**
 * Pure helpers for the audio tool: probe parsing, format rules, output mapping, filter chains.
 * No I/O here, so everything is unit-tested in media.test.ts.
 */

export type OutputChoice = "same" | "mp3" | "wav" | "flac";
/** noise = Remove noise, conversation = Keep all voices (phone calls, meetings). */
export type Mode = "noise" | "conversation";

/**
 * Upload "mode" field → Mode. Anything else (including the retired "voice" = Voice clean mode that old
 * clients may still send) falls back to plain noise removal instead of failing.
 */
export function parseMode(raw: unknown): Mode {
  return raw === "conversation" ? "conversation" : "noise";
}
export type EngineName = "deepfilternet" | "rnnoise" | "afftdn";

export type ProbeInfo = {
  codec: string;
  container: string;
  duration: number | null;
  channels: number;
  sampleRate: number;
  hasVideo: boolean;
  streamIndex: number;
  /** Audio bit rate in kbit/s when ffprobe knows it (BUG-1342: "same" output keeps it). */
  bitRateK?: number | null;
};

export type ProbeResult =
  | { ok: true; info: ProbeInfo }
  | { ok: false; status: number; code: string; message: string; duration?: number; info?: ProbeInfo };

/** Demuxers that can pull in other files, devices or URLs (playlists, concat lists, pipelines). */
export const BLOCKED_FORMATS = new Set([
  "hls", "applehttp", "concat", "ffconcat", "image2", "image2pipe", "lavfi", "sdp", "rtp", "rtsp", "tee",
  "dash", "webm_dash_manifest", "m3u", "m3u8", "pls", "xspf", "asx", "wpl", "smil", "ffmetadata",
  "tty", "srt", "webvtt", "ass", "data", "dshow", "gdigrab", "vfwcap", "avfoundation", "lavfi",
]);

/** Playlist / list extensions refused up front (the probe would refuse them too). */
export const BLOCKED_EXTENSIONS = new Set(["m3u", "m3u8", "pls", "xspf", "asx", "wpl", "cue", "ffconcat", "smil", "sdp", "txt"]);

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * Magic-number sniff. Returns a reason when the bytes are clearly not media
 * (executables, archives, documents, HTML, playlists or any plain-text file).
 */
export function sniffReject(head: Uint8Array): string | null {
  if (head.length < 4) return "File is empty or too small";
  const ascii = (n: number) => String.fromCharCode(...head.subarray(0, Math.min(n, head.length)));
  const start = ascii(16);
  if (start.startsWith("MZ")) return "Executable files are not allowed";
  if (head[0] === 0x7f && start.slice(1, 4) === "ELF") return "Executable files are not allowed";
  if (start.startsWith("PK\u0003\u0004") || start.startsWith("Rar!") || start.startsWith("7z\u00bc\u00af")) return "Archives are not allowed";
  if (start.startsWith("%PDF")) return "Documents are not allowed";
  const lower = ascii(512).replace(/^\uFEFF|^\u00ef\u00bb\u00bf/, "").trimStart().toLowerCase();
  if (lower.startsWith("#extm3u") || lower.startsWith("[playlist]") || lower.startsWith("ffconcat") || lower.startsWith("<?xml") || lower.startsWith("<html") || lower.startsWith("<!doctype") || lower.startsWith("<asx") || lower.startsWith("v=0")) {
    return "Playlists and text files are not allowed";
  }
  // Pure printable text in the first 512 bytes: no audio/video container looks like that.
  const sample = head.subarray(0, Math.min(512, head.length));
  let printable = 0;
  for (const b of sample) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  if (sample.length >= 16 && printable === sample.length) return "Text files are not allowed";
  return null;
}

type RawStream = {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  sample_rate?: string | number;
  bit_rate?: string | number;
  duration?: string | number;
  duration_ts?: string | number;
  time_base?: string;
  disposition?: { default?: number; attached_pic?: number };
};
type RawProbe = { streams?: RawStream[]; format?: { format_name?: string; duration?: string | number; bit_rate?: string | number } };

/** Still-image codecs used for cover art (some M4A/MP4 files lack the attached_pic flag). */
const IMAGE_CODECS = new Set(["mjpeg", "png", "bmp", "gif", "webp", "tiff", "jpegls"]);

/** Seconds, or null for N/A / NaN / Infinity / 0 / negative / absurd (> 1 week) values. */
export function positive(v: unknown): number | null {
  if (typeof v === "string" && !/^\s*[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?\s*$/i.test(v)) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) && n > 0 && n < 7 * 24 * 3600 ? n : null;
}

/** duration_ts × time_base ("1/44100") → seconds, or null. */
function fromTimebase(ts: unknown, base: unknown): number | null {
  const t = Number.parseFloat(String(ts ?? ""));
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(base ?? ""));
  if (!Number.isFinite(t) || t <= 0 || !m || Number(m[2]) === 0) return null;
  return positive((t * Number(m[1])) / Number(m[2]));
}

/**
 * BUG (sharafat-voice-karachi.mp4): duration used to come from the CONTAINER (format.duration)
 * first. In MP4/M4A/MOV that is the longest track / movie header, which can be wrong or include
 * non-audio tracks. Now: the chosen AUDIO stream's duration → its duration_ts × time_base →
 * container duration. Unknown stays null (never rejected on N/A).
 */
export function audioDuration(stream: RawStream | undefined, format: RawProbe["format"]): number | null {
  return positive(stream?.duration) ?? fromTimebase(stream?.duration_ts, stream?.time_base) ?? positive(format?.duration);
}

/** Map finished work (`done` of `total`) onto the job's progress band [from, to]. Never above `to`. */
export function bandProgress(done: number, total: number, from: number, to: number): number {
  if (!(total > 0)) return from;
  const f = Math.max(0, Math.min(1, done / total));
  return Math.round((from + (to - from) * f) * 10) / 10;
}

/** Stream bit rate (or the container's, for a lone audio stream) in kbit/s; null when unknown/absurd. */
export function probeBitRateK(stream: RawStream | undefined, format: RawProbe["format"], useFormat: boolean): number | null {
  const n = Number(stream?.bit_rate ?? (useFormat ? format?.bit_rate : undefined));
  return Number.isFinite(n) && n >= 4000 && n <= 3_000_000 ? Math.round(n / 1000) : null;
}

/** Restart message for a job that was running when the API stopped. */
export const RESTART_MESSAGE = "The server restarted while your file was being cleaned. Please upload it again to retry.";

/** Largest out_time_us / out_time_ms from `ffmpeg -progress pipe:1` → seconds (both keys are µs). */
export function parseProgressSeconds(text: string): number | null {
  let best = 0;
  for (const m of String(text).matchAll(/^out_time_(?:us|ms)=(\d+)\s*$/gm)) best = Math.max(best, Number(m[1]));
  return best > 0 ? positive(best / 1e6) : null;
}

/** Fast packet scan (stream copy to the null muxer) to measure the real audio length. */
export function measureArgs(input: string, streamIndex: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-v", "error", "-nostats",
    "-protocol_whitelist", "file,pipe",
    "-i", `file:${input}`,
    "-map", `0:a:${Math.max(0, Math.floor(streamIndex))}`,
    "-vn", "-sn", "-dn", "-c", "copy",
    "-progress", "pipe:1",
    "-f", "null", "-",
  ];
}

export function tooLongMessage(seconds: number, maxSeconds: number): string {
  const s = Math.round(seconds);
  return `This recording is ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} long. The limit is ${Math.round(maxSeconds / 60)} minutes.`;
}

/** ffprobe JSON → what the job needs, or a public rejection. */
export function parseProbe(raw: RawProbe | null | undefined, maxSeconds: number): ProbeResult {
  if (!raw || typeof raw !== "object" || !raw.format) {
    return { ok: false, status: 422, code: "UNREADABLE_MEDIA", message: "We could not read this file. It may be damaged." };
  }
  const formats = String(raw.format.format_name || "").toLowerCase().split(",").map((f) => f.trim()).filter(Boolean);
  if (formats.some((f) => BLOCKED_FORMATS.has(f))) {
    return { ok: false, status: 415, code: "UNSUPPORTED_FORMAT", message: "Playlists and stream lists are not supported. Upload the audio file itself." };
  }
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const audio = streams.filter((s) => s.codec_type === "audio");
  if (!audio.length) {
    return { ok: false, status: 415, code: "NO_AUDIO_STREAM", message: "This file has no audio track." };
  }
  const pick = audio.find((s) => s.disposition?.default === 1) || audio[0];
  // Audio-only MP4/M4A: only real (non cover-art) video tracks count as video.
  const hasVideo = streams.some((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1 && !IMAGE_CODECS.has(String(s.codec_name || "").toLowerCase()));
  const duration = audioDuration(pick, raw.format);
  const info: ProbeInfo = {
    codec: String(pick.codec_name || "unknown").toLowerCase(),
    container: formats[0] || "unknown",
    duration,
    channels: Math.max(1, Math.min(8, Number(pick.channels) || 1)),
    sampleRate: Number(pick.sample_rate) || 0,
    hasVideo,
    streamIndex: audio.indexOf(pick),
    bitRateK: probeBitRateK(pick, raw.format, audio.length === 1 && !hasVideo),
  };
  if (duration !== null && duration > maxSeconds + 0.5) {
    // The service confirms this with a packet scan before rejecting (headers can lie).
    return { ok: false, status: 422, code: "TOO_LONG", message: tooLongMessage(duration, maxSeconds), duration, info };
  }
  return { ok: true, info };
}

export type OutputSpec = {
  ext: string;
  label: string;
  contentType: string;
  /** ffmpeg output args (codec, bitrate, muxer). Never contains user text. */
  args: string[];
  sampleRate: number;
  maxChannels: number;
  note?: string;
};

const MP3: OutputSpec = { ext: "mp3", label: "MP3", contentType: "audio/mpeg", args: ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"], sampleRate: 48000, maxChannels: 2 };
const WAV: OutputSpec = { ext: "wav", label: "WAV", contentType: "audio/wav", args: ["-c:a", "pcm_s16le", "-f", "wav"], sampleRate: 48000, maxChannels: 2 };
const FLAC: OutputSpec = { ext: "flac", label: "FLAC", contentType: "audio/flac", args: ["-c:a", "flac", "-f", "flac"], sampleRate: 48000, maxChannels: 2 };

type SameRule = { spec: OutputSpec; encoder: string };

const MP3_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const AC3_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];

/**
 * BUG-1342: lossy "Same as input" keeps the input bit rate (rounded up to a rate the encoder accepts,
 * within a sane floor/ceiling) instead of a fixed 192k, so a 48 kbps AAC stays about 48 kbps.
 */
export function sameBitrateK(codec: string, inputK: number | null | undefined): number | null {
  const k = Number(inputK);
  if (!Number.isFinite(k) || k <= 0) return null;
  const up = (list: number[]) => list.find((r) => r >= k) ?? list[list.length - 1];
  if (codec === "mp3") return up(MP3_RATES);
  if (codec === "ac3" || codec === "eac3") return up(AC3_RATES);
  if (codec === "aac") return Math.min(256, Math.max(32, Math.ceil(k / 8) * 8));
  if (codec === "opus") return Math.min(256, Math.max(16, Math.ceil(k / 8) * 8));
  if (codec === "wmav1" || codec === "wmav2" || codec === "wmapro") return Math.min(256, Math.max(32, Math.ceil(k / 8) * 8));
  if (codec === "vorbis") return Math.min(320, Math.max(48, Math.ceil(k / 8) * 8));
  return null;
}

/** Replace `-b:a`/`-q:a` in a spec with a fixed bit rate. */
function withBitrate(spec: OutputSpec, k: number | null): OutputSpec {
  if (!k) return spec;
  const args: string[] = [];
  for (let i = 0; i < spec.args.length; i++) {
    if (spec.args[i] === "-b:a" || spec.args[i] === "-q:a") {
      i++;
      continue;
    }
    args.push(spec.args[i]);
  }
  const at = args.indexOf("-c:a") + 2;
  args.splice(at, 0, "-b:a", `${k}k`);
  return { ...spec, args };
}

function sameRule(codec: string, container: string): SameRule | null {
  if (codec === "aac") return { encoder: "aac", spec: { ext: "m4a", label: "M4A", contentType: "audio/mp4", args: ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "ipod"], sampleRate: 48000, maxChannels: 2 } };
  if (codec === "alac") return { encoder: "alac", spec: { ext: "m4a", label: "M4A", contentType: "audio/mp4", args: ["-c:a", "alac", "-f", "ipod"], sampleRate: 48000, maxChannels: 2 } };
  if (codec === "mp3") return { encoder: "libmp3lame", spec: MP3 };
  if (codec === "opus") return { encoder: "libopus", spec: { ext: "opus", label: "OPUS", contentType: "audio/ogg", args: ["-c:a", "libopus", "-b:a", "128k", "-f", "ogg"], sampleRate: 48000, maxChannels: 2 } };
  if (codec === "vorbis") return { encoder: "libvorbis", spec: { ext: "ogg", label: "OGG", contentType: "audio/ogg", args: ["-c:a", "libvorbis", "-q:a", "5", "-f", "ogg"], sampleRate: 48000, maxChannels: 2 } };
  if (codec === "flac") return { encoder: "flac", spec: FLAC };
  if (codec === "wmav1" || codec === "wmav2" || codec === "wmapro") return { encoder: "wmav2", spec: { ext: "wma", label: "WMA", contentType: "audio/x-ms-wma", args: ["-c:a", "wmav2", "-b:a", "192k", "-f", "asf"], sampleRate: 48000, maxChannels: 2 } };
  if (codec === "ac3") return { encoder: "ac3", spec: { ext: "ac3", label: "AC3", contentType: "audio/ac3", args: ["-c:a", "ac3", "-b:a", "192k", "-f", "ac3"], sampleRate: 48000, maxChannels: 2 } };
  if (codec === "eac3") return { encoder: "eac3", spec: { ext: "eac3", label: "EAC3", contentType: "audio/eac3", args: ["-c:a", "eac3", "-b:a", "192k", "-f", "eac3"], sampleRate: 48000, maxChannels: 2 } };
  if (codec === "amr_nb") return { encoder: "libopencore_amrnb", spec: { ext: "amr", label: "AMR", contentType: "audio/amr", args: ["-c:a", "libopencore_amrnb", "-b:a", "12.2k", "-f", "amr"], sampleRate: 8000, maxChannels: 1 } };
  if (codec.startsWith("pcm_")) {
    if (container.includes("aiff")) return { encoder: "pcm_s16be", spec: { ext: "aiff", label: "AIFF", contentType: "audio/aiff", args: ["-c:a", "pcm_s16be", "-f", "aiff"], sampleRate: 48000, maxChannels: 2 } };
    return { encoder: "pcm_s16le", spec: WAV };
  }
  return null;
}

/** Output file for a probed input. Falls back to MP3 when "same" has no encoder here. */
export function outputFor(choice: OutputChoice, codec: string, container: string, encoders: Set<string>, inputBitRateK: number | null = null): OutputSpec {
  if (choice === "mp3") return MP3;
  if (choice === "wav") return WAV;
  if (choice === "flac") return FLAC;
  const rule = sameRule(codec, container);
  if (rule && encoders.has(rule.encoder)) return withBitrate(rule.spec, sameBitrateK(codec, inputBitRateK));
  const what = rule ? `${rule.spec.label} encoder unavailable` : `${codec.toUpperCase()} cannot be written`;
  return { ...MP3, note: `Saved as MP3 (${what})` };
}

/** API strength: an integer 0..100 ("80"). Anything else → null (the route answers 400). Missing → fallback. */
export function parseStrength(v: unknown, fallback = 80): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const t = String(v).trim();
  // An empty / whitespace-only field means "not sent" → default (documented in the README).
  if (t === "") return fallback;
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

export function clampStrength(v: unknown, fallback = 80): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * BUG-1340/1343: the most any frame may be pulled down, in dB. DeepFilterNet3 without a cap treats
 * quiet / far voices as noise and removes them (25-60 dB). Capped and graded instead:
 *   Remove noise: 0 → 6 dB, 20 → 8.4, 50 → 12, 80 → 15 (default), 100 → 18 dB.
 *   Keep all voices (conversation): 8 → 12 dB (80 → 11.2) plus a little dry signal.
 * Never null (no "unlimited"), always monotonic.
 */
export const ATTEN_MIN_DB = 6;
export const ATTEN_MAX_DB = 18;
export function dfAttenLimit(strength: number, mode: Mode = "noise"): number {
  const s = clampStrength(strength);
  if (mode === "conversation") return Math.round((8 + s * 0.04) * 10) / 10;
  const db = s <= 50 ? 6 + s * 0.12 : s <= 80 ? 12 + (s - 50) * 0.1 : 15 + (s - 80) * 0.15;
  return Math.round(db * 10) / 10;
}

/** Share of the original mixed back in (0..0.15): gentle settings and Keep all voices. */
export function dryMix(strength: number, mode: Mode = "noise"): number {
  if (mode === "conversation") return 0.1;
  const s = clampStrength(strength);
  return s >= 50 ? 0 : Math.round(0.15 * (1 - s / 50) * 100) / 100;
}

/** RNNoise wet share so its floor matches the same cap: wet = 1 - 10^(-limit/20). */
export function rnnoiseMix(strength: number, mode: Mode = "noise"): number {
  return Math.round((1 - 10 ** (-dfAttenLimit(strength, mode) / 20)) * 100) / 100;
}

/** afftdn noise reduction in dB = the same cap. */
export function afftdnNr(strength: number, mode: Mode = "noise"): number {
  return dfAttenLimit(strength, mode);
}

/** Filter for the ffmpeg fallbacks. The RNNoise model is passed by bare file name (cwd = model dir). */
export function fallbackFilter(engine: "rnnoise" | "afftdn", strength: number, modelFile = "sh.rnnn", mode: Mode = "noise"): string {
  if (engine === "rnnoise") return `arnndn=m=${modelFile.replace(/[^\w.-]/g, "")}:mix=${rnnoiseMix(strength, mode)}`;
  return `afftdn=nr=${afftdnNr(strength, mode)}:nf=-30:tn=1`;
}

/** Overall "Noise floor dB" and integrated loudness from an astats+ebur128 pass. */
export function parseMetrics(stderr: string): { noiseFloorDb: number | null; lufs: number | null } {
  const floors = [...stderr.matchAll(/Noise floor dB:\s*(-?[\d.]+|-inf)/g)].map((m) => m[1]);
  const last = floors.length ? floors[floors.length - 1] : null;
  const floor = last && last !== "-inf" ? Number.parseFloat(last) : null;
  const iMatch = [...stderr.matchAll(/\bI:\s*(-?[\d.]+)\s*LUFS/g)];
  const lufs = iMatch.length ? Number.parseFloat(iMatch[iMatch.length - 1][1]) : null;
  return {
    noiseFloorDb: floor !== null && Number.isFinite(floor) ? Math.round(floor * 10) / 10 : null,
    lufs: lufs !== null && Number.isFinite(lufs) && lufs > -70 ? Math.round(lufs * 10) / 10 : null,
  };
}

/** File name for downloads: only [\w.- ], max 80 chars, never empty. */
/**
 * Upload name as the user meant it (BUG-1324): percent-decoded when it looks encoded ("Caf%C3%A9.mp3"),
 * NFC-normalised, with CR/LF, other control characters, quotes and path separators removed.
 */
export function cleanUploadName(raw: unknown): string {
  let name = String(raw ?? "");
  if (/%[0-9a-f]{2}/i.test(name)) {
    try {
      name = decodeURIComponent(name);
    } catch {
      /* not valid percent-encoding: keep as is */
    }
  }
  name = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
    .replace(/["'`]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  return name.slice(0, 200) || "audio";
}

/** Download base name: Unicode letters/numbers kept, everything risky → "_". */
export function safeBaseName(name: string): string {
  const base = cleanUploadName(name).replace(/\.[\p{L}\p{N}]{1,8}$/u, "");
  const clean = base
    .replace(/[^\p{L}\p{N}\p{M}._\- ]/gu, "_")
    .replace(/^[.\s]+/, "")
    .replace(/_+/g, "_")
    .trim();
  return Array.from(clean).slice(0, 80).join("").trim() || "audio";
}

/** ASCII-only fallback for old clients: accents stripped (é → e), other non-ASCII → "_". */
export function asciiFileName(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;%]/g, "_")
    .replace(/_+/g, "_");
  return ascii.replace(/^[_\s.]+(?=.)/, "") || "audio";
}

/** RFC 5987 value: encodeURIComponent plus the characters it leaves that attr-char forbids. */
function rfc5987(v: string): string {
  return encodeURIComponent(v).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** RFC 6266 attachment header: ASCII filename= fallback + filename*=UTF-8'' with the real name. */
export function contentDisposition(originalName: string, ext: string): string {
  const fileName = `${safeBaseName(originalName)}-clean.${ext.replace(/[^a-z0-9]/gi, "")}`;
  return `attachment; filename="${asciiFileName(fileName)}"; filename*=UTF-8''${rfc5987(fileName)}`;
}

/** Single "bytes=a-b" range parser for preview players. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

/** Decode args: first audio stream → 48 kHz mono float WAV. Paths are server-made (uuid dirs). */
export function decodeArgs(input: string, output: string, streamIndex: number, maxSeconds: number, channels = 1): string[] {
  return [
    "-nostdin", "-hide_banner", "-v", "error", "-y",
    "-protocol_whitelist", "file,pipe",
    "-i", `file:${input}`,
    "-map", `0:a:${Math.max(0, Math.floor(streamIndex))}`,
    "-vn", "-sn", "-dn",
    "-t", String(Math.ceil(maxSeconds + 1)),
    // Stereo stays stereo (the worker cleans differing channels separately, dual-mono once).
    "-ac", String(channels >= 2 ? 2 : 1), "-ar", "48000", "-c:a", "pcm_f32le",
    "-f", "wav", `file:${output}`,
  ];
}

export function probeArgs(input: string): string[] {
  return ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams", `file:${input}`];
}

/** Rates each encoder accepts (others take any rate). */
const ENCODER_RATES: Record<string, number[]> = {
  libmp3lame: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
  libopus: [8000, 12000, 16000, 24000, 48000],
  ac3: [32000, 44100, 48000],
  eac3: [32000, 44100, 48000],
  wmav2: [8000, 11025, 16000, 22050, 32000, 44100, 48000],
  aac: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
  libopencore_amrnb: [8000],
};

/**
 * BUG-1325: write the output at the INPUT sample rate (DeepFilterNet works at 48 kHz internally).
 * Inputs above 48 kHz (or unknown) stay at 48 kHz; formats with fixed rate sets use the nearest
 * allowed rate at or above the input (AMR is always 8 kHz).
 */
export function outputSampleRate(spec: OutputSpec, inputRate: number): number {
  const target = Number.isFinite(inputRate) && inputRate >= 8000 ? Math.min(Math.round(inputRate), 48000) : 48000;
  const codec = spec.args[spec.args.indexOf("-c:a") + 1] || "";
  const allowed = ENCODER_RATES[codec];
  if (!allowed) return target;
  return allowed.find((r) => r >= target) ?? allowed[allowed.length - 1];
}

export function encodeArgs(input: string, output: string, spec: OutputSpec, channels: number, inputRate = 0): string[] {
  const ch = Math.max(1, Math.min(spec.maxChannels, channels));
  return [
    "-nostdin", "-hide_banner", "-v", "error", "-y",
    "-protocol_whitelist", "file,pipe",
    "-i", `file:${input}`,
    "-map_metadata", "-1",
    "-ac", String(ch), "-ar", String(outputSampleRate(spec, inputRate)),
    ...spec.args,
    `file:${output}`,
  ];
}

/** BUG-1341: small mono preview, 48 kbps by default and never above the source bit rate. */
export function previewBitrateK(sourceK: number | null | undefined): number {
  const k = Number(sourceK);
  if (!Number.isFinite(k) || k <= 0 || k >= 48) return 48;
  return k >= 32 ? 32 : k >= 24 ? 24 : 16;
}

export function previewArgs(input: string, output: string, sourceK: number | null = null): string[] {
  const k = previewBitrateK(sourceK);
  return [
    "-nostdin", "-hide_banner", "-v", "error", "-y",
    "-protocol_whitelist", "file,pipe",
    "-i", `file:${input}`,
    // MPEG-1 layer 3 needs >= 32k at 44.1 kHz; lower rates use 24 kHz (MPEG-2).
    "-map_metadata", "-1", "-ac", "1", "-ar", k >= 32 ? "44100" : "24000",
    "-c:a", "libmp3lame", "-b:a", `${k}k`, "-f", "mp3",
    `file:${output}`,
  ];
}

/** 8 kHz mono s16 PCM for peaks + background level (one pass per file). */
export function pcmArgs(input: string): string[] {
  return ["-nostdin", "-hide_banner", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", `file:${input}`, "-ac", "1", "-ar", "8000", "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1"];
}

/** RMS level (dBFS) of consecutive `win`-sample windows of s16 mono PCM. */
export function windowLevelsDb(pcm: Buffer, win = 400): number[] {
  const samples = Math.floor(pcm.length / 2);
  const out: number[] = [];
  for (let start = 0; start + win <= samples; start += win) {
    let sum = 0;
    for (let i = start; i < start + win; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    out.push(10 * Math.log10(sum / win + 1e-15));
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * BUG-1344: real background level, not astats' digital-silence floor. 50 ms windows; digital silence
 * (< -100 dBFS) is ignored. Background windows = the quietest 20 % of the ORIGINAL (speech is louder),
 * before = their median (= the original's 10th percentile), after = the cleaned file's median over the
 * SAME windows, so the two numbers compare like with like. null when there is not enough signal.
 */
export function backgroundLevels(before: number[], after: number[]): { beforeDb: number | null; afterDb: number | null } {
  const idx = before.map((v, i) => [v, i] as const).filter(([v]) => v > -100);
  if (idx.length < 20) return { beforeDb: null, afterDb: null };
  const cut = percentile(idx.map(([v]) => v).sort((a, b) => a - b), 20);
  const quiet = idx.filter(([v]) => v <= cut).map(([, i]) => i);
  const med = (vals: number[]) => {
    const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return s.length ? Math.round(percentile(s, 50) * 10) / 10 : null;
  };
  return { beforeDb: med(quiet.map((i) => before[i])), afterDb: med(quiet.filter((i) => i < after.length).map((i) => Math.max(-120, after[i]))) };
}

/** Waveform peaks (0..1, 2 decimals) from 16-bit mono PCM, `count` buckets. */
export function peaksFromPcm(pcm: Buffer, count = 160): number[] {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return Array(count).fill(0);
  const per = samples / count;
  const out: number[] = [];
  let max = 0;
  for (let b = 0; b < count; b++) {
    const start = Math.floor(b * per);
    const end = Math.max(start + 1, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end && i < samples; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    out.push(peak);
    if (peak > max) max = peak;
  }
  return out.map((v) => Math.round((v / 32768) * 100) / 100);
}

export function peaksArgs(input: string): string[] {
  return ["-nostdin", "-hide_banner", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", `file:${input}`, "-ac", "1", "-ar", "800", "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1"];
}

export const JOB_STATES = ["queued", "probing", "denoising", "encoding", "done", "failed", "canceled"] as const;
export type JobState = (typeof JOB_STATES)[number];
