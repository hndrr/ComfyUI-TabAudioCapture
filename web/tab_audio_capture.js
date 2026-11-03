/* global window, document, navigator, AudioContext, AudioWorkletNode, MediaStream, WebSocket */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LIVE_TYPE = "TabAudioCaptureLive";
const RECORDER_TYPE = "TabAudioCaptureRecorder";
const WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const AUDIO_WORKLET_URL = new URL("./worklets/tab_audio_worklet.mjs", import.meta.url).href;

/** @param {string} route @returns {URL} */
function apiUrl(route) {
  return new URL(api.apiURL(route), window.location.href);
}

/** @param {Response} response */
async function parseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/** @param {unknown} error */
function asMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {any} node @param {string} name */
function widget(node, name) {
  return node.widgets?.find((item) => item.name === name);
}

/** @param {any} node @param {string} name */
function hideInputWidget(node, name) {
  const target = widget(node, name);
  if (!target) return;
  // Keep prompt serialization enabled, but hide the internal UUID/filename field.
  target.computeSize = () => [0, -4];
  target.draw = () => {};
  target.hidden = true;
  target.options ??= {};
  target.options.hidden = true;
}

function applyFormatUI(node) {
  const format = widget(node, "format")?.value ?? "wav";
  for (const [name, visible] of [["wav_bit_depth", format === "wav"], ["m4a_bitrate", format === "m4a"]]) {
    const target = widget(node, name);
    if (!target) continue;
    target.__tabAudioLayout ??= { computeSize: target.computeSize, draw: target.draw };
    target.hidden = !visible;
    target.options ??= {};
    target.options.hidden = !visible;
    target.computeSize = visible ? target.__tabAudioLayout.computeSize : () => [0, -4];
    target.draw = visible ? target.__tabAudioLayout.draw : () => {};
  }
  node.widgets = [...node.widgets];
  const size = node.computeSize();
  node.setSize([Math.max(node.size[0], 360), size[1]]);
  node.setDirtyCanvas?.(true, true);
}

function updateButton(state) {
  const label = state.stopping ? "Saving…" : state.active
    ? state.mode === "record" ? "Stop & Save" : "Stop Capture"
    : state.busy ? "Cancel" : state.mode === "record" ? "Start Recording" : "Start Capture";
  state.button.label = label;
  if (state.pauseButton) {
    state.pauseButton.label = state.pauseChanging ? "Please wait…" : state.paused ? "Resume Recording" : "Pause Recording";
    state.pauseButton.disabled = !state.active || state.stopping || state.pauseChanging;
  }
  if (state.saveButton) {
    state.saveButton.label = state.saving ? "Saving Latest Audio…" : "Save Latest Audio";
    state.saveButton.disabled = !state.sessionId || state.busy || state.stopping || state.saving;
  }
}

function previewRecording(state, relativeFile) {
  state.player.pause();
  if (relativeFile) {
    const parts = relativeFile.split("/");
    const params = new URLSearchParams({ filename: parts.pop(), subfolder: parts.join("/"), type: "output" });
    state.player.src = apiUrl(`/view?${params}`).href;
  } else {
    state.player.removeAttribute("src");
  }
  state.player.load();
}

async function snapshot(state) {
  const seconds = Number(widget(state.node, "duration_seconds")?.value ?? 10);
  const response = await api.fetchApi("/tab_audio/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: state.sessionId, seconds }),
  });
  const data = await parseJson(response);
  state.player.pause();
  state.player.src = apiUrl(`/tab_audio/preview/${data.snapshot_id}`).href;
  state.player.load();
  return data.snapshot_id;
}

/** @param {any} state @param {string} message */
function setStatus(state, message) {
  if (!state.statusWidget) return;
  state.statusWidget.textContent = message;
  state.statusWidget.hidden = !message;
  updateButton(state);
  const size = state.node.computeSize();
  state.node.setSize([state.node.size[0], size[1]]);
  state.node.setDirtyCanvas?.(true, true);
}

