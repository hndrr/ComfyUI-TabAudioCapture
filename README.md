# ComfyUI Tab/System Audio Capture

Capture playback audio from a Chrome/Chromium tab or the entire PC and output standard ComfyUI `AUDIO`. Tab capture also includes cross-origin iframes without accessing their DOM.

## Choose what to record

Both nodes use the same browser sharing dialog:

- **One tab:** select **Chrome Tab**, choose the source tab, and enable **Share tab audio**. The source can be the ComfyUI tab or another tab.
- **The entire PC:** select **Entire Screen** and enable **Share system audio**. This includes playback from other applications and notification sounds. The browser and OS must support system audio sharing; screen/audio recording permission may be required.

Only audio is sent to ComfyUI and saved. These nodes capture playback audio, not microphone input. Enable audio sharing each time you start; selecting a screen alone does not provide audio.

## Nodes

### Tab/System Audio Capture · Live

- Click `Start Capture` and share tab or system audio. Capture continues independently of workflow execution and retains the latest 120 seconds.
- Set `duration_seconds` (0.5–60 seconds), then click `Run`. The node snapshots the latest audio when you queue the workflow, so waiting for GPU execution does not change that snapshot.
- The native audio player supports playback and seeking after a snapshot or stop. The last captured buffer remains available after `Stop Capture`.
- Output: `audio` (`AUDIO`). The node does not automatically queue or repeat workflows.

### Tab/System Audio Capture · Stop & Save

- Set the save options before `Start Recording`, then share tab or system audio. `Stop & Save` saves the recording and updates the native audio player without running the workflow.
- `filename_prefix` selects a folder and filename inside `ComfyUI/output`. For example, `music/take` creates `output/music/take_00001.wav`. The default remains `tab_audio/tab_audio`.
- `format`: `original` preserves captured float32 PCM in WAV; `wav` writes 16/24/32-bit PCM (default: 24-bit); `m4a` writes AAC at 128/192/256/320 kbps (default: 256 kbps). The relevant depth or bitrate control appears under Advanced for the selected format.
- `Run` outputs `audio` (`AUDIO`) and `saved_file_path` (`STRING`). The path is absolute and connects directly to Video Helper Suite's **Load Audio (Path)** → `audio_file` input.
- Saved file references remain in workflows and work after restarting ComfyUI. Recordings stop after 10 minutes and preserve the AudioContext sample rate. Saved recordings are not automatically deleted.

## Example workflows

Drag a JSON file into ComfyUI. Choose the audio source when starting capture.

- [Record, save and inspect outputs](example/record_tab_audio.json): recorder → Preview Audio and saved path display.
- [Load the saved path](example/record_tab_audio_with_vhs.json): `saved_file_path` → Load Audio (Path) → Preview Audio. Requires Video Helper Suite.
- [Snapshot the latest audio](example/live_tab_audio.json): Live → Preview Audio.

The existing node IDs (`TabAudioCaptureLive`, `TabAudioCaptureRecorder`) and example filenames are unchanged so existing workflows remain compatible.

## Installation

1. Place this repository in `ComfyUI/custom_nodes/ComfyUI-TabAudioCapture`.
2. Restart ComfyUI and reload the browser.
3. Search for `Tab/System Audio Capture`, add either node, and connect its `audio` output to an audio input.
4. Start capture and share tab or system audio as described above.

No additional runtime dependencies are required beyond ComfyUI's `torch`, `numpy`, `aiohttp` and `av`.

## Notes

- Chrome/Chromium is the intended browser. Audio capture requires HTTPS or a localhost connection. Browser and OS support determines whether entire-PC audio is available.
- Tab capture mixes all playback within the selected tab; it cannot isolate one iframe. Protected playback or source restrictions may prevent capture.
- Audio passes through AudioWorklet → float32 PCM → WebSocket → ComfyUI. The native `AUDIO` value contains `waveform` shaped `[1, channels, samples]` and `sample_rate`.
- `AUDIO` sockets carry fixed snapshots or completed recordings, not a continuous stream that updates an already-running generation.
- Live snapshots use temporary disk files and do not survive a server restart. Snapshots older than 24 hours are cleaned up when starting a new session.
- Capture stops if pending WebSocket data exceeds 4 MiB. Network interruptions or closing the browser tab may interrupt recording. HTTPS reverse proxies must support WebSocket upgrades.
- Intended for a local ComfyUI installation and browser. Environments that restrict custom nodes may not support these nodes.

## Tests

Run in this node directory using a Python environment with ComfyUI's dependencies:

```bash
python -m pytest -q
node --test tests/test_ui.mjs
```

The tests cover audio formats, output paths, HTTP/WebSocket behavior, capture controls and player updates. Browser sharing dialogs are mocked; live browser recording must be verified separately. Install `pytest` only in your development environment if needed.
