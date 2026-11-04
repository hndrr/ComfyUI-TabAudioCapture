"""ComfyUI AUDIO-output nodes for capturing tab and system playback audio."""

import asyncio
import io
import logging
import wave
from urllib.parse import urlsplit

import numpy as np
from aiohttp import WSMsgType, web
from server import PromptServer

from .sessions import M4A_BITRATES, REGISTRY, WAV_CODECS, load_recorded_wav, recording_path
from .meter import AudioMeter
from .range_select import AudioRangeSelect
from .smart_capture import SmartAudioCapture
from .loop_capture import AudioLoopCapture
from .feature_extractor import AudioFeatureExtractor

_LOG = logging.getLogger(__name__)


class LiveTabAudio:
    """Always stream in the browser; freeze the last N seconds on queue."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "duration_seconds": ("FLOAT", {"default": 10.0, "min": 0.5, "max": 60.0, "step": 0.5}),
            "snapshot_id": ("STRING", {"default": ""}),
        }, "optional": {
            "filename_prefix": ("STRING", {"default": "tab_audio/tab_audio", "tooltip": "Folder and filename prefix inside ComfyUI/output."}),
            "format": (["original", "wav", "m4a"], {"default": "wav"}),
            "wav_bit_depth": (list(WAV_CODECS), {"default": "24-bit PCM", "advanced": True}),
            "m4a_bitrate": (list(M4A_BITRATES), {"default": "256k", "advanced": True}),
        }}

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "run"
    CATEGORY = "audio/Tab Audio Capture"
    DESCRIPTION = "Capture playback audio from a Chrome tab or the entire PC. Choose Chrome Tab + Share tab audio, or Entire Screen + Share system audio. System audio requires browser/OS support. On Queue, snapshot the most recent N seconds as AUDIO."

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return float("nan")

    def run(self, duration_seconds, snapshot_id, **_save_options):
        if not snapshot_id:
            raise ValueError("Live Audio Capture: click Start Capture, share tab or system audio, then Queue Prompt")
        return (REGISTRY.load_snapshot(snapshot_id),)


class RecordedTabAudio:
    """Record until Stop & Save, then expose the saved recording as AUDIO."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "recording_file": ("STRING", {"default": ""}),
        }, "optional": {
            "filename_prefix": ("STRING", {"default": "tab_audio/tab_audio", "tooltip": "Folder and filename prefix inside ComfyUI/output, e.g. audio/session."}),
            "format": (["original", "wav", "m4a"], {"default": "wav", "tooltip": "Original preserves captured float32 PCM in WAV. WAV selects PCM depth; M4A uses AAC."}),
            "wav_bit_depth": (list(WAV_CODECS), {"default": "24-bit PCM", "advanced": True}),
            "m4a_bitrate": (list(M4A_BITRATES), {"default": "256k", "advanced": True}),
        }}

    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("audio", "saved_file_path")
    FUNCTION = "run"
    CATEGORY = "audio/Tab Audio Capture"
    DESCRIPTION = "Record playback audio from a Chrome tab or the entire PC until Stop & Save. Choose Chrome Tab + Share tab audio, or Entire Screen + Share system audio. System audio requires browser/OS support. Set the output folder and Original/WAV/M4A format before recording; preview the saved audio before Queue."

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return float("nan")

    def run(self, recording_file, **_save_options):
        audio = load_recorded_wav(recording_file)
        return (audio, str(recording_path(recording_file).resolve()))


NODE_CLASS_MAPPINGS = {
    "TabAudioCaptureRecorder": RecordedTabAudio,
    "TabAudioCaptureLive": LiveTabAudio,
    "TabAudioMeter": AudioMeter,
    "TabAudioRangeSelect": AudioRangeSelect,
    "TabAudioCaptureSmart": SmartAudioCapture,
    "TabAudioLoopCapture": AudioLoopCapture,
    "TabAudioFeatureExtractor": AudioFeatureExtractor,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "TabAudioCaptureRecorder": "Tab/System Audio Capture",
    "TabAudioCaptureLive": "Tab/System Audio Capture · Live",
    "TabAudioMeter": "Audio Meter",
    "TabAudioRangeSelect": "Audio Range Select",
    "TabAudioCaptureSmart": "Smart Audio Capture",
    "TabAudioLoopCapture": "Audio Loop Capture",
    "TabAudioFeatureExtractor": "Audio Feature Extractor",
}
WEB_DIRECTORY = "./web"