/** @param {any} state @param {string} message */
function fail(state, message) {
  const logMessage = String(message).replace(/[\r\n\u2028\u2029]/g, " ");
  console.error("[Tab Audio Capture]", logMessage);
  setStatus(state, `Error: ${message}`);
}

/** @param {any} state */
function startClock(state) {
  if (state.clock) window.clearInterval(state.clock);
  state.startedAt = Date.now();
  state.clock = window.setInterval(() => {
    if (state.active && !state.stopping) {
      setStatus(state, captureStatus(state));
    }
  }, 1000);
}

function captureStatus(state) {
  const seconds = Math.floor(state.mode === "record"
    ? state.recordedFrames / (state.context?.sampleRate || 48000)
    : (Date.now() - state.startedAt) / 1000);
  const saved = state.mode === "live" && state.lastSavedFile ? ` · Saved: ${state.lastSavedFile}` : "";
  return `${state.paused ? "Paused" : "Capturing"} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${saved}`;
}

async function togglePause(state) {
  if (!state.active || state.stopping || state.pauseChanging || state.mode !== "record") return;
  const paused = !state.paused;
  state.pauseChanging = true;
  updateButton(state);
  let timer;
  try {
    await new Promise((resolve, reject) => {
      state.pausePending = { resolve, reject, type: paused ? "paused" : "resumed" };
      timer = window.setTimeout(() => reject(new Error("Recording pause timed out")), 3000);
      state.processor.port.postMessage({ type: paused ? "pause" : "resume" });
    });
    if (state.active && !state.stopping) {
      state.paused = paused;
      setStatus(state, captureStatus(state));
    }
  } catch (error) {
    if (state.active && !state.stopping) fail(state, asMessage(error));
  } finally {
    window.clearTimeout(timer);
    state.pausePending = null;
    state.pauseChanging = false;
    updateButton(state);
  }
}

async function saveLatest(state) {
  if (!state.sessionId || state.busy || state.stopping || state.saving) return;
  const options = {
    filename_prefix: widget(state.node, "filename_prefix")?.value ?? "tab_audio/tab_audio",
    format: widget(state.node, "format")?.value ?? "wav",
    wav_bit_depth: widget(state.node, "wav_bit_depth")?.value ?? "24-bit PCM",
    m4a_bitrate: widget(state.node, "m4a_bitrate")?.value ?? "256k",
  };
  state.saving = true;
  updateButton(state);
  let timer;
  try {
    let snapshotId;
    if (state.active) {
      await flushWorklet(state);
      snapshotId = await new Promise((resolve, reject) => {
        state.snapshotPending = { resolve, reject };
        timer = window.setTimeout(() => reject(new Error("Live snapshot timed out")), 5000);
        if (state.socket?.readyState !== WebSocket.OPEN) {
          reject(new Error("Capture connection has already closed"));
          return;
        }
        state.socket.send(JSON.stringify({ command: "snapshot", seconds: Number(widget(state.node, "duration_seconds")?.value ?? 10) }));
      });
    } else {
      snapshotId = await snapshot(state);
    }
    window.clearTimeout(timer);
    state.snapshotPending = null;
    const response = await api.fetchApi("/tab_audio/save_snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot_id: snapshotId, ...options }),
    });
    const result = await parseJson(response);
    if (!result.saved_file) throw new Error("No audio saved");
    state.lastSavedFile = result.saved_file;
    previewRecording(state, result.saved_file);
    setStatus(state, state.active ? captureStatus(state) : `Saved: ${result.saved_file}`);
  } catch (error) {
    fail(state, `Could not save latest audio: ${asMessage(error)}`);
  } finally {
    window.clearTimeout(timer);
    state.snapshotPending = null;
    state.saving = false;
    updateButton(state);
  }
}

