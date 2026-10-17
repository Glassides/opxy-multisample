// The auto-sampler: plays notes over MIDI, captures the result, and hands raw
// recordings back to the app for the shared processing pipeline.

import { wait } from './recorder.js';
import { dbToLin, linToDb } from './process.js';

export const MAX_ZONES = 24;

// Which notes get sampled for a range / step, optionally snapped so that the
// grid passes through C (midi 0, 12, 24 … are all C).
export function plannedNotes({ start, end, step, anchorToC = false }) {
  const notes = [];
  if (end < start) [start, end] = [end, start];
  step = Math.max(1, step | 0);
  let first = start;
  if (anchorToC) first = Math.ceil(start / step) * step;
  for (let n = first; n <= end; n += step) notes.push(n);
  return notes;
}

// Suggestions for getting a too-large plan under the limit.
export function fitSuggestions({ start, end, step, anchorToC }) {
  const out = [];
  for (let s = step + 1; s <= 12; s++) {
    if (plannedNotes({ start, end, step: s, anchorToC }).length <= MAX_ZONES) { out.push({ step: s }); break; }
  }
  const notes = plannedNotes({ start, end, step, anchorToC });
  if (notes.length > MAX_ZONES) out.push({ end: notes[MAX_ZONES - 1] });
  return out;
}

function peakEnvelope(mono, sampleRate, windowMs = 5) {
  const w = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const n = Math.ceil(mono.length / w);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    const a = i * w, b = Math.min(mono.length, a + w);
    for (let j = a; j < b; j++) { const v = Math.abs(mono[j]); if (v > p) p = v; }
    env[i] = p;
  }
  return { env, hop: w };
}

function monoOf(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = (channels[0][i] + channels[1][i]) * 0.5;
  return m;
}

export class AutoSampler {
  constructor({ midi, recorder, pick = 'stereo' }) {
    this.midi = midi;
    this.recorder = recorder;
    this.pick = pick;
    this.aborted = false;
    this._wake = null;
  }

  // A wait that abort() can cut short.
  _wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._wake = null; resolve(); }, ms);
      this._wake = () => { clearTimeout(t); this._wake = null; resolve(); };
    });
  }

  // Play one note, record, and measure latency / release / noise floor.
  // Returns { latencyMs, releaseSec, noiseFloorDb, peakDb, channels, sampleRate, noteOnFrame, noteOffFrame }.
  async testNote({ note = 60, velocity = 100, holdSec = 1, maxTailSec = 12, onsetThresholdDb = -40 }) {
    const rec = this.recorder;
    const sr = rec.sampleRate;
    this.aborted = false;
    rec.start();
    await this._wait(300);                    // noise-floor window
    const noteOnFrame = rec.nowFrame;
    this.midi.noteOn(note, velocity);
    await this._wait(holdSec * 1000);
    const noteOffFrame = rec.nowFrame;
    this.midi.noteOff(note);

    // Keep recording until the signal falls back to the floor or the cap is reached.
    const started = performance.now();
    let endFrame = noteOffFrame;
    const floorLin = await this._noiseFloor(0, noteOnFrame);
    const silent = Math.max(floorLin * 2, dbToLin(-66));
    let quietSince = null;
    while (performance.now() - started < maxTailSec * 1000) {
      await wait(100);
      if (this.aborted) break;
      const [l, r] = rec.meter;
      const level = Math.max(l, r);
      if (level < silent) {
        if (quietSince === null) quietSince = rec.nowFrame;
        else if (rec.nowFrame - quietSince > sr * 0.4) { endFrame = quietSince; break; }
      } else {
        quietSince = null;
      }
      endFrame = rec.nowFrame;
    }
    rec.stop();

    const channels = rec.slice(0, rec.nowFrame, this.pick);
    const mono = monoOf(channels);
    const { env, hop } = peakEnvelope(mono, sr);
    const floorDb = linToDb(floorLin);
    const onsetThr = Math.max(dbToLin(onsetThresholdDb), floorLin * 4);
    let onset = -1;
    for (let i = Math.floor(noteOnFrame / hop); i < env.length; i++) if (env[i] > onsetThr) { onset = i * hop; break; }
    const latencyMs = onset >= 0 ? ((onset - noteOnFrame) / sr) * 1000 : null;

    // Release: from note-off (+ latency) until the envelope stays under the floor.
    let releaseSec = null;
    if (onset >= 0) {
      const offAt = noteOffFrame + (onset - noteOnFrame);
      const relThr = Math.max(floorLin * 2, dbToLin(-60));
      let quiet = 0;
      let relEnd = -1;
      for (let i = Math.floor(offAt / hop); i < env.length; i++) {
        if (env[i] < relThr) { quiet++; if (quiet * hop > sr * 0.15) { relEnd = (i - quiet) * hop; break; } }
        else quiet = 0;
      }
      if (relEnd < 0) relEnd = Math.min(rec.nowFrame, endFrame);
      releaseSec = Math.max(0, (relEnd - offAt) / sr);
    }
    let peak = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
    rec.discardBefore(rec.nowFrame);
    return { latencyMs, releaseSec, noiseFloorDb: floorDb, peakDb: linToDb(peak), channels, sampleRate: sr, noteOnFrame, noteOffFrame };
  }

  async _noiseFloor(from, to) {
    const ch = this.recorder.slice(from, to, this.pick);
    const mono = monoOf(ch);
    let p = 0;
    for (let i = 0; i < mono.length; i++) { const v = Math.abs(mono[i]); if (v > p) p = v; }
    return p;
  }

  // Record every note in `notes`. Calls onNote(note, raw, index) as each one lands.
  async run({ notes, velocity, holdSec, releaseSec, latencyMs, preRollMs = 30, onNote, onProgress }) {
    const rec = this.recorder;
    const sr = rec.sampleRate;
    this.aborted = false;
    rec.start();
    await wait(200);
    try {
      for (let i = 0; i < notes.length; i++) {
        if (this.aborted) break;
        const note = notes[i];
        onProgress?.({ index: i, note, phase: 'playing' });
        const noteOnFrame = rec.nowFrame;
        this.midi.noteOn(note, velocity);
        await this._wait(holdSec * 1000);
        this.midi.noteOff(note);
        if (this.aborted) break;
        onProgress?.({ index: i, note, phase: 'release' });
        await this._wait((latencyMs + releaseSec * 1000) + 150);
        if (this.aborted) break;
        const from = Math.max(0, noteOnFrame - Math.round((preRollMs / 1000) * sr));
        const to = rec.nowFrame;
        const channels = rec.slice(from, to, this.pick);
        rec.discardBefore(from);
        const latencyFrames = Math.round((latencyMs / 1000) * sr) + (noteOnFrame - from);
        const holdFrames = Math.round(holdSec * sr);
        onNote?.(note, { channels, sampleRate: sr }, i, { latencyFrames, holdFrames, noteOnOffset: noteOnFrame - from });
      }
    } finally {
      this.midi.allNotesOff();
      rec.stop();
      rec.discardBefore(rec.nowFrame);
    }
    return !this.aborted;
  }

  abort() {
    this.aborted = true;
    this.midi.allNotesOff();
    this._wake?.();
  }
}
