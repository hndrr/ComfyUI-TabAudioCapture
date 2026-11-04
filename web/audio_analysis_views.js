/* Compact, real-data visualizations for two standard ComfyUI AUDIO processing nodes.
 * No third-party graph or DOM framework is required. */
import { app } from "../../scripts/app.js";

const LOOP = "TabAudioLoopCapture";
const FEATURES = "TabAudioFeatureExtractor";
const states = new WeakMap();
const registered = new WeakSet();

function textElement(tag, content, css = "") {
  const element = document.createElement(tag);
  element.textContent = content;
  if (css) element.style.cssText = css;
  return element;
}

function styleColor(name, fallback, canvas) {
  if (typeof getComputedStyle !== "function") return fallback;
  return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
}

function paint(canvas, height, render) {
  const width = Math.max(160, canvas.clientWidth || 320);
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return; // Can also run in non-visual test environments.
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const bg = styleColor("--comfy-input-bg", "#151820", canvas);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  render(ctx, width, height);
}

function drawLoop(state) {
  const { canvas, source, info } = state;
  if (!source || !Array.isArray(source.minmax)) return;
  const accent = styleColor("--p-primary-color", "#659af0", canvas);
  const ink = styleColor("--input-text", "#bdc7d7", canvas);
  paint(canvas, 100, (ctx, w, h) => {
    const left = 8, right = w - 8, plot = right - left;
    const total = Math.max(0.001, source.total_seconds);
    const from = Math.max(0, Math.min(1, source.start_seconds / total));
    const until = Math.max(from, Math.min(1, source.end_seconds / total));
    const x1 = left + from * plot, x2 = left + until * plot;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.2;
    ctx.fillRect(x1, 6, x2 - x1, h - 20);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const bins = source.minmax;
    const scale = (h - 28) * 0.42 / Math.max(1, ...bins.flat().map(x => Math.abs(x)));
    bins.forEach(([low, high], i) => {
      const x = left + (i + 0.5) / bins.length * plot;
      ctx.moveTo(x, (h - 8) / 2 - high * scale);
      ctx.lineTo(x, (h - 8) / 2 - low * scale);
    });
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    for (const x of [x1, x2]) {
      ctx.moveTo(x, 4); ctx.lineTo(x, h - 15);
    }
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("0 s", 8, h - 3);
    ctx.textAlign = "right";
    ctx.fillText(total.toFixed(2) + " s", w - 8, h - 3);
  });
  info.textContent = [
    source.start_seconds.toFixed(2) + "–" + source.end_seconds.toFixed(2) + " s",
    source.duration_seconds.toFixed(2) + " s loop",
    source.first_batch_only ? "preview: first batch" : "",
  ].filter(Boolean).join(" · ");
}

