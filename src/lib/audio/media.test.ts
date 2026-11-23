import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asciiFileName,
  cleanUploadName,
  contentDisposition,
  outputSampleRate,
  parseStrength,
  decodeArgs,
  dfAttenLimit,
  encodeArgs,
  fallbackFilter,
  outputFor,
  parseMetrics,
  parseMode,
  parseProbe,
  parseRange,
  peaksFromPcm,
  previewArgs,
  probeArgs,
  safeBaseName,
  sniffReject,
  audioDuration,
  measureArgs,
  parseProgressSeconds,
  positive,
  tooLongMessage,
} from "./media";
import { loadAudioConfig } from "./config";

const ALL = new Set(["aac", "alac", "libmp3lame", "libopus", "libvorbis", "flac", "wmav2", "ac3", "eac3", "pcm_s16le", "pcm_s16be", "libopencore_amrnb"]);
const enc = (s: string) => new TextEncoder().encode(s);

test("audio probe: audio stream found, default stream picked, container duration when the stream has none", () => {
  const r = parseProbe(
    {
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "222.5" },
      streams: [
        { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "44100" },
        { codec_type: "audio", codec_name: "ac3", channels: 6, sample_rate: "48000", disposition: { default: 1 } },
      ],
    },
    600
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.info.codec, "ac3");
  assert.equal(r.info.streamIndex, 1);
  assert.equal(r.info.duration, 222.5);
  assert.equal(r.info.container, "mov");
  assert.equal(r.info.hasVideo, false);
});

test("audio probe: video + audio → hasVideo; cover art is not video; stream duration fallback", () => {
  const v = parseProbe({ format: { format_name: "matroska,webm" }, streams: [{ codec_type: "video" }, { codec_type: "audio", codec_name: "opus", duration: "12" }] }, 600);
  assert.ok(v.ok && v.info.hasVideo && v.info.duration === 12);
  const art = parseProbe({ format: { format_name: "mp3" }, streams: [{ codec_type: "audio", codec_name: "mp3" }, { codec_type: "video", disposition: { attached_pic: 1 } }] }, 600);
  assert.ok(art.ok && !art.info.hasVideo && art.info.duration === null);
});

test("audio probe: rejects no audio, playlists/concat, too long, unreadable", () => {
  const none = parseProbe({ format: { format_name: "mov,mp4" }, streams: [{ codec_type: "video" }] }, 600);
  assert.ok(!none.ok && none.status === 415 && none.code === "NO_AUDIO_STREAM");
  for (const f of ["hls", "concat", "ffconcat", "image2", "lavfi", "sdp", "tee", "dash"]) {
    const r = parseProbe({ format: { format_name: f }, streams: [{ codec_type: "audio", codec_name: "aac" }] }, 600);
    assert.ok(!r.ok && r.status === 415 && r.code === "UNSUPPORTED_FORMAT", f);
  }
  const long = parseProbe({ format: { format_name: "mp3", duration: "660" }, streams: [{ codec_type: "audio", codec_name: "mp3" }] }, 600);
  assert.ok(!long.ok && long.status === 422 && long.code === "TOO_LONG");
  const bad = parseProbe(null, 600);
  assert.ok(!bad.ok && bad.status === 422 && bad.code === "UNREADABLE_MEDIA");
});

test("audio sniff: rejects exe, zip, pdf, html, playlists and plain text; accepts media magic", () => {
  assert.ok(sniffReject(enc("MZ\x90\x00 this is a windows binary")));
  assert.ok(sniffReject(enc("PK\x03\x04 zipzipzipzipzip")));
  assert.ok(sniffReject(enc("%PDF-1.7 aaaaaaaaaaaaa")));
  assert.ok(sniffReject(enc("<!DOCTYPE html><html></html>")));
  assert.ok(sniffReject(enc("#EXTM3U\n#EXTINF:10,\nC:\\Windows\\win.ini\n")));
  assert.ok(sniffReject(enc("ffconcat version 1.0\nfile 'C:/Windows/win.ini'\n")));
  assert.ok(sniffReject(enc("[playlist]\nFile1=http://example.com/a.mp3\n")));
  assert.ok(sniffReject(enc("just some plain text that is long enough")));
  assert.equal(sniffReject(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0x10, 0xff, 0xfb, 0x90, 0x00, 0x00, 0x01, 0x02, 0x80])), null); // ID3/MP3
  const wav = new Uint8Array(44);
  wav.set(enc("RIFF"), 0);
  wav.set(enc("WAVEfmt "), 8);
  wav[16] = 16;
  assert.equal(sniffReject(wav), null);
});

