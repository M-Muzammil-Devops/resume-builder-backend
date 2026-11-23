import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundLevels,
  decodeArgs,
  dfAttenLimit,
  dryMix,
  fallbackFilter,
  outputFor,
  parseProbe,
  previewArgs,
  previewBitrateK,
  sameBitrateK,
  windowLevelsDb,
} from "./media";
import { makePreviewSigner } from "./previewToken";

const ALL = new Set(["libmp3lame", "aac", "libopus", "flac", "pcm_s16le", "ac3", "eac3", "wmav2", "libvorbis"]);

test("BUG-1340/1343: strength → DFN attenuation cap is 6-18 dB, graded, monotonic; default 80 → 15 dB", () => {
  assert.equal(dfAttenLimit(0), 6);
  assert.equal(dfAttenLimit(20), 8.4);
  assert.equal(dfAttenLimit(50), 12);
  assert.equal(dfAttenLimit(80), 15);
  assert.equal(dfAttenLimit(100), 18);
  for (let s = 1; s <= 100; s++) {
    assert.ok(dfAttenLimit(s) > dfAttenLimit(s - 1), `monotonic at ${s}`);
    assert.ok(dfAttenLimit(s) <= 18 && dfAttenLimit(s) >= 6);
    assert.notEqual(dfAttenLimit(s), null);
  }
  // Noticeably graded: 20 / 50 / 80 differ by >= 3 dB each (QA: 50 and 80 sounded the same, 20 cut 26 dB).
  assert.ok(dfAttenLimit(50) - dfAttenLimit(20) >= 3);
  assert.ok(dfAttenLimit(80) - dfAttenLimit(50) >= 3);
});

test("BUG-1340: Keep all voices (conversation) = 8-12 dB cap + 10 % dry; gentle strengths blend a little dry", () => {
  assert.equal(dfAttenLimit(0, "conversation"), 8);
  assert.equal(dfAttenLimit(80, "conversation"), 11.2);
  assert.equal(dfAttenLimit(100, "conversation"), 12);
  assert.equal(dryMix(80, "conversation"), 0.1);
  assert.equal(dryMix(0), 0.15);
  assert.equal(dryMix(20), 0.09);
  assert.equal(dryMix(50), 0);
  assert.equal(dryMix(80), 0);
  // Fallback engines get the same cap.
  assert.equal(fallbackFilter("afftdn", 80), "afftdn=nr=15:nf=-30:tn=1");
  assert.equal(fallbackFilter("rnnoise", 80), "arnndn=m=sh.rnnn:mix=0.82");
  assert.equal(fallbackFilter("rnnoise", 80, "sh.rnnn", "conversation"), "arnndn=m=sh.rnnn:mix=0.72");
});

test("BUG-1340: stereo is decoded as stereo (worker splits differing channels), mono stays mono", () => {
  const st = decodeArgs("a", "b", 0, 600, 2);
  assert.equal(st[st.indexOf("-ac") + 1], "2");
  const mo = decodeArgs("a", "b", 0, 600);
  assert.equal(mo[mo.indexOf("-ac") + 1], "1");
});

