"""Beat-length loop extraction from any standard ComfyUI AUDIO snapshot."""
from __future__ import annotations

import math
import torch


class AudioLoopCapture:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "bpm": ("FLOAT", {"default": 120.0, "min": 20.0, "max": 300.0, "step": 0.1}),
            "bars": ("INT", {"default": 4, "min": 1, "max": 64}),
            "beats_per_bar": ("INT", {"default": 4, "min": 1, "max": 16}),
            "end_offset_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 120.0, "step": 0.01}),
            "crossfade_ms": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 1.0}),
        }}

    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("audio", "duration_seconds")
    FUNCTION = "run"
    CATEGORY = "audio/Tab Audio Capture"
    DESCRIPTION = (
        "Extract the last N bars from AUDIO using a supplied BPM. "
        "Connect Tab/System Audio Capture Live for rolling capture. "
        "Offset shifts the ending point backwards; BPM and phase are manual."
    )

    def run(self, audio, bpm, bars, beats_per_bar, end_offset_seconds=0.0, crossfade_ms=0.0):
        waveform = audio.get("waveform")
        sr = audio.get("sample_rate")
        if not isinstance(waveform, torch.Tensor) or waveform.ndim != 3 or not waveform.shape[-1]:
            raise ValueError("Audio Loop Capture expects AUDIO waveform [batch, channels, samples]")
        if not isinstance(sr, int) or sr <= 0:
            raise ValueError("Invalid audio sample rate")
        if not all(math.isfinite(float(v)) for v in (bpm, end_offset_seconds, crossfade_ms)):
            raise ValueError("Loop parameters must be finite")
        if bpm <= 0 or end_offset_seconds < 0 or crossfade_ms < 0 or bars < 1 or beats_per_bar < 1:
            raise ValueError("Invalid loop parameters")

        length = round(sr * 60.0 * int(bars) * int(beats_per_bar) / float(bpm))
        end = waveform.shape[-1] - round(float(end_offset_seconds) * sr)
        start = end - length
        if length < 2 or end > waveform.shape[-1] or start < 0 or end <= 0:
            raise ValueError("Insufficient captured audio for the specified bars, BPM and offset")

        result = waveform[..., start:end].clone()
        fade = min(round(sr * float(crossfade_ms) / 1000), length // 4)
        if fade > 0:
            # Blend the end with a matching portion of the beginning while preserving exact loop duration.
            # The first samples are unchanged, so adjacent loop copies meet more smoothly.
            weights = torch.linspace(0, 1, fade, device=result.device, dtype=result.dtype)
            result[..., -fade:] = (
                result[..., -fade:] * (1 - weights) +
                result[..., :fade].clone() * weights
            )
        return ({**audio, "waveform": result}, length / sr)
