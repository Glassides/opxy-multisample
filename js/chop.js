// Split one long recording of consecutive notes into segments by silence.

import { dbToLin } from './process.js';

export function chopBySilence(channels, sampleRate, {
  thresholdDb = -45,
  minSilenceMs = 150,
  minNoteMs = 100,
  preRollMs = 2,
} = {}) {
  const thr = dbToLin(thresholdDb);
  const n = channels[0].length;
  const minSilence = Math.round((minSilenceMs / 1000) * sampleRate);
  const minNote = Math.round((minNoteMs / 1000) * sampleRate);
  const preRoll = Math.round((preRollMs / 1000) * sampleRate);

  // Envelope follower on a coarse grid so this stays quick on 20 s+ files.
  const hop = 64;
  const frames = Math.ceil(n / hop);
  const loud = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = f * hop;
    const b = Math.min(n, a + hop);
    let p = 0;
    for (const ch of channels) for (let i = a; i < b; i++) { const v = Math.abs(ch[i]); if (v > p) p = v; }
    loud[f] = p > thr ? 1 : 0;
  }

  const segments = [];
  let inNote = false;
  let start = 0;
  let quietRun = 0;
  for (let f = 0; f < frames; f++) {
    if (loud[f]) {
      if (!inNote) { inNote = true; start = Math.max(0, f * hop - preRoll); }
      quietRun = 0;
    } else if (inNote) {
      quietRun += hop;
      if (quietRun >= minSilence) {
        const end = f * hop - quietRun + hop;
        if (end - start >= minNote) segments.push({ start, end });
        inNote = false;
        quietRun = 0;
      }
    }
  }
  if (inNote) {
    const end = n;
    if (end - start >= minNote) segments.push({ start, end });
  }
  return segments;
}
