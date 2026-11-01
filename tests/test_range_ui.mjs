import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/audio_range_select.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "");

function setup({ start = 0, end = 0, id = 42 } = {}) {
  let extension;
  let queueResult = async () => true;
  const queues = [];
  const observers = [];
  const callbacks = [];
  const commands = [];
  const ctx = {};
  for (const method of ["setTransform", "fillRect", "beginPath", "moveTo", "lineTo", "stroke", "fillText"]) {
    ctx[method] = (...args) => commands.push({ method, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle, alpha: ctx.globalAlpha });
  }
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.style = {};
      this.children = [];
      this.attributes = {};
      this.handlers = new Map();
      this.captures = new Set();
      this.width = 0;
      this.clientWidth = 300;
      this.zoom = 1;
    }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getBoundingClientRect() { return { left: 50, width: this.clientWidth * this.zoom, height: (parseFloat(this.style.height) || 128) * this.zoom }; }
    getContext() { return ctx; }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    removeEventListener(name, callback) { if (this.handlers.get(name) === callback) this.handlers.delete(name); }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    dispatch(type, fraction, options = {}) {
      const rect = this.getBoundingClientRect();
      const event = { type, button: 0, pointerId: 1, clientX: rect.left + (10 + fraction * (this.clientWidth - 20)) * this.zoom,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...options };
      this.handlers.get(type)?.(event);
      return event;
    }
  }
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
  }
  const app = {
    registerExtension(value) { extension = value; },
    async queuePrompt(...args) { queues.push(args); return queueResult(...args); },
  };
  vm.runInNewContext(source, {
    app, document: { createElement: (tag) => new Element(tag) }, ResizeObserver: Observer,
    window: { devicePixelRatio: 2 },
    getComputedStyle: () => ({ getPropertyValue: (name) => ({
      "--comfy-input-bg": "#111", "--input-text": "#eee", "--border-color": "#333",
      "--descrip-text": "#999", "--p-primary-color": "#87a",
    })[name] || "" }),
  });
  class Node {
    constructor() {
      this.id = id;
      this.size = [250, 120];
      this.hooks = [];
      this.changes = [];
      this.graphChanges = 0;
      this.graphVersion = 0;
      this.dirty = 0;
      this.graph = { change: () => this.graphChanges++, incrementVersion: () => this.graphVersion++ };
      this.widgets = [
        { name: "start_seconds", type: "number", value: start },
        { name: "end_seconds", type: "number", value: end },
      ];
      for (const widget of this.widgets) {
        widget.callback = function (...args) { callbacks.push({ widget: this, args }); return "callback-result"; };
        widget.originalCallback = widget.callback;
      }
    }
    onNodeCreated(...args) { this.hooks.push(["created", this, args]); return "created-result"; }
    onConfigure(...args) { this.hooks.push(["configure", this, args]); return "configure-result"; }
    onExecuted(...args) { this.hooks.push(["executed", this, args]); return "executed-result"; }
    onRemoved(...args) { this.hooks.push(["removed", this, args]); return "removed-result"; }
    onWidgetChanged(...args) { this.changes.push(args); }
    setDirtyCanvas() { this.dirty++; }
    computeSize() { return [this.size[0], 40 + this.widgets.reduce((sum, widget) => sum + (widget.computeSize?.()[1] || 20), 0)]; }
    setSize(size) { this.size = size; }
    addWidget(type, name, value, callback, options) {
      const widget = { type, name, value, callback, options };
      this.widgets.push(widget);
      return widget;
    }
    addDOMWidget(name, type, element, options) {
      const widget = { type, name, element, options };
      this.widgets.push(widget);
      return widget;
    }
  }
  extension.beforeRegisterNodeDef(Node, { name: "TabAudioRangeSelect" });
  const node = new Node();
  assert.equal(node.onNodeCreated("initial"), "created-result");
  const find = (name) => node.widgets.find((widget) => widget.name === name);
  const [canvas, status] = find("range_waveform").element.children;
  const payload = (overrides = {}) => ({
    minmax: [[[-0.3, 0.2], [-1, 1], [-0.1, 0.6], [-0.2, 0.1]], [[-1, 1], [-0.2, 0.3], [-0.4, 0.4], [-0.8, 0.2]]],
    sample_rate: 10, total_samples: 100, duration: 10, ...overrides,
  });
  const execute = (overrides) => node.onExecuted({ range_waveform: [payload(overrides)] }, "execution-marker");
  const drag = (first, final) => {
    canvas.dispatch("pointerdown", first);
    canvas.dispatch("pointermove", final);
    canvas.dispatch("pointerup", final);
  };
  const selection = () => [find("start_seconds").value, find("end_seconds").value];
  const highlight = () => commands.filter((command) => command.method === "fillRect" && command.alpha === 0.22).at(-1);
  return { extension, Node, node, find, canvas, status, commands, callbacks, observers, queues,
    execute, drag, selection, highlight, setQueue: (fn) => { queueResult = fn; } };
}

