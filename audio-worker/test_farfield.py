"""BUG-1340 regression: quiet / far talkers must survive DeepFilterNet3.

Runs the real model (worker venv) on testdata/farfield.ogg - a near talker at -20 dBFS and two far,
reverberant talkers at -34 / -40 dBFS - with the same settings the API sends, and measures every speech
segment's level drop (100-4000 Hz band, original -> cleaned):

  default  (Remove noise, strength 80 -> 15 dB cap)          : every segment <= 18 dB down
  conversation (Keep all voices, strength 80 -> 11.2 dB + 10 % dry) : every segment <= 10 dB down
  graded: strength 20 < 50 < 80 in background reduction (BUG-1343)

Skipped when DeepFilterNet is not installed. R25_REPORT=<file.json> writes the per-segment table,
R25_OLD=1 also measures the old uncapped mapping (strength 80 -> 81.2 dB) for the before/after report.
"""
import json
import os
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "testdata", "farfield.ogg")
META = os.path.join(HERE, "testdata", "farfield.json")

# Same numbers as dfAttenLimit()/dryMix() in src/lib/audio/media.ts (checked by media.test.ts too).
CONFIGS = {
    "s80": (15.0, 0.0),
    "s50": (12.0, 0.0),
    "s20": (8.4, 0.09),
    "conv80": (11.2, 0.1),
}

try:
    import soundfile as sf
    import torch
    from df.enhance import enhance, init_df

    HAVE_DF = os.path.exists(FIXTURE)
except Exception:  # noqa: BLE001
    HAVE_DF = False


def band_db(x, sr):
    spec = np.fft.rfft(x.astype(np.float64))
    f = np.fft.rfftfreq(x.size, 1 / sr)
    spec[(f < 100) | (f > 4000)] = 0
    y = np.fft.irfft(spec, x.size)
    return 20 * np.log10(np.sqrt(np.mean(y**2)) + 1e-12)


@unittest.skipUnless(HAVE_DF, "DeepFilterNet or fixture not available")
class FarFieldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import contextlib
        import sys

        from worker import process_file

        torch.set_num_threads(max(1, min(8, (os.cpu_count() or 4) // 2)))
        with contextlib.redirect_stdout(sys.stderr):
            model, state, _ = init_df(log_level="ERROR", log_file=None)
        sr = state.sr()
        cls.sr = sr
        cls.meta = json.load(open(META, encoding="utf-8"))
        tmp = tempfile.mkdtemp()
        src = os.path.join(tmp, "in.wav")
        x, fsr = sf.read(FIXTURE, dtype="float32")
        assert fsr == sr
        sf.write(src, x, sr, subtype="FLOAT")
        cls.orig = x
        cls.out = {}
        configs = dict(CONFIGS)
        if os.environ.get("R25_OLD"):
            configs["old_s80"] = (81.2, 0.0)
        for name, (lim, dry) in configs.items():

            def denoise(block, lim=lim):
                t = torch.from_numpy(np.ascontiguousarray(block)).unsqueeze(0)
                with torch.no_grad(), contextlib.redirect_stdout(sys.stderr):
                    o = enhance(model, state, t, atten_lim_db=lim)
                return o.squeeze(0).numpy().astype("float32")

            dst = os.path.join(tmp, f"{name}.wav")
            process_file(sf, np, denoise, src, dst, sr, dry_mix=dry)
            y, _ = sf.read(dst, dtype="float32")
            cls.out[name] = y
        cls.drops = {name: cls._drops(y) for name, y in cls.out.items()}
        cls.bg = {name: cls._bg_drop(y) for name, y in cls.out.items()}
        report = os.environ.get("R25_REPORT")
        if report:
            rows = []
            for i, seg in enumerate(cls.meta["segments"]):
                rows.append({**seg, **{k: round(v[i], 1) for k, v in cls.drops.items()}})
            json.dump({"segments": rows, "background_drop_db": {k: round(v, 1) for k, v in cls.bg.items()}}, open(report, "w"), indent=1)

    @classmethod
    def _drops(cls, y):
        res = []
        for seg in cls.meta["segments"]:
            a, b = int(seg["start"] * cls.sr), int(seg["end"] * cls.sr)
            res.append(band_db(cls.orig[a:b], cls.sr) - band_db(y[a:b], cls.sr))
        return res

    @classmethod
    def _bg_drop(cls, y):
        # Background = the gaps between segments (and the lead-in), excluding 0.3 s around speech.
        mask = np.ones(cls.orig.size, dtype=bool)
        for seg in cls.meta["segments"]:
            mask[max(0, int((seg["start"] - 0.3) * cls.sr)) : int((seg["end"] + 0.3) * cls.sr)] = False
        return band_db(cls.orig[mask], cls.sr) - band_db(y[mask], cls.sr)

    def test_default_strength_keeps_every_voice(self):
        worst = max(self.drops["s80"])
        self.assertLessEqual(worst, 18.0, f"segment drops at strength 80: {[round(d, 1) for d in self.drops['s80']]}")

    def test_conversation_mode_keeps_far_voices_within_10_db(self):
        worst = max(self.drops["conv80"])
        self.assertLessEqual(worst, 10.0, f"conversation drops: {[round(d, 1) for d in self.drops['conv80']]}")

    def test_no_segment_is_gated_to_silence(self):
        for name in CONFIGS:
            self.assertLessEqual(max(self.drops[name]), 20.0, name)

    def test_strength_is_graded(self):
        # More strength -> more background removed (BUG-1343), with clear steps.
        self.assertGreater(self.bg["s50"], self.bg["s20"] + 2.0, self.bg)
        self.assertGreater(self.bg["s80"], self.bg["s50"] + 1.5, self.bg)

    def test_noise_is_still_reduced(self):
        self.assertGreaterEqual(self.bg["s80"], 10.0, self.bg)


if __name__ == "__main__":
    unittest.main()