def _same_origin(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        # WebSocket calls from the UI's browser always contain Origin.
        return False
    try:
        host = urlsplit(origin).netloc.lower()
        return host == request.host.lower()
    except ValueError:
        return False


@PromptServer.instance.routes.get("/tab_audio/ws")
async def tab_audio_websocket(request: web.Request) -> web.StreamResponse:
    if not _same_origin(request):
        return web.json_response({"error": "Invalid WebSocket Origin"}, status=403)

    ws = web.WebSocketResponse(max_msg_size=1024 * 1024, heartbeat=20.0)
    await ws.prepare(request)
    session = None
    stopped = False
    try:
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                try:
                    payload = message.json()
                    command = payload.get("command")
                    if command == "start" and session is None:
                        session = REGISTRY.start(
                            str(payload.get("session_id", "")),
                            str(payload.get("mode", "")),
                            int(payload.get("sample_rate", 0)),
                            int(payload.get("channels", 0)),
                            filename_prefix=payload.get("filename_prefix", "tab_audio/tab_audio"),
                            format=payload.get("format", "wav"),
                            wav_bit_depth=payload.get("wav_bit_depth", "16-bit PCM"),
                            m4a_bitrate=payload.get("m4a_bitrate", "256k"),
                        )
                        await ws.send_json({"event": "started", "session_id": session.session_id})
                    elif command == "stop" and session is not None:
                        result = await asyncio.to_thread(session.stop)
                        stopped = True
                        await ws.send_json({"event": "stopped", "saved_file": result})
                        await ws.close()
                        break
                    elif command == "snapshot" and session is not None:
                        try:
                            snapshot_id = await asyncio.to_thread(REGISTRY.snapshot, session.session_id, float(payload.get("seconds", 10.0)))
                            await ws.send_json({"event": "snapshot", "snapshot_id": snapshot_id})
                        except (ValueError, TypeError) as exc:
                            await ws.send_json({"event": "snapshot_error", "message": str(exc)})
                    else:
                        raise ValueError("Invalid command or capture state")
                except (ValueError, TypeError, KeyError) as exc:
                    await ws.send_json({"event": "error", "message": str(exc)})
                    break
            elif message.type == WSMsgType.BINARY:
                if session is None:
                    await ws.send_json({"event": "error", "message": "Start capture before sending PCM"})
                    break
                try:
                    session.append(message.data)
                except ValueError as exc:
                    await ws.send_json({"event": "error", "message": str(exc)})
                    break
            elif message.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    except Exception:
        _LOG.exception("Tab Audio Capture WebSocket failed")
    finally:
        if session is not None and not stopped:
            try:
                # Finalize recordings when sharing is interrupted.
                await asyncio.to_thread(session.stop)
            except Exception:
                _LOG.exception("Could not finalize an interrupted tab audio recording")
        if not ws.closed:
            await ws.close()
    return ws


@PromptServer.instance.routes.post("/tab_audio/snapshot")
async def tab_audio_snapshot(request: web.Request) -> web.Response:
    if not _same_origin(request):
        return web.json_response({"error": "Invalid request Origin"}, status=403)
    try:
        body = await request.json()
        session_id = body.get("session_id")
        seconds = float(body.get("seconds", 10.0))
        snapshot_id = await asyncio.to_thread(REGISTRY.snapshot, session_id, seconds)
        return web.json_response({"snapshot_id": snapshot_id})
    except (ValueError, TypeError, KeyError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/tab_audio/status")
async def tab_audio_status(request: web.Request) -> web.Response:
    if not _same_origin(request):
        return web.json_response({"error": "Invalid request Origin"}, status=403)
    try:
        body = await request.json()
        session = REGISTRY.get(body.get("session_id"))
        if session.mode != "record":
            raise ValueError("Not a recording session")
        return web.json_response({"saved_file": session.saved_file, "active": session.active})
    except (ValueError, TypeError, KeyError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/tab_audio/save_snapshot")
async def tab_audio_save_snapshot(request: web.Request) -> web.Response:
    if not _same_origin(request):
        return web.json_response({"error": "Invalid request Origin"}, status=403)
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object")
        saved_file = await asyncio.to_thread(
            REGISTRY.save_snapshot,
            body.get("snapshot_id"),
            filename_prefix=body.get("filename_prefix", "tab_audio/tab_audio"),
            format=body.get("format", "wav"),
            wav_bit_depth=body.get("wav_bit_depth", "24-bit PCM"),
            m4a_bitrate=body.get("m4a_bitrate", "256k"),
        )
        return web.json_response({"saved_file": saved_file})
    except (ValueError, TypeError, KeyError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


def _snapshot_wav(snapshot_id):
    audio = REGISTRY.load_snapshot(snapshot_id)
    samples = audio["waveform"][0].numpy().T
    pcm = (np.clip(np.nan_to_num(samples), -1, 1) * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(samples.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(audio["sample_rate"])
        handle.writeframes(pcm.tobytes())
    return output.getvalue()


@PromptServer.instance.routes.get("/tab_audio/preview/{snapshot_id}")
async def tab_audio_preview(request: web.Request) -> web.Response:
    try:
        data = await asyncio.to_thread(_snapshot_wav, request.match_info["snapshot_id"])
        return web.Response(body=data, content_type="audio/wav")
    except (ValueError, KeyError) as exc:
        return web.json_response({"error": str(exc)}, status=404)


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