test("audio output mapping: same-as-input per codec, explicit choices, MP3 fallback note", () => {
  assert.equal(outputFor("same", "aac", "mov", ALL).ext, "m4a");
  assert.equal(outputFor("same", "alac", "mov", ALL).args.includes("alac"), true);
  assert.equal(outputFor("same", "mp3", "mp3", ALL).ext, "mp3");
  assert.equal(outputFor("same", "opus", "ogg", ALL).ext, "opus");
  assert.equal(outputFor("same", "vorbis", "ogg", ALL).ext, "ogg");
  assert.equal(outputFor("same", "flac", "flac", ALL).ext, "flac");
  assert.equal(outputFor("same", "pcm_s16le", "wav", ALL).ext, "wav");
  assert.equal(outputFor("same", "pcm_s16be", "aiff", ALL).ext, "aiff");
  assert.equal(outputFor("same", "wmav2", "asf", ALL).ext, "wma");
  assert.equal(outputFor("same", "ac3", "ac3", ALL).ext, "ac3");
  assert.equal(outputFor("same", "amr_nb", "amr", ALL).sampleRate, 8000);
  const noAmr = outputFor("same", "amr_nb", "amr", new Set(["libmp3lame"]));
  assert.equal(noAmr.ext, "mp3");
  assert.match(noAmr.note || "", /AMR encoder unavailable/);
  assert.match(outputFor("same", "ape", "ape", ALL).note || "", /APE cannot be written/);
  assert.equal(outputFor("wav", "aac", "mov", ALL).ext, "wav");
  assert.equal(outputFor("flac", "aac", "mov", ALL).ext, "flac");
  assert.equal(outputFor("mp3", "flac", "flac", ALL).ext, "mp3");
});

test("audio strength mapping per engine", () => {
  assert.equal(dfAttenLimit(100), 18); // round25: capped, never "unlimited"
  assert.equal(dfAttenLimit(0), 6);
  assert.equal(dfAttenLimit(80), 15);
  assert.equal(fallbackFilter("rnnoise", 60), "arnndn=m=sh.rnnn:mix=0.78");
  assert.equal(fallbackFilter("rnnoise", 50, "../evil:x.rnnn"), "arnndn=m=..evilx.rnnn:mix=0.75");
  assert.equal(fallbackFilter("afftdn", 100), "afftdn=nr=18:nf=-30:tn=1");
});

test("audio ffmpeg args: arrays only, protocol whitelist, server paths only", () => {
  const dec = decodeArgs("D:\\tmp\\a\\input", "D:\\tmp\\a\\dec.wav", 1, 600);
  assert.ok(Array.isArray(dec));
  assert.deepEqual(dec.slice(dec.indexOf("-protocol_whitelist"), dec.indexOf("-protocol_whitelist") + 2), ["-protocol_whitelist", "file,pipe"]);
  assert.ok(dec.includes("file:D:\\tmp\\a\\input"));
  assert.ok(dec.includes("0:a:1"));
  assert.ok(dec.includes("-vn"));
  for (const args of [dec, probeArgs("x"), encodeArgs("a", "b", outputFor("mp3", "", "", ALL), 2), previewArgs("a", "b")]) {
    assert.ok(args.includes("-protocol_whitelist"));
    assert.ok(args.every((a) => typeof a === "string" && !a.includes("&&") && !a.includes("|") || a === "file,pipe"));
  }
  assert.ok(encodeArgs("a", "b", outputFor("same", "amr_nb", "amr", ALL), 2).join(" ").includes("-ac 1"));
});

test("audio metrics parsing + mode fallback", () => {
  // The retired "voice" (Voice clean) mode and unknown values fall back to plain noise removal.
  assert.equal(parseMode("conversation"), "conversation");
  assert.equal(parseMode("noise"), "noise");
  assert.equal(parseMode("voice"), "noise");
  assert.equal(parseMode(undefined), "noise");
  const met = parseMetrics("[Parsed_astats_0] Overall\nNoise floor dB: -48.123\n[Parsed_ebur128_1] Summary:\n  Integrated loudness:\n    I:         -16.2 LUFS\n");
  assert.deepEqual(met, { noiseFloorDb: -48.1, lufs: -16.2 });
  assert.deepEqual(parseMetrics("Noise floor dB: -inf\n I: -70.0 LUFS"), { noiseFloorDb: null, lufs: null });
});

