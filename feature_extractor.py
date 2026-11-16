"""Lightweight frame-wise feature extraction for native ComfyUI AUDIO."""
from __future__ import annotations

import json
import math

import numpy as np
import torch


class AudioFeatureExtractor:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "fps": ("INT", {"default": 30, "min": 1, "max": 120}),
            "bass_cutoff_hz": ("FLOAT", {"default": 250.0, "min": 20.0, "max": 1000.0}),
            "treble_start_hz": ("FLOAT", {"default": 4000.0, "min": 500.0, "max": 16000.0}),
        }}

    RETURN_TYPES = ("STRING", "FLOAT", "FLOAT", "FLOAT", "FLOAT")
    RETURN_NAMES = ("features_json", "mean_rms", "mean_bass", "mean_treble", "max_onset")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "audio/Tab Audio Capture"
    DESCRIPTION = (
        "Analyze an AUDIO snapshot into a timestamped JSON envelope of RMS, "
        "bass energy, treble energy and spectral-flux onset (0..1), plus summary floats. "
        "This node does not run in real time or detect BPM."
    )

    def run(self, audio, fps=30, bass_cutoff_hz=250.0, treble_start_hz=4000.0):
        waveform = audio.get("waveform")
        sr = audio.get("sample_rate")
        if not isinstance(waveform, torch.Tensor) or waveform.ndim != 3 or not waveform.shape[-1]:
            raise ValueError("Audio Feature Extractor expects AUDIO waveform [batch, channels, samples]")
        if not isinstance(sr, int) or sr <= 0:
            raise ValueError("Invalid sample rate")
        if not 1 <= fps <= 120 or not math.isfinite(bass_cutoff_hz) or not math.isfinite(treble_start_hz):
            raise ValueError("Invalid feature settings")
        if bass_cutoff_hz <= 0 or treble_start_hz <= bass_cutoff_hz or treble_start_hz >= sr / 2:
            raise ValueError("Frequency bands must satisfy 0 < bass cutoff < treble start < Nyquist")

        # One envelope is emitted per batch item. Stereo is downmixed for consistent analysis.
        hop = max(1, round(sr / fps))
        n_fft = 1 << max(8, (hop * 2 - 1).bit_length())
        win = np.hanning(n_fft).astype(np.float32)
        freqs = np.fft.rfftfreq(n_fft, 1 / sr)
        bass_mask = freqs < bass_cutoff_hz
        treble_mask = freqs >= treble_start_hz
        batches = []
        for batch in waveform.detach().to("cpu", dtype=torch.float32):
            samples = batch.mean(dim=0).numpy()
            samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
            rows = []
            previous = None
            for start in range(0, len(samples), hop):
                block = samples[start:start + n_fft]
                if len(block) < n_fft:
                    block = np.pad(block, (0, n_fft - len(block)))
                rms = float(np.sqrt(np.mean(block * block)))
                spectrum = np.abs(np.fft.rfft(block * win))
                power = spectrum * spectrum
                total = max(float(np.sum(power)), 1e-12)
                bass = float(np.sqrt(np.sum(power[bass_mask]) / total))
                treble = float(np.sqrt(np.sum(power[treble_mask]) / total))
                if previous is None:
                    onset = 0.0
                else:
                    onset = float(np.maximum(spectrum - previous, 0).sum() /
                                  max(float(np.sum(spectrum)), 1e-12))
                previous = spectrum
                rows.append({
                    "time": round(start / sr, 6),
                    "rms": round(rms, 6),
                    "bass": round(bass, 6),
                    "treble": round(treble, 6),
                    "onset": round(min(onset, 1.0), 6),
                })
            batches.append(rows)
        flat = [r for b in batches for r in b]
        def mean(name):
            return float(np.mean([r[name] for r in flat])) if flat else 0.0
        payload = {
            "sample_rate": sr, "fps": fps, "duration_seconds": waveform.shape[-1] / sr,
            "bands_hz": {"bass_max": bass_cutoff_hz, "treble_min": treble_start_hz},
            "batches": batches,
        }
        means = {name: mean(name) for name in ("rms", "bass", "treble")}
        max_onset = max((r["onset"] for r in flat), default=0.0)
        first = batches[0]
        # Bound UI payload to 160 display points, regardless of source length/fps.
        n_bins = min(160, len(first))
        preview = []
        for i in range(n_bins):
            start = i * len(first) // n_bins
            end = (i + 1) * len(first) // n_bins
            region = first[start:end]
            preview.append({
                "time": region[0]["time"],
                "rms": round(sum(r["rms"] for r in region) / len(region), 5),
                "bass": round(sum(r["bass"] for r in region) / len(region), 5),
                "treble": round(sum(r["treble"] for r in region) / len(region), 5),
                "onset": max(r["onset"] for r in region),
            })
        return {
            "result": (json.dumps(payload, separators=(",", ":")),
                       means["rms"], means["bass"], means["treble"], max_onset),
            "ui": {"feature_preview": [{
                "samples": preview,
                "total_frames": len(first),
                "batch_count": len(batches),
                "duration_seconds": payload["duration_seconds"],
                "summary": {**means, "max_onset": max_onset},
                "head_json": json.dumps(first[:2], ensure_ascii=False),
            }]},
        }
