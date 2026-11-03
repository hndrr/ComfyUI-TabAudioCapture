import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const extensionUrl = new URL("../web/tab_audio_capture.js", import.meta.url);
const source = fs.readFileSync(extensionUrl, "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("import.meta.url", JSON.stringify(extensionUrl.href));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function element() {
  return {
    style: {}, hidden: false, classList: { add() {} },
    setAttribute() {}, append() {}, removeAttribute(name) { delete this[name]; },
    pause() { this.paused = true; }, load() { this.loaded = true; },
  };
}

function setup(mode = "record") {
  let extension;
  const requests = [];
  const captureOptions = [];
  const errors = [];
  const sent = [];
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    listeners = {};
    constructor() { queueMicrotask(() => { this.readyState = 1; this.emit("open"); }); }
    addEventListener(event, callback) { (this.listeners[event] ??= []).push(callback); }
    emit(event, packet) { for (const callback of this.listeners[event] ?? []) callback({ data: JSON.stringify(packet) }); }
    send(data) {
      sent.push(data);
      if (typeof data !== "string") return;
      const command = JSON.parse(data).command;
      if (command === "start") this.emit("message", { event: "started" });
      if (command === "stop") this.emit("message", { event: "stopped", saved_file: `music/take_00001.${find("format")?.value === "m4a" ? "m4a" : "wav"}` });
      if (command === "snapshot") this.emit("message", { event: "snapshot", snapshot_id: "snapshot-123" });
    }
    close() { this.readyState = 3; this.emit("close"); }
  }
  const connection = () => ({ connect() {}, disconnect() {} });
  class Context {
    state = "running";
    sampleRate = 48000;
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return connection(); }
    createGain() { return { ...connection(), gain: {} }; }
    async resume() {}
    async close() { this.state = "closed"; }
  }
  class Worklet {
    port = { postMessage: (message) => {
      if (message.type === "flush") {
        sent.push("flush");
        queueMicrotask(() => this.port.onmessage({ data: { type: "flushed" } }));
      } else if (message.type === "pause" || message.type === "resume") {
        sent.push(message.type);
        queueMicrotask(() => this.port.onmessage({ data: { type: message.type === "pause" ? "paused" : "resumed" } }));
      }
    } };
    connect() {}
    disconnect() {}
  }
  const navigator = { mediaDevices: { getDisplayMedia: async (options) => { captureOptions.push(options); return stream; } } };
  const api = {
    apiURL: (route) => `/api${route}`,
    fetchApi: async (route, options) => {
      requests.push([route, JSON.parse(options.body)]);
      return { ok: true, json: async () => route === "/tab_audio/save_snapshot"
        ? { saved_file: `music/latest_00001.${find("format")?.value === "m4a" ? "m4a" : "wav"}` }
        : { snapshot_id: "snapshot-123" } };
    },
  };
  vm.runInNewContext(source, {
    app: { registerExtension: (value) => { extension = value; } }, api,
    document: { createElement: element }, navigator,
    window: { location: { href: "http://localhost:8188/" }, isSecureContext: true,
      setInterval: () => 1, clearInterval() {},
      clearTimeout,
      setTimeout: (callback, delay) => setTimeout(callback, delay).unref() },
    AudioContext: Context, AudioWorkletNode: Worklet, MediaStream: class { constructor() { return stream; } },
    WebSocket: Socket, URL, URLSearchParams, crypto: { randomUUID: () => "capture-123" },
    console: { error: (...values) => errors.push(values) }, requestAnimationFrame: (callback) => callback(),
  });
  const names = mode === "record" ? ["recording_file", "filename_prefix", "format", "wav_bit_depth", "m4a_bitrate"] : ["duration_seconds", "snapshot_id", "filename_prefix", "format", "wav_bit_depth", "m4a_bitrate"];
  const values = mode === "record" ? ["", "music/take", "wav", "24-bit PCM", "256k"] : [10, "", "music/take", "wav", "24-bit PCM", "256k"];
  const node = {
    comfyClass: mode === "record" ? "TabAudioCaptureRecorder" : "TabAudioCaptureLive",
    size: [300, 180],
    outputs: mode === "record" ? [{ name: "audio", type: "AUDIO" }, { name: "saved_wav", type: "STRING", links: [7] }] : [{ name: "audio", type: "AUDIO" }],
    widgets: names.map((name, index) => ({ name, value: values[index], options: {}, computeSize: () => [300, 20], draw() {} })),
    setDirtyCanvas() {}, setSize(size) { this.size = size; },
    computeSize() { return [300, 40 + this.widgets.reduce((height, widget) => height + Math.max(0, widget.computeSize?.()[1] ?? 20), 0)]; },
    addWidget(type, name, value, callback, options) {
      const widget = { type, name, value, callback, options };
      this.widgets.push(widget); return widget;
    },
    addDOMWidget(name, type, element, options) {
      const widget = { name, type, element, options };
      this.widgets.push(widget); return widget;
    },
  };
  const find = (name) => node.widgets.find((widget) => widget.name === name);
  extension.nodeCreated(node);
  return { node, find, state: node.__tabAudioState, navigator, stream, track, sent, requests, captureOptions, errors, api };
}

