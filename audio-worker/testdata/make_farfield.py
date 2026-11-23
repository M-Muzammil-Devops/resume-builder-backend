"""Build the multi-speaker far-field regression fixture (BUG-1340).

  python testdata/make_farfield.py <tts_dir>      (tts_dir: NN_near.wav / NN_far1.wav / NN_far2.wav, 48 kHz mono)

The TTS lines were made with Windows SAPI (David, Zira, David +40 % pitch). One near talker at about
-20 dBFS (dry), two far talkers at about -36 and -40 dBFS with heavy room reverb (RT60 0.9 s, weak direct path) and a
narrow 250-3000 Hz band, a phone-like band limit and a steady background (pink noise + hum) at about -50 dBFS.
Knobs (env): FF_FAR1, FF_FAR2, FF_RT60, FF_DIRECT, FF_BG. Writes farfield.ogg (Opus, 48 kHz mono)
and farfield.json (speech segments with talker and level). Deterministic (fixed seed).
"""
import glob
import json
import os
import sys

import numpy as np
import soundfile as sf

SR = 48000
LEVEL = {"near": -20.0, "far1": float(os.environ.get("FF_FAR1", -36)), "far2": float(os.environ.get("FF_FAR2", -40))}
RT60 = float(os.environ.get("FF_RT60", 0.9))
DIRECT = float(os.environ.get("FF_DIRECT", 0.12))
BG_DB = float(os.environ.get("FF_BG", -50))
HERE = os.path.dirname(os.path.abspath(__file__))


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(np.square(x, dtype=np.float64))) + 1e-12)


def trim(x, thr_db=-45.0, win=480):
    n = x.size // win
    env = np.array([rms_db(x[i * win : (i + 1) * win]) for i in range(n)])
    on = np.where(env > rms_db(x) + thr_db + 20)[0] if n else []
    if not len(on):
        return x
    return x[max(0, on[0] * win - win) : min(x.size, (on[-1] + 2) * win)]


def fft_conv(x, h):
    n = x.size + h.size - 1
    size = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)[:n]
    return y.astype(np.float32)


def room_ir(rng, rt60=0.7, length_s=0.9, direct=0.35):
    t = np.arange(int(length_s * SR)) / SR
    tail = rng.standard_normal(t.size) * np.exp(-6.91 * t / rt60)
    tail[: int(0.004 * SR)] = 0  # pre-delay before early reflections
    h = tail / np.sqrt(np.sum(tail**2))
    h[0] += direct
    return h.astype(np.float32)


def band(x, lo=120.0, hi=3800.0):
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(x.size, 1 / SR)
    gain = np.clip((f - lo * 0.7) / (lo * 0.3), 0, 1) * np.clip((hi * 1.3 - f) / (hi * 0.3), 0, 1)
    return np.fft.irfft(spec * gain, x.size).astype(np.float32)


def pink(rng, n):
    w = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    return np.fft.irfft(w / np.sqrt(f), n).astype(np.float32)


def main(tts_dir):
    rng = np.random.default_rng(1340)
    files = sorted(glob.glob(os.path.join(tts_dir, "*_*.wav")))
    if not files:
        raise SystemExit(f"no TTS files in {tts_dir}")
    gap = int(0.8 * SR)
    pieces, segments, pos = [], [], int(1.5 * SR)
    for path in files:
        talker = os.path.splitext(os.path.basename(path))[0].split("_", 1)[1]
        x, sr = sf.read(path, dtype="float32")
        if sr != SR:
            raise SystemExit(f"{path}: expected {SR} Hz")
        x = trim(x)
        if talker != "near":
            x = band(fft_conv(x, room_ir(rng, rt60=RT60, direct=DIRECT))[: x.size + int(0.5 * SR)], 250.0, 3000.0)
        x = x * (10 ** ((LEVEL[talker] - rms_db(x)) / 20))
        pieces.append((pos, x))
        segments.append({"start": round(pos / SR, 3), "end": round((pos + x.size) / SR, 3), "talker": talker, "level_dbfs": LEVEL[talker]})
        pos += x.size + gap
    total = pos + int(1.0 * SR)
    mix = np.zeros(total, dtype=np.float32)
    for start, x in pieces:
        mix[start : start + x.size] += x
    mix = band(mix)
    noise = band(pink(rng, total))
    t = np.arange(total) / SR
    hum = 0.3 * np.sin(2 * np.pi * 50 * t) + 0.15 * np.sin(2 * np.pi * 150 * t)
    bg = noise / np.sqrt(np.mean(noise**2)) + hum.astype(np.float32) * 0.5
    bg = bg * (10 ** ((BG_DB - rms_db(bg)) / 20))
    out = np.clip(mix + bg, -1, 1).astype(np.float32)
    sf.write(os.path.join(HERE, "farfield.ogg"), out, SR, format="OGG", subtype="OPUS")
    meta = {"sr": SR, "seconds": round(total / SR, 3), "background_dbfs": BG_DB, "rt60": RT60, "direct": DIRECT, "segments": segments}
    with open(os.path.join(HERE, "farfield.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)
    print(f"farfield.ogg {total / SR:.1f} s, {len(segments)} segments")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "tts"))
