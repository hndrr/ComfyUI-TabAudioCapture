"""The meter accepts native AUDIO without copying or changing it."""

import importlib.util
from pathlib import Path

import pytest
import torch


spec = importlib.util.spec_from_file_location("tab_audio_meter", Path(__file__).resolve().parents[1] / "meter.py")
meter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(meter)


def test_meter_schema_has_only_native_audio():
    assert meter.AudioMeter.INPUT_TYPES() == {"required": {"audio": ("AUDIO",)}}
    assert meter.AudioMeter.RETURN_TYPES == ("AUDIO",)
    assert meter.AudioMeter.RETURN_NAMES == ("audio",)
    assert meter.AudioMeter.FUNCTION == "run"
    assert meter.AudioMeter.CATEGORY == "audio/Tab Audio Capture"


@pytest.mark.parametrize("batch,channels,rate", [(1, 1, 8000), (1, 2, 48000), (2, 2, 44100)])
def test_meter_preserves_audio_object_and_tensor_identity(batch, channels, rate):
    waveform = torch.linspace(-1, 1, batch * channels * 128).reshape(batch, channels, 128)
    original = waveform.clone()
    metadata = {"source": "capture"}
    audio = {"waveform": waveform, "sample_rate": rate, "metadata": metadata}

    result = getattr(meter.AudioMeter(), meter.AudioMeter.FUNCTION)(audio=audio)

    assert isinstance(result, tuple) and len(result) == 1
    assert result[0] is audio
    assert result[0]["waveform"] is waveform
    assert result[0]["metadata"] is metadata
    assert result[0]["sample_rate"] == rate
    assert set(audio) == {"waveform", "sample_rate", "metadata"}
    torch.testing.assert_close(waveform, original, rtol=0, atol=0)
