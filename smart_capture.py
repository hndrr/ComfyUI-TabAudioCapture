"""Smart capture: select a persisted take recorded by the browser event detector."""
from .sessions import load_recorded_wav, recording_path


class SmartAudioCapture:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "recording_file": ("STRING", {"default": ""}),
            "take_history": ("STRING", {"default": "[]"}),
            "threshold_db": ("FLOAT", {"default": -35.0, "min": -80.0, "max": -5.0, "step": 1.0}),
            "silence_seconds": ("FLOAT", {"default": 1.5, "min": 0.3, "max": 8.0, "step": 0.1}),
            "pre_roll_seconds": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1}),
            "min_sound_seconds": ("FLOAT", {"default": 0.5, "min": 0.1, "max": 10.0, "step": 0.1}),
            "filename_prefix": ("STRING", {"default": "tab_audio/smart_take"}),
        }}

    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("audio", "saved_file_path")
    FUNCTION = "run"
    CATEGORY = "audio/Tab Audio Capture"
    DESCRIPTION = "Automatically save playback takes when sound ends; select a saved take for AUDIO output."

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return float("nan")

    def run(self, recording_file, **_kwargs):
        audio = load_recorded_wav(recording_file)
        return (audio, str(recording_path(recording_file).resolve()))
