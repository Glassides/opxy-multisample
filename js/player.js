// Audition playback: plays a zone's processed audio, pitched to a target note,
// looping between its loop points if enabled. Computer-keyboard mapping lives
// in app.js; this just owns the AudioContext.

import { zoneForNote } from './patch.js';

let ctx = null;
const active = new Map(); // note -> { src, gain }

export function audioContext() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function bufferFor(zone) {
  const ac = audioContext();
  const { channels, sampleRate } = zone.processed;
  if (!zone._buffer || zone._bufferKey !== channels) {
    const buf = ac.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((ch, i) => buf.copyToChannel(ch, i));
    zone._buffer = buf;
    zone._bufferKey = channels;
  }
  return zone._buffer;
}

export function noteOn(zones, note, { releaseSec = 0.15, attackSec = 0, offsetFrames = 0 } = {}) {
  const sorted = [...zones].filter((z) => z.processed).sort((a, b) => a.keycenter - b.keycenter);
  const zone = zoneForNote(sorted, note);
  if (!zone) return null;
  noteOff(note, 0);

  const ac = audioContext();
  const src = ac.createBufferSource();
  src.buffer = bufferFor(zone);
  src.playbackRate.value = Math.pow(2, (note - zone.keycenter) / 12);
  const loop = zone.processed.loop;
  if (loop && zone.loopEnabled) {
    src.loop = true;
    src.loopStart = loop.start / zone.processed.sampleRate;
    src.loopEnd = loop.end / zone.processed.sampleRate;
  }
  const gain = ac.createGain();
  gain.gain.setValueAtTime(attackSec > 0 ? 0.0001 : 1, ac.currentTime);
  if (attackSec > 0) gain.gain.exponentialRampToValueAtTime(1, ac.currentTime + attackSec);
  src.connect(gain).connect(ac.destination);
  const sr = zone.processed.sampleRate;
  const offsetSec = Math.max(0, Math.min(offsetFrames, zone.processed.channels[0].length - 1)) / sr;
  src.start(0, offsetSec);
  active.set(note, { src, gain, zone, releaseSec, startedAt: ac.currentTime - offsetSec / src.playbackRate.value });
  src.onended = () => {
    if (active.get(note)?.src === src) active.delete(note);
  };
  return zone;
}

// releaseSec: fade length, or null to let the sample play out naturally.
// exitLoop: leave the loop on release and play the tail ("loop until release"),
// otherwise keep looping and rely on the fade ("loop forever").
export function noteOff(note, releaseSec, { exitLoop = true } = {}) {
  const v = active.get(note);
  if (!v) return;
  const ac = audioContext();
  const t = ac.currentTime;
  const rel = releaseSec === undefined ? v.releaseSec : releaseSec;
  if (v.src.loop && exitLoop) {
    v.src.loop = false;             // continues from the current position to the end
    if (rel !== null) fadeOut(v, t, rel);
    else v.src.onended = () => { if (active.get(note)?.src === v.src) active.delete(note); };
  } else if (rel === null && !v.src.loop) {
    // one-shot: let it finish
  } else {
    fadeOut(v, t, rel ?? 0.15);
  }
  if (rel !== null || v.src.loop) active.delete(note);
  else v.src.onended = () => { if (active.get(note)?.src === v.src) active.delete(note); };
}

function fadeOut(v, t, rel) {
  v.gain.gain.cancelScheduledValues(t);
  v.gain.gain.setValueAtTime(v.gain.gain.value, t);
  v.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.005, rel));
  v.src.stop(t + Math.max(0.005, rel) + 0.01);
}

export function allNotesOff() {
  for (const note of [...active.keys()]) noteOff(note, 0.02, { exitLoop: false });
}

// Current playback frame in the zone for a playhead, or null.
export function playheadFor(zone) {
  for (const v of active.values()) {
    if (v.zone !== zone) continue;
    const ac = audioContext();
    const sr = zone.processed.sampleRate;
    const rate = v.src.playbackRate.value;
    let frame = (ac.currentTime - v.startedAt) * rate * sr;
    const n = zone.processed.channels[0].length;
    if (v.src.loop) {
      const ls = v.src.loopStart * sr;
      const le = v.src.loopEnd * sr;
      if (frame > le && le > ls) frame = ls + ((frame - ls) % (le - ls));
    }
    return Math.min(n - 1, frame);
  }
  return null;
}

export function isRinging(note) { return active.has(note); }