/** @param {any} state */
async function cleanup(state) {
  if (state.clock) window.clearInterval(state.clock);
  state.clock = null;
  state.active = false;
  state.paused = false;
  state.pausePending?.reject(new Error("Capture ended"));
  state.snapshotPending?.reject(new Error("Capture ended"));
  const stream = state.stream;
  const context = state.context;
  const socket = state.socket;
  state.stream = null;
  state.context = null;
  state.socket = null;

  try { state.processor?.disconnect(); } catch { /* already disconnected */ }
  try { state.source?.disconnect(); } catch { /* already disconnected */ }
  try { state.silentGain?.disconnect(); } catch { /* already disconnected */ }
  state.processor = null;
  state.source = null;
  state.silentGain = null;
  if (stream) for (const track of stream.getTracks()) track.stop();
  if (context && context.state !== "closed") {
    await context.close().catch(() => {});
  }
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
}

/** @param {any} state */
async function recoverSavedRecording(state) {
  if (state.mode !== "record" || !state.sessionId) return;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await api.fetchApi("/tab_audio/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: state.sessionId }),
      });
      const data = await parseJson(response);
      if (data.saved_file) {
        widget(state.node, "recording_file").value = data.saved_file;
        previewRecording(state, data.saved_file);
        setStatus(state, `Saved: ${data.saved_file}`);
        return;
      }
      if (!data.active) {
        setStatus(state, "No audio recorded");
        return;
      }
    } catch (error) {
      if (attempt === 11) {
        fail(state, `Could not recover recording: ${asMessage(error)}`);
        return;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  }
  fail(state, "Save timed out; check the output folder");
}

/** @param {any} state */
async function onDisconnected(state) {
  if (!state.socket || state.stopping) return;
  await cleanup(state);
  if (state.mode === "record") await recoverSavedRecording(state);
  else setStatus(state, "Capture ended (last buffer retained)");
}

