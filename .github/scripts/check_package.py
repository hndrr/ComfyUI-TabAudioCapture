"""Verify the ZIP produced by the same comfy-cli used for publishing."""

from pathlib import Path
import sys
import zipfile


def check_package(path):
    required = {
        "__init__.py", "sessions.py", "pyproject.toml", "requirements.txt", "LICENSE", "README.md",
        "web/tab_audio_capture.js", "web/worklets/tab_audio_worklet.mjs",
        "example/record_tab_audio.json", "example/record_tab_audio_with_vhs.json", "example/live_tab_audio.json",
        "docs/images/recorder.jpg", "docs/images/live.jpg",
    }
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
    missing = required - names
    development = {
        name for name in names
        if name.startswith((".github/", "tests/", ".git/", ".venv/", "__pycache__/"))
        or name in ("pytest.ini", "docs/MAINTAINING.md", "node.zip")
    }
    if missing or development:
        raise ValueError(f"Incorrect Registry archive: missing={sorted(missing)}, development={sorted(development)}")
    print(f"Registry archive verified: {len(names)} files, including both nodes' screenshots")


if __name__ == "__main__":
    check_package(Path(sys.argv[1]))
