/* global window, document, navigator, AudioContext, AudioWorkletNode, MediaStream, WebSocket */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TYPE = "TabAudioCaptureSmart";
const WORKLET = new URL("./worklets/tab_audio_worklet.mjs", import.meta.url).href;
const get = (node, name) => node.widgets?.find(w => w.name === name);
const value = (node, name) => get(node, name)?.value;
const errorText = e => e instanceof Error ? e.message : String(e);
const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));

function hide(node, name) {
  const w = get(node, name);
  if (!w) return;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
  w.hidden = true;
}

function status(state, message) {
  state.status.textContent = message;
  state.node.setDirtyCanvas?.(true, true);
}
function savedUrl(relative) {
  const parts = relative.split("/");
  return api.apiURL("/view?" + new URLSearchParams({
    filename: parts.pop(), subfolder: parts.join("/"), type: "output",
  }));
}
function refresh(state) {
  const select = state.select;
  select.replaceChildren();
  state.history.forEach((file, index) => {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = "Take " + String(index + 1).padStart(2, "0") + " — " + file;
    select.append(option);
  });
  select.value = value(state.node, "recording_file") || state.history.at(-1) || "";
  const chosen = select.value;
  state.player.src = chosen ? savedUrl(chosen) : "";
  state.player.load();
}
function selectTake(state, file) {
  if (!state.history.includes(file)) return;
  get(state.node, "recording_file").value = file;
  refresh(state);
}

async function openTake(state) {
  const sessionId = crypto.randomUUID();
  const url = new URL(api.apiURL("/tab_audio/ws"), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url.href);
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    ws.addEventListener("open", resolve, { once: true });
  });
  await ready;
  const started = new Promise((resolve, reject) => {
    ws.addEventListener("message", event => {
      const packet = JSON.parse(event.data);
      if (packet.event === "started") resolve();
      if (packet.event === "error") reject(new Error(packet.message));
    });
    ws.addEventListener("close", () => reject(new Error("Connection closed before starting")), { once: true });
  });
  ws.send(JSON.stringify({
    command: "start", mode: "record", session_id: sessionId,
    sample_rate: state.context.sampleRate, channels: 2,
    filename_prefix: value(state.node, "filename_prefix") || "tab_audio/smart_take",
    format: "wav", wav_bit_depth: "24-bit PCM",
  }));
  await started;
  return ws;
}

