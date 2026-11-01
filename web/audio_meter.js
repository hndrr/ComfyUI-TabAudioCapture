import { app } from "../../scripts/app.js";

const METER_TYPE = "TabAudioMeter";
const CAPTURE_TYPES = new Set(["TabAudioCaptureRecorder", "TabAudioCaptureLive"]);
const FLOOR_DB = -60;

// Only known pass-through nodes may be traversed: an audio transform would
// otherwise misleadingly display the capture's levels instead of its output.
function findCapture(node) {
  const graph = node.graph;
  const visited = new Set([node]);
  let current = node;
  let slot = current.inputs?.findIndex((input) => input.name === "audio") ?? -1;
  while (graph && slot >= 0 && visited.size < 32) {
    const link = current.getInputLink(slot);
    if (!link) return null;
    const upstream = graph.getNodeById(link.origin_id);
    if (!upstream || visited.has(upstream)) return null;
    visited.add(upstream);
    const type = upstream.comfyClass || upstream.type;
    const output = upstream.outputs?.[link.origin_slot];
    if (CAPTURE_TYPES.has(type)) return output?.type === "AUDIO" ? upstream : null;
    if (type !== METER_TYPE && type !== "Reroute") return null;
    if (output?.type !== "AUDIO" && output?.type !== "*") return null;
    current = upstream;
    slot = type === "Reroute" ? 0 : current.inputs?.findIndex((input) => input.name === "audio") ?? -1;
  }
  return null;
}

function sameCapture(branch, capture) {
  return branch && branch.source === capture.source && branch.context === capture.context
    && branch.stream === capture.stream && branch.processor === capture.processor;
}

function disconnectBranch(branch) {
  // Remember only edges owned by this meter. Never disconnect the recorder,
  // stop its tracks, or close/resume its shared AudioContext.
  for (const [source, destination, ...ports] of branch.edges) {
    try { source.disconnect(destination, ...ports); } catch { /* capture may have already stopped */ }
  }
}

function createBranch(capture) {
  const branch = {
    source: capture.source, context: capture.context, stream: capture.stream,
    processor: capture.processor, edges: [], analysers: [], buffers: [],
  };
  const connect = (source, destination, ...ports) => {
    branch.edges.push([source, destination, ...ports]);
    source.connect(destination, ...ports);
  };
  try {
    // Web Audio's speaker upmix duplicates mono into L/R, just as the capture
    // worklet does. Stereo remains separated before peak analysis.
    const stereo = capture.context.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = "explicit";
    stereo.channelInterpretation = "speakers";
    const splitter = capture.context.createChannelSplitter(2);
    connect(stereo, splitter);
    for (let channel = 0; channel < 2; channel++) {
      const analyser = capture.context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      connect(splitter, analyser, channel, 0);
      branch.analysers.push(analyser);
      branch.buffers.push(new Float32Array(analyser.fftSize));
    }
    // Analyser outputs may remain unconnected; this branch is never audible.
    connect(capture.source, stereo);
    return branch;
  } catch (error) {
    disconnectBranch(branch);
    throw error;
  }
}

function peakDB(analyser, buffer) {
  analyser.getFloatTimeDomainData(buffer);
  let peak = 0;
  for (const sample of buffer) {
    if (!Number.isFinite(sample)) throw new Error("Invalid audio samples");
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
}

function meterUI(node) {
  const container = document.createElement("div");
  container.style.cssText = "box-sizing:border-box;width:100%;padding:8px;display:flex;flex-direction:column;gap:6px;color:var(--input-text,#ddd);background:var(--comfy-menu-bg,#222);font:11px sans-serif;";
  const channels = ["L", "R"].map((label) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;";
    const name = document.createElement("span");
    name.textContent = label;
    const bar = document.createElement("div");
    bar.style.cssText = "height:10px;flex:1;overflow:hidden;border-radius:2px;background:var(--comfy-input-bg,#111);border:1px solid var(--border-color,#666);";
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", `${label === "L" ? "Left" : "Right"} peak dBFS`);
    bar.setAttribute("aria-valuemin", String(FLOOR_DB));
    bar.setAttribute("aria-valuemax", "0");
    const fill = document.createElement("div");
    fill.style.cssText = "height:100%;width:0%;background:var(--p-green-500,#38b764);";
    bar.append(fill);
    const value = document.createElement("span");
    value.style.cssText = "width:78px;text-align:right;font-variant-numeric:tabular-nums;";
    row.append(name, bar, value);
    container.append(row);
    return { bar, fill, value };
  });
  const status = document.createElement("div");
  status.style.cssText = "color:var(--descrip-text,var(--input-text,#aaa));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  status.setAttribute("role", "status");
  container.append(status);
  const widget = node.addDOMWidget("audio_meter", "audioMeter", container, {
    serialize: false,
    margin: 0,
    getMinHeight: () => 76,
    getMaxHeight: () => 76,
  });
  widget.serialize = false;
  widget.computeSize = () => [240, 76];
  return { container, channels, status };
}