for (const mode of ["record", "live"]) {
  test(`${mode}: capture picker offers tab and system audio`, async () => {
    const { state, captureOptions } = setup(mode);
    state.button.callback();
    assert.match(state.statusWidget.textContent, /Chrome Tab.*Entire Screen/);
    await tick();
    assert.equal(captureOptions[0].video.displaySurface, "browser");
    assert.notEqual(captureOptions[0].preferCurrentTab, true);
    assert.equal(captureOptions[0].selfBrowserSurface, "include");
    assert.equal(captureOptions[0].audio.suppressLocalAudioPlayback, false);
    assert.equal(captureOptions[0].systemAudio, "include");
    state.button.callback();
    await tick();
  });
}

test("the existing recorder accepts entire-screen audio", async () => {
  const { state, stream } = setup();
  stream.getVideoTracks = () => [{ getSettings: () => ({ displaySurface: "monitor" }) }];
  state.button.callback();
  await tick();
  assert.equal(state.active, true);
  state.button.callback();
  await tick();
  assert.match(state.player.src, /take_00001.wav/);
});

test("missing audio explains both sharing choices and releases the capture", async () => {
  const { state, stream, track } = setup();
  stream.getAudioTracks = () => [];
  state.button.callback();
  await tick();
  assert.equal(state.active, false);
  assert.equal(state.busy, false);
  assert.equal(track.stopped, true);
  assert.match(state.statusWidget.textContent, /Share tab audio.*Share system audio/);
});

test("one native recording button, format visibility, and restored preview", () => {
  const { node, find, state } = setup();
  assert.equal(node.widgets.filter((widget) => widget.type === "audiorecord").length, 1);
  assert.equal(find("recording_file").hidden, true);
  assert.equal(find("capture_audio").serialize, false);
  assert.equal(state.player.controls, true);
  assert.equal(node.outputs[1].name, "saved_file_path");
  const wavHeight = node.size[1];
  for (const format of ["original", "m4a", "wav", "original"]) {
    find("format").value = format;
    find("format").callback();
    assert.equal(find("wav_bit_depth").hidden, format !== "wav");
    assert.equal(find("m4a_bitrate").hidden, format !== "m4a");
  }
  assert.ok(node.size[1] < wavHeight);
  find("recording_file").value = "music/take_00001.m4a";
  node.outputs[1].name = "saved_wav";
  node.onConfigure();
  assert.equal(node.outputs[1].name, "saved_file_path");
  assert.deepEqual(node.outputs[1].links, [7]);
  assert.equal(state.player.src, "http://localhost:8188/api/view?filename=take_00001.m4a&subfolder=music&type=output");
});

for (const format of ["original", "wav", "m4a"]) {
  test(`${format}: start, forward PCM, flush before stop, save path, and preview`, async () => {
    const { find, state, sent, track } = setup();
    find("format").value = format;
    state.button.callback();
    await tick();
    assert.equal(state.active, true);
    assert.equal(state.button.label, "Stop & Save");
    const start = JSON.parse(sent[0]);
    assert.equal(start.filename_prefix, "music/take");
    assert.equal(start.format, format);
    assert.equal(start.wav_bit_depth, "24-bit PCM");
    assert.equal(start.m4a_bitrate, "256k");
    const pcm = new Float32Array([0.1, -0.1, 0.2, -0.2]).buffer;
    state.processor.port.onmessage({ data: { type: "chunk", buffer: pcm } });
    assert.equal(sent[1], pcm);
    state.button.callback();
    await tick();
    assert.equal(sent[2], "flush");
    assert.equal(JSON.parse(sent[3]).command, "stop");
    assert.equal(state.active, false);
    assert.equal(state.stopping, false);
    assert.equal(state.button.label, "Start Recording");
    assert.equal(track.stopped, true);
    const filename = `take_00001.${format === "m4a" ? "m4a" : "wav"}`;
    assert.equal(find("recording_file").value, `music/${filename}`);
    assert.equal(state.player.src, `http://localhost:8188/api/view?filename=${filename}&subfolder=music&type=output`);
    assert.match(state.statusWidget.textContent, /Saved:/);
  });
}