test("only the registered range type gets controls, once, with transient widgets", () => {
  const h = setup();
  class Other {}
  h.extension.beforeRegisterNodeDef(Other, { name: "TabAudioCaptureRecorder" });
  assert.equal(Other.prototype.onNodeCreated, undefined);
  h.extension.beforeRegisterNodeDef(h.Node, { name: "TabAudioRangeSelect" });
  h.node.onNodeCreated("again");
  assert.deepEqual(h.node.widgets.map((widget) => widget.name), [
    "start_seconds", "end_seconds", "Load Waveform", "Reset Full Range", "range_waveform",
  ]);
  for (const widget of h.node.widgets.slice(2)) {
    assert.equal(widget.serialize, false);
    assert.equal(widget.options.serialize, false);
  }
  assert.equal(h.observers.length, 1);
  assert.match(h.status.textContent, /Load Waveform/);
  assert.deepEqual(h.selection(), [0, 0]);
  assert.equal(h.node.hooks[0][1], h.node);
  assert.deepEqual(h.node.hooks[0][2], ["initial"]);
});

test("execution draws the full multichannel source and highlights default full range", () => {
  const h = setup();
  assert.equal(h.execute(), "executed-result");
  assert.deepEqual(h.selection(), [0, 0]);
  assert.deepEqual(Array.from(h.highlight().args), [10, 0, 280, 108]);
  assert.equal(h.canvas.width, 600);
  assert.equal(h.canvas.height, 256);
  assert.equal(h.highlight().fill, "#87a");
  assert.ok(h.commands.filter((command) => command.method === "stroke" && command.stroke === "#eee").length >= 2);
  assert.match(h.status.textContent, /0\.000 – 10\.000 s \/ 10\.000 s/);
  assert.equal(h.node.hooks.at(-1)[0], "executed");
  assert.equal(h.node.hooks.at(-1)[2][1], "execution-marker");
});

test("drag writes native numeric widgets immediately and notifies existing callbacks", () => {
  const h = setup();
  h.execute();
  const down = h.canvas.dispatch("pointerdown", 0.2);
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  assert.equal(h.canvas.hasPointerCapture(1), true);
  h.canvas.dispatch("pointermove", 0.7);
  assert.deepEqual(h.selection(), [2, 7]);
  assert.ok(h.node.graphChanges > 0);
  assert.equal(h.node.graphVersion, 2);
  assert.ok(h.node.dirty > 0);
  assert.equal(h.callbacks[0].widget, h.find("start_seconds"));
  assert.deepEqual(h.callbacks[0].args, [2]);
  assert.deepEqual(h.node.changes.map((change) => change.slice(0, 3)), [["start_seconds", 2, 0], ["end_seconds", 7, 0]]);
  assert.deepEqual(Array.from(h.highlight().args), [66, 0, 140, 108]);
  h.canvas.dispatch("pointerup", 0.7);
  assert.equal(h.canvas.hasPointerCapture(1), false);
  assert.equal(h.queues.length, 0);
});

test("reverse drag and range handles update both directions; source end stays sentinel zero", () => {
  const h = setup();
  h.execute();
  h.drag(0.8, 0.3);
  assert.deepEqual(h.selection(), [3, 8]);
  h.drag(0.3, 0.2);
  assert.deepEqual(h.selection(), [2, 8]);
  h.drag(0.8, 1.2);
  assert.deepEqual(h.selection(), [2, 0]);
  h.drag(1, 0.7);
  assert.deepEqual(h.selection(), [2, 7]);
});

