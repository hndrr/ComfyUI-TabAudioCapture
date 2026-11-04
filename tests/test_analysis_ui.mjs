import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../web/audio_analysis_views.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "");

function setup(name) {
  let extension, drawCalls = 0, queueArgs = null, disconnected = false;
  const context = {
    setTransform() {}, fillRect() { drawCalls++; }, beginPath() {}, moveTo() {},
    lineTo() {}, stroke() {}, fillText() {},
  };
  function element(tag) {
    return {
      tag, style: {}, textContent: "", children: [], clientWidth: 350,
      append(...children) { this.children.push(...children); },
      setAttribute(k, v) { this[k] = v; },
      getContext: tag === "canvas" ? () => context : undefined,
    };
  }
  class ResizeObserver {
    observe() {}
    disconnect() { disconnected = true; }
  }
  const app = {
    registerExtension(result) { extension = result; },
    async queuePrompt(...args) { queueArgs = args; return true; },
  };
  vm.runInNewContext(script, {
    app, document: {createElement: element}, ResizeObserver,
    window: {devicePixelRatio: 1}, URL, Array, Math, Number,
  });
  const nodeType = {prototype: {}};
  extension.beforeRegisterNodeDef(nodeType, {name});
  const node = Object.create(nodeType.prototype);
  node.id = 42; node.size = [300, 180]; node.widgets = [];
  node.computeSize = () => [350, 240]; node.setSize = size => { node.size = size; };
  node.setDirtyCanvas = () => {};
  node.addDOMWidget = (name, type, element, options) => {
    const result = {name, type, element, options};
    node.widgets.push(result);
    return result;
  };
  node.addWidget = (type, name, value, callback, options) => {
    const result = {type, name, value, callback, options};
    node.widgets.push(result);
    return result;
  };
  node.onNodeCreated?.();
  const widget = node.widgets.find(item => item.type === "audioLoopPreview" ||
    item.type === "audioFeaturePreview");
  const button = node.widgets.find(item => item.type === "button");
  return {node, widget, button, drawCount: () => drawCalls,
    disconnected: () => disconnected, queued: () => queueArgs};
}

test("loop preview is drawn using actual server waveform and range", async () => {
  const x = setup("TabAudioLoopCapture");
  assert.ok(x.widget && x.button);
  assert.equal(x.widget.serialize, false);
  assert.equal(x.widget.element.children[2], undefined);
  x.node.onExecuted({
    loop_preview: [{
      minmax: [[-0.2, 0.4], [-0.3, 0.7], [-0.4, 0.1]],
      total_seconds: 12, start_seconds: 4, end_seconds: 12,
      duration_seconds: 8, first_batch_only: false,
    }],
  });
  assert.ok(x.drawCount() > 0);
  assert.match(x.widget.element.children[1].textContent, /4.00–12.00 s/);
  await x.button.callback();
  assert.equal(JSON.stringify(x.queued()), JSON.stringify([0, 1, ["42"]]));
  x.node.onRemoved();
  assert.ok(x.disconnected());
});

test("feature curves and summaries use analysis payload", () => {
  const x = setup("TabAudioFeatureExtractor");
  const [canvas, info, json] = x.widget.element.children;
  assert.equal(canvas["aria-label"], "RMS, bass, treble and onset feature graphs");
  x.node.onExecuted({
    feature_preview: [{
      samples: [{time: 0, rms: 0.1, bass: 0.6, treble: 0.02, onset: 0},
                {time: 0.1, rms: 0.6, bass: 0.1, treble: 0.5, onset: 0.9}],
      total_frames: 1000, batch_count: 1, duration_seconds: 10,
      summary: {rms: 0.3, bass: 0.4, treble: 0.2, max_onset: 0.9},
      head_json: "[{\"rms\":0.1}]",
    }],
  });
  assert.ok(x.drawCount() > 0);
  assert.match(info.textContent, /RMS 0.300/);
  assert.match(info.textContent, /Onset 0.900/);
  assert.match(json.textContent, /1000 frames/);
  assert.match(json.textContent, /rms/);
  x.node.onRemoved();
  assert.ok(x.disconnected());
});

test("unrelated nodes are not modified", () => {
  const x = setup("OtherComfyNode");
  assert.equal(x.widget, undefined);
  assert.equal(x.button, undefined);
});