test("failed sharing releases the button and allows another attempt", async () => {
  const { state, navigator } = setup();
  navigator.mediaDevices.getDisplayMedia = async () => { throw new Error("Permission denied"); };
  state.button.callback();
  await tick();
  assert.equal(state.busy, false);
  assert.equal(state.active, false);
  assert.equal(state.button.label, "Start Recording");
  assert.match(state.statusWidget.textContent, /Permission denied/);
});

test("server errors cannot inject console lines and preserve the status text", async () => {
  const { state, errors } = setup();
  state.button.callback();
  await tick();
  const message = "Capture failed\r\n[INFO] done\u2028next\u2029line";
  state.socket.emit("message", { event: "error", message });
  assert.deepEqual(errors, [["[Tab Audio Capture]", "Capture failed  [INFO] done next line"]]);
  assert.equal(state.statusWidget.textContent, `Error: ${message}`);
  state.button.callback();
  await tick();
});

test("live queue snapshot uses selected duration and updates its preview", async () => {
  const { state, find, requests } = setup("live");
  state.sessionId = "session-123";
  find("duration_seconds").value = 5;
  assert.equal(await find("snapshot_id").serializeValue(), "snapshot-123");
  assert.equal(requests[0][1].seconds, 5);
  assert.equal(state.player.src, "http://localhost:8188/api/tab_audio/preview/snapshot-123");
});

function processor() {
  let Processor;
  const packets = [];
  vm.runInNewContext(fs.readFileSync(new URL("../web/worklets/tab_audio_worklet.mjs", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class { port = { postMessage: (packet) => packets.push(packet) }; },
    registerProcessor: (_name, value) => { Processor = value; },
  });
  return { instance: new Processor(), packets };
}

test("worklet preserves stereo order across a full packet and the final partial packet", () => {
  const { instance, packets } = processor();
  const left = Float32Array.from({ length: 2049 }, (_, index) => index / 4096);
  const right = Float32Array.from(left, (value) => -value);
  assert.equal(instance.process([[left, right]]), true);
  instance.port.onmessage({ data: { type: "flush" } });
  const chunks = packets.filter((packet) => packet.type === "chunk");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].buffer.byteLength, 2048 * 2 * 4);
  assert.equal(chunks[1].buffer.byteLength, 2 * 4);
  const recorded = [...new Float32Array(chunks[0].buffer), ...new Float32Array(chunks[1].buffer)];
  for (let frame = 0; frame < left.length; frame++) {
    assert.equal(recorded[frame * 2], left[frame]);
    assert.equal(recorded[frame * 2 + 1], right[frame]);
  }
  assert.equal(packets.at(-1).type, "flushed");
});

test("worklet duplicates mono and does not resend audio after a second flush", () => {
  const { instance, packets } = processor();
  instance.process([[new Float32Array([0.25, -0.5])]]);
  instance.port.onmessage({ data: { type: "flush" } });
  instance.port.onmessage({ data: { type: "flush" } });
  const chunks = packets.filter((packet) => packet.type === "chunk");
  assert.equal(chunks.length, 1);
  assert.deepEqual([...new Float32Array(chunks[0].buffer)], [0.25, 0.25, -0.5, -0.5]);
});

test("worklet pause flushes the boundary, excludes paused audio, and resumes without duplication", () => {
  const { instance, packets } = processor();
  instance.process([[new Float32Array([0.1, 0.2])]]);
  instance.port.onmessage({ data: { type: "pause" } });
  assert.equal(packets.at(-1).type, "paused");
  instance.process([[new Float32Array([0.9, 0.8, 0.7])]]);
  instance.port.onmessage({ data: { type: "flush" } });
  instance.port.onmessage({ data: { type: "resume" } });
  assert.equal(packets.at(-1).type, "resumed");
  instance.process([[new Float32Array([0.3])]]);
  instance.port.onmessage({ data: { type: "flush" } });
  const actual = packets.filter((packet) => packet.type === "chunk").flatMap((packet) => [...new Float32Array(packet.buffer)]);
  assert.deepEqual(actual, [...new Float32Array([0.1, 0.1, 0.2, 0.2, 0.3, 0.3])]);
});

