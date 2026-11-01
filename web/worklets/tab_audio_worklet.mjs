/* AudioWorklet global scope; not a regular ComfyUI frontend extension. */
class TabAudioPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 2;
    this.framesPerChunk = 2048;
    this.currentFrames = 0;
    this.packet = new Float32Array(this.framesPerChunk * this.channels);
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.sendPacket();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  sendPacket() {
    if (this.currentFrames === 0) return;
    const frames = this.currentFrames;
    const payload = frames === this.framesPerChunk
      ? this.packet
      : this.packet.slice(0, frames * this.channels);
    this.port.postMessage({ type: "chunk", buffer: payload.buffer }, [payload.buffer]);
    this.packet = new Float32Array(this.framesPerChunk * this.channels);
    this.currentFrames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const left = input[0];
    const right = input[1] || left;
    for (let i = 0; i < left.length; i++) {
      const offset = this.currentFrames * 2;
      this.packet[offset] = left[i];
      this.packet[offset + 1] = right[i];
      this.currentFrames++;
      if (this.currentFrames === this.framesPerChunk) this.sendPacket();
    }
    return true;
  }
}

registerProcessor("tab-audio-pcm-processor", TabAudioPCMProcessor);