test("audio filename sanitizer + Content-Disposition + range", () => {
  assert.equal(safeBaseName('in"ter\\view/../café?.m4a'), "inter_view_.._café_");
  assert.equal(safeBaseName(".m4a"), "audio");
  assert.equal(safeBaseName("x".repeat(200) + ".mp3").length, 80);
  const cd = contentDisposition('my "talk"\r\n.wav', "mp3");
  assert.ok(!/[\r\n]/.test(cd));
  assert.match(cd, /^attachment; filename="my talk-clean\.mp3"; filename\*=UTF-8''my%20talk-clean\.mp3$/);
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.equal(parseRange("bytes=2000-", 1000), "invalid");
  assert.equal(parseRange(undefined, 1000), null);
});

test("audio config: defaults and env names", () => {
  const c = loadAudioConfig({} as NodeJS.ProcessEnv);
  assert.equal(c.maxBytes, 100 * 1024 * 1024); // round23: 100 MB / 20 min
  assert.equal(c.maxSeconds, 1200);
  assert.equal(c.uploadsPerHour, 10);
  assert.equal(c.ttlMs, 3_600_000);
  assert.ok(!c.tmpDir.includes("uploads"));
  const d = loadAudioConfig({ AUDIO_MAX_MB: "5", AUDIO_MAX_SECONDS: "30", FFMPEG_PATH: "C:/ff/ffmpeg.exe" } as NodeJS.ProcessEnv);
  assert.equal(d.maxBytes, 5 * 1024 * 1024);
  assert.equal(d.maxSeconds, 30);
  assert.equal(d.ffmpegPath, "C:/ff/ffmpeg.exe");
});

test("audio waveform peaks from PCM", () => {
  const pcm = Buffer.alloc(2 * 1000);
  pcm.writeInt16LE(16384, 2 * 10);
  pcm.writeInt16LE(-32768, 2 * 990);
  const p = peaksFromPcm(pcm, 10);
  assert.equal(p.length, 10);
  assert.equal(p[0], 0.5);
  assert.equal(p[9], 1);
  assert.equal(p[5], 0);
  assert.deepEqual(peaksFromPcm(Buffer.alloc(0), 4), [0, 0, 0, 0]);
});

test("audio duration (sharafat-voice-karachi.mp4): audio-only MP4 uses the AUDIO stream, not the container header", () => {
  // Audio-only .mp4 whose container/movie header claims 25 min while the audio track is 6:30.
  const r = parseProbe(
    {
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1500.000000" },
      streams: [
        { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "48000", duration: "390.016000", disposition: { default: 1 } },
        { codec_type: "data", codec_name: "bin_data", duration: "1500.0" },
      ],
    },
    600
  );
  assert.ok(r.ok, "must not be rejected as too long");
  if (!r.ok) return;
  assert.equal(r.info.duration, 390.016);
  assert.equal(r.info.hasVideo, false);
  assert.equal(r.info.container, "mov");
});

test("audio duration: duration_ts × time_base, then container; N/A / NaN / Infinity / ms-sized values are unknown", () => {
  assert.equal(audioDuration({ duration_ts: 2646000, time_base: "1/44100" }, { duration: "999" }), 60);
  assert.equal(audioDuration({ duration: "N/A" }, { duration: "42.5" }), 42.5);
  assert.equal(audioDuration({ duration: "N/A" }, { duration: "N/A" }), null);
  assert.equal(audioDuration(undefined, undefined), null);
  for (const v of ["N/A", "nan", "NaN", "inf", "Infinity", "-5", "0", "", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "12abc"]) {
    assert.equal(positive(v), null, String(v));
  }
  assert.equal(positive("7.5"), 7.5);
  assert.equal(positive(1e12), null); // absurd (ms/timebase mix-up) → unknown, not "too long"
  const unknown = parseProbe({ format: { format_name: "mov,mp4", duration: "N/A" }, streams: [{ codec_type: "audio", codec_name: "aac", duration: "N/A" }] }, 600);
  assert.ok(unknown.ok && unknown.info.duration === null);
});

