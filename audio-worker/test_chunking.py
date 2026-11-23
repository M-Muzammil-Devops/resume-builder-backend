"""python -m unittest discover -s audio-worker -p "test_*.py"  (uses the worker venv: numpy only)."""
import unittest

import numpy as np

from chunking import Stitcher, fade_curves, plan_chunks

SR = 1000  # small rate keeps the tests fast; the logic is rate-independent


def run(signal, fn, **kw):
    out = []
    st = Stitcher(out.append)
    for c in plan_chunks(signal.size, SR, **kw):
        st.add(c, fn(signal[c["read_start"] : c["read_end"]]))
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


class PlanTests(unittest.TestCase):
    def test_short_file_is_one_chunk(self):
        self.assertEqual(plan_chunks(30 * SR, SR), [{"index": 0, "start": 0, "end": 30 * SR, "read_start": 0, "read_end": 30 * SR}])

    def test_19_minutes_covers_every_frame_once(self):
        total = 19 * 60 * SR + 123
        chunks = plan_chunks(total, SR)
        self.assertEqual(len(chunks), 19)
        self.assertEqual(chunks[0]["start"], 0)
        self.assertEqual(chunks[-1]["end"], total)
        for a, b in zip(chunks, chunks[1:]):
            self.assertEqual(a["end"], b["start"])  # contiguous, no gaps or double frames
            self.assertEqual(a["read_end"], a["end"] + SR // 2)  # 0.5 s overlap
            self.assertEqual(b["read_start"], b["start"] - SR)  # 1 s pre-roll

    def test_tiny_last_piece_is_merged(self):
        chunks = plan_chunks(120 * SR + 2 * SR, SR)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[-1]["end"], 122 * SR)

    def test_empty(self):
        self.assertEqual(plan_chunks(0, SR), [])


class StitchTests(unittest.TestCase):
    def test_fades_sum_to_one(self):
        a, b = fade_curves(500)
        np.testing.assert_allclose(a + b, 1.0, atol=1e-6)
        self.assertLess(a[0], 0.01)
        self.assertGreater(a[-1], 0.99)

    def test_identity_is_lossless(self):
        rng = np.random.default_rng(1)
        x = rng.standard_normal(200 * SR + 77).astype(np.float32)
        y = run(x, lambda w: w)
        self.assertEqual(y.size, x.size)
        np.testing.assert_allclose(y, x, atol=1e-6)

    def test_no_click_at_seams(self):
        # Each chunk comes back with a different gain (like a model whose level drifts per chunk).
        # Without a crossfade that is a hard step at every seam; with it the change is spread over 0.5 s.
        x = np.ones(180 * SR, dtype=np.float32)
        gains = iter([1.0, 0.6, 0.9])
        y = run(x, lambda w: w * next(gains))
        self.assertEqual(y.size, x.size)
        self.assertLess(float(np.max(np.abs(np.diff(y)))), 0.01)  # a hard step would be 0.4

    def test_short_model_output_is_padded(self):
        x = np.ones(130 * SR, dtype=np.float32)
        y = run(x, lambda w: w[:-3])
        self.assertEqual(y.size, x.size)


class StereoAndDryTests(unittest.TestCase):
    """BUG-1340: per-channel processing when L/R differ, single pass for dual-mono, dry mix."""

    def _file(self, data, sr=SR):
        import os
        import tempfile

        import soundfile as sf

        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        sf.write(path, data, sr, subtype="FLOAT")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        return path

    def _run(self, data, dry=0.0, fn=lambda b: b * 0.5):
        import os
        import tempfile

        import soundfile as sf
        from worker import process_file

        src = self._file(data)
        fd, dst = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        self.addCleanup(lambda: os.path.exists(dst) and os.remove(dst))
        calls = []

        def denoise(block):
            calls.append(block.shape)
            return fn(block)

        n, ch = process_file(sf, np, denoise, src, dst, SR, dry_mix=dry, chunk_s=60, overlap_s=0.5)
        out, _ = sf.read(dst, dtype="float32", always_2d=True)
        return out, ch, calls

    def test_dual_mono_is_cleaned_once_and_written_mono(self):
        t = np.arange(10 * SR) / SR
        x = (0.3 * np.sin(2 * np.pi * 5 * t)).astype(np.float32)
        out, ch, calls = self._run(np.stack([x, x], axis=1))
        self.assertEqual(ch, 1)
        self.assertEqual(out.shape[1], 1)
        self.assertEqual(len(calls), 1)
        np.testing.assert_allclose(out[:, 0], x * 0.5, atol=1e-5)

    def test_different_channels_are_cleaned_separately(self):
        t = np.arange(10 * SR) / SR
        left = (0.3 * np.sin(2 * np.pi * 5 * t)).astype(np.float32)
        right = (0.05 * np.sin(2 * np.pi * 7 * t)).astype(np.float32)  # quiet far talker only on R
        out, ch, calls = self._run(np.stack([left, right], axis=1))
        self.assertEqual(ch, 2)
        self.assertEqual(len(calls), 2)
        np.testing.assert_allclose(out[:, 0], left * 0.5, atol=1e-5)
        np.testing.assert_allclose(out[:, 1], right * 0.5, atol=1e-5)

    def test_dry_mix_blends_original_back(self):
        x = np.full(5 * SR, 0.4, dtype=np.float32)
        out, _, _ = self._run(x, dry=0.1, fn=lambda b: b * 0.0)  # model removes everything
        np.testing.assert_allclose(out[:, 0], 0.04, atol=1e-6)  # 10 % dry survives: never silence

    def test_dry_mix_is_capped(self):
        x = np.full(5 * SR, 0.4, dtype=np.float32)
        out, _, _ = self._run(x, dry=0.9, fn=lambda b: b * 0.0)
        np.testing.assert_allclose(out[:, 0], 0.4 * 0.3, atol=1e-6)


class DeviceTests(unittest.TestCase):
    def test_device_choice(self):
        from worker import pick_device

        self.assertEqual(pick_device(None, True), ("cpu", False, None))  # default is CPU even with a GPU
        self.assertEqual(pick_device("cpu", True)[1], False)
        self.assertEqual(pick_device("cuda", True), ("cuda", True, None))
        want, use, warn = pick_device("cuda", False)
        self.assertFalse(use)
        self.assertIn("falling back to CPU", warn)
        self.assertEqual(pick_device("auto", False), ("auto", False, None))
        self.assertEqual(pick_device("AUTO", True)[1], True)
        self.assertFalse(pick_device("tpu", True)[1])


if __name__ == "__main__":
    unittest.main()