test("sample positions retain precision finer than the numeric widget's displayed step", () => {
  const h = setup();
  h.execute({ sample_rate: 48000, total_samples: 48000, duration: 1 });
  h.drag(10000 / 48000, 20001 / 48000);
  assert.deepEqual(h.selection(), [10000 / 48000, 20001 / 48000]);
});

test("pointer coordinates track graph zoom while keeping the canvas at its content size", () => {
  const h = setup();
  h.execute();
  for (const zoom of [0.5, 2]) {
    h.find("Reset Full Range").callback();
    h.canvas.zoom = zoom;
    h.drag(0.2, 0.7);
    assert.deepEqual(h.selection(), [2, 7]);
    assert.equal(h.canvas.width, 600);
    assert.deepEqual(Array.from(h.highlight().args), [66, 0, 140, 108]);
  }
});

test("drag clamps outside the canvas and handle crossing keeps at least one sample", () => {
  const h = setup();
  h.execute();
  h.drag(0.2, -1);
  assert.deepEqual(h.selection(), [0, 2]);
  h.drag(0.4, 2);
  assert.deepEqual(h.selection(), [4, 0]);
  h.find("start_seconds").value = 2;
  h.find("end_seconds").value = 7;
  h.drag(0.2, 0.9);
  assert.deepEqual(h.selection(), [6.9, 7]);
  h.find("start_seconds").value = 2;
  h.drag(0.7, 0.1);
  assert.deepEqual(h.selection(), [2, 2.1]);
});

test("a click keeps the range; foreign pointers, right clicks, and canceled drags stay safe", () => {
  const h = setup();
  h.execute();
  h.drag(0.5, 0.5);
  assert.deepEqual(h.selection(), [0, 0]);
  h.canvas.dispatch("pointerdown", 0.2, { button: 2 });
  h.canvas.dispatch("pointermove", 0.7);
  assert.deepEqual(h.selection(), [0, 0]);
  h.canvas.dispatch("pointerdown", 0.2);
  h.canvas.dispatch("pointermove", 0.7, { pointerId: 2 });
  assert.deepEqual(h.selection(), [0, 0]);
  h.canvas.dispatch("pointermove", 0.6);
  h.canvas.dispatch("pointercancel", 0.9);
  assert.deepEqual(h.selection(), [2, 6]);
  assert.equal(h.canvas.hasPointerCapture(1), false);
  h.canvas.dispatch("pointermove", 0.9);
  assert.deepEqual(h.selection(), [2, 6]);
  h.canvas.dispatch("pointerdown", 0.3);
  h.canvas.dispatch("lostpointercapture", 0.3);
  h.canvas.dispatch("pointermove", 0.9);
  assert.deepEqual(h.selection(), [2, 6]);
});

test("numeric callbacks redraw selection, preserve context and return value, and flag empty bounds", () => {
  const h = setup();
  h.execute();
  const start = h.find("start_seconds");
  const end = h.find("end_seconds");
  start.value = 1;
  assert.equal(start.callback(1, "native-marker"), "callback-result");
  assert.equal(h.callbacks.at(-1).widget, start);
  assert.deepEqual(h.callbacks.at(-1).args, [1, "native-marker"]);
  end.value = 3;
  end.callback(3);
  assert.match(h.status.textContent, /1\.000 – 3\.000/);
  end.value = 0;
  end.callback(0);
  assert.match(h.status.textContent, /1\.000 – 10\.000/);
  end.value = 0.5;
  end.callback(0.5);
  assert.match(h.status.textContent, /nonempty range/);
  start.value = NaN;
  start.callback(NaN);
  assert.match(h.status.textContent, /nonempty range/);
});

test("reset selects the full source and updates numeric controls without queueing", () => {
  const h = setup({ start: 2, end: 4 });
  h.execute();
  h.canvas.dispatch("pointerdown", 0.2);
  h.find("Reset Full Range").callback();
  assert.equal(h.canvas.hasPointerCapture(1), false);
  assert.deepEqual(h.selection(), [0, 0]);
  assert.deepEqual(Array.from(h.highlight().args), [10, 0, 280, 108]);
  assert.deepEqual(h.node.changes.map((change) => change.slice(0, 3)), [["start_seconds", 0, 2], ["end_seconds", 0, 4]]);
  assert.equal(h.queues.length, 0);
});