test("recorder pause retains capture, counts recorded frames, and can save while paused", async () => {
  const { state, track, sent } = setup();
  assert.equal(state.pauseButton.disabled, true);
  state.button.callback();
  await tick();
  const context = state.context;
  const socket = state.socket;
  state.processor.port.onmessage({ data: { type: "chunk", buffer: new Float32Array(96000).buffer } });
  assert.equal(state.recordedFrames, 48000);
  state.pauseButton.callback();
  state.pauseButton.callback();
  await tick();
  assert.equal(state.paused, true);
  assert.equal(state.pauseButton.label, "Resume Recording");
  assert.match(state.statusWidget.textContent, /Paused 0:01/);
  assert.equal(sent.filter((entry) => entry === "pause").length, 1);
  assert.equal(state.context, context);
  assert.equal(state.socket, socket);
  assert.equal(track.stopped, false);
  state.button.callback();
  await tick();
  assert.equal(state.active, false);
  assert.equal(state.paused, false);
  assert.equal(state.pauseButton.disabled, true);
  assert.match(state.player.src, /take_00001.wav/);
});

test("recorder resume uses the same sharing session", async () => {
  const { state, captureOptions, track } = setup();
  state.button.callback();
  await tick();
  state.pauseButton.callback();
  await tick();
  state.pauseButton.callback();
  await tick();
  assert.equal(state.paused, false);
  assert.equal(state.pauseButton.label, "Pause Recording");
  assert.equal(captureOptions.length, 1);
  assert.equal(track.stopped, false);
  state.button.callback();
  await tick();
});

for (const format of ["original", "wav", "m4a"]) {
  test(`live ${format}: freeze before encoding and continue capture after saving`, async () => {
    const { state, find, sent, requests, track } = setup("live");
    assert.equal(state.pauseButton, null);
    assert.equal(state.saveButton.disabled, true);
    find("format").value = format;
    find("duration_seconds").value = 7.5;
    state.button.callback();
    await tick();
    const context = state.context;
    state.saveButton.callback();
    state.saveButton.callback();
    await tick();
    assert.equal(sent[1], "flush");
    assert.deepEqual(JSON.parse(sent[2]), { command: "snapshot", seconds: 7.5 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], "/tab_audio/save_snapshot");
    assert.equal(requests[0][1].format, format);
    assert.equal(requests[0][1].snapshot_id, "snapshot-123");
    assert.equal(state.active, true);
    assert.equal(state.context, context);
    assert.equal(track.stopped, false);
    assert.equal(state.saving, false);
    assert.match(state.player.src, new RegExp(`latest_00001.${format === "m4a" ? "m4a" : "wav"}`));
    const pcm = new Float32Array([0.4, 0.5]).buffer;
    state.processor.port.onmessage({ data: { type: "chunk", buffer: pcm } });
    assert.equal(sent.at(-1), pcm);
    state.button.callback();
    await tick();
  });
}

test("live save errors preserve capture and allow retry", async () => {
  const { state, api, track } = setup("live");
  state.button.callback();
  await tick();
  const fetchApi = api.fetchApi;
  api.fetchApi = async () => ({ ok: false, status: 400, json: async () => ({ error: "Invalid save options" }) });
  state.saveButton.callback();
  await tick();
  assert.equal(state.active, true);
  assert.equal(track.stopped, false);
  assert.equal(state.saving, false);
  assert.match(state.statusWidget.textContent, /Invalid save options/);
  api.fetchApi = fetchApi;
  state.saveButton.callback();
  await tick();
  assert.match(state.statusWidget.textContent, /Saved:/);
  state.button.callback();
  await tick();
});

test("live can save the retained buffer after stopping", async () => {
  const { state, requests } = setup("live");
  state.button.callback();
  await tick();
  state.button.callback();
  await tick();
  assert.equal(state.saveButton.disabled, false);
  state.saveButton.callback();
  await tick();
  assert.equal(requests.at(-2)[0], "/tab_audio/snapshot");
  assert.equal(requests.at(-1)[0], "/tab_audio/save_snapshot");
  assert.equal(state.active, false);
  assert.match(state.player.src, /latest_00001.wav/);
});
