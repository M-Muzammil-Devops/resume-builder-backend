"""Chunked processing helpers for the audio worker (pure numpy, no torch, so they are unit-testable).

Long files are processed in ~60 s chunks. Each chunk is read with a short pre-roll (discarded, lets the
model's recurrent state settle) and a short overlap past its end. The overlap of chunk i and the start
of chunk i+1 are blended with an equal-gain raised-cosine crossfade, so there is no click at the seams.
Only one chunk (+ pre-roll + overlap) is in memory at a time.
"""
import math

import numpy as np


def plan_chunks(total, sr, chunk_s=60.0, overlap_s=0.5, preroll_s=1.0, min_last_s=5.0):
    """Split `total` frames into chunks.

    Returns a list of dicts: core [start, end) frames each chunk owns, and the read window
    [read_start, read_end) that includes the pre-roll before and the overlap after.
    A short last piece (< min_last_s) is merged into the previous chunk.
    """
    total = int(total)
    if total <= 0:
        return []
    size = max(1, int(round(chunk_s * sr)))
    overlap = max(0, int(round(overlap_s * sr)))
    preroll = max(0, int(round(preroll_s * sr)))
    n = max(1, math.ceil(total / size))
    if n > 1 and total - (n - 1) * size < min_last_s * sr:
        n -= 1
    chunks = []
    for i in range(n):
        start = i * size
        end = total if i == n - 1 else (i + 1) * size
        chunks.append(
            {
                "index": i,
                "start": start,
                "end": end,
                "read_start": max(0, start - preroll) if i > 0 else 0,
                "read_end": min(total, end + overlap) if i < n - 1 else total,
            }
        )
    return chunks


def fade_curves(n):
    """Equal-gain raised-cosine fades (fade_in + fade_out == 1 everywhere)."""
    if n <= 0:
        return np.zeros(0, dtype=np.float32), np.zeros(0, dtype=np.float32)
    t = (np.arange(n, dtype=np.float64) + 0.5) / n
    fade_in = (0.5 - 0.5 * np.cos(np.pi * t)).astype(np.float32)
    return fade_in, (1.0 - fade_in).astype(np.float32)


class Stitcher:
    """Turns processed chunk windows into one continuous signal, written through `write(frames)`."""

    def __init__(self, write):
        self.write = write
        self.tail = None  # processed overlap past the previous chunk's end
        self.written = 0

    def add(self, chunk, processed):
        """`processed` is (frames,) for mono or (frames, channels) for multi-channel files."""
        processed = np.asarray(processed, dtype=np.float32)
        want = chunk["read_end"] - chunk["read_start"]
        if processed.shape[0] < want:  # models may return a few frames short: pad with silence
            pad = np.zeros((want - processed.shape[0],) + processed.shape[1:], dtype=np.float32)
            processed = np.concatenate([processed, pad])
        processed = processed[:want]
        offset = chunk["start"] - chunk["read_start"]  # drop the pre-roll
        core_len = chunk["end"] - chunk["start"]
        body = processed[offset : offset + core_len].copy()
        if self.tail is not None and self.tail.shape[0]:
            n = min(self.tail.shape[0], body.shape[0])
            fade_in, fade_out = fade_curves(n)
            if body.ndim == 2:
                fade_in, fade_out = fade_in[:, None], fade_out[:, None]
            body[:n] = body[:n] * fade_in + self.tail[:n] * fade_out
        self.tail = processed[offset + core_len :].copy()
        self.write(body)
        self.written += body.shape[0]
        return body.shape[0]