const series = [
  ["rms", "RMS", "#77aaf1"],
  ["bass", "Bass", "#8cceb3"],
  ["treble", "Treble", "#c2a5e8"],
  ["onset", "Onset", "#f2bc78"],
];
function drawFeatures(state) {
  const { canvas, source, info, example } = state;
  if (!source || !Array.isArray(source.samples)) return;
  const ink = styleColor("--input-text", "#c5cdd8", canvas);
  paint(canvas, 172, (ctx, width) => {
    const left = 48, right = width - 10, chartWidth = Math.max(1, right - left);
    const samples = source.samples;
    for (let row = 0; row < series.length; row++) {
      const [key, title, color] = series[row];
      const top = 6 + row * 42;
      const bottom = top + 30;
      const maximum = Math.max(0.001, ...samples.map(point => Number(point[key]) || 0));
      ctx.strokeStyle = styleColor("--border-color", "#444a56", canvas);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); ctx.stroke();
      ctx.strokeStyle = color;
      ctx.beginPath();
      samples.forEach((point, i) => {
        const x = left + (samples.length === 1 ? 0 : i / (samples.length - 1)) * chartWidth;
        const y = bottom - (Number(point[key]) || 0) / maximum * 25;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(title, 5, top + 19);
    }
  });
  const s = source.summary || {};
  info.textContent = "RMS " + Number(s.rms || 0).toFixed(3) +
    " · Bass " + Number(s.bass || 0).toFixed(3) +
    " · Treble " + Number(s.treble || 0).toFixed(3) +
    " · Onset " + Number(s.max_onset || 0).toFixed(3);
  example.textContent = source.total_frames + " frames · " +
    source.batch_count + " batch · " + source.duration_seconds.toFixed(2) +
    " s | JSON sample: " + (source.head_json || "[]").slice(0, 140);
}

function install(node, kind) {
  if (states.has(node)) return states.get(node);
  const root = document.createElement("div");
  root.style.cssText = "width:100%;min-width:0;box-sizing:border-box;padding:6px 8px;display:flex;flex-direction:column;gap:4px;background:var(--comfy-menu-bg,#222);color:var(--input-text,#ddd);font:11px sans-serif;";
  const info = textElement("div", kind === "loop" ? "Run to preview selected bars" : "Run to preview feature curves",
    "font:11px sans-serif;color:var(--descrip-text,#aaa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
  const canvas = document.createElement("canvas");
  const height = kind === "loop" ? 100 : 172;
  canvas.style.cssText = "width:100%;display:block;height:" + height + "px;";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", kind === "loop" ? "Loop source waveform and selected time range" :
    "RMS, bass, treble and onset feature graphs");
  root.append(canvas, info);
  const example = textElement("div", "", "font:10px monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--descrip-text,#aaa)");
  if (kind === "features") root.append(example);
  const state = { node, kind, root, canvas, info, example, source: null, removed: false, drawing: false };
  states.set(node, state);
  const dom = node.addDOMWidget(
    kind === "loop" ? "loop_preview" : "feature_preview",
    kind === "loop" ? "audioLoopPreview" : "audioFeaturePreview", root,
    {serialize: false, getMinHeight: () => height + 42, getMaxHeight: () => height + 42},
  );
  dom.serialize = false;
  dom.computeSize = () => [0, height + 42];
  const button = node.addWidget(
    "button", kind === "loop" ? "Preview Loop" : "Analyze & Preview", null,
    async () => {
      if (state.drawing || state.removed) return;
      state.drawing = true;
      info.textContent = "Running analysis…";
      try {
        const queued = await app.queuePrompt(0, 1, [String(node.id)]);
        if (queued === false) info.textContent = "Queue failed: check the AUDIO input";
      } catch (error) {
        info.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        state.drawing = false;
      }
    }, {serialize: false},
  );
  button.serialize = false;
  state.render = () => kind === "loop" ? drawLoop(state) : drawFeatures(state);
  state.show = source => {
    state.source = source;
    state.render();
    node.setDirtyCanvas?.(true, true);
  };
  // A resize can occur after ComfyUI has laid out the DOM widget.
  if (typeof ResizeObserver === "function") {
    state.observer = new ResizeObserver(() => state.render());
    state.observer.observe(canvas);
  }
  node.setSize([Math.max(node.size[0], 320), node.computeSize()[1]]);
  return state;
}

app.registerExtension({
  name: "TabAudioCapture.audio_analysis_views",
  beforeRegisterNodeDef(nodeType, nodeData) {
    const kind = nodeData.name === LOOP ? "loop" : nodeData.name === FEATURES ? "features" : null;
    if (!kind || registered.has(nodeType)) return;
    registered.add(nodeType);
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const output = created?.apply(this, args);
      install(this, kind);
      return output;
    };
    const executed = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const output = executed?.apply(this, arguments);
      const payload = message?.[kind === "loop" ? "loop_preview" : "feature_preview"]?.[0];
      if (payload) install(this, kind).show(payload);
      return output;
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      const state = states.get(this);
      if (state) {
        state.removed = true;
        state.observer?.disconnect();
        states.delete(this);
      }
      return removed?.apply(this, args);
    };
  },
});