test("BUG-1342: 'Same as input' keeps the input bit rate (48 kbps AAC → 48k AAC, not 192k)", () => {
  const raw = { format: { format_name: "mov,mp4,m4a", duration: "942", bit_rate: "49950" }, streams: [{ codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", bit_rate: "48000" }] };
  const r = parseProbe(raw, 1200);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.info.bitRateK, 48);
  const spec = outputFor("same", "aac", "mov", ALL, r.info.bitRateK);
  assert.equal(spec.args[spec.args.indexOf("-b:a") + 1], "48k");
  assert.equal(spec.args.filter((a) => a === "-b:a").length, 1);
  assert.equal(sameBitrateK("mp3", 70), 80);
  assert.equal(sameBitrateK("mp3", 400), 320);
  assert.equal(sameBitrateK("aac", 20), 32);
  assert.equal(sameBitrateK("opus", 24), 24);
  assert.equal(sameBitrateK("aac", null), null);
  // Unknown bit rate keeps the old default; explicit MP3 choice is unchanged.
  const def = outputFor("same", "aac", "mov", ALL, null);
  assert.equal(def.args[def.args.indexOf("-b:a") + 1], "192k");
  const mp3same = outputFor("same", "mp3", "mp3", ALL, 128);
  assert.equal(mp3same.args[mp3same.args.indexOf("-b:a") + 1], "128k");
  assert.ok(!mp3same.args.includes("-q:a"));
  assert.ok(outputFor("mp3", "aac", "mov", ALL, 48).args.includes("-q:a"));
});

test("BUG-1341: preview is mono MP3 at 48 kbps, never above the source bit rate", () => {
  assert.equal(previewBitrateK(null), 48);
  assert.equal(previewBitrateK(320), 48);
  assert.equal(previewBitrateK(40), 32);
  assert.equal(previewBitrateK(12), 16);
  const a = previewArgs("in", "out", 48);
  assert.equal(a[a.indexOf("-ac") + 1], "1");
  assert.equal(a[a.indexOf("-b:a") + 1], "48k");
  const low = previewArgs("in", "out", 20);
  assert.equal(low[low.indexOf("-ar") + 1], "24000");
});

function pcm(levels: number[], win = 400, seed = 7) {
  // White-ish noise windows at the given dBFS levels (deterministic LCG).
  const buf = Buffer.alloc(levels.length * win * 2);
  let x = seed;
  levels.forEach((db, w) => {
    const amp = 10 ** (db / 20) * Math.sqrt(3) * 32767;
    for (let i = 0; i < win; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(((x / 2147483648) * 2 - 1) * amp))), (w * win + i) * 2);
    }
  });
  return buf;
}

test("BUG-1344: background level = quiet windows of the original, compared on the same windows after cleaning", () => {
  // 70 % speech at -25 dBFS, 30 % background at -56 dBFS, plus digital silence that must be ignored.
  const before = [...Array(70).fill(-25), ...Array(30).fill(-56), ...Array(20).fill(-200)];
  const after = [...Array(70).fill(-27), ...Array(30).fill(-71), ...Array(20).fill(-200)];
  const lb = windowLevelsDb(pcm(before.map((v) => (v < -150 ? -400 : v))));
  const la = windowLevelsDb(pcm(after.map((v) => (v < -150 ? -400 : v))));
  const bg = backgroundLevels(lb, la);
  assert.ok(bg.beforeDb! > -58 && bg.beforeDb! < -54, String(bg.beforeDb));
  assert.ok(bg.afterDb! > -73 && bg.afterDb! < -69, String(bg.afterDb));
  // Not the astats-style digital floor (-100 dB and below).
  assert.ok(bg.beforeDb! > -100 && bg.afterDb! > -100);
  assert.deepEqual(backgroundLevels([-200, -200], [-200, -200]), { beforeDb: null, afterDb: null });
});

test("BUG-1341: preview signer binds job + track + user + expiry", () => {
  const s = makePreviewSigner("unit-test-secret-0123456789");
  const now = 1_800_000_000_000;
  const id = "11111111-1111-4111-8111-111111111111";
  const { path, exp } = s.sign(id, "clean", "u1", now);
  const sig = path.split("/").pop()!;
  assert.equal(s.verify(id, "clean", "u1", exp, sig, now), "ok");
  assert.equal(s.verify(id, "clean", "u2", exp, sig, now), "bad");
  assert.equal(s.verify(id, "original", "u1", exp, sig, now), "bad");
  assert.equal(s.verify(id, "clean", "u1", exp + 1, sig, now), "bad");
  assert.equal(s.verify(id, "clean", "u1", exp, sig, now + 301_000), "expired");
  assert.equal(s.verify(id, "clean", "u1", exp, "x", now), "bad");
  // Another secret (e.g. after a restart) never validates old links.
  assert.equal(makePreviewSigner("another-secret-abcdefghij").verify(id, "clean", "u1", exp, sig, now), "bad");
});
