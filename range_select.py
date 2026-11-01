"""Select a sample range from native ComfyUI AUDIO without changing its samples."""

import math
from numbers import Integral

import numpy as np
import torch


def _range_waveform(waveform, sample_rate):
    total_samples = waveform.shape[-1]
    bins = min(2048, total_samples)
    # Equal, non-overlapping bins cover the full source, including its last sample.
    offsets = np.arange(bins, dtype=np.int64) * total_samples // bins
    source = waveform[0].detach().cpu()
    if source.dtype == torch.bfloat16:
        source = source.float()
    samples = source.numpy()
    minimum = np.minimum.reduceat(samples, offsets, axis=-1)
    maximum = np.maximum.reduceat(samples, offsets, axis=-1)
    minmax = np.stack((minimum, maximum), axis=-1)
    # Nonfinite samples remain untouched in AUDIO; only the JSON preview is sanitized.
    minmax = np.nan_to_num(minmax, nan=0.0, posinf=0.0, neginf=0.0)
    return {
        "minmax": minmax.tolist(),
        "sample_rate": int(sample_rate),
        "total_samples": total_samples,
        "duration": total_samples / sample_rate,
    }


class AudioRangeSelect:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "start_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.01}),
            "end_seconds": ("FLOAT", {
                "default": 0.0, "min": 0.0, "step": 0.01,
                "tooltip": "0 selects through the end of the source audio.",
            }),
        }}

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "run"
    CATEGORY = "audio/Tab Audio Capture"
    OUTPUT_NODE = True
    DESCRIPTION = "Select a range of AUDIO. Load Waveform previews the full source; drag to set start and end. End 0 means the source end."

    def run(self, audio, start_seconds=0.0, end_seconds=0.0):
        waveform = audio["waveform"]
        sample_rate = audio["sample_rate"]
        if not isinstance(waveform, torch.Tensor) or waveform.ndim != 3 or any(size == 0 for size in waveform.shape):
            raise ValueError("Audio Range Select requires nonempty AUDIO shaped [batch, channels, samples].")
        if isinstance(sample_rate, bool) or not isinstance(sample_rate, Integral) or sample_rate <= 0:
            raise ValueError("Audio Range Select requires a positive integer sample rate.")
        try:
            start_seconds, end_seconds = float(start_seconds), float(end_seconds)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("Audio range bounds must be finite, nonnegative seconds.") from exc
        if not all(math.isfinite(value) and value >= 0 for value in (start_seconds, end_seconds)):
            raise ValueError("Audio range bounds must be finite, nonnegative seconds.")

        total_samples = waveform.shape[-1]
        duration = total_samples / sample_rate
        end = duration if end_seconds == 0 else min(end_seconds, duration)
        if start_seconds >= end:
            raise ValueError("Audio range must start before its end within the source duration.")
        # Floor partial sample positions, correcting a single float ULP at exact boundaries.
        start_sample = int(math.nextafter(start_seconds * sample_rate, math.inf))
        end_sample = total_samples if end >= duration else int(math.nextafter(end * sample_rate, math.inf))
        if end_sample <= start_sample:
            raise ValueError("Audio range is empty at this sample rate; select at least one sample.")

        selected = {**audio, "waveform": waveform[..., start_sample:end_sample].clone()}
        return {
            "result": (selected,),
            "ui": {"range_waveform": [_range_waveform(waveform, sample_rate)]},
        }
