import { app } from "../../scripts/app.js";

const NODE_TYPE = "TabAudioRangeSelect";
const PADDING = 10;
const states = new WeakMap();
const registered = new WeakSet();

function install(node) {
  if (states.has(node)) return states.get(node);
  const start = node.widgets.find((widget) => widget.name === "start_seconds");
  const end = node.widgets.find((widget) => widget.name === "end_seconds");
  const container = document.createElement("div");
  container.style.cssText = "width:100%;min-width:0;box-sizing:border-box;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:128px;touch-action:none;cursor:crosshair;";
  canvas.title = "Drag a range, or drag either range edge. End 0 means the source end.";
  canvas.setAttribute("aria-label", "Source audio waveform and selected range");
  const status = document.createElement("div");
  status.style.cssText = "font:11px sans-serif;color:var(--descrip-text);padding:4px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  container.append(canvas, status);

  const state = { source: null, drag: null, removed: false, loading: false, height: 128, message: "Load Waveform to select a range." };
  states.set(node, state);

  function range() {
    const source = state.source;
    const from = Number(start.value);
    const to = Number(end.value);
    if (!source || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return null;
    const last = to === 0 ? source.duration : Math.min(to, source.duration);
    if (from >= last) return null;
    const sample = (seconds) => Math.floor(seconds * source.sample_rate * (1 + Number.EPSILON));
    const first = sample(from);
    const final = last >= source.duration ? source.total_samples : sample(last);
    return final > first ? [first, final] : null;
  }

  function draw() {
    if (state.removed) return;
    const width = Math.max(1, canvas.clientWidth);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.round(state.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const style = getComputedStyle(canvas);
    const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    ctx.fillStyle = color("--comfy-input-bg", "#222");
    ctx.fillRect(0, 0, width, state.height);
    status.textContent = state.message || "";
    const source = state.source;
    if (!source) return;
    const plotWidth = Math.max(1, width - 2 * PADDING);
    const plotHeight = state.height - 20;
    const channelHeight = plotHeight / source.minmax.length;
    const selection = range();
    const xFor = (sample) => PADDING + sample / source.total_samples * plotWidth;
    const accent = color("--p-primary-color", "#4b94d6");
    if (selection) {
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = accent;
      ctx.fillRect(xFor(selection[0]), 0, xFor(selection[1]) - xFor(selection[0]), plotHeight);
      ctx.globalAlpha = 1;
    }
    source.minmax.forEach((bins, channel) => {
      const middle = (channel + 0.5) * channelHeight;
      let amplitude = 1;
      for (const [low, high] of bins) amplitude = Math.max(amplitude, Math.abs(low), Math.abs(high));
      const scale = channelHeight * 0.42 / amplitude;
      ctx.strokeStyle = color("--border-color", "#555");
      ctx.beginPath();
      ctx.moveTo(PADDING, middle);
      ctx.lineTo(width - PADDING, middle);
      ctx.stroke();
      ctx.strokeStyle = color("--input-text", "#ddd");
      ctx.beginPath();
      bins.forEach(([low, high], index) => {
        const x = PADDING + (index + 0.5) / bins.length * plotWidth;
        ctx.moveTo(x, middle - high * scale);
        ctx.lineTo(x, middle - low * scale + 0.5);
      });
      ctx.stroke();
    });
    if (selection) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const sample of selection) {
        ctx.moveTo(xFor(sample), 0);
        ctx.lineTo(xFor(sample), plotHeight);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = color("--descrip-text", "#aaa");
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("0 s", PADDING, state.height - 5);
    ctx.textAlign = "right";
    ctx.fillText(`${source.duration.toFixed(3)} s`, width - PADDING, state.height - 5);
    if (!state.message) {
      status.textContent = selection
        ? `${(selection[0] / source.sample_rate).toFixed(3)} – ${(selection[1] / source.sample_rate).toFixed(3)} s / ${source.duration.toFixed(3)} s`
        : "Select a nonempty range within the source duration.";
    }
  }

  function setValue(widget, value) {
    const previous = widget.value;
    if (previous === value) return;
    widget.value = value;
    widget.callback?.call(widget, value);
    node.onWidgetChanged?.(widget.name, value, previous, widget);
    node.graph?.incrementVersion();
  }

  function setRange(first, final) {
    const source = state.source;
    setValue(start, first / source.sample_rate);
    setValue(end, final === source.total_samples ? 0 : final / source.sample_rate);
    node.graph?.change();
    node.setDirtyCanvas(true, true);
    draw();
  }

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width) * canvas.clientWidth;
    return Math.round(Math.max(0, Math.min(1, (x - PADDING) / Math.max(1, canvas.clientWidth - 2 * PADDING))) * state.source.total_samples);
  }

  function down(event) {
    if (event.button !== 0 || !state.source || state.drag) return;
    event.preventDefault();
    event.stopPropagation();
    const point = position(event);
    const selected = range();
    const tolerance = 8 / Math.max(1, canvas.clientWidth - 2 * PADDING) * state.source.total_samples;
    let mode = "new";
    if (selected) {
      const left = Math.abs(point - selected[0]);
      const right = Math.abs(point - selected[1]);
      if (Math.min(left, right) <= tolerance) mode = left <= right ? "start" : "end";
    }
    state.drag = { pointerId: event.pointerId, point, selected, mode };
    canvas.setPointerCapture(event.pointerId);
  }

  function move(event) {
    const drag = state.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = position(event);
    if (drag.mode === "start") setRange(Math.min(point, drag.selected[1] - 1), drag.selected[1]);
    else if (drag.mode === "end") setRange(drag.selected[0], Math.max(point, drag.selected[0] + 1));
    else if (point !== drag.point) setRange(Math.min(point, drag.point), Math.max(point, drag.point));
  }

  function finish(event) {
    if (state.drag?.pointerId !== event.pointerId) return;
    if (event.type === "pointerup") move(event);
    state.drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  const handlers = { pointerdown: down, pointermove: move, pointerup: finish, pointercancel: finish, lostpointercapture: finish };
  for (const [name, handler] of Object.entries(handlers)) canvas.addEventListener(name, handler);
  const observer = new ResizeObserver(draw);
  observer.observe(canvas);

  const callbacks = [start, end].map((widget) => {
    const original = widget.callback;
    const wrapped = function () {
      const result = original?.apply(this, arguments);
      draw();
      return result;
    };
    widget.callback = wrapped;
    return { widget, original, wrapped };
  });

  const load = node.addWidget("button", "Load Waveform", null, async () => {
    if (state.loading || state.removed) return;
    state.loading = true;
    state.message = "Loading waveform…";
    draw();
    try {
      const queued = await app.queuePrompt(0, 1, { queueNodeIds: [String(node.id)] });
      if (queued === false) throw new Error("Could not queue waveform. Check the audio input and range.");
    } catch (error) {
      state.message = error.message;
      draw();
    } finally {
      state.loading = false;
    }
  }, { serialize: false });
  load.serialize = false;
  const reset = node.addWidget("button", "Reset Full Range", null, () => {
    setValue(start, 0);
    setValue(end, 0);
    if (state.drag && canvas.hasPointerCapture(state.drag.pointerId)) canvas.releasePointerCapture(state.drag.pointerId);
    state.drag = null;
    node.graph?.change();
    node.setDirtyCanvas(true, true);
    draw();
  }, { serialize: false });
  reset.serialize = false;
  const waveform = node.addDOMWidget("range_waveform", "audioRangeWaveform", container, {
    serialize: false,
    getMinHeight: () => state.height + 26,
    getMaxHeight: () => state.height + 26,
  });
  waveform.serialize = false;
  waveform.computeSize = () => [0, state.height + 26];

  state.draw = draw;
  state.executed = (source) => {
    state.source = source;
    state.message = null;
    state.height = Math.max(128, Math.min(240, source.minmax.length * 48));
    canvas.style.height = `${state.height}px`;
    node.setSize([Math.max(320, node.size[0]), node.computeSize()[1]]);
    draw();
  };
  state.remove = () => {
    state.removed = true;
    if (state.drag && canvas.hasPointerCapture(state.drag.pointerId)) canvas.releasePointerCapture(state.drag.pointerId);
    state.drag = null;
    observer.disconnect();
    for (const [name, handler] of Object.entries(handlers)) canvas.removeEventListener(name, handler);
    for (const { widget, original, wrapped } of callbacks) {
      if (widget.callback === wrapped) widget.callback = original;
    }
  };
  node.setSize([Math.max(320, node.size[0]), node.computeSize()[1]]);
  draw();
  return state;
}

app.registerExtension({
  name: "TabAudioCapture.audio_range_select",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE || registered.has(nodeType)) return;
    registered.add(nodeType);
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      install(this);
      return result;
    };
    const executed = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = executed?.apply(this, arguments);
      const source = message?.range_waveform?.[0];
      if (source) install(this).executed(source);
      return result;
    };
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = configure?.apply(this, arguments);
      install(this).draw();
      return result;
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      states.get(this)?.remove();
      return removed?.apply(this, arguments);
    };
  },
});
