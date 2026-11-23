"""DeepFilterNet3 denoise worker for the Resume Builder audio tool.

Protocol (one JSON object per line):
  stdout on start : {"type":"ready","device":"cpu"|"cuda"}
  stdin  per job  : {"id": str, "input": wav_path, "output": wav_path, "atten_lim_db": float|null,
                     "dry_mix"?: float (0..0.3), "chunk_seconds"?: float, "overlap_seconds"?: float}
  stdout per chunk: {"type":"progress","id": str, "done": int, "total": int}
  stdout per job  : {"type":"result","id": str, "ok": bool, "error"?: str, "seconds"?: float, "chunks"?: int,
                     "channels"?: int}
Input is the 48 kHz float WAV written by the API (ffmpeg, mono or stereo). Paths come from the API, never from users.

BUG-1340: `atten_lim_db` caps how far DeepFilterNet may pull any frame down (the API maps strength to
6-18 dB), so quiet / far voices are never gated to silence. `dry_mix` blends a little of the original back.
Stereo files whose channels really differ are cleaned per channel; dual-mono (L == R) is cleaned once.

Device (--device / AUDIO_DEVICE): cpu (default) | cuda | auto. CUDA is used only when asked for AND
torch.cuda.is_available(); otherwise a warning goes to stderr and the worker runs on CPU.
Files are processed in ~60 s chunks (see chunking.py) so memory stays flat for 20-minute files.
"""
import argparse
import contextlib
import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("PYTHONWARNINGS", "ignore")


PROTO = sys.stdout


def emit(obj):
    PROTO.write(json.dumps(obj) + "\n")
    PROTO.flush()


def pick_device(wanted, cuda_available):
    """-> (wanted, use_cuda, warning). Default CPU; CUDA only when asked for and available."""
    want = (wanted or "cpu").strip().lower()
    if want not in ("cpu", "cuda", "auto"):
        return want, False, f"unknown AUDIO_DEVICE={want!r}, using CPU"
    if want == "cpu":
        return want, False, None
    if cuda_available:
        return want, True, None
    if want == "cuda":
        return want, False, "AUDIO_DEVICE=cuda but torch.cuda.is_available() is False (CPU-only torch or no GPU); falling back to CPU"
    return want, False, None


def normalize_in_place(sf, np, path, gain, block=48000 * 30):
    """Scale a written WAV by `gain` block by block (keeps memory flat)."""
    with sf.SoundFile(path, "r+") as f:
        pos = 0
        while pos < f.frames:
            f.seek(pos)
            data = f.read(min(block, f.frames - pos), dtype="float32", always_2d=True)
            f.seek(pos)
            f.write(data * gain)
            pos += data.shape[0]


def channels_differ(sf, np, path, block=48000 * 30, threshold_db=-40.0):
    """True when a stereo file's L and R differ (side energy above -40 dB of mid). Dual-mono -> False."""
    with sf.SoundFile(path) as f:
        if f.channels < 2:
            return False
        side = mid = 0.0
        while True:
            data = f.read(block, dtype="float32", always_2d=True)
            if not data.shape[0]:
                break
            l, r = data[:, 0].astype("float64"), data[:, 1].astype("float64")
            side += float(np.sum((l - r) ** 2))
            mid += float(np.sum(((l + r) / 2) ** 2))
    if mid <= 1e-12:
        return side > 1e-12
    return 10 * np.log10(max(side, 1e-20) / mid) > threshold_db


