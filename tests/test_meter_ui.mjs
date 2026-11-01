import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/audio_meter.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "");

function element(tag) {
  return {
    tag, style: {}, attributes: {}, children: [], textContent: "",
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
  };
}

// A small signal graph models speaker mono upmix and the splitter's discrete
// outputs, so channel tests exercise the connections rather than canned values.
function captureNode(id = 1, type = "TabAudioCaptureRecorder", samples = [[-0.5, 0.1], [0.125, -0.25]]) {
  const audioNodes = [];
  const disconnects = [];
  const context = {
    state: "running", currentTime: 0, closeCalls: 0, resumeCalls: 0,
    close() { this.closeCalls++; }, resume() { this.resumeCalls++; },
    createGain() { return audioNode("gain"); },
    createChannelSplitter(channels) {
      assert.equal(channels, 2);
      return audioNode("splitter");
    },
    createAnalyser() {
      const node = audioNode("analyser");
      node.fftSize = 2048;
      node.reads = 0;
      node.getFloatTimeDomainData = (buffer) => {
        node.reads++;
        const samples = node.signal()[0] ?? [0];
        for (let index = 0; index < buffer.length; index++) buffer[index] = samples[index % samples.length];
      };
      return node;
    },
  };
  function audioNode(kind) {
    const node = {
      kind, context, incoming: [], outgoing: [],
      connect(destination, output = 0, input = 0) {
        if (this.failConnect) throw new Error("Connect failed");
        const edge = { source: this, destination, output, input };
        this.outgoing.push(edge);
        destination.incoming.push(edge);
      },
      disconnect(...args) {
        disconnects.push({ source: this, args });
        assert.ok(args[0], "cleanup must always name its destination");
        this.outgoing = this.outgoing.filter((edge) => {
          const match = edge.destination === args[0]
            && (args.length < 2 || edge.output === args[1])
            && (args.length < 3 || edge.input === args[2]);
          if (match) edge.destination.incoming = edge.destination.incoming.filter((other) => other !== edge);
          return !match;
        });
        if (this.failDisconnect) throw new Error("Already disconnected");
      },
      signal(output = 0) {
        if (kind === "source") return this.samples;
        const edge = this.incoming[0];
        if (!edge) return [[0]];
        const channels = edge.source.signal(edge.output);
        if (kind === "gain" && this.channelCount === 2 && this.channelCountMode === "explicit"
          && this.channelInterpretation === "speakers" && channels.length === 1) return [channels[0], channels[0]];
        if (kind === "splitter") return [channels[output] ?? [0]];
        return channels;
      },
    };
    audioNodes.push(node);
    return node;
  }
  const source = audioNode("source");
  source.samples = samples;
  const processor = audioNode("worklet");
  processor.port = { messages: [], postMessage(message) { this.messages.push(message); } };
  source.connect(processor);
  const track = { readyState: "live", stopCalls: 0, stop() { this.stopCalls++; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const capture = { active: true, context, source, stream, processor, paused: false };
  const node = { id, comfyClass: type, outputs: [{ type: "AUDIO" }, { type: "STRING" }], __tabAudioState: capture };
  return { node, capture, context, source, processor, stream, track, audioNodes, disconnects };
}

function setup(capture = captureNode()) {
  let extension;
  let nextTimer = 0;
  const timers = new Map();
  const hookCalls = [];
  const graph = {
    links: {}, nodes: new Map(),
    getNodeById(id) { return this.nodes.get(id); },
  };
  const app = { registerExtension(value) { extension = value; } };
  // No api/queue/media-device/context-creation globals: attempting to use any
  // would fail these tests instead of silently making a network/capture call.
  vm.runInNewContext(source, {
    app, document: { createElement: element },
    window: {
      setInterval(callback, delay) {
        assert.equal(delay, 50);
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearInterval(id) { timers.delete(id); },
    },
  });
  function makeMeter(id = 10) {
    const node = {
      id, graph, comfyClass: "TabAudioMeter", size: [260, 120],
      inputs: [{ name: "audio", type: "AUDIO", link: null }], outputs: [{ name: "audio", type: "AUDIO" }], widgets: [],
      getInputLink(slot) { return graph.links[this.inputs[slot]?.link] ?? null; },
      computeSize() { return [260, 120]; }, setSize(size) { this.size = size; },
      addDOMWidget(name, type, element, options) {
        const widget = { name, type, element, options };
        this.widgets.push(widget);
        return widget;
      },
      onAdded(...args) { hookCalls.push([this, "added", args]); return "added"; },
      onConfigure(...args) { hookCalls.push([this, "configure", args]); return "configured"; },
      onConnectionsChange(...args) { hookCalls.push([this, "connection", args]); return "connected"; },
      onRemoved(...args) { hookCalls.push([this, "removed", args]); return "removed"; },
    };
    graph.nodes.set(id, node);
    extension.nodeCreated(node);
    return node;
  }
  function addCapture(next) { graph.nodes.set(next.node.id, next.node); }
  addCapture(capture);
  const node = makeMeter();
  let nextLink = 0;
  function connect(upstream = capture.node, target = node, output = 0) {
    const id = ++nextLink;
    graph.links[id] = { id, origin_id: upstream.id, origin_slot: output, target_id: target.id, target_slot: 0, type: "AUDIO" };
    target.inputs[0].link = id;
    target.onConnectionsChange?.(1, 0, true, graph.links[id]);
    return id;
  }
  function poll(seconds = 0.05) {
    for (const entry of graph.nodes.values()) {
      if (entry.__tabAudioState?.context) entry.__tabAudioState.context.currentTime += seconds;
    }
    for (const callback of [...timers.values()]) callback();
  }
  return { extension, node, state: node.__tabAudioMeter, graph, timers, hookCalls, capture,
    connect, poll, makeMeter, addCapture };
}

function assertCaptureIntact(capture) {
  assert.ok(capture.source.outgoing.some((edge) => edge.destination === capture.processor));
  assert.equal(capture.track.stopCalls, 0);
  assert.equal(capture.context.closeCalls, 0);
  assert.equal(capture.context.resumeCalls, 0);
  assert.equal(capture.processor.port.messages.length, 0);
}

test("only the meter gets two bars and status, without serialized controls", () => {
  const { extension, node, state, timers } = setup();
  const other = { comfyClass: "TabAudioCaptureRecorder" };
  extension.nodeCreated(other);
  assert.equal(other.__tabAudioMeter, undefined);
  extension.nodeCreated(node);
  assert.equal(node.widgets.length, 1);
  assert.equal(timers.size, 1);
  assert.equal(node.widgets[0].serialize, false);
  assert.equal(node.widgets[0].options.margin, 0);
  assert.equal(node.widgets[0].options.getMinHeight(), 76);
  assert.equal(node.widgets[0].options.getMaxHeight(), 76);
  assert.equal(node.widgets[0].options.serialize, false);
  assert.equal(state.container.children.length, 3);
  assert.equal(state.channels.length, 2);
  assert.match(state.container.style.cssText, /var\(--input-text/);
  assert.match(state.status.textContent, /Not connected/);
  for (const channel of state.channels) {
    assert.equal(channel.value.textContent, "—");
    assert.equal(channel.fill.style.width, "0%");
    assert.equal(channel.bar.attributes["aria-valuenow"], undefined);
  }
});

for (const type of ["TabAudioCaptureRecorder", "TabAudioCaptureLive"]) {
  test(`${type}: separate signed L/R sample peaks without queueing or changing capture`, () => {
    const capture = captureNode(1, type);
    Object.freeze(capture.capture);
    const { connect, poll, state } = setup(capture);
    connect();
    poll();
    assert.equal(state.channels[0].value.textContent, "-6.0 dBFS");
    assert.equal(state.channels[1].value.textContent, "-12.0 dBFS");
    assert.match(state.status.textContent, /Monitoring/);
    assert.ok(parseFloat(state.channels[0].fill.style.width) > parseFloat(state.channels[1].fill.style.width));
    const branch = state.branch;
    for (let i = 0; i < 20; i++) poll();
    assert.equal(state.branch, branch);
    assert.equal(capture.audioNodes.filter((node) => node.kind === "analyser").length, 2);
    assert.equal(capture.source.outgoing.length, 2);
    assertCaptureIntact(capture);
  });
}

test("mono is upmixed to dual mono without relying on track channel metadata", () => {
  const capture = captureNode(1, "TabAudioCaptureLive", [[0.125, -0.5]]);
  const { connect, state } = setup(capture);
  connect();
  assert.equal(state.channels[0].value.textContent, "-6.0 dBFS");
  assert.equal(state.channels[1].value.textContent, "-6.0 dBFS");
  assertCaptureIntact(capture);
});

test("discovery uses the installed getInputLink API rather than deprecated input.link access", () => {
  const { node, graph, connect, poll, state } = setup();
  const id = connect();
  node.getInputLink = (slot) => {
    assert.equal(slot, 0);
    return graph.links[id];
  };
  Object.defineProperty(node.inputs[0], "link", {
    get() { throw new Error("Deprecated input.link read"); },
  });
  poll();
  assert.equal(state.status.textContent, "Monitoring");
});

test("zero samples display real negative infinity and silence needs two continuous seconds on both channels", () => {
  const { connect, poll, state, capture } = setup();
  capture.source.samples = [[0], [0]];
  connect();
  assert.equal(state.channels[0].value.textContent, "−∞ dBFS");
  poll(1.99);
  assert.equal(state.status.textContent, "Monitoring");
  poll(0.01);
  assert.match(state.status.textContent, /^Silence/);
  capture.source.samples = [[0], [0.01]];
  poll();
  assert.equal(state.status.textContent, "Monitoring");
  assert.equal(state.quietSince, null);
  capture.source.samples = [[0.01], [0]];
  poll(3);
  assert.equal(state.status.textContent, "Monitoring");
  capture.source.samples = [[0], [0]];
  poll();
  poll(1.99);
  assert.equal(state.status.textContent, "Monitoring");
  poll(0.02);
  assert.match(state.status.textContent, /^Silence/);
});

test("unchanged waiting status avoids DOM writes and monitoring still updates levels", () => {
  const capture = captureNode();
  capture.capture.active = false;
  const h = setup(capture);
  h.connect();
  let text = h.state.status.textContent;
  let writes = 0;
  Object.defineProperty(h.state.status, "textContent", {
    get() { return text; },
    set(value) { text = value; writes++; },
  });
  h.poll();
  h.poll();
  assert.equal(writes, 0);
  capture.capture.active = true;
  h.poll();
  assert.equal(writes, 1);
  capture.source.samples = [[0.9], [0.1]];
  h.poll();
  assert.equal(writes, 2);
  assert.match(h.state.channels[0].value.textContent, /-0\.9 dBFS/);
  capture.capture.active = false;
  h.poll();
  assert.equal(writes, 3);
  assert.ok(h.state.channels.every((channel) => channel.value.textContent === "—" && channel.fill.style.width === "0%"));
  h.poll();
  assert.equal(writes, 3);
});

test("peaks at and above full scale retain dBFS readings and clamp only bar length", () => {
  const capture = captureNode(1, "TabAudioCaptureRecorder", [[-1], [2]]);
  const { connect, state } = setup(capture);
  connect();
  assert.equal(state.channels[0].value.textContent, "0.0 dBFS");
  assert.equal(state.channels[1].value.textContent, "6.0 dBFS");
  assert.equal(state.channels[0].fill.style.width, "100%");
  assert.equal(state.channels[1].fill.style.width, "100%");
  assert.match(state.channels[1].fill.style.background, /red/);
});

test("capture idle, ended tracks and suspended/interrupted/closed contexts never show silence or stale readings", () => {
  const { connect, poll, state, capture } = setup();
  capture.capture.active = false;
  connect();
  poll(10);
  assert.equal(state.branch, null);
  assert.match(state.status.textContent, /Waiting for capture/);
  capture.capture.active = true;
  poll();
  assert.ok(state.branch);
  for (const contextState of ["suspended", "interrupted", "closed"]) {
    capture.context.state = contextState;
    poll(10);
    assert.match(state.status.textContent, new RegExp(contextState));
    assert.equal(state.branch, null);
    assert.equal(state.quietSince, null);
    assert.equal(state.channels[0].value.textContent, "—");
    assert.equal(state.channels[1].fill.style.width, "0%");
    assertCaptureIntact(capture);
    capture.context.state = "running";
    poll();
  }
  capture.track.readyState = "ended";
  poll(10);
  assert.equal(state.branch, null);
  assert.match(state.status.textContent, /Waiting for capture/);
  assertCaptureIntact(capture);
});

test("late capture UI initialization and stopped/cleared shared state display waiting and release the old branch", () => {
  const { state, capture, connect, poll } = setup();
  delete capture.node.__tabAudioState;
  connect();
  assert.equal(state.status.textContent, "Waiting for capture");
  capture.node.__tabAudioState = capture.capture;
  poll();
  assert.ok(state.branch);
  capture.capture.active = false;
  capture.capture.source = null;
  capture.capture.context = null;
  capture.capture.stream = null;
  capture.capture.processor = null;
  poll(10);
  assert.equal(state.branch, null);
  assert.equal(state.status.textContent, "Waiting for capture");
  assert.equal(state.quietSince, null);
  assert.ok(state.channels.every((channel) => channel.value.textContent === "—"));
  assert.equal(capture.source.outgoing.length, 1);
  assertCaptureIntact(capture);
});

test("silence timer restarts after context suspension and capture pause does not affect monitoring", () => {
  const { connect, poll, state, capture } = setup();
  capture.source.samples = [[0], [0]];
  connect();
  poll(1.9);
  capture.context.state = "suspended";
  poll(20);
  capture.context.state = "running";
  capture.capture.paused = true;
  poll();
  assert.equal(state.status.textContent, "Monitoring");
  poll(1.9);
  assert.equal(state.status.textContent, "Monitoring");
  poll(0.2);
  assert.match(state.status.textContent, /^Silence/);
  capture.source.samples = [[0.25], [-0.5]];
  poll();
  assert.equal(state.channels[0].value.textContent, "-12.0 dBFS");
  assert.equal(state.channels[1].value.textContent, "-6.0 dBFS");
  assert.equal(state.status.textContent, "Monitoring");
  assertCaptureIntact(capture);
});

test("disconnect and reconnect replace only owned edges, including when upstream already disconnected", () => {
  const { node, state, connect, capture, poll } = setup();
  connect();
  const first = state.branch;
  capture.source.failDisconnect = true;
  node.inputs[0].link = null;
  node.onConnectionsChange(1, 0, false, null);
  assert.equal(state.branch, null);
  assert.equal(capture.source.outgoing.length, 1);
  assert.match(state.status.textContent, /Not connected/);
  assert.equal(state.channels[0].value.textContent, "—");
  assert.equal(first.edges[0][0].outgoing.length, 0);
  assertCaptureIntact(capture);
  capture.source.failDisconnect = false;
  connect();
  poll();
  assert.notEqual(state.branch, first);
  assert.equal(capture.source.outgoing.length, 2);
  node.onRemoved();
  assert.equal(capture.source.outgoing.length, 1);
  assertCaptureIntact(capture);
});

test("changing upstream nodes, deleting the capture, and restarting capture are detected by polling", () => {
  const { node, state, graph, connect, addCapture, poll, capture } = setup();
  connect();
  const second = captureNode(2, "TabAudioCaptureLive", [[0.125], [1]]);
  addCapture(second);
  const link = graph.links[node.inputs[0].link];
  link.origin_id = second.node.id; // Simulates an upstream reroute change.
  poll();
  assert.equal(capture.source.outgoing.length, 1);
  assert.equal(state.branch.source, second.source);
  assert.equal(state.channels[1].value.textContent, "0.0 dBFS");
  const restarted = captureNode(2, "TabAudioCaptureLive", [[0.25], [0.5]]);
  Object.assign(second.capture, restarted.capture);
  poll();
  assert.equal(second.source.outgoing.length, 1);
  assert.equal(state.branch.source, restarted.source);
  assert.equal(state.channels[0].value.textContent, "-12.0 dBFS");
  graph.nodes.delete(2);
  poll();
  assert.equal(restarted.source.outgoing.length, 1);
  assert.equal(state.branch, null);
  assert.match(state.status.textContent, /Not connected/);
  for (const item of [capture, second, restarted]) assertCaptureIntact(item);
});

test("changes to source, context, stream or processor detach and rebuild the meter branch", () => {
  for (const key of ["source", "context", "stream", "processor"]) {
    const { connect, poll, state, capture } = setup();
    connect();
    const first = state.branch;
    const replacement = captureNode(2);
    capture.capture[key] = replacement.capture[key];
    poll();
    assert.notEqual(state.branch, first, key);
    assert.equal(state.branch[key], replacement.capture[key]);
    assertCaptureIntact(capture);
    assertCaptureIntact(replacement);
  }
});

test("two meters have independent branches and removing one preserves the other and recorder", () => {
  const { node, state, connect, makeMeter, timers, poll, capture } = setup();
  const other = makeMeter(11);
  connect();
  connect(capture.node, other);
  assert.equal(capture.source.outgoing.length, 3);
  const remaining = other.__tabAudioMeter.branch;
  node.onRemoved();
  assert.equal(timers.size, 1);
  assert.equal(state.branch, null);
  poll();
  assert.equal(other.__tabAudioMeter.branch, remaining);
  assert.equal(other.__tabAudioMeter.channels[0].value.textContent, "-6.0 dBFS");
  assert.equal(capture.source.outgoing.length, 2);
  other.onRemoved();
  assert.equal(timers.size, 0);
  assert.equal(capture.source.outgoing.length, 1);
  assertCaptureIntact(capture);
});

test("creation, configure, connection, removal and re-add preserve original hooks and timer ownership", () => {
  const { node, state, connect, poll, timers, hookCalls } = setup();
  assert.equal(node.onAdded(node.graph), "added");
  assert.equal(timers.size, 1);
  connect();
  const branch = state.branch;
  assert.equal(node.onConfigure({ id: 10 }), "configured");
  assert.notEqual(state.branch, branch);
  assert.equal(node.onConnectionsChange(2, 0, true, {}), "connected");
  const afterConfigure = state.branch;
  assert.equal(node.onRemoved("reason"), "removed");
  assert.equal(timers.size, 0);
  node.onRemoved();
  poll();
  assert.equal(state.branch, null);
  assert.equal(node.onAdded(node.graph), "added");
  assert.equal(timers.size, 1);
  assert.ok(state.branch);
  assert.notEqual(state.branch, afterConfigure);
  assert.ok(hookCalls.every(([receiver]) => receiver === node));
  const configureCall = hookCalls.find(([, hook]) => hook === "configure");
  assert.deepEqual(configureCall[2], [{ id: 10 }]);
  assert.deepEqual(hookCalls.find(([, hook]) => hook === "removed")[2], ["reason"]);
});

test("known Reroute and AUDIO meter passthrough discovery works; cycles, transforms and STRING outputs do not", () => {
  const { node, state, graph, connect, poll, capture } = setup();
  const reroute = {
    id: 20, type: "Reroute", inputs: [{ link: null }], outputs: [{ type: "*" }],
    getInputLink(slot) { return graph.links[this.inputs[slot]?.link] ?? null; },
  };
  graph.nodes.set(20, reroute);
  connect(capture.node, reroute);
  connect(reroute);
  assert.ok(state.branch);
  reroute.type = "AudioAdjustVolume";
  poll();
  assert.equal(state.branch, null);
  assert.match(state.status.textContent, /Not connected/);
  reroute.type = "TabAudioMeter";
  reroute.inputs[0].name = "audio";
  poll();
  assert.ok(state.branch);
  connect(reroute, reroute);
  poll();
  assert.equal(state.branch, null);
  connect(capture.node, node, 1);
  assert.equal(state.branch, null);
  connect();
  delete graph.links[node.inputs[0].link];
  poll();
  assert.equal(state.branch, null);
  assertCaptureIntact(capture);
});

test("failed branch construction cleans up, does not retry continuously, and recovers on capture restart", () => {
  const { state, connect, poll, capture } = setup();
  capture.source.failConnect = true;
  connect();
  assert.equal(state.branch, null);
  assert.match(state.status.textContent, /unavailable/);
  assert.equal(state.channels[0].value.textContent, "—");
  const count = capture.audioNodes.length;
  for (let i = 0; i < 20; i++) poll();
  assert.equal(capture.audioNodes.length, count);
  assert.ok(capture.audioNodes.filter((node) => !["source", "worklet"].includes(node.kind)).every((node) => node.outgoing.length === 0));
  assertCaptureIntact(capture);
  const replacement = captureNode(1);
  Object.assign(capture.capture, replacement.capture);
  poll();
  assert.ok(state.branch);
  assert.equal(state.status.textContent, "Monitoring");
  assertCaptureIntact(replacement);
});

test("analyser failures clear both channels and detach without reporting silence", () => {
  const { connect, poll, state, capture } = setup();
  connect();
  state.branch.analysers[1].getFloatTimeDomainData = () => { throw new Error("Context ended"); };
  poll(10);
  assert.equal(state.branch, null);
  assert.match(state.status.textContent, /unavailable/);
  assert.equal(state.quietSince, null);
  assert.ok(state.channels.every((channel) => channel.value.textContent === "—"));
  assert.equal(capture.source.outgoing.length, 1);
  assertCaptureIntact(capture);
});