/** @param {any} state */
async function startCapture(state) {
  if (state.busy || state.active || state.stopping || state.saving) return;
  state.busy = true;
  state.recordedFrames = 0;
  state.paused = false;
  state.lastSavedFile = "";
  state.cancelRequested = false;
  state.sessionId = crypto.randomUUID();
  if (state.mode === "record") {
    const fileWidget = widget(state.node, "recording_file");
    if (fileWidget) fileWidget.value = "";
    previewRecording(state, "");
  }
  state.player.pause();
  setStatus(state, "Choose Chrome Tab + tab audio, or Entire Screen + system audio…");

  // getDisplayMedia must be called from the button's user gesture.
  let capturePromise;
  try {
    if (!window.isSecureContext) throw new Error("HTTPS or localhost is required for screen capture");
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Audio capture is not supported in this browser");
    capturePromise = navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: { suppressLocalAudioPlayback: false },
      selfBrowserSurface: "include",
      systemAudio: "include",
    });
  } catch (error) {
    state.busy = false;
    fail(state, asMessage(error));
    return;
  }

  try {
    state.stream = await capturePromise;
    if (state.cancelRequested) {
      await cleanup(state);
      state.busy = false;
      setStatus(state, "Idle (capture cancelled)");
      return;
    }
    const tracks = state.stream.getAudioTracks();
    if (!tracks.length) {
      throw new Error("No audio track. Enable Share tab audio for Chrome Tab, or Share system audio for Entire Screen (requires browser/OS support).");
    }

    const audioOnly = new MediaStream(tracks);
    state.context = new AudioContext({ latencyHint: "interactive" });
    await state.context.audioWorklet.addModule(AUDIO_WORKLET_URL);
    state.source = state.context.createMediaStreamSource(audioOnly);
    state.processor = new AudioWorkletNode(state.context, "tab-audio-pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    state.silentGain = state.context.createGain();
    state.silentGain.gain.value = 0;

    const url = apiUrl("/tab_audio/ws");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url.href);
    state.socket = socket;

    let startResolve;
    let startReject;
    let stopResolve;
    let stopReject;
    const started = new Promise((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });
    state.waitForStopped = () => new Promise((resolve, reject) => {
      stopResolve = resolve;
      stopReject = reject;
    });

    socket.addEventListener("message", (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.event === "started") startResolve(packet);
        if (packet.event === "stopped") stopResolve?.(packet);
        if (packet.event === "snapshot") state.snapshotPending?.resolve(packet.snapshot_id);
        if (packet.event === "snapshot_error") state.snapshotPending?.reject(new Error(packet.message));
        if (packet.event === "error") {
          startReject(new Error(packet.message));
          stopReject?.(new Error(packet.message));
          state.snapshotPending?.reject(new Error(packet.message));
          fail(state, packet.message);
        }
      } catch (error) {
        fail(state, `Bad server response: ${asMessage(error)}`);
      }
    });
    socket.addEventListener("error", () => {
      startReject(new Error("WebSocket connection failed"));
      stopReject?.(new Error("WebSocket connection failed"));
      state.snapshotPending?.reject(new Error("WebSocket connection failed"));
    });
    socket.addEventListener("close", () => {
      startReject(new Error("WebSocket disconnected"));
      stopReject?.(new Error("WebSocket disconnected before save was confirmed"));
      state.snapshotPending?.reject(new Error("WebSocket disconnected"));
      void onDisconnected(state);
    });

    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
      socket.addEventListener("close", () => reject(new Error("WebSocket closed before capture started")), { once: true });
    });
    socket.send(JSON.stringify({
      command: "start",
      mode: state.mode,
      session_id: state.sessionId,
      sample_rate: state.context.sampleRate,
      channels: 2,
      ...(state.mode === "record" ? {
        filename_prefix: widget(state.node, "filename_prefix")?.value ?? "tab_audio/tab_audio",
        format: widget(state.node, "format")?.value ?? "wav",
        wav_bit_depth: widget(state.node, "wav_bit_depth")?.value ?? "24-bit PCM",
        m4a_bitrate: widget(state.node, "m4a_bitrate")?.value ?? "256k",
      } : {}),
    }));
    await started;

    state.processor.port.onmessage = (event) => {
      if (state.pausePending && event.data?.type === state.pausePending.type) {
        state.pausePending.resolve();
        return;
      }
      if (event.data?.type === "flushed") {
        state.flushResolve?.();
        return;
      }
      if (event.data?.type !== "chunk") return;
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
        fail(state, "Network is too slow: audio buffer exceeded 4 MiB");
        void stopCapture(state);
        return;
      }
      socket.send(event.data.buffer);
      if (state.mode === "record") state.recordedFrames += event.data.buffer.byteLength / 8;
    };

    state.source.connect(state.processor);
    state.processor.connect(state.silentGain);
    state.silentGain.connect(state.context.destination);
    await state.context.resume();
    if (state.context.state !== "running") throw new Error("AudioContext is not running");

    for (const track of state.stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (!state.stopping) void stopCapture(state);
      }, { once: true });
    }
    state.active = true;
    state.busy = false;
    startClock(state);
    setStatus(state, "Capturing 0:00");
  } catch (error) {
    await cleanup(state);
    state.busy = false;
    fail(state, asMessage(error));
  }
}

/** @param {any} state */
async function flushWorklet(state) {
  if (!state.processor || !state.context || state.context.state === "closed") return;
  const flushed = new Promise((resolve) => {
    state.flushResolve = resolve;
    window.setTimeout(resolve, 800);
  });
  state.processor.port.postMessage({ type: "flush" });
  await flushed;
  state.flushResolve = null;
}

/** @param {any} state */
async function stopCapture(state) {
  if (state.stopping || (!state.active && !state.busy)) return;
  if (state.busy && !state.active) {
    state.cancelRequested = true;
    setStatus(state, "Cancelling capture…");
    return;
  }
  state.stopping = true;
  setStatus(state, state.mode === "record" ? "Saving…" : "Stopping capture…");
  try {
    await flushWorklet(state);
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Capture connection has already closed");
    }
    const waitForStopped = state.waitForStopped();
    socket.send(JSON.stringify({ command: "stop" }));
    const result = await waitForStopped;
    await cleanup(state);
    if (state.mode === "record") {
      if (!result.saved_file) throw new Error("No audio recorded");
      widget(state.node, "recording_file").value = result.saved_file;
      previewRecording(state, result.saved_file);
      setStatus(state, `Saved: ${result.saved_file}`);
    } else {
      await snapshot(state);
      setStatus(state, "Stopped (last buffer available for Queue)");
    }
  } catch (error) {
    fail(state, asMessage(error));
    await cleanup(state);
    await recoverSavedRecording(state);
  } finally {
    state.stopping = false;
    state.busy = false;
    updateButton(state);
  }
}