test("configure and repeated execution retain saved numeric selections, with no duplicated widgets", () => {
  const h = setup({ start: 1.25, end: 6.5 });
  assert.equal(h.node.onConfigure({ restored: true }), "configure-result");
  h.execute();
  h.execute();
  assert.deepEqual(h.selection(), [1.25, 6.5]);
  h.find("start_seconds").value = 2;
  h.find("end_seconds").value = 0;
  h.node.onConfigure({ widgets_values: [2, 0] });
  assert.deepEqual(h.selection(), [2, 0]);
  assert.match(h.status.textContent, /2\.000 – 10\.000/);
  assert.equal(h.node.widgets.length, 5);
  assert.equal(h.observers.length, 1);
  assert.equal(h.node.onExecuted({ unrelated: [] }), "executed-result");
  assert.deepEqual(h.selection(), [2, 0]);
  h.execute({ minmax: Array.from({ length: 6 }, () => [[-1, 1]]) });
  assert.equal(h.canvas.style.height, "240px");
  assert.equal(h.find("range_waveform").computeSize()[1], 266);
});

test("Load Waveform uses only the installed partial queue API and stringifies node IDs", async () => {
  const h = setup({ start: 2, end: 5, id: 84 });
  let finish;
  h.setQueue(() => new Promise((resolve) => { finish = resolve; }));
  const loading = h.find("Load Waveform").callback();
  await h.find("Load Waveform").callback();
  assert.equal(h.queues.length, 1);
  assert.equal(JSON.stringify(h.queues[0]), JSON.stringify([0, 1, { queueNodeIds: ["84"] }]));
  assert.deepEqual(h.selection(), [2, 5]);
  assert.match(h.status.textContent, /Loading waveform/);
  finish(true);
  await loading;
  h.execute();
  assert.match(h.status.textContent, /2\.000 – 5\.000/);
  h.setQueue(async () => true);
  await h.find("Load Waveform").callback();
  assert.equal(h.queues.length, 2);
});

test("queue rejection and false results display errors and allow retry", async () => {
  const h = setup();
  h.setQueue(async () => { throw new Error("Disconnected"); });
  await h.find("Load Waveform").callback();
  assert.match(h.status.textContent, /Disconnected/);
  h.setQueue(async () => false);
  await h.find("Load Waveform").callback();
  assert.match(h.status.textContent, /Could not queue waveform/);
  h.setQueue(async () => true);
  await h.find("Load Waveform").callback();
  assert.equal(h.queues.length, 3);
});

test("resize redraws at device scale and removal releases handlers, observer and callbacks", async () => {
  const h = setup();
  h.execute();
  h.canvas.clientWidth = 400;
  h.observers[0].callback([]);
  assert.equal(h.canvas.width, 800);
  assert.deepEqual(Array.from(h.highlight().args), [10, 0, 380, 108]);
  h.canvas.dispatch("pointerdown", 0.2);
  assert.equal(h.node.onRemoved("remove-marker"), "removed-result");
  assert.equal(h.canvas.captures.size, 0);
  assert.equal(h.canvas.handlers.size, 0);
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.find("start_seconds").callback, h.find("start_seconds").originalCallback);
  const count = h.commands.length;
  h.observers[0].callback([]);
  await h.find("Load Waveform").callback();
  assert.equal(h.commands.length, count);
  assert.equal(h.queues.length, 0);
  assert.deepEqual(h.node.hooks.at(-1)[2], ["remove-marker"]);
});

test("nodes keep independent waveform, selection, and lifecycle state", () => {
  const h = setup();
  h.execute();
  h.drag(0.2, 0.7);
  const other = new h.Node();
  other.onNodeCreated();
  other.onExecuted({ range_waveform: [{ minmax: [[[-0.5, 0.5]]], sample_rate: 2, total_samples: 4, duration: 2 }] });
  assert.deepEqual(other.widgets.slice(0, 2).map((widget) => widget.value), [0, 0]);
  assert.deepEqual(h.selection(), [2, 7]);
  other.onRemoved();
  h.drag(0.7, 0.9);
  assert.deepEqual(h.selection(), [2, 9]);
});