test("audio duration: cover art (attached_pic or still-image codec) is not video", () => {
  const r = parseProbe(
    { format: { format_name: "mov,mp4,m4a" }, streams: [{ codec_type: "audio", codec_name: "aac", duration: "30" }, { codec_type: "video", codec_name: "mjpeg" }] },
    600
  );
  assert.ok(r.ok && r.info.hasVideo === false);
  const v = parseProbe({ format: { format_name: "mov,mp4" }, streams: [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio", codec_name: "aac", duration: "30" }] }, 600);
  assert.ok(v.ok && v.info.hasVideo === true);
});

test("audio duration: too long carries the detected length; measuring parses ffmpeg -progress", () => {
  const long = parseProbe({ format: { format_name: "mov,mp4" }, streams: [{ codec_type: "audio", codec_name: "aac", duration: "700.4" }] }, 600);
  assert.ok(!long.ok && long.code === "TOO_LONG" && long.duration === 700.4 && long.info?.streamIndex === 0);
  if (!long.ok) assert.equal(long.message, "This recording is 11:40 long. The limit is 10 minutes.");
  assert.equal(tooLongMessage(65, 600), "This recording is 1:05 long. The limit is 10 minutes.");
  assert.equal(parseProgressSeconds("out_time_us=1000000\nout_time_ms=1000000\nprogress=continue\nout_time_us=390016000\nout_time_us=N/A\nprogress=end\n"), 390.016);
  assert.equal(parseProgressSeconds("out_time_us=N/A\nprogress=end\n"), null);
  const a = measureArgs("C:/tmp/in", 1);
  assert.deepEqual(a.slice(a.indexOf("-map"), a.indexOf("-map") + 2), ["-map", "0:a:1"]);
  assert.ok(a.includes("copy") && a.includes("pipe:1") && a.includes("file:C:/tmp/in") && a.includes("file,pipe"));
});

test("BUG-1324 upload names: percent-decoded, control chars/quotes stripped, Unicode kept, ASCII fallback", () => {
  assert.equal(cleanUploadName("Caf%C3%A9%20talk.mp3"), "Café talk.mp3");
  assert.equal(cleanUploadName("bad%E0%A4%A.mp3"), "bad%E0%A4%A.mp3"); // invalid encoding kept as is
  assert.equal(cleanUploadName('a\r\nb"c\'d`e\u0007f.wav'), "abcdef.wav");
  assert.equal(cleanUploadName("..\\..\\x/y.mp3"), ".._.._x_y.mp3");
  assert.equal(cleanUploadName(""), "audio");
  assert.equal(safeBaseName("شرافت کراچی.mp4"), "شرافت کراچی");
  assert.equal(safeBaseName("Señor_日本語.m4a"), "Señor_日本語");
  assert.equal(asciiFileName("Café talk-clean.mp3"), "Cafe talk-clean.mp3");
  assert.equal(asciiFileName("شرافت-clean.m4a"), "-clean.m4a");
  const cd = contentDisposition("Caf%C3%A9 (1)'s.mp3", "mp3");
  assert.equal(cd, "attachment; filename=\"Cafe _1_s-clean.mp3\"; filename*=UTF-8''Caf%C3%A9%20_1_s-clean.mp3");
  const urdu = contentDisposition("شرافت.mp4", "m4a");
  assert.match(urdu, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''%D8%B4/);
  assert.ok(!/[\r\n]/.test(contentDisposition("a\r\nSet-Cookie: x.mp3", "mp3")));
});

test("BUG-1325 output sample rate follows the input (48 kHz cap, encoder rate sets)", () => {
  const wav = outputFor("wav", "", "", ALL);
  const mp3 = outputFor("mp3", "", "", ALL);
  const flac = outputFor("flac", "", "", ALL);
  assert.equal(outputSampleRate(wav, 44100), 44100);
  assert.equal(outputSampleRate(wav, 16000), 16000);
  assert.equal(outputSampleRate(wav, 96000), 48000);
  assert.equal(outputSampleRate(wav, 0), 48000);
  assert.equal(outputSampleRate(flac, 22050), 22050);
  assert.equal(outputSampleRate(mp3, 44100), 44100);
  assert.equal(outputSampleRate(mp3, 37800), 44100);
  assert.equal(outputSampleRate(outputFor("same", "opus", "ogg", ALL), 44100), 48000);
  assert.equal(outputSampleRate(outputFor("same", "opus", "ogg", ALL), 16000), 16000);
  assert.equal(outputSampleRate(outputFor("same", "ac3", "ac3", ALL), 22050), 32000);
  assert.equal(outputSampleRate(outputFor("same", "aac", "mov,mp4", ALL), 44100), 44100);
  assert.equal(outputSampleRate(outputFor("same", "amr_nb", "amr", ALL), 48000), 8000);
  const a = encodeArgs("in", "out", wav, 2, 44100);
  assert.equal(a[a.indexOf("-ar") + 1], "44100");
});

test("strength: integer 0..100 only", () => {
  assert.equal(parseStrength(undefined), 80);
  assert.equal(parseStrength(""), 80);
  assert.equal(parseStrength("0"), 0);
  assert.equal(parseStrength("100"), 100);
  assert.equal(parseStrength(" 55 "), 55);
  for (const v of ["101", "-1", "50.5", "1e2", "abc", "0x10", "1000", "NaN"]) assert.equal(parseStrength(v), null, v);
});
