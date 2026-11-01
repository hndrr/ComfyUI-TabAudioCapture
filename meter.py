"""Native AUDIO pass-through for the independent browser audio meter."""


class AudioMeter:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "run"
    CATEGORY = "audio/Tab Audio Capture"
    DESCRIPTION = "Monitor live left/right peak levels from a connected Tab/System Audio Capture node. AUDIO passes through unchanged."

    def run(self, audio):
        return (audio,)