function installMeter(node) {
  if (node.__tabAudioMeter) return;
  const state = { ...meterUI(node), branch: null, failed: null, quietSince: null, timer: null, removed: false };
  node.__tabAudioMeter = state;

  const render = (message, levels = null) => {
    if (levels === null && state.status.textContent === message) return;
    state.status.textContent = message;
    state.channels.forEach(({ bar, fill, value }, channel) => {
      const db = levels?.[channel];
      const text = db == null ? "—" : db === -Infinity ? "−∞ dBFS" : `${db.toFixed(1)} dBFS`;
      value.textContent = text;
      fill.style.width = `${db == null ? 0 : Math.max(0, Math.min(100, (db - FLOOR_DB) / -FLOOR_DB * 100))}%`;
      fill.style.background = db >= 0 ? "var(--p-red-500,#ef4444)" : "var(--p-green-500,#38b764)";
      bar.setAttribute("aria-valuetext", text);
      if (db == null) bar.removeAttribute("aria-valuenow");
      else bar.setAttribute("aria-valuenow", String(Math.max(FLOOR_DB, Math.min(0, db))));
    });
  };
  const detach = () => {
    if (state.branch) disconnectBranch(state.branch);
    state.branch = null;
    state.quietSince = null;
  };
  const update = () => {
    if (state.removed) return;
    const upstream = findCapture(node);
    if (!upstream) {
      detach();
      state.failed = null;
      render("Not connected · connect Recorder/Live AUDIO");
      return;
    }
    const capture = upstream.__tabAudioState;
    if (!capture?.active || !capture.context || !capture.source || !capture.stream || !capture.processor
      || !capture.stream.getAudioTracks().some((track) => track.readyState === "live")) {
      detach();
      state.failed = null;
      render("Waiting for capture");
      return;
    }
    if (!sameCapture(state.branch, capture)) detach();
    if (capture.context.state !== "running") {
      detach();
      state.failed = null;
      render(`Waiting · audio context ${capture.context.state}`);
      return;
    }
    if (sameCapture(state.failed, capture)) {
      render("Meter unavailable · restart capture");
      return;
    }
    try {
      state.branch ??= createBranch(capture);
      state.failed = null;
      const levels = state.branch.analysers.map((analyser, index) => peakDB(analyser, state.branch.buffers[index]));
      const now = capture.context.currentTime;
      if (levels.every((db) => db < FLOOR_DB)) state.quietSince ??= now;
      else state.quietSince = null;
      render(state.quietSince != null && now - state.quietSince >= 2
        ? "Silence · both below −60 dBFS for 2 s" : "Monitoring", levels);
    } catch {
      detach();
      state.failed = { source: capture.source, context: capture.context, stream: capture.stream, processor: capture.processor };
      render("Meter unavailable · restart capture");
    }
  };
  const start = () => {
    state.removed = false;
    if (state.timer == null) state.timer = window.setInterval(update, 50);
    update();
  };
  const originalAdded = node.onAdded;
  node.onAdded = function () {
    const result = originalAdded?.apply(this, arguments);
    start();
    return result;
  };
  const originalConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = originalConfigure?.apply(this, arguments);
    detach();
    state.failed = null;
    update();
    return result;
  };
  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (type, slot) {
    const result = originalConnectionsChange?.apply(this, arguments);
    if (type === 1 && this.inputs?.[slot]?.name === "audio") {
      detach();
      state.failed = null;
      update();
    }
    return result;
  };
  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    state.removed = true;
    if (state.timer != null) window.clearInterval(state.timer);
    state.timer = null;
    detach();
    state.failed = null;
    render("Not connected");
    return originalRemoved?.apply(this, arguments);
  };
  start();
  const size = node.computeSize();
  node.setSize([Math.max(node.size[0], size[0], 260), Math.max(node.size[1], size[1])]);
}

app.registerExtension({
  name: "TabAudioCapture.audio_meter",
  nodeCreated(node) {
    if (node.comfyClass === METER_TYPE) installMeter(node);
  },
});