/** @param {any} node @param {"live"|"record"} mode */
function installNodeUI(node, mode) {
  if (node.__tabAudioState) return;
  const state = {
    node, mode, stream: null, context: null, processor: null, source: null,
    silentGain: null, socket: null, sessionId: null, active: false,
    busy: false, stopping: false, cancelRequested: false, clock: null, statusWidget: null,
    waitForStopped: null, flushResolve: null, startedAt: 0, button: null, player: null,
    paused: false, pauseChanging: false, pausePending: null, pauseButton: null, recordedFrames: 0,
    saving: false, snapshotPending: null, saveButton: null, lastSavedFile: "",
  };
  node.__tabAudioState = state;

  const internalName = mode === "live" ? "snapshot_id" : "recording_file";
  hideInputWidget(node, internalName);

  if (mode === "live") {
    const input = widget(node, "snapshot_id");
    if (input) {
      // Called and awaited by graphToPrompt. This locks the audio when Queue is clicked,
      // independently of how long the GPU execution queue takes.
      input.serializeValue = async () => {
        if (!state.sessionId) return "";
        try {
          return await snapshot(state);
        } catch (error) {
          fail(state, `Snapshot failed: ${asMessage(error)}`);
          return "";
        }
      };
    }
  }

  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:100%;";
  const player = document.createElement("audio");
  player.controls = true;
  player.style.width = "100%";
  player.classList.add("comfy-audio");
  player.setAttribute("name", "media");
  player.preload = "metadata";
  container.append(player);
  state.player = player;
  const status = document.createElement("div");
  status.style.cssText = "font:11px sans-serif;color:var(--descrip-text,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;";
  status.hidden = true;
  container.append(status);
  state.statusWidget = status;
  const audioUI = node.addDOMWidget("capture_audio", "audioUI", container, { serialize: false });
  audioUI.serialize = false;
  audioUI.computeSize = () => [0, status.hidden ? 54 : 72];
  const startButton = node.addWidget(
    "button", mode === "live" ? "Start Capture" : "Start Recording", null,
    () => { void (state.active || state.busy ? stopCapture(state) : startCapture(state)); }, { serialize: false }
  );
  startButton.serialize = false;
  startButton.type = "audiorecord";
  startButton.label = startButton.name;
  state.button = startButton;

  if (mode === "record") {
    state.pauseButton = node.addWidget("button", "Pause Recording", null, () => { void togglePause(state); }, { serialize: false });
    state.pauseButton.serialize = false;
  } else {
    state.saveButton = node.addWidget("button", "Save Latest Audio", null, () => { void saveLatest(state); }, { serialize: false });
    state.saveButton.serialize = false;
  }
  const format = widget(node, "format");
  if (format) {
    const originalCallback = format.callback;
    format.callback = function () {
      const result = originalCallback?.apply(this, arguments);
      applyFormatUI(node);
      return result;
    };
  }

  const restoreUI = () => {
    hideInputWidget(node, internalName);
    applyFormatUI(node);
    updateButton(state);
    if (mode === "record") {
      node.outputs[1].name = "saved_file_path";
      previewRecording(state, widget(node, "recording_file")?.value);
    }
  };
  const originalConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = originalConfigure?.apply(this, arguments);
    restoreUI();
    return result;
  };

  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    state.player.pause();
    if (state.active || state.busy) void stopCapture(state);
    originalRemoved?.apply(this, arguments);
  };
  restoreUI();
  requestAnimationFrame(restoreUI);
  const size = node.computeSize();
  node.setSize([Math.max(size[0], 300), size[1]]);
}

app.registerExtension({
  name: "TabAudioCapture.tab_audio_capture",
  nodeCreated(node) {
    if (node.comfyClass === LIVE_TYPE) installNodeUI(node, "live");
    if (node.comfyClass === RECORDER_TYPE) installNodeUI(node, "record");
  },
});