def process_file(sf, np, denoise, src_path, dst_path, sr, dry_mix=0.0, chunk_s=60.0, overlap_s=0.5, on_progress=None):
    """Chunked denoise of `src_path` into `dst_path` (float WAV). `denoise(mono_block) -> mono_block`.

    Returns (chunks, channels_out). Memory stays flat: one chunk (+ pre-roll/overlap) at a time.
    """
    from chunking import Stitcher, plan_chunks

    dry = max(0.0, min(0.3, float(dry_mix or 0.0)))
    split = channels_differ(sf, np, src_path)
    with sf.SoundFile(src_path) as src:
        if src.samplerate != sr:
            raise ValueError(f"expected {sr} Hz input, got {src.samplerate}")
        out_ch = min(2, src.channels) if split else 1
        chunks = plan_chunks(src.frames, sr, chunk_s=chunk_s, overlap_s=overlap_s)
        peak = 0.0
        with sf.SoundFile(dst_path, "w", samplerate=sr, channels=out_ch, subtype="FLOAT") as dst:
            stitch = Stitcher(dst.write)
            for c in chunks:
                src.seek(c["read_start"])
                block = src.read(c["read_end"] - c["read_start"], dtype="float32", always_2d=True)
                if split:
                    cols = [block[:, i] for i in range(out_ch)]
                else:
                    cols = [block.mean(axis=1) if block.shape[1] > 1 else block[:, 0]]
                outs = []
                for col in cols:
                    wet = denoise(col)
                    n = min(wet.shape[0], col.shape[0])
                    wet = wet[:n]
                    if dry > 0:
                        wet = (1.0 - dry) * wet + dry * col[:n]
                    outs.append(wet.astype("float32"))
                n = min(o.shape[0] for o in outs)
                processed = outs[0][:n] if out_ch == 1 else np.stack([o[:n] for o in outs], axis=1)
                if processed.size:
                    peak = max(peak, float(np.max(np.abs(processed))))
                stitch.add(c, processed)
                if on_progress:
                    on_progress(c["index"] + 1, len(chunks))
    if peak > 0.999:
        normalize_in_place(sf, np, dst_path, 0.999 / peak)
    return len(chunks), out_ch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=os.environ.get("AUDIO_DEVICE") or "cpu")
    args = parser.parse_args()

    import numpy as np
    import soundfile as sf
    import torch

    want, use_cuda, warning = pick_device(args.device, torch.cuda.is_available())
    if warning:
        print(f"[audio-worker] WARNING: {warning}", file=sys.stderr, flush=True)
    if not use_cuda:
        # DeepFilterNet picks its device from this env/config; force CPU when CUDA is absent or unwanted.
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    torch.set_num_threads(max(1, min(8, (os.cpu_count() or 4) // 2)))

    from df.enhance import enhance, init_df

    # Library logs go to stderr so stdout stays a clean JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        model, df_state, _ = init_df(log_level="ERROR", log_file=None)
    sr = df_state.sr()
    device = "cuda" if use_cuda else "cpu"
    emit({"type": "ready", "device": device, "sr": sr})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job_id = None
        try:
            job = json.loads(line)
            job_id = str(job["id"])
            started = time.time()
            limit = job.get("atten_lim_db")
            # Defence in depth (BUG-1340): never run without a cap, never deeper than 30 dB.
            limit = 18.0 if limit is None else max(0.0, min(30.0, float(limit)))
            chunk_s = float(job.get("chunk_seconds") or 60)
            overlap_s = float(job.get("overlap_seconds") or 0.5)
            dry_mix = float(job.get("dry_mix") or 0.0)

            def denoise(block):
                tensor = torch.from_numpy(np.ascontiguousarray(block)).unsqueeze(0)
                with torch.no_grad(), contextlib.redirect_stdout(sys.stderr):
                    out = enhance(model, df_state, tensor, atten_lim_db=limit)
                return out.squeeze(0).detach().cpu().numpy().astype("float32")

            n_chunks, out_ch = process_file(
                sf, np, denoise, job["input"], job["output"], sr, dry_mix=dry_mix, chunk_s=chunk_s, overlap_s=overlap_s,
                on_progress=lambda done, total: emit({"type": "progress", "id": job_id, "done": done, "total": total}),
            )
            emit({"type": "result", "id": job_id, "ok": True, "seconds": round(time.time() - started, 3), "chunks": n_chunks, "channels": out_ch})
        except Exception as exc:  # report and keep serving
            emit({"type": "result", "id": job_id or "", "ok": False, "error": str(exc)[:300]})


if __name__ == "__main__":
    main()
