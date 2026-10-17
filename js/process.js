// The shared processing pipeline: trim, loop search, normalise, cap, fade.
// Everything works on Float32Array channel arrays at a given sample rate and
// returns new arrays; nothing mutates its input.

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

export function peak(channels, from = 0, to = Infinity) {
  let p = 0;
  const end = Math.min(to, channels[0].length);
  for (const ch of channels) {
    for (let i = from; i < end; i++) {
      const a = Math.abs(ch[i]);
      if (a > p) p = a;
    }
  }
  return p;
}

// First frame where any channel exceeds the threshold, searched from
// `notBefore` (used for the latency offset when auto-sampling). A short
// pre-roll keeps the very start of the attack.
export function findStart(channels, sampleRate, { thresholdDb = -48, notBefore = 0, preRollMs = 2 } = {}) {
  const thr = dbToLin(thresholdDb);
  const n = channels[0].length;
  for (let i = Math.max(0, notBefore); i < n; i++) {
    for (const ch of channels) {
      if (Math.abs(ch[i]) > thr) {
        return Math.max(notBefore, i - Math.round((preRollMs / 1000) * sampleRate));
      }
    }
  }
  return n;
}

// Last frame where any channel exceeds the threshold (for trailing silence).
export function findEnd(channels, { thresholdDb = -60 } = {}) {
  const thr = dbToLin(thresholdDb);
  for (let i = channels[0].length - 1; i >= 0; i--) {
    for (const ch of channels) if (Math.abs(ch[i]) > thr) return i + 1;
  }
  return 0;
}

export function slice(channels, from, to) {
  return channels.map((ch) => ch.slice(from, to));
}

export function normalise(channels, targetDb = -1) {
  const p = peak(channels);
  if (p === 0) return channels;
  const g = dbToLin(targetDb) / p;
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * g;
    return out;
  });
}

export function fadeOut(channels, sampleRate, ms) {
  const len = Math.min(channels[0].length, Math.round((ms / 1000) * sampleRate));
  if (len <= 0) return channels;
  const n = channels[0].length;
  return channels.map((ch) => {
    const out = ch.slice();
    for (let i = 0; i < len; i++) {
      const t = i / len;
      out[n - 1 - i] *= t;
    }
    return out;
  });
}

export function fadeIn(channels, sampleRate, ms) {
  const len = Math.min(channels[0].length, Math.round((ms / 1000) * sampleRate));
  if (len <= 0) return channels;
  return channels.map((ch) => {
    const out = ch.slice();
    for (let i = 0; i < len; i++) out[i] *= i / len;
    return out;
  });
}

function monoMix(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i];
    m[i] = s / channels.length;
  }
  return m;
}

function risingZeroCrossings(mono, from, to, maxCount) {
  const out = [];
  const step = Math.max(1, Math.floor((to - from) / (maxCount * 8)));
  for (let i = Math.max(1, from); i < to; i++) {
    if (mono[i - 1] < 0 && mono[i] >= 0) {
      out.push(i);
      // Skip ahead a little so candidates are spread across the region
      // rather than bunched in the first few cycles.
      i += step;
    }
  }
  return out;
}

// Search for loop points inside [searchStart, searchEnd). Candidates are rising
// zero crossings; a pair is scored by how well the audio following the start
// matches the audio following the end (so the splice is seamless), with a mild
// preference for longer loops. Returns { start, end, score } or null.
export function findLoop(channels, sampleRate, {
  searchStart = 0,
  searchEnd = channels[0].length,
  minLengthMs = 50,
  compareMs = 30,
  maxCandidates = 96,
} = {}) {
  const mono = monoMix(channels);
  const n = mono.length;
  searchEnd = Math.min(searchEnd, n);
  const minLen = Math.round((minLengthMs / 1000) * sampleRate);
  const cmp = Math.round((compareMs / 1000) * sampleRate);
  if (searchEnd - searchStart < minLen + cmp) return null;

  const span = searchEnd - searchStart;
  const starts = risingZeroCrossings(mono, searchStart, searchStart + Math.floor(span * 0.6), maxCandidates);
  const ends = risingZeroCrossings(mono, searchStart + Math.floor(span * 0.4), searchEnd - cmp, maxCandidates);
  if (!starts.length || !ends.length) return null;

  let best = null;
  for (const e of ends) {
    // Energy around the end point, to normalise the error.
    let energy = 1e-9;
    for (let k = 0; k < cmp; k++) energy += mono[e + k] * mono[e + k];
    for (const s of starts) {
      const len = e - s;
      if (len < minLen) continue;
      let err = 0;
      for (let k = 0; k < cmp; k++) {
        const d = mono[s + k] - mono[e + k];
        err += d * d;
      }
      // Normalised mismatch, then reward length (longer loops hide
      // periodicity errors better and sound less static).
      const mismatch = err / energy;
      const score = mismatch / Math.pow(len / span, 0.35);
      if (!best || score < best.score) best = { start: s, end: e, score, mismatch };
    }
  }
  return best;
}

