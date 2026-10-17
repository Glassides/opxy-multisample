// Continuous audio input capture with frame-addressed slicing.
//
// The auto-sampler records one long stream and cuts each note out of it by
// frame index, so note timing is driven by AudioContext.currentTime rather
// than by starting and stopping a recorder per note.

import { linToDb } from './process.js';

export async function listInputs() {
  // Labels are only populated after a permission grant.
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || `input ${d.deviceId.slice(0, 6)}` }));
}

export async function requestInputPermission() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
}

export class Recorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.chunks = [];       // { frame, data: Float32Array[] }
    this.frames = 0;        // frames captured so far
    this.channels = 0;
    this.capturing = false;
    this.meter = [0, 0];    // recent peak per channel (linear)
    this.onLevel = null;
  }

  get sampleRate() { return this.ctx?.sampleRate || 0; }

  async open(deviceId) {
    await this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Chrome-specific: keep the raw signal.
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
      },
    });
    const track = this.stream.getAudioTracks()[0];
    const settings = track.getSettings();
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: settings.sampleRate || undefined });
    await this.ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.channels = Math.min(2, this.source.channelCount || settings.channelCount || 1);
    this.node = new AudioWorkletNode(this.ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: this.channels, channelCountMode: 'explicit' });
    this.node.port.onmessage = (e) => this._onBlock(e.data);
    this.source.connect(this.node);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return { sampleRate: this.ctx.sampleRate, channels: this.channels, label: track.label };
  }

  _onBlock(block) {
    let peakL = 0, peakR = 0;
    const l = block[0], r = block[1] || block[0];
    for (let i = 0; i < l.length; i++) {
      const a = Math.abs(l[i]); if (a > peakL) peakL = a;
      const b = Math.abs(r[i]); if (b > peakR) peakR = b;
    }
    this.meter = [Math.max(peakL, this.meter[0] * 0.8), Math.max(peakR, this.meter[1] * 0.8)];
    if (this.capturing) {
      this.chunks.push({ frame: this.frames, data: block });
      this.frames += l.length;
    }
  }

  // Frame index corresponding to "now" on the audio clock.
  get nowFrame() { return this.frames; }

  start() {
    this.chunks = [];
    this.frames = 0;
    this.capturing = true;
  }
  stop() { this.capturing = false; }

  // Free everything before `frame`.
  discardBefore(frame) {
    let i = 0;
    while (i < this.chunks.length && this.chunks[i].frame + this.chunks[i].data[0].length <= frame) i++;
    this.chunks.splice(0, i);
  }

  // Returns Float32Array[] for [from, to) — pads with silence if not yet captured.
  slice(from, to, pick = 'stereo') {
    const n = Math.max(0, to - from);
    const chans = pick === 'stereo' && this.channels >= 2 ? 2 : 1;
    const out = Array.from({ length: chans }, () => new Float32Array(n));
    for (const c of this.chunks) {
      const len = c.data[0].length;
      if (c.frame + len <= from || c.frame >= to) continue;
      const a = Math.max(from, c.frame), b = Math.min(to, c.frame + len);
      for (let ch = 0; ch < chans; ch++) {
        const srcIdx = pick === 'right' ? Math.min(1, c.data.length - 1) : pick === 'left' ? 0 : ch;
        out[ch].set(c.data[srcIdx].subarray(a - c.frame, b - c.frame), a - from);
      }
    }
    return out;
  }

  meterDb() { return this.meter.map(linToDb); }

  async close() {
    this.capturing = false;
    this.chunks = [];
    try { this.node?.disconnect(); this.source?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = this.stream = this.source = this.node = null;
  }
}

// Wait for `ms` of audio-clock time.
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
