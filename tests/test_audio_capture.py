"""Self-contained tests; run with `pytest -q` in this node directory."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import uuid
import wave

import av
import numpy as np
import pytest
from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer


@pytest.fixture(scope="module")
def package():
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory() as tmp:
        folder_paths = types.ModuleType("folder_paths")
        folder_paths.get_temp_directory = lambda: str(Path(tmp) / "temp")
        folder_paths.get_output_directory = lambda: str(Path(tmp) / "output")
        folder_paths.is_within_directory = lambda directory, target: Path(target).resolve().is_relative_to(Path(directory).resolve())
        def get_save_image_path(prefix, output_dir):
            path = Path(output_dir) / prefix
            if not folder_paths.is_within_directory(output_dir, path):
                raise ValueError("Invalid recording filename prefix")
            path.parent.mkdir(parents=True, exist_ok=True)
            counter = 1
            while list(path.parent.glob(f"{path.name}_{counter:05}.*")):
                counter += 1
            return str(path.parent), path.name, counter, os.path.relpath(path.parent, output_dir), prefix
        folder_paths.get_save_image_path = get_save_image_path
        old_folders = sys.modules.get("folder_paths")
        old_server = sys.modules.get("server")
        sys.modules["folder_paths"] = folder_paths
        fake_server = types.ModuleType("server")
        fake_server.PromptServer = type("PromptServer", (), {})
        fake_server.PromptServer.instance = types.SimpleNamespace(routes=web.RouteTableDef())
        sys.modules["server"] = fake_server
        spec = importlib.util.spec_from_file_location("test_tab_audio_pkg", root / "__init__.py", submodule_search_locations=[str(root)])
        module = importlib.util.module_from_spec(spec)
        sys.modules["test_tab_audio_pkg"] = module
        try:
            spec.loader.exec_module(module)
            yield module, fake_server.PromptServer.instance.routes, root
        finally:
            sys.modules.pop("test_tab_audio_pkg", None)
            sys.modules.pop("test_tab_audio_pkg.sessions", None)
            if old_folders is None: sys.modules.pop("folder_paths", None)
            else: sys.modules["folder_paths"] = old_folders
            if old_server is None: sys.modules.pop("server", None)
            else: sys.modules["server"] = old_server


def samples(nframes=2400, channels=2):
    t = np.arange(nframes, dtype=np.float32) / 48000
    left = np.sin(2 * np.pi * 440 * t).astype("<f4")
    if channels == 1: return left.reshape(-1, 1)
    return np.stack([left, -left], axis=1).astype("<f4")


def test_two_node_schemas(package):
    module, _, _ = package
    assert module.LiveTabAudio.RETURN_TYPES == ("AUDIO",)
    assert module.RecordedTabAudio.RETURN_TYPES == ("AUDIO", "STRING")
    assert module.RecordedTabAudio.RETURN_NAMES == ("audio", "saved_file_path")
    assert "duration_seconds" in module.LiveTabAudio.INPUT_TYPES()["required"]
    assert "recording_file" in module.RecordedTabAudio.INPUT_TYPES()["required"]


@pytest.mark.parametrize("filename", ["record_tab_audio.json", "record_tab_audio_with_vhs.json", "live_tab_audio.json"])
def test_example_workflow_connections_and_portable_values(package, filename):
    module, _, root = package
    workflow = json.loads((root / "example" / filename).read_text())
    nodes = {node["id"]: node for node in workflow["nodes"]}
    assert len(nodes) == len(workflow["nodes"])
    for link_id, source, output, target, input_, kind in workflow["links"]:
        assert nodes[source]["outputs"][output]["type"] == kind
        assert link_id in nodes[source]["outputs"][output]["links"]
        assert nodes[target]["inputs"][input_]["type"] in (kind, "*")
        assert nodes[target]["inputs"][input_]["link"] == link_id
    for node in workflow["nodes"]:
        if node["type"] in module.NODE_CLASS_MAPPINGS:
            schema = module.NODE_CLASS_MAPPINGS[node["type"]]
            names = list(schema.INPUT_TYPES()["required"]) + list(schema.INPUT_TYPES().get("optional", {}))
            assert dict(zip(names, node["widgets_values"])) == node["widgets_values_named"]
            for index, name in enumerate(schema.RETURN_NAMES):
                assert node["outputs"][index]["name"] == name
            internal = "snapshot_id" if node["type"] == "TabAudioCaptureLive" else "recording_file"
            assert node["widgets_values_named"][internal] == ""
        if node["type"] == "VHS_LoadAudio":
            link = next(link for link in workflow["links"] if link[0] == node["inputs"][0]["link"])
            assert nodes[link[1]]["outputs"][link[2]]["name"] == "saved_file_path"
            assert node["inputs"][0]["name"] == "audio_file"
            assert node["widgets_values"]["audiopreview"]["params"] == {"start_time": 0, "duration": 0}
            assert node["widgets_values_named"] == node["widgets_values"]


def test_live_ring_and_queue_snapshot(package):
    module, _, _ = package
    s = module.REGISTRY.start(str(uuid.uuid4()), "live", 48000, 2)
    pcm = samples(4800).tobytes()
    s.append(pcm)
    snap = module.REGISTRY.snapshot(s.session_id, 0.1)
    audio, = module.LiveTabAudio().run(0.1, snap)
    assert audio["waveform"].shape == (1, 2, 4800)
    assert audio["sample_rate"] == 48000
    np.testing.assert_allclose(audio["waveform"][0, 0].numpy(), samples(4800)[-4800:, 0])
    s.append(samples(4800).tobytes())
    # Snapshot is immutable, even after the incoming buffer changes.
    again, = module.LiveTabAudio().run(0.1, snap)
    np.testing.assert_allclose(audio["waveform"].numpy(), again["waveform"].numpy())
    s.stop()
    still = module.REGISTRY.snapshot(s.session_id, 0.1)
    assert module.LiveTabAudio().run(0.1, still)[0]["waveform"].shape == (1, 2, 4800)


def test_stop_save_and_reopen(package):
    module, _, _ = package
    s = module.REGISTRY.start(str(uuid.uuid4()), "record", 48000, 2)
    s.append(samples(4800).tobytes())
    path = s.stop()
    assert path.startswith("tab_audio/tab_audio_")
    assert s.stop() == path  # idempotent
    audio, output_name = module.RecordedTabAudio().run(path)
    assert output_name == str((Path(sys.modules["folder_paths"].get_output_directory()) / path).resolve())
    assert audio["sample_rate"] == 48000
    assert audio["waveform"].shape == (1, 2, 4800)
    np.testing.assert_allclose(audio["waveform"][0, 0].numpy(), samples(4800)[:, 0], atol=5e-5)
    with wave.open(str(Path(sys.modules["folder_paths"].get_output_directory()) / path), "rb") as wav:
        assert wav.getnchannels() == 2
        assert wav.getsampwidth() == 2
        assert wav.getnframes() == 4800


def test_rejected_paths_and_empty_recording(package):
    module, _, _ = package
    with pytest.raises(ValueError, match="Invalid recording"):
        module.RecordedTabAudio().run("tab_audio/../../secrets.wav")
    with pytest.raises(ValueError, match="Record audio first"):
        module.RecordedTabAudio().run("")
    s = module.REGISTRY.start(str(uuid.uuid4()), "record", 48000, 2)
    assert s.stop() is None


@pytest.mark.parametrize("format,depth,codec", [
    ("original", "24-bit PCM", "pcm_f32le"),
    ("wav", "16-bit PCM", "pcm_s16le"),
    ("wav", "24-bit PCM", "pcm_s24le"),
    ("wav", "32-bit PCM", "pcm_s32le"),
    ("m4a", "24-bit PCM", "aac"),
])
@pytest.mark.parametrize("channels", [1, 2])
def test_save_formats_and_directory(package, format, depth, codec, channels):
    module, _, _ = package
    session = module.REGISTRY.start(str(uuid.uuid4()), "record", 48000, channels,
        filename_prefix="music/takes/session", format=format, wav_bit_depth=depth, m4a_bitrate="192k")
    source = samples(48000, channels)
    session.append(source[:17000].tobytes())
    session.append(source[17000:].tobytes())
    relative = session.stop()
    assert relative.startswith("music/takes/session_")
    assert relative.endswith(".m4a" if format == "m4a" else ".wav")
    path = Path(sys.modules["folder_paths"].get_output_directory()) / relative
    with av.open(str(path)) as container:
        assert container.streams.audio[0].codec_context.name == codec
    audio, saved = module.RecordedTabAudio().run(relative)
    assert saved == str(path.resolve())
    assert Path(saved).is_absolute()
    assert Path(saved).is_file()
    assert audio["sample_rate"] == 48000
    assert audio["waveform"].shape[:2] == (1, channels)
    decoded = audio["waveform"][0].numpy().T
    if format == "original":
        np.testing.assert_array_equal(decoded, source)
    elif format == "wav":
        np.testing.assert_allclose(decoded, source, atol=4e-5)
    else:
        assert abs(len(decoded) - len(source)) < 1024
        assert np.corrcoef(decoded[:len(source), 0], source[:, 0])[0, 1] > 0.98


@pytest.mark.parametrize("options", [
    {"format": "../mp3"}, {"wav_bit_depth": "8-bit PCM"},
    {"format": "m4a", "m4a_bitrate": "999k"},
    {"filename_prefix": "../../escape"},
])
def test_rejected_save_options(package, options):
    module, _, _ = package
    with pytest.raises(ValueError):
        module.REGISTRY.start(str(uuid.uuid4()), "record", 48000, 2, **options)


def test_recording_symlink_cannot_escape_output(package, tmp_path):
    module, _, _ = package
    output = Path(sys.modules["folder_paths"].get_output_directory())
    link = output / "outside.wav"
    link.symlink_to(tmp_path / "outside.wav")
    with pytest.raises(ValueError, match="Invalid recording"):
        module.RecordedTabAudio().run("outside.wav")


def test_live_bounded_memory(package):
    module, _, _ = package
    s = module.REGISTRY.start(str(uuid.uuid4()), "live", 8000, 1)
    chunk = np.zeros((8000, 1), dtype="<f4").tobytes()
    for _ in range(122):
        s.append(chunk)
    assert s.ring_frames <= 120 * 8000
    assert s.latest(60).shape == (480000, 1)
    s.stop()


@pytest.mark.parametrize("format", ["original", "wav", "m4a"])
def test_ws_capture_snapshot_and_record_status(package, format):
    asyncio.run(check_ws_capture_snapshot_and_record_status(package, format))


async def check_ws_capture_snapshot_and_record_status(package, format):
    module, routes, _ = package
    aioapp = web.Application()
    aioapp.add_routes(routes)
    async with TestServer(aioapp) as server:
        async with TestClient(server) as client:
            origin = str(server.make_url("/")).rstrip("/")
            headers = {"Origin": origin}
            capture_id = str(uuid.uuid4())
            async with client.ws_connect("/tab_audio/ws", headers=headers) as ws:
                await ws.send_json({"command": "start", "session_id": capture_id, "mode": "live", "sample_rate": 48000, "channels": 2})
                started = await ws.receive_json(timeout=5)
                assert started["event"] == "started"
                await ws.send_bytes(samples(4800).tobytes())
                # WebSocket messages and HTTP snapshots run concurrently; a short
                # 'ping' delay allows the server loop to receive the PCM first.
                await asyncio.sleep(0.05)
                async with client.post("/tab_audio/snapshot", headers=headers, json={"session_id": capture_id, "seconds": 0.1}) as resp:
                    assert resp.status == 200
                    snap = (await resp.json())["snapshot_id"]
                assert module.LiveTabAudio().run(0.1, snap)[0]["waveform"].shape == (1, 2, 4800)
                async with client.get(f"/tab_audio/preview/{snap}") as resp:
                    assert resp.status == 200
                    assert resp.content_type == "audio/wav"
                    assert (await resp.read()).startswith(b"RIFF")
                await ws.send_json({"command": "stop"})
                assert (await ws.receive_json(timeout=5))["event"] == "stopped"

            record_id = str(uuid.uuid4())
            async with client.ws_connect("/tab_audio/ws", headers=headers) as ws:
                await ws.send_json({"command": "start", "session_id": record_id, "mode": "record", "sample_rate": 48000, "channels": 2,
                    "filename_prefix": "music/ws_record", "format": format, "wav_bit_depth": "24-bit PCM", "m4a_bitrate": "128k"})
                assert (await ws.receive_json(timeout=5))["event"] == "started"
                await ws.send_bytes(samples(4800).tobytes())
                await ws.send_json({"command": "stop"})
                result = await ws.receive_json(timeout=5)
                assert result["event"] == "stopped"
                assert result["saved_file"].startswith("music/ws_record_")
                assert result["saved_file"].endswith(".m4a" if format == "m4a" else ".wav")
            async with client.post("/tab_audio/status", headers=headers, json={"session_id": record_id}) as resp:
                assert resp.status == 200
                assert (await resp.json())["saved_file"] == result["saved_file"]
            module.REGISTRY.sessions.pop(record_id)
            audio, saved_file_path = module.RecordedTabAudio().run(result["saved_file"], format=format)
            assert saved_file_path == str((Path(sys.modules["folder_paths"].get_output_directory()) / result["saved_file"]).resolve())
            assert Path(saved_file_path).is_absolute()
            assert Path(saved_file_path).is_file()
            assert audio["sample_rate"] == 48000
            assert audio["waveform"].shape[:2] == (1, 2)
            decoded = audio["waveform"][0].numpy().T
            assert abs(len(decoded) - 4800) < 1024
            assert np.corrcoef(decoded[:4800, 0], samples(4800)[:, 0])[0, 1] > 0.98
            assert np.corrcoef(decoded[:4800, 1], samples(4800)[:, 1])[0, 1] > 0.98

            # Reject cross-site WS connection before upgrading.
            with pytest.raises(Exception):
                async with client.ws_connect("/tab_audio/ws", headers={"Origin": "https://evil.example"}):
                    pass
