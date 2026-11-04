import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../web/smart_capture.js", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("import.meta.url", JSON.stringify(sourceUrl.href));
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  let extension;
  const messages = [], sockets = [], tracks = [];
  function element() {
    return {
      style: {}, children: [], controls: false, src: "",
      append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; },
      load() {}, addEventListener(event, cb) { this["on" + event] = cb; },
    };
  }
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0; this.bufferedAmount = 0; this.listeners = {};
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
    }
    addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
    removeEventListener(name, callback) {
      this.listeners[name] = (this.listeners[name] || []).filter(cb => cb !== callback);
    }
    emit(name, packet = {}) {
      for (const cb of this.listeners[name] || []) cb({
        data: name === "message" ? JSON.stringify(packet) : undefined,
      });
    }
    send(data) {
      messages.push(data);
      if (typeof data !== "string") return;
      const packet = JSON.parse(data);
      if (packet.command === "start") this.emit("message", {event: "started"});
      if (packet.command === "stop") this.emit("message", {
        event: "stopped", saved_file: "tab_audio/smart_take_00001.wav",
      });
    }
    close() { this.readyState = 3; this.emit("close"); }
  }
  class Context {
    sampleRate = 8000;
    state = "running";
    audioWorklet = {addModule: async () => {}};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {value: 1}, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.state = "closed"; }
  }
  class Worklet {
    port = {onmessage: null};
    connect() {}
    disconnect() {}
  }
  const track = {stop() { this.stopped = true; }, addEventListener() {}};
  tracks.push(track);
  const stream = {getTracks: () => tracks, getAudioTracks: () => tracks};
  const widgets = [
    ["recording_file", ""], ["take_history", "[]"], ["threshold_db", -35],
    ["silence_seconds", 0.3], ["pre_roll_seconds", 1],
    ["min_sound_seconds", 0.1], ["filename_prefix", "tab_audio/smart_take"],
  ].map(([name, value]) => ({name, value}));
  const node = {
    comfyClass: "TabAudioCaptureSmart", widgets, size: [320, 200],
    setDirtyCanvas() {}, setSize(size) { this.size = size; }, computeSize() {return [370, 220];},
    addDOMWidget(name, type, element) { return {name, type, element}; },
    addWidget(type, name, value, callback) { return {type, name, value, callback, label: name}; },
  };
  vm.runInNewContext(source, {
    app: {registerExtension(x) {extension = x;}}, api: {apiURL: p => "http://localhost:8188" + p},
    document: {createElement: element}, window: {location: {href: "http://localhost:8188"}, isSecureContext: true, setTimeout, clearTimeout},
    navigator: {mediaDevices: {getDisplayMedia: async () => stream}},
    AudioContext: Context, AudioWorkletNode: Worklet,
    MediaStream: class { constructor() {} }, WebSocket: Socket,
    URL, URLSearchParams, Float32Array, Math,
    crypto: {randomUUID: () => "test-session"},
  });
  extension.nodeCreated(node);
  const state = node.__smartCapture;
  function send(rms, frames = 1024) {
    const data = new Float32Array(frames * 2);
    data.fill(rms);
    state.processor.port.onmessage({data: {type: "chunk", buffer: data.buffer}});
  }
  return {node, state, messages, sockets, send, widgets, track};
}

test("smart capture records on threshold with pre-roll, saves, and restores history", async () => {
  const x = setup();
  x.state.button.callback();
  await tick(); await tick();
  assert.equal(x.state.active, true);
  // Two 128-ms chunks cross the 100ms confirmation threshold.
  x.send(0.0);
  x.send(0.5);
  await tick(); await tick();
  assert.equal(x.sockets.length, 1);
  assert.equal(x.messages.some(m => typeof m === "string" && JSON.parse(m).command === "start"), true);
  // Pre-roll includes silence and the onset, without duplicated PCM data.
  const binary = x.messages.filter(m => m instanceof ArrayBuffer);
  assert.equal(binary.length, 2);
  x.send(0.0); x.send(0.0); x.send(0.0);
  await tick(); await tick();
  assert.equal(x.state.history.length, 1, "status=" + x.state.status.textContent + "; elapsed=" + x.state.elapsed + "; lastSound=" + x.state.lastSound + "; hasTake=" + !!x.state.take + "; websocket=" + x.state.take?.ws?.readyState);
  assert.equal(x.widgets[0].value, "tab_audio/smart_take_00001.wav");
  assert.match(x.state.player.src, /smart_take_00001.wav/);
  x.state.button.callback();
  await tick();
  assert.equal(x.state.active, false);
  assert.equal(x.track.stopped, true);
});

test("a manual stop finalizes an open take", async () => {
  const x = setup();
  x.state.button.callback();
  await tick(); await tick();
  x.send(0.6);
  await tick(); await tick();
  x.state.button.callback();
  await tick(); await tick();
  assert.equal(x.state.history.length, 1, "status=" + x.state.status.textContent + "; elapsed=" + x.state.elapsed + "; lastSound=" + x.state.lastSound + "; hasTake=" + !!x.state.take + "; websocket=" + x.state.take?.ws?.readyState);
  assert.equal(x.state.active, false);
});
