"""Capture-session storage and WAV output for ComfyUI-TabAudioCapture.

The browser streams interleaved little-endian float32 PCM. Live capture retains
only a bounded ring; recording capture spools to disk to bound RAM usage.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from pathlib import Path
import os
import threading
import time
import uuid

import av
import numpy as np
import torch
import folder_paths

MAX_LIVE_SECONDS = 120
MAX_RECORD_SECONDS = 600
MAX_SNAPSHOT_SECONDS = 60
SNAPSHOT_TTL_SECONDS = 24 * 60 * 60
WAV_CODECS = {"16-bit PCM": "pcm_s16le", "24-bit PCM": "pcm_s24le", "32-bit PCM": "pcm_s32le"}
M4A_BITRATES = {"128k": 128000, "192k": 192000, "256k": 256000, "320k": 320000}


def _capture_temp_dir() -> Path:
    path = Path(folder_paths.get_temp_directory()) / "tab_audio_capture"
    path.mkdir(parents=True, exist_ok=True)
    return path


def recording_path(relative_file: str) -> Path:
    if not relative_file:
        raise ValueError("Record audio first and click Stop & Save")
    output = folder_paths.get_output_directory()
    path = Path(output) / relative_file
    if not folder_paths.is_within_directory(output, str(path)) or path.suffix not in (".wav", ".m4a"):
        raise ValueError("Invalid recording filename")
    return path


def normalize_id(value: str) -> str:
    try:
        normalized = str(uuid.UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("Invalid capture ID") from exc
    if str(value).lower() != normalized:
        raise ValueError("Invalid capture ID")
    return normalized


@dataclass(frozen=True)
class Snapshot:
    path: Path
    sample_rate: int
    channels: int
    created: float


class CaptureSession:
    def __init__(self, session_id: str, mode: str, sample_rate: int, channels: int, *,
                 filename_prefix="tab_audio/tab_audio", format="wav", wav_bit_depth="16-bit PCM", m4a_bitrate="256k"):
        self.session_id = normalize_id(session_id)
        if mode not in ("live", "record"):
            raise ValueError("Invalid mode")
        if not (8000 <= sample_rate <= 192000):
            raise ValueError("Unsupported sample rate")
        if channels not in (1, 2):
            raise ValueError("Only mono or stereo audio is supported")
        if format not in ("original", "wav", "m4a"):
            raise ValueError("Audio format must be original, wav, or m4a")
        if format == "wav" and wav_bit_depth not in WAV_CODECS:
            raise ValueError("Unsupported WAV bit depth")
        if format == "m4a" and m4a_bitrate not in M4A_BITRATES:
            raise ValueError("Unsupported M4A bitrate")
        output = folder_paths.get_output_directory()
        if not folder_paths.is_within_directory(output, os.path.join(output, filename_prefix)):
            raise ValueError("Invalid recording filename prefix")
        self.filename_prefix = filename_prefix
        self.format = format
        self.wav_bit_depth = wav_bit_depth
        self.m4a_bitrate = m4a_bitrate
        self.mode = mode
        self.sample_rate = sample_rate
        self.channels = channels
        self.created = time.time()
        self.last_activity = self.created
        self.lock = threading.RLock()
        self.active = True
        self.total_frames = 0
        self.ring: deque[np.ndarray] = deque()
        self.ring_frames = 0
        self.raw_path: Path | None = None
        self.raw_file = None
        self.saved_file: str | None = None
        if mode == "record":
            self.raw_path = _capture_temp_dir() / f"record_{session_id}.f32"
            self.raw_file = self.raw_path.open("wb")

    def append(self, pcm: bytes) -> None:
        if not pcm or len(pcm) > 1024 * 1024:
            raise ValueError("Invalid PCM chunk size")
        if len(pcm) % (4 * self.channels):
            raise ValueError("PCM chunk is not frame-aligned")
        samples = np.frombuffer(pcm, dtype="<f4")
        frame_count = len(samples) // self.channels
        with self.lock:
            if not self.active:
                raise ValueError("Capture is already stopped")
            if self.mode == "record":
                if self.total_frames + frame_count > self.sample_rate * MAX_RECORD_SECONDS:
                    raise ValueError(f"Recording limit reached ({MAX_RECORD_SECONDS} s)")
                assert self.raw_file is not None
                self.raw_file.write(pcm)
            else:
                self.ring.append(samples.reshape((-1, self.channels)).copy())
                self.ring_frames += frame_count
                max_frames = self.sample_rate * MAX_LIVE_SECONDS
                while self.ring_frames > max_frames and len(self.ring) > 1:
                    self.ring_frames -= len(self.ring.popleft())
            self.total_frames += frame_count
            self.last_activity = time.time()

    def latest(self, seconds: float) -> np.ndarray:
        if self.mode != "live":
            raise ValueError("Snapshots are only available for live sessions")
        if not (0.1 <= seconds <= MAX_SNAPSHOT_SECONDS):
            raise ValueError("Snapshot duration must be within 0.1–60 seconds")
        with self.lock:
            if self.ring_frames == 0:
                raise ValueError("No audio received yet. Play audio in the shared tab first")
            needed = min(round(seconds * self.sample_rate), self.ring_frames)
            parts = []
            for block in reversed(self.ring):
                if needed <= 0:
                    break
                take = min(len(block), needed)
                parts.append(block[-take:])
                needed -= take
            return np.concatenate(parts[::-1], axis=0)

    def stop(self) -> str | None:
        """Idempotently stop and save the selected format without buffering the recording."""
        with self.lock:
            if not self.active:
                return self.saved_file
            self.active = False
            self.last_activity = time.time()
            if self.mode == "live":
                return None

            assert self.raw_file is not None and self.raw_path is not None
            self.raw_file.flush()
            self.raw_file.close()
            self.raw_file = None
            if self.total_frames == 0:
                self.raw_path.unlink(missing_ok=True)
                return None

            folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                self.filename_prefix, folder_paths.get_output_directory())
            extension = "m4a" if self.format == "m4a" else "wav"
            name = f"{filename.replace('%batch_num%', '0')}_{counter:05}.{extension}"
            relative_file = (Path(subfolder) / name).as_posix()
            final_path = recording_path(relative_file)
            partial = Path(folder) / f".{name}.{self.session_id}.part"
            codec = "pcm_f32le" if self.format == "original" else WAV_CODECS[self.wav_bit_depth] if self.format == "wav" else "aac"
            layout = "mono" if self.channels == 1 else "stereo"
            try:
                with self.raw_path.open("rb") as source:
                    with av.open(str(partial), "w", format="ipod" if extension == "m4a" else "wav") as dest:
                        stream = dest.add_stream(codec, rate=self.sample_rate, layout=layout)
                        if self.format == "m4a":
                            stream.bit_rate = M4A_BITRATES[self.m4a_bitrate]
                        offset = 0
                        while chunk := source.read(4 * self.channels * 16384):
                            samples = np.frombuffer(chunk, dtype="<f4").reshape(1, -1)
                            if self.format != "original":
                                samples = np.clip(np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0), -1, 1)
                            frame = av.AudioFrame.from_ndarray(samples, format="flt", layout=layout)
                            frame.sample_rate = self.sample_rate
                            frame.pts = offset
                            offset += frame.samples
                            for packet in stream.encode(frame):
                                dest.mux(packet)
                        for packet in stream.encode(None):
                            dest.mux(packet)
                os.replace(partial, final_path)
                self.saved_file = relative_file
            finally:
                partial.unlink(missing_ok=True)
                self.raw_path.unlink(missing_ok=True)
            return self.saved_file


class SessionRegistry:
    def __init__(self):
        self.lock = threading.RLock()
        self.sessions: dict[str, CaptureSession] = {}
        self.snapshots: dict[str, Snapshot] = {}

    def start(self, session_id: str, mode: str, sample_rate: int, channels: int, **save_options) -> CaptureSession:
        session_id = normalize_id(session_id)
        with self.lock:
            self.prune()
            if session_id in self.sessions:
                raise ValueError("Capture ID is already in use; start a new recording")
            session = CaptureSession(session_id, mode, sample_rate, channels, **save_options)
            self.sessions[session_id] = session
            return session

    def get(self, session_id: str) -> CaptureSession:
        session_id = normalize_id(session_id)
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None:
                raise ValueError("Audio session not found (it may have expired or ComfyUI restarted)")
            return session

    def snapshot(self, session_id: str, seconds: float) -> str:
        session = self.get(session_id)
        pcm = session.latest(seconds)
        snapshot_id = str(uuid.uuid4())
        dest = _capture_temp_dir() / f"snapshot_{snapshot_id}.f32"
        np.asarray(pcm, dtype="<f4").tofile(str(dest))
        with self.lock:
            self.snapshots[snapshot_id] = Snapshot(dest, session.sample_rate, session.channels, time.time())
        return snapshot_id

    def load_snapshot(self, snapshot_id: str) -> dict:
        snapshot_id = normalize_id(snapshot_id)
        with self.lock:
            meta = self.snapshots.get(snapshot_id)
        if meta is None or not meta.path.is_file():
            raise ValueError("Live audio snapshot not found. Capture audio and queue the workflow again")
        frames = np.fromfile(meta.path, dtype="<f4")
        if not frames.size or frames.size % meta.channels:
            raise ValueError("Live audio snapshot is empty or corrupted")
        array = frames.reshape((-1, meta.channels)).T.copy()
        return {"waveform": torch.from_numpy(array).unsqueeze(0), "sample_rate": meta.sample_rate}

    def prune(self) -> None:
        """Called under registry lock; keep stopped sessions for a while."""
        now = time.time()
        for session_id, session in list(self.sessions.items()):
            if not session.active and now - session.last_activity > SNAPSHOT_TTL_SECONDS:
                del self.sessions[session_id]
        for sid, meta in list(self.snapshots.items()):
            if now - meta.created > SNAPSHOT_TTL_SECONDS:
                meta.path.unlink(missing_ok=True)
                del self.snapshots[sid]


REGISTRY = SessionRegistry()


def load_recorded_wav(relative_file: str) -> dict:
    path = recording_path(relative_file)
    if not path.is_file():
        raise ValueError("Audio file not found. Record and save again")
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        sample_rate = stream.codec_context.sample_rate
        channels = stream.codec_context.channels
        if channels not in (1, 2):
            raise ValueError("Only mono or stereo audio is supported")
        resampler = av.AudioResampler(format="fltp", layout=stream.layout, rate=sample_rate)
        parts = []
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                parts.append(converted.to_ndarray())
        for converted in resampler.resample(None):
            parts.append(converted.to_ndarray())
    waveform = torch.from_numpy(np.concatenate(parts, axis=1)).unsqueeze(0)
    return {"waveform": waveform, "sample_rate": sample_rate}