export function capLength(channels, sampleRate, maxSeconds = 20) {
  const max = Math.floor(maxSeconds * sampleRate);
  return channels[0].length > max ? slice(channels, 0, max) : channels;
}

// Full pipeline for one note. `raw` is { channels, sampleRate }.
// Returns { channels, sampleRate, trimmedFrom, loop, peakDb }.
export function processNote(raw, opts) {
  const {
    trim = true,
    thresholdDb = -48,
    latencyFrames = 0,
    trimEnd = true,
    endThresholdDb = -72,
    normaliseTo = -1,
    doNormalise = true,
    loopEnabled = true,
    loopSearch = null,         // { fromFrac, toFrac } of the trimmed note, or { fromFrame, toFrame }
    cutAtLoopEnd = false,
    cutTailMs = 10,
    fadeOutMs = 0,
    fadeInMs = 0,
    maxSeconds = 20,
  } = opts;

  let ch = raw.channels;
  const sr = raw.sampleRate;
  let trimmedFrom = 0;

  if (trim) {
    trimmedFrom = findStart(ch, sr, { thresholdDb, notBefore: latencyFrames });
    const end = trimEnd ? Math.max(trimmedFrom + 1, findEnd(ch, { thresholdDb: endThresholdDb })) : ch[0].length;
    ch = slice(ch, trimmedFrom, end);
  }
  if (fadeInMs > 0) ch = fadeIn(ch, sr, fadeInMs);
  ch = capLength(ch, sr, maxSeconds);

  let loop = null;
  if (loopEnabled) {
    const n = ch[0].length;
    let from, to;
    if (loopSearch && loopSearch.fromFrame !== undefined) {
      from = Math.max(0, loopSearch.fromFrame - trimmedFrom);
      to = Math.min(n, loopSearch.toFrame - trimmedFrom);
    } else {
      const f = loopSearch || { fromFrac: 0.25, toFrac: 0.9 };
      from = Math.floor(n * f.fromFrac);
      to = Math.floor(n * f.toFrac);
    }
    loop = findLoop(ch, sr, { searchStart: from, searchEnd: to });
  }

  if (loop && cutAtLoopEnd) {
    const cut = Math.min(ch[0].length, loop.end + Math.round((cutTailMs / 1000) * sr));
    ch = slice(ch, 0, cut);
  }
  if (fadeOutMs > 0 && !(loop && cutAtLoopEnd)) ch = fadeOut(ch, sr, fadeOutMs);
  if (doNormalise) ch = normalise(ch, normaliseTo);

  return { channels: ch, sampleRate: sr, trimmedFrom, loop, peakDb: linToDb(peak(ch)) };
}

// Nearest rising zero crossing to `frame` within ±maxDist, on a mono mix.
export function nearestZeroCrossing(channels, frame, maxDist = 4000) {
  const mono = monoMix(channels);
  const n = mono.length;
  frame = Math.max(1, Math.min(n - 1, Math.round(frame)));
  for (let d = 0; d <= maxDist; d++) {
    const a = frame - d, b = frame + d;
    if (a >= 1 && mono[a - 1] < 0 && mono[a] >= 0) return a;
    if (b < n && mono[b - 1] < 0 && mono[b] >= 0) return b;
  }
  return frame;
}

// Shift pitch by `cents` through resampling (Catmull-Rom interpolation).
// Meant for small corrections, where this is clean enough and keeps the
// pipeline synchronous.
export function retune(channels, cents) {
  if (!cents) return channels;
  const ratio = Math.pow(2, cents / 1200);   // >1 raises pitch (reads faster)
  const n = channels[0].length;
  const outLen = Math.floor(n / ratio);
  return channels.map((ch) => {
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const t = pos - j;
      const p0 = ch[Math.max(0, j - 1)], p1 = ch[j], p2 = ch[Math.min(n - 1, j + 1)], p3 = ch[Math.min(n - 1, j + 2)];
      out[i] = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    }
    return out;
  });
}
