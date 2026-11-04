"""Tests for the three new native-AUDIO nodes."""
import json
import numpy as np
import pytest
import torch

from tests.test_audio_capture import package  # reuse isolated mocked ComfyUI installation


def test_new_nodes_registered(package):
    mod, _, _ = package
    for name in ("TabAudioCaptureSmart", "TabAudioLoopCapture", "TabAudioFeatureExtractor"):
        assert name in mod.NODE_CLASS_MAPPINGS
    assert mod.SmartAudioCapture.RETURN_TYPES == ("AUDIO", "STRING")


def test_loop_exact_length_and_selection(package):
    mod, _, _ = package
    sr = 1000
    wave = torch.arange(10000, dtype=torch.float32).reshape(1, 1, 10000)
    audio, duration = mod.AudioLoopCapture().run(
        {"waveform": wave, "sample_rate": sr},
        bpm=120, bars=2, beats_per_bar=4, end_offset_seconds=1, crossfade_ms=0,
    )
    assert duration == 4.0
    torch.testing.assert_close(audio["waveform"], wave[..., 5000:9000])
    assert audio["waveform"].shape == (1, 1, 4000)
    assert audio["waveform"].data_ptr() != wave.data_ptr()


def test_loop_rejects_insufficient_audio_and_bad_settings(package):
    mod, _, _ = package
    audio = {"waveform": torch.zeros(1, 2, 1000), "sample_rate": 1000}
    with pytest.raises(ValueError, match="Insufficient"):
        mod.AudioLoopCapture().run(audio, 120, 4, 4)
    with pytest.raises(ValueError, match="Invalid"):
        mod.AudioLoopCapture().run(audio, float("nan"), 1, 1)


def test_loop_crossfade_preserves_length(package):
    mod, _, _ = package
    sample = torch.linspace(-1, 1, 10000).reshape(1, 1, -1)
    audio, _ = mod.AudioLoopCapture().run(
        {"waveform": sample, "sample_rate": 1000}, 120, 2, 4, 0, 10
    )
    assert audio["waveform"].shape[-1] == 4000
    assert bool(torch.isfinite(audio["waveform"]).all())


def test_features_silence_and_sine(package):
    mod, _, _ = package
    sr = 8000
    zeros = {"waveform": torch.zeros(1, 2, sr), "sample_rate": sr}
    output = mod.AudioFeatureExtractor().run(zeros, fps=20, treble_start_hz=3000)
    report = json.loads(output[0])
    assert len(report["batches"]) == 1
    assert len(report["batches"][0]) == 20
    assert output[1:] == (0.0, 0.0, 0.0, 0.0)
    x = np.sin(2 * np.pi * 100 * np.arange(sr) / sr).astype("float32")
    tone = {"waveform": torch.from_numpy(x).reshape(1, 1, -1), "sample_rate": sr}
    result = mod.AudioFeatureExtractor().run(tone, fps=20, treble_start_hz=3000)
    assert result[1] > 0
    assert result[2] > result[3]
    assert result[4] >= 0
    assert json.loads(result[0])["duration_seconds"] == 1.0


def test_features_bad_band(package):
    mod, _, _ = package
    with pytest.raises(ValueError, match="Frequency bands"):
        mod.AudioFeatureExtractor().run(
            {"waveform": torch.zeros(1, 1, 4000), "sample_rate": 8000},
            fps=30, bass_cutoff_hz=250, treble_start_hz=5000,
        )


def test_smart_persisted_take_and_path_validation(package):
    mod, _, _ = package
    import uuid
    session = mod.REGISTRY.start(str(uuid.uuid4()), "record", 8000, 1)
    pcm = np.zeros((8000, 1), dtype="<f4")
    session.append(pcm.tobytes())
    filename = session.stop()
    output, path = mod.SmartAudioCapture().run(filename)
    assert output["waveform"].shape == (1, 1, 8000)
    assert path.endswith(filename)
    with pytest.raises(ValueError):
        mod.SmartAudioCapture().run("../outside.wav")
