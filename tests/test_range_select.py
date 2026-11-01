"""Native AUDIO selection and bounded waveform previews."""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest
import torch


spec = importlib.util.spec_from_file_location("tab_audio_range_select", Path(__file__).resolve().parents[1] / "range_select.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
AudioRangeSelect = module.AudioRangeSelect


def audio(samples=100, sample_rate=10, batch=1, channels=1, dtype=torch.float32):
    return {
        "waveform": torch.arange(batch * channels * samples, dtype=dtype).reshape(batch, channels, samples),
        "sample_rate": sample_rate,
    }


def test_legacy_contract():
    assert AudioRangeSelect.RETURN_TYPES == ("AUDIO",)
    assert AudioRangeSelect.RETURN_NAMES == ("audio",)
    assert AudioRangeSelect.FUNCTION == "run"
    assert AudioRangeSelect.OUTPUT_NODE is True
    required = AudioRangeSelect.INPUT_TYPES()["required"]
    assert list(required) == ["audio", "start_seconds", "end_seconds"]
    assert required["audio"] == ("AUDIO",)
    for name in ("start_seconds", "end_seconds"):
        assert required[name][0] == "FLOAT"
        assert required[name][1]["default"] == 0
        assert required[name][1]["min"] == 0


@pytest.mark.parametrize("start,end,first,last", [
    (0, 0, 0, 100),
    (2, 0, 20, 100),
    (2, 5, 20, 50),
    (2.09, 5.09, 20, 50),
    (0, 0.1, 0, 1),
    (9.9, 10, 99, 100),
    (9.9, 1000, 99, 100),
    (0, 1e308, 0, 100),
])
def test_half_open_sample_cuts(start, end, first, last):
    source = audio()
    output = AudioRangeSelect().run(source, start, end)
    torch.testing.assert_close(output["result"][0]["waveform"], source["waveform"][..., first:last], rtol=0, atol=0)
    assert output["result"][0]["sample_rate"] == source["sample_rate"]


def test_decimal_exact_boundaries_and_noninteger_duration():
    source = audio(samples=97, sample_rate=100)
    result = AudioRangeSelect().run(source, 0.29, 0.57)["result"][0]
    torch.testing.assert_close(result["waveform"], source["waveform"][..., 29:57], rtol=0, atol=0)
    tail = AudioRangeSelect().run(source, 0.96, 0)["result"][0]["waveform"]
    assert tail.flatten().tolist() == [96]


@pytest.mark.parametrize("dtype", [torch.float16, torch.float32, torch.float64, torch.bfloat16])
def test_stereo_batch_dtype_metadata_and_no_source_alias(dtype):
    source = audio(batch=3, channels=2, dtype=dtype)
    source["metadata"] = "kept"
    before = source["waveform"].clone()
    selected = AudioRangeSelect().run(source, 2, 5)["result"][0]
    assert selected is not source
    assert selected["waveform"].shape == (3, 2, 30)
    assert selected["waveform"].dtype == dtype
    assert selected["waveform"].device == source["waveform"].device
    assert selected["metadata"] == "kept"
    assert selected["sample_rate"] == source["sample_rate"]
    torch.testing.assert_close(selected["waveform"], before[..., 20:50], rtol=0, atol=0)
    selected["waveform"].zero_()
    torch.testing.assert_close(source["waveform"], before, rtol=0, atol=0)


def test_full_range_is_an_independent_tensor():
    source = audio()
    selected = AudioRangeSelect().run(source)["result"][0]["waveform"]
    selected.zero_()
    assert source["waveform"][..., -1].item() == 99


@pytest.mark.parametrize("start,end", [
    (-1, 0), (0, -1), (float("nan"), 0), (0, float("nan")),
    (float("inf"), 0), (0, float("inf")), (0, -float("inf")),
    (3, 2), (2, 2), (10, 0), (11, 100), (1e308, 0),
    (0.01, 0.09), (None, 1), ("bad", 1),
])
def test_invalid_nonfinite_and_sample_empty_bounds(start, end):
    with pytest.raises(ValueError, match="range|bounds"):
        AudioRangeSelect().run(audio(), start, end)


@pytest.mark.parametrize("shape", [(1, 1, 0), (0, 2, 10), (1, 0, 10), (2, 10)])
def test_reject_empty_or_non_native_shape(shape):
    with pytest.raises(ValueError, match="nonempty AUDIO"):
        AudioRangeSelect().run({"waveform": torch.zeros(shape), "sample_rate": 10})


@pytest.mark.parametrize("sample_rate", [0, -1, 10.5, float("nan"), True])
def test_reject_invalid_sample_rate(sample_rate):
    with pytest.raises(ValueError, match="sample rate"):
        AudioRangeSelect().run(audio(sample_rate=sample_rate))


def test_waveform_is_original_full_source_per_channel_first_batch():
    source = audio(samples=9, sample_rate=2, batch=2, channels=2)
    source["waveform"][0, 1] *= -1
    source["waveform"][1] = 1000
    output = AudioRangeSelect().run(source, 1, 2)
    preview = output["ui"]["range_waveform"][0]
    assert preview["sample_rate"] == 2
    assert preview["total_samples"] == 9
    assert preview["duration"] == 4.5
    for channel in range(2):
        expected = source["waveform"][0, channel].tolist()
        assert preview["minmax"][channel] == [[value, value] for value in expected]
    assert output["result"][0]["waveform"].shape == (2, 2, 2)
    json.dumps(output["ui"], allow_nan=False)


def test_preview_bins_cover_every_sample_including_uneven_tail():
    total = 12347
    source = audio(samples=total, sample_rate=44100, channels=2)
    values = torch.sin(torch.arange(total, dtype=torch.float32))
    source["waveform"][0, 0] = values
    source["waveform"][0, 1] = -2 * values
    source["waveform"][0, 0, -1] = -100
    preview = AudioRangeSelect().run(source)["ui"]["range_waveform"][0]
    offsets = np.arange(2049, dtype=np.int64) * total // 2048
    assert len(preview["minmax"]) == 2
    for channel, bins in enumerate(preview["minmax"]):
        assert len(bins) == 2048
        for index, (minimum, maximum) in enumerate(bins):
            chunk = source["waveform"][0, channel, offsets[index]:offsets[index + 1]]
            assert minimum == chunk.min().item()
            assert maximum == chunk.max().item()
    assert preview["minmax"][0][-1][0] == -100


def test_preview_does_not_require_grad_or_contiguous_source():
    waveform = torch.arange(48, dtype=torch.float64).reshape(2, 12, 2).transpose(1, 2).requires_grad_()
    source = {"waveform": waveform, "sample_rate": 4}
    result = AudioRangeSelect().run(source, 0.5, 1.5)
    assert result["result"][0]["waveform"].requires_grad
    torch.testing.assert_close(result["result"][0]["waveform"], waveform[..., 2:6], rtol=0, atol=0)
    assert len(result["ui"]["range_waveform"][0]["minmax"]) == 2


def test_nonfinite_preview_does_not_change_audio_samples():
    source = {"waveform": torch.tensor([[[float("nan"), float("inf"), -float("inf"), 0.5]]]), "sample_rate": 2}
    result = AudioRangeSelect().run(source)
    json.dumps(result["ui"], allow_nan=False)
    torch.testing.assert_close(result["result"][0]["waveform"], source["waveform"], equal_nan=True)