async function finalize(state) {
  if (!state.take || state.take.finishing) return;
  const take = state.take;
  take.finishing = true;
  status(state, "Saving take…");
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Save timed out")), 15000);
      const onMessage = event => {
        const packet = JSON.parse(event.data);
        if (packet.event === "stopped" || packet.event === "error") {
          window.clearTimeout(timeout);
          take.ws.removeEventListener("message", onMessage);
          if (packet.event === "error") reject(new Error(packet.message));
          else resolve(packet.saved_file);
        }
      };
      take.ws.addEventListener("message", onMessage);
      if (take.ws.readyState !== WebSocket.OPEN) {
        window.clearTimeout(timeout);
        reject(new Error("Recording connection lost"));
      } else take.ws.send(JSON.stringify({command: "stop"}));
    });
    if (result) {
      state.history.push(result);
      // Keep all saved files on disk; cap the in-node history.
      state.history = state.history.slice(-30);
      get(state.node, "take_history").value = JSON.stringify(state.history);
      selectTake(state, result);
    }
    status(state, result ? "Saved: " + result : "No audio recorded");
  } catch (error) {
    status(state, "Save error: " + errorText(error));
  } finally {
    take.ws.close();
    if (state.take === take) state.take = null;
    state.lastSound = 0;
  }
}
async function beginTake(state) {
  if (state.take || !state.active) return;
  // Capture buffered pre-roll before opening the new recording session.
  const initial = state.preRoll.slice();
  state.take = { ws: null, pending: [], finishing: false, frames: 0 };
  const take = state.take;
  status(state, "Starting take…");
  try {
    const ws = await openTake(state);
    if (!state.active || state.take !== take) { ws.close(); return; }
    take.ws = ws;
    for (const chunk of initial.concat(take.pending)) {
      if (ws.bufferedAmount > 4 * 1024 * 1024) throw new Error("Network backpressure");
      ws.send(chunk);
    }
    take.pending = [];
    status(state, "Recording take…");
  } catch (error) {
    status(state, "Recording error: " + errorText(error));
    take.ws?.close();
    if (state.take === take) state.take = null;
  }
}
function processChunk(state, buffer) {
  if (!state.active) return;
  const samples = new Float32Array(buffer);
  if (!samples.length) return;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  const db = 10 * Math.log10(energy / samples.length + 1e-12);
  const frames = samples.length / 2;
  const seconds = frames / state.context.sampleRate;
  state.elapsed += seconds;
  const threshold = Number(value(state.node, "threshold_db") ?? -35);
  const sounding = db >= threshold;
  state.preRoll.push(buffer);
  state.preFrames += frames;
  // Retain the confirmation interval as well as audio from before the onset.
  const maxFrames = state.context.sampleRate * (
    Number(value(state.node, "pre_roll_seconds") ?? 1) +
    Number(value(state.node, "min_sound_seconds") ?? 0.5) + 0.1
  );
  while (state.preFrames > maxFrames && state.preRoll.length > 1) {
    state.preFrames -= state.preRoll.shift().byteLength / 8;
  }
  if (!state.take) {
    state.soundDuration = sounding ? state.soundDuration + seconds : 0;
    if (!state.stopping && state.soundDuration >= Number(value(state.node, "min_sound_seconds") ?? 0.5)) {
      // The rolling buffer already contains the full trigger period; never duplicate it.
      const opening = beginTake(state);
      if (state.take) state.take.opening = opening;
      state.lastSound = state.elapsed;
      state.soundDuration = 0;
      return;
    }
  } else {
    const take = state.take;
    if (!take.finishing) {
      if (take.ws?.readyState === WebSocket.OPEN) {
        if (take.ws.bufferedAmount > 4 * 1024 * 1024) {
          status(state, "Network backpressure — stopping");
          void finalize(state);
          return;
        }
        take.ws.send(buffer);
      } else if (take.pending.length < 2500) take.pending.push(buffer);
      else { status(state, "Connection backlog exceeded"); void stop(state); return; }
      take.frames += frames;
      if (sounding) state.lastSound = state.elapsed;
      if (take.ws && (state.elapsed - state.lastSound >= Number(value(state.node, "silence_seconds") ?? 1.5) ||
          take.frames >= state.context.sampleRate * 60)) void finalize(state);
    }
  }
}
async function start(state) {
  if (state.active || state.starting || state.stopping) return;
  state.starting = true;
  status(state, "Choose a tab and enable audio sharing…");
  try {
    if (!window.isSecureContext) throw new Error("HTTPS or localhost required");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" }, audio: { suppressLocalAudioPlayback: false },
      selfBrowserSurface: "include", systemAudio: "include",
    });
    state.stream = stream;
    if (!stream.getAudioTracks().length) throw new Error("Enable Share tab audio or Share system audio");
    const context = new AudioContext({ latencyHint: "interactive" });
    state.context = context;
    await context.audioWorklet.addModule(WORKLET);
    const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const processor = new AudioWorkletNode(context, "tab-audio-pcm-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    const silent = context.createGain();
    silent.gain.value = 0;
    state.source = source; state.processor = processor; state.silent = silent;
    state.preRoll = []; state.preFrames = 0; state.elapsed = 0;
    state.soundDuration = 0; state.lastSound = 0;
    processor.port.onmessage = event => {
      if (event.data?.type === "chunk") processChunk(state, event.data.buffer);
    };
    source.connect(processor); processor.connect(silent); silent.connect(context.destination);
    await context.resume();
    state.active = true;
    stream.getTracks().forEach(track => track.addEventListener("ended", () => { void stop(state); }, { once: true }));
    status(state, "Armed — waiting for audio");
    state.button.label = "Stop Smart Capture";
  } catch (error) {
    status(state, "Capture error: " + errorText(error));
    await stop(state);
  } finally { state.starting = false; }
}
async function stop(state) {
  if (state.stopping) return;
  state.stopping = true;
  // Wait for a pending connection so a manual stop never loses an accepted take.
  const opening = state.take?.opening;
  if (opening) await opening.catch(() => {});
  state.active = false;
  if (state.take?.ws) await finalize(state);
  state.processor?.disconnect();
  state.source?.disconnect();
  state.silent?.disconnect();
  state.stream?.getTracks().forEach(track => track.stop());
  if (state.context?.state !== "closed") await state.context?.close();
  state.stream = null; state.context = null; state.processor = null;
  state.button.label = "Start Smart Capture";
  state.stopping = false;
  if (!state.history.length) status(state, "Stopped");
  else status(state, "Stopped — " + state.history.length + " takes available");
}
function install(node) {
  if (node.__smartCapture) return;
  hide(node, "recording_file"); hide(node, "take_history");
  const state = { node, active: false, starting: false, stopping: false, take: null, history: [], preRoll: [],
    preFrames: 0, elapsed: 0, soundDuration: 0, lastSound: 0 };
  node.__smartCapture = state;
  const root = document.createElement("div");
  root.style.cssText = "width:100%;display:flex;flex-direction:column;gap:4px";
  const select = document.createElement("select");
  select.style.width = "100%";
  select.addEventListener("change", () => selectTake(state, select.value));
  const player = document.createElement("audio");
  player.controls = true; player.style.width = "100%";
  const statusEl = document.createElement("div");
  statusEl.style.cssText = "font:11px sans-serif;color:var(--descrip-text,#999)";
  statusEl.textContent = "Idle";
  root.append(select, player, statusEl);
  state.select = select; state.player = player; state.status = statusEl;
  const dom = node.addDOMWidget("smart_capture_ui", "smartAudio", root, { serialize: false });
  dom.serialize = false;
  dom.computeSize = () => [0, 110];
  state.button = node.addWidget("button", "Start Smart Capture", null,
    () => { void (state.active ? stop(state) : start(state)); }, { serialize: false });
  state.button.serialize = false;
  function restore() {
    hide(node, "recording_file"); hide(node, "take_history");
    try {
      const saved = JSON.parse(value(node, "take_history") || "[]");
      state.history = Array.isArray(saved) ? saved.filter(x => typeof x === "string").slice(-30) : [];
    } catch { state.history = []; }
    refresh(state);
    node.setSize([Math.max(node.size[0], 370), node.computeSize()[1]]);
  }
  const configured = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = configured?.apply(this, args); restore(); return result;
  };
  const removed = node.onRemoved;
  node.onRemoved = function (...args) {
    void stop(state); return removed?.apply(this, args);
  };
  restore();
}
app.registerExtension({
  name: "TabAudioCapture.smart_capture",
  nodeCreated(node) { if (node.comfyClass === TYPE) install(node); },
});
