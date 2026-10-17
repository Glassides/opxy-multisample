// UI glue for the import mode. Auto-sample (stage 2) will feed zones into the
// same state and reuse the processing / review / export below.

import { VERSION } from './version.js';
import { $, $$, el, formatBytes, formatSeconds, drawWaveform, download } from './ui.js';
import { setMiddleCOctave, midiToName, nameToMidi, noteFromFilename, sanitiseName } from './notes.js';
import { decodeFile, toMono, resample, encodeWav } from './audio.js';
import { processNote, nearestZeroCrossing, retune } from './process.js';
import { LoopEditor } from './loopeditor.js';
import { saveSession, loadSession, clearSession } from './session.js';
import { detectPitch } from './pitch.js';
import { chopBySilence } from './chop.js';
import { buildPatch, MAX_ZONES, MAX_SECONDS, zoneForNote } from './patch.js';
import { buildZip } from './zip.js';
import { noteOn, noteOff, allNotesOff, playheadFor, isRinging } from './player.js';
import { initAutoSample } from './autosample.js';
import { initKnobs } from './knob.js';

// ---------- state ----------

const state = {
  zones: [],         // see addZone()
  selectedId: null,
  nextId: 1,
  octave: 3,         // keyboard base octave (in the chosen convention)
  mode: 'import',
};

const opts = {
  trim: true, thresholdDb: -48,
  normalise: true, normaliseTo: -1,
  loop: true, crossfade: 0.1, onRelease: false, cutAtLoopEnd: false,
  fade: false, fadeOutMs: 200,
  winFrom: 0.25, winTo: 0.9,
  rate: 44100, mono: false,
  ampAttack: 0, ampRelease: 0,
  extendTop: true,
  retune: false,
  longMode: false, longStart: 'c1', longStep: 3, chopThr: -45, chopGap: 150,
};

$('#version').textContent = `v${VERSION}`;

// ---------- theme ----------

const root = document.documentElement;
try { const t = localStorage.getItem('theme'); if (t) root.dataset.theme = t; } catch {}
$('#theme').addEventListener('click', () => {
  const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
  render();
});

if (!window.OfflineAudioContext || !window.AudioContext) $('#unsupported').classList.remove('hidden');

// ---------- option wiring ----------

function bindRange(id, key, fmt, { scale = 1 } = {}) {
  const input = $(id);
  const val = $(`${id}-val`) || $(`${id.replace(/-(ms|to|from)$/, '')}-val`);
  const update = () => {
    opts[key] = Number(input.value) * scale;
    if (val && fmt) val.textContent = fmt(Number(input.value));
  };
  input.addEventListener('input', () => { update(); scheduleReprocess(); });
  update();
}
function bindCheck(id, key, reprocess = true) {
  const input = $(id);
  const update = () => { opts[key] = input.checked; };
  input.addEventListener('change', () => { update(); if (reprocess) scheduleReprocess(); else render(); });
  update();
}

bindCheck('#opt-trim', 'trim');
bindRange('#opt-thr', 'thresholdDb', (v) => `${v} dB`);
bindCheck('#opt-norm', 'normalise');
bindRange('#opt-norm-to', 'normaliseTo', (v) => `${v} dB`);
bindCheck('#opt-loop', 'loop');
bindRange('#opt-xf', 'crossfade', (v) => `${v} %`, { scale: 0.01 });
bindCheck('#opt-onrelease', 'onRelease', false);
bindCheck('#opt-cut', 'cutAtLoopEnd');
bindCheck('#opt-fade', 'fade');
bindRange('#opt-fade-ms', 'fadeOutMs', (v) => `${v} ms`);
bindRange('#opt-att', 'ampAttack', (v) => `${v} %`, { scale: 0.01 });
bindRange('#opt-rel', 'ampRelease', (v) => `${v} %`, { scale: 0.01 });
bindCheck('#opt-extend', 'extendTop', false);
bindCheck('#opt-retune', 'retune');
bindCheck('#opt-mono', 'mono', false);
$('#opt-rate').addEventListener('change', (e) => { opts.rate = Number(e.target.value); render(); });

const winFrom = $('#opt-win-from');
const winTo = $('#opt-win-to');
function updateWin() {
  let a = Number(winFrom.value), b = Number(winTo.value);
  if (b <= a + 5) { b = a + 5; winTo.value = b; }
  opts.winFrom = a / 100; opts.winTo = b / 100;
  $('#opt-win-from-val').textContent = `${a} %`;
  $('#opt-win-val').textContent = `${b} %`;
}
winFrom.addEventListener('input', () => { updateWin(); scheduleReprocess(); });
winTo.addEventListener('input', () => { updateWin(); scheduleReprocess(); });
updateWin();

$('#convention').addEventListener('change', (e) => {
  setMiddleCOctave(Number(e.target.value));
  render();
});
$('#long-mode').addEventListener('change', (e) => {
  opts.longMode = e.target.checked;
  $$('.long-only').forEach((n) => n.classList.toggle('hidden', !opts.longMode));
});
$('#long-start').addEventListener('input', (e) => { opts.longStart = e.target.value; });
bindRange('#long-step', 'longStep', (v) => `${v}`);
bindRange('#chop-thr', 'chopThr', (v) => `${v} dB`);
bindRange('#chop-gap', 'chopGap', (v) => `${v} ms`);
$('#preset-name').addEventListener('input', () => { markDirty(); render(); });

// ---------- loading files ----------

const dropzone = $('#dropzone');
const fileInput = $('#file-input');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const files = await filesFromDataTransfer(e.dataTransfer);
  loadFiles(files);
});
fileInput.addEventListener('change', () => { loadFiles([...fileInput.files]); fileInput.value = ''; });

// Dropped folders need walking via the File System API; plain files come as-is.
async function filesFromDataTransfer(dt) {
  const out = [];
  const items = [...(dt.items || [])];
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.some(Boolean)) {
    for (const entry of entries) if (entry) await walkEntry(entry, out);
  } else {
    out.push(...dt.files);
  }
  return out.filter((f) => /\.(wav|aif|aiff|flac|mp3|m4a|ogg)$/i.test(f.name) && !f.name.startsWith('.'));
}
function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) entry.file((f) => { out.push(f); resolve(); }, resolve);
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readAll = () => reader.readEntries(async (list) => {
        if (!list.length) return resolve();
        for (const e of list) await walkEntry(e, out);
        readAll();
      }, resolve);
      readAll();
    } else resolve();
  });
}

const status = (msg, isError = false) => {
  const n = $('#import-status');
  n.textContent = msg;
  n.classList.toggle('danger', isError);
};

async function loadFiles(files) {
  if (!files.length) return status('no audio files found', true);
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (opts.longMode) return loadLongRecording(files[0]);

  let loaded = 0;
  for (const file of files) {
    status(`decoding ${file.name} (${loaded + 1}/${files.length})…`);
    let decoded;
    try { decoded = await decodeFile(file); } catch (err) {
      status(`could not decode ${file.name}: ${err.message}`, true);
      continue;
    }
    let note = noteFromFilename(file.name);
    if (!note && decoded.header.rootNote !== null && decoded.header.rootNote <= 127) {
      note = { midi: decoded.header.rootNote, source: 'metadata' };
    }
    if (!note) {
      const p = detectPitch(decoded.channels, decoded.sampleRate);
      if (p && p.confidence > 0.8) note = { midi: p.midi, source: `pitch (${p.hz.toFixed(1)} hz)` };
    }
    if (!note) {
      const midi = await askNote(file.name);
      if (midi === null) continue;
      note = { midi, source: 'you' };
    }
    addZone({ name: file.name, raw: { channels: decoded.channels, sampleRate: decoded.sampleRate }, keycenter: note.midi, noteSource: note.source });
    loaded++;
  }
  status(`${loaded} file${loaded === 1 ? '' : 's'} loaded`);
  reprocessAll();
  checkZoneCount();
}

async function loadLongRecording(file) {
  const startMidi = nameToMidi(opts.longStart) ?? (Number.isFinite(Number(opts.longStart)) ? Number(opts.longStart) : null);
  if (startMidi === null) return status(`"${opts.longStart}" is not a note`, true);
  status(`decoding ${file.name}…`);
  let decoded;
  try { decoded = await decodeFile(file); } catch (err) { return status(`could not decode: ${err.message}`, true); }
  const segments = chopBySilence(decoded.channels, decoded.sampleRate, { thresholdDb: opts.chopThr, minSilenceMs: opts.chopGap });
  if (!segments.length) return status('no notes found — try a lower silence threshold', true);
  segments.forEach((seg, i) => {
    const midi = startMidi + i * opts.longStep;
    if (midi > 127) return;
    addZone({
      name: `${file.name} #${i + 1}`,
      raw: { channels: decoded.channels.map((ch) => ch.slice(seg.start, seg.end)), sampleRate: decoded.sampleRate },
      keycenter: midi,
      noteSource: 'sequence',
    });
  });
  status(`${segments.length} notes found in ${file.name}`);
  reprocessAll();
  checkZoneCount();
}

function askNote(filename) {
  const dlg = $('#note-dialog');
  const input = $('#note-dialog-input');
  $('#note-dialog-file').textContent = filename;
  input.value = '';
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); cleanup(); resolve(v); };
    const ok = () => {
      const v = input.value.trim();
      const midi = nameToMidi(v) ?? (/^\d{1,3}$/.test(v) && Number(v) <= 127 ? Number(v) : null);
      if (midi === null) { input.focus(); input.select(); return; }
      done(midi);
    };
    const skip = () => done(null);
    const key = (e) => { if (e.key === 'Enter') ok(); };
    const cleanup = () => {
      $('#note-dialog-ok').removeEventListener('click', ok);
      $('#note-dialog-skip').removeEventListener('click', skip);
      input.removeEventListener('keydown', key);
    };
    $('#note-dialog-ok').addEventListener('click', ok);
    $('#note-dialog-skip').addEventListener('click', skip);
    input.addEventListener('keydown', key);
    dlg.showModal();
    input.focus();
  });
}

// ---------- zones ----------

function addZone({ name, raw, keycenter, noteSource, hints = null, origin = 'import' }) {
  const zone = {
    id: state.nextId++,
    name,
    raw,
    keycenter,
    noteSource,
    hints,
    origin,
    detected: null,       // { midi, cents, hz, confidence } from detect pitch
    fadeMs: null,         // per-zone fade override (ms), null = global setting
    window: null,         // loop search window in processed frames, for display
    processed: null,
    loopEnabled: opts.loop,
    loopOverride: null,   // { start, end } set by hand on the detail panel
  };
  state.zones.push(zone);
  if (state.selectedId === null) state.selectedId = zone.id;
  markDirty();
  return zone;
}

function sortedZones() {
  return [...state.zones].sort((a, b) => a.keycenter - b.keycenter || a.id - b.id);
}

function processZone(zone) {
  const h = zone.hints;
  let raw = zone.raw;
  if (opts.retune && zone.detected?.cents) {
    if (!zone._retuned || zone._retuned.cents !== zone.detected.cents || zone._retuned.src !== zone.raw) {
      zone._retuned = { cents: zone.detected.cents, src: zone.raw, channels: retune(zone.raw.channels, -zone.detected.cents) };
    }
    raw = { channels: zone._retuned.channels, sampleRate: zone.raw.sampleRate };
  }
  // Auto-sampled zones know where the note starts and how long it was held,
  // so the loop window is a fraction of the held part rather than of the file.
  const loopSearch = h
    ? { fromFrame: h.onsetFrame + Math.round(h.holdFrames * opts.winFrom), toFrame: h.onsetFrame + Math.round(h.holdFrames * opts.winTo) }
    : { fromFrac: opts.winFrom, toFrac: opts.winTo };
  zone.processed = processNote(raw, {
    trim: opts.trim,
    thresholdDb: opts.thresholdDb,
    latencyFrames: h ? h.latencyFrames : 0,
    doNormalise: opts.normalise,
    normaliseTo: opts.normaliseTo,
    loopEnabled: opts.loop,
    loopSearch,
    cutAtLoopEnd: opts.cutAtLoopEnd && zone.loopEnabled,
    fadeOutMs: zone.fadeMs !== null ? zone.fadeMs : opts.fade ? opts.fadeOutMs : 0,
    maxSeconds: MAX_SECONDS,
  });
  const n = zone.processed.channels[0].length;
  if (zone.loopOverride) {
    zone.processed.loop = {
      start: Math.min(n - 2, zone.loopOverride.start),
      end: Math.min(n - 1, zone.loopOverride.end),
    };
  }
  // Search window in processed-frame terms, for the editor to draw and drag.
  if (h) {
    const onset = Math.max(0, h.onsetFrame - zone.processed.trimmedFrom);
    zone.window = { start: Math.min(n - 1, onset + Math.round(h.holdFrames * opts.winFrom)), end: Math.min(n, onset + Math.round(h.holdFrames * opts.winTo)) };
  } else {
    zone.window = { start: Math.floor(n * opts.winFrom), end: Math.floor(n * opts.winTo) };
  }
  zone._buffer = null;
}

let reprocessTimer = null;
function scheduleReprocess() {
  clearTimeout(reprocessTimer);
  reprocessTimer = setTimeout(reprocessAll, 120);
}
function reprocessAll() {
  for (const z of state.zones) if (z.raw) processZone(z);
  markDirty();
  render();
}

function removeZone(id) {
  state.zones = state.zones.filter((z) => z.id !== id);
  markDirty();
  if (state.selectedId === id) state.selectedId = state.zones[0]?.id ?? null;
  render();
}

// Keep evenly spaced roots, always keeping the lowest and highest.
function thinZones(target = MAX_ZONES) {
  const sorted = sortedZones();
  if (sorted.length <= target) return;
  const keep = new Set();
  for (let i = 0; i < target; i++) keep.add(Math.round((i * (sorted.length - 1)) / (target - 1)));
  state.zones = sorted.filter((_, i) => keep.has(i));
  if (!state.zones.find((z) => z.id === state.selectedId)) state.selectedId = state.zones[0]?.id ?? null;
  markDirty();
  render();
}
$('#thin').addEventListener('click', () => thinZones());
$('#clear').addEventListener('click', () => { allNotesOff(); state.zones = []; state.selectedId = null; markDirty(); render(); });

function checkZoneCount() {
  const n = state.zones.length;
  const notice = $('#zones-notice');
  notice.innerHTML = '';
  if (n > MAX_ZONES) {
    notice.append(el('div', { class: 'notice error' },
      `${n} zones — the op-xy holds ${MAX_ZONES}. `,
      el('button', { class: 'btn small', onclick: () => thinZones() }, `keep ${MAX_ZONES} evenly spaced`),
      ' or remove zones by hand.'));
  }
  const dupes = findDuplicateKeys();
  if (dupes.length) {
    notice.append(el('div', { class: 'notice error' }, `more than one sample on ${dupes.map(midiToName).join(', ')} — the device needs one per key.`));
  }
}
function findDuplicateKeys() {
  const seen = new Map();
  for (const z of state.zones) seen.set(z.keycenter, (seen.get(z.keycenter) || 0) + 1);
  return [...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k);
}

// ---------- rendering ----------

function render() {
  checkZoneCount();
  renderZoneMap();
  renderZoneList();
  renderDetail();
  renderKeyboard();
  renderExport();
}

function renderZoneMap() {
  const map = $('#zonemap');
  map.innerHTML = '';
  const sorted = sortedZones();
  for (let i = 0; i < MAX_ZONES; i++) {
    const z = sorted[i];
    map.append(el('div', {
      class: `slot ${z ? 'filled' : ''} ${z && z.id === state.selectedId ? 'selected' : ''}`,
      title: z ? `${midiToName(z.keycenter)} — ${z.name}` : `empty slot ${i + 1}`,
      dataset: z ? { zone: z.id } : {},
      onclick: z ? () => { state.selectedId = z.id; render(); } : null,
    }, z ? midiToName(z.keycenter) : ''));
  }
  $('#zone-count').textContent = `${state.zones.length} / ${MAX_ZONES}`;
  $('#thin').classList.toggle('hidden', state.zones.length <= MAX_ZONES);
}

function renderZoneList() {
  const list = $('#zones');
  list.innerHTML = '';
  const sorted = sortedZones();
  const dupes = new Set(findDuplicateKeys());
  sorted.forEach((z, i) => {
    const p = z.processed;
    const secs = p ? p.channels[0].length / p.sampleRate : 0;
    const noteInput = el('input', {
      type: 'text', value: midiToName(z.keycenter), title: `source: ${z.noteSource}`,
      onchange: (e) => {
        const v = e.target.value.trim();
        const midi = nameToMidi(v) ?? (/^\d{1,3}$/.test(v) && Number(v) <= 127 ? Number(v) : null);
        if (midi === null) { e.target.value = midiToName(z.keycenter); return; }
        z.keycenter = midi; z.noteSource = 'you'; markDirty(); render();
      },
    });
    const canvas = el('canvas');
    const row = el('div', {
      class: `zone ${z.id === state.selectedId ? 'selected' : ''} ${dupes.has(z.keycenter) || secs > MAX_SECONDS ? 'problem' : ''} ${z.recording ? 'recording' : ''}`,
      onclick: (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') { state.selectedId = z.id; render(); } },
    },
      el('span', { class: 'idx' }, String(i + 1).padStart(2, '0')),
      el('span', { class: 'note' }, noteInput, el('span', { class: 'src' }, z.noteSource === 'filename' ? '' : z.noteSource.split(' ')[0])),
      el('div', {}, canvas, el('div', { class: 'name', title: z.name }, z.name)),
      el('span', { class: 'meta' }, z.recording ? 'recording…' : p ? `${formatSeconds(secs)} · ${p.loop && z.loopEnabled ? 'loop' : 'one-shot'}` : '…'),
      el('button', { class: 'icon', title: 'remove', onclick: () => removeZone(z.id) }, '×'),
    );
    list.append(row);
    if (p) requestAnimationFrame(() => drawWaveform(canvas, p.channels, { loop: z.loopEnabled ? p.loop : null, band: z.window }));
  });
}

const detail = {
  panel: $('#detail-panel'), wave: $('#wave'), title: $('#detail-title'),
  start: $('#loop-start'), end: $('#loop-end'), startVal: $('#loop-start-val'), endVal: $('#loop-end-val'),
  on: $('#loop-on'), pitch: $('#pitch-val'), usePitch: $('#use-pitch'), fade: $('#zone-fade'), fadeVal: $('#fade-val'),
};
function selectedZone() { return state.zones.find((z) => z.id === state.selectedId) || null; }

function setLoop(z, start, end) {
  z.loopOverride = { start, end };
  z.processed.loop = { start, end, score: null };
  z._buffer = null;
  markDirty();
}

const editor = new LoopEditor({
  canvas: detail.wave,
  splice: $('#splice'),
  getZone: selectedZone,
  onLoop: (start, end) => {
    const z = selectedZone();
    if (!z?.processed) return;
    setLoop(z, start, end);
    renderDetail();
    renderZoneList();
  },
  onWindow: (a, b) => {
    const z = selectedZone();
    if (!z?.processed) return;
    const n = z.processed.channels[0].length;
    let from, to;
    if (z.hints) {
      const onset = Math.max(0, z.hints.onsetFrame - z.processed.trimmedFrom);
      from = (a - onset) / z.hints.holdFrames; to = (b - onset) / z.hints.holdFrames;
    } else {
      from = a / n; to = b / n;
    }
    from = Math.max(0, Math.min(0.95, from)); to = Math.max(from + 0.05, Math.min(1, to));
    winFrom.value = Math.round(from * 100); winTo.value = Math.round(to * 100);
    updateWin();
    scheduleReprocess();
  },
  onSeek: (frame) => {
    const z = selectedZone();
    if (!z?.processed) return;
    startAudition(z, frame);
  },
});
$('#zoom-fit').addEventListener('click', () => { editor.fit(); renderDetail(); });
$('#zoom-loop').addEventListener('click', () => { editor.zoomToLoop(); renderDetail(); });
$('#zoom-in').addEventListener('click', () => { editor.zoomBy(1.6); renderDetail(); });
$('#zoom-out').addEventListener('click', () => { editor.zoomBy(1 / 1.6); renderDetail(); });

function pitchLabel(d) {
  if (!d) return 'not detected';
  const sign = d.cents > 0 ? '+' : '';
  return `${midiToName(d.midi)} ${sign}${d.cents} ¢ · ${d.hz.toFixed(1)} hz`;
}
function detectZone(z) {
  if (!z?.processed) return;
  const win = z.window || { start: 0, end: z.processed.channels[0].length };
  const fromFrac = win.start / z.processed.channels[0].length;
  z.detected = detectPitch(z.processed.channels, z.processed.sampleRate, { fromFrac, windowMs: 200 });
  if (opts.retune) processZone(z);
  markDirty();
}
$('#detect').addEventListener('click', () => { const z = selectedZone(); if (z) { detectZone(z); render(); } });
$('#detect-all').addEventListener('click', () => { for (const z of state.zones) detectZone(z); render(); });
detail.usePitch.addEventListener('click', () => {
  const z = selectedZone();
  if (!z?.detected) return;
  z.keycenter = z.detected.midi; z.noteSource = 'pitch';
  markDirty(); render();
});
detail.fade.addEventListener('change', () => {
  const z = selectedZone();
  if (!z) return;
  const v = detail.fade.value.trim();
  z.fadeMs = v === '' ? null : Math.max(0, Number(v) || 0);
  processZone(z); markDirty(); render();
});
$('#loop-apply-all').addEventListener('click', () => {
  const src = selectedZone();
  const loop = src?.processed?.loop;
  if (!loop || !src.window) return;
  const span = Math.max(1, src.window.end - src.window.start);
  const fs = (loop.start - src.window.start) / span, fe = (loop.end - src.window.start) / span;
  for (const z of state.zones) {
    if (z === src || !z.processed || !z.window) continue;
    const zs = Math.max(1, z.window.end - z.window.start);
    const n = z.processed.channels[0].length;
    let a = Math.round(z.window.start + fs * zs), b = Math.round(z.window.start + fe * zs);
    a = nearestZeroCrossing(z.processed.channels, Math.max(0, Math.min(n - 2, a)));
    b = nearestZeroCrossing(z.processed.channels, Math.max(a + 16, Math.min(n - 1, b)));
    setLoop(z, a, b);
    z.loopEnabled = src.loopEnabled;
  }
  render();
});

function renderDetail() {
  const z = selectedZone();
  if (auditioning && (!z || auditioning.zoneId !== z.id)) stopAudition();
  detail.panel.classList.toggle('hidden', !z);
  if (!z || !z.processed) return;
  const p = z.processed;
  const n = p.channels[0].length;
  detail.title.textContent = `${midiToName(z.keycenter)} · ${z.name} · ${formatSeconds(n / p.sampleRate)} · peak ${p.peakDb.toFixed(1)} dB`;
  detail.start.max = detail.end.max = n - 1;
  detail.on.checked = !!(z.loopEnabled && p.loop);
  detail.on.disabled = !opts.loop;
  if (p.loop) {
    detail.start.value = p.loop.start;
    detail.end.value = p.loop.end;
    const len = p.loop.end - p.loop.start;
    detail.startVal.textContent = `${p.loop.start} · ${(p.loop.start / p.sampleRate).toFixed(3)} s`;
    detail.endVal.textContent = `${p.loop.end} · ${(len / p.sampleRate * 1000).toFixed(0)} ms long`;
  } else {
    detail.startVal.textContent = detail.endVal.textContent = 'no loop';
  }
  detail.pitch.textContent = pitchLabel(z.detected);
  detail.usePitch.classList.toggle('hidden', !(z.detected && z.detected.midi !== z.keycenter));
  detail.fade.value = z.fadeMs === null ? '' : z.fadeMs;
  detail.fadeVal.textContent = z.fadeMs === null ? (opts.fade ? `global ${opts.fadeOutMs} ms` : 'off') : `${z.fadeMs} ms`;
  editor.draw(playheadFor(z));
}

function nudgeLoop() {
  const z = selectedZone();
  if (!z || !z.processed) return;
  let s = Number(detail.start.value), e = Number(detail.end.value);
  if (e <= s + 16) e = s + 16;
  setLoop(z, s, e);
  renderDetail();
  renderZoneList();
}
detail.start.addEventListener('input', nudgeLoop);
detail.end.addEventListener('input', nudgeLoop);
detail.on.addEventListener('change', () => { const z = selectedZone(); if (z) { z.loopEnabled = detail.on.checked; markDirty(); render(); } });
$('#loop-refind').addEventListener('click', () => {
  const z = selectedZone();
  if (!z) return;
  z.loopOverride = null;
  processZone(z);
  markDirty();
  render();
});
$('#remove').addEventListener('click', () => { const z = selectedZone(); if (z) removeZone(z.id); });
// The play button latches: play → "stop" → release like a key (leave the loop, play the tail).
let auditioning = null; // { zoneId, note }
function releaseFor() {
  return opts.ampRelease > 0 ? 0.05 + opts.ampRelease * 4 : null;
}
function stopAudition() {
  if (!auditioning) return;
  noteOff(auditioning.note, releaseFor(), { exitLoop: !opts.onRelease });
  auditioning = null;
  $('#audition').textContent = 'play';
}
function startAudition(z, offsetFrames = 0) {
  stopAudition();
  noteOn(state.zones, z.keycenter, { attackSec: opts.ampAttack * 2, offsetFrames });
  auditioning = { zoneId: z.id, note: z.keycenter };
  $('#audition').textContent = 'stop';
  animatePlayhead();
}
$('#audition').addEventListener('click', () => {
  const z = selectedZone();
  if (!z) return;
  if (auditioning && auditioning.zoneId === z.id) stopAudition(); else startAudition(z);
});

// ---------- keyboard ----------

const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
const held = new Set();

function keyboardBase() { return nameToMidi(`c${state.octave}`) ?? 48; }

function renderKeyboard() {
  const kb = $('#keyboard');
  kb.innerHTML = '';
  const base = keyboardBase();
  const sorted = sortedZones();
  for (let i = 0; i < 25; i++) {
    const midi = base + i;
    const black = [1, 3, 6, 8, 10].includes(midi % 12);
    const zone = sorted.length ? zoneForNote(sorted, midi) : null;
    const zi = zone ? sorted.indexOf(zone) : -1;
    kb.append(el('div', {
      class: `key ${black ? 'black' : ''} ${held.has(midi) ? 'down' : ''} ${zi >= 0 ? (zi % 2 ? 'zone-b' : 'zone-a') : ''} ${zone && zone.keycenter === midi ? 'root' : ''}`,
      style: zone ? '' : 'opacity:0.35',
      title: zone ? `${midiToName(midi)} → zone ${midiToName(zone.keycenter)}` : midiToName(midi),
      dataset: { midi },
      onmousedown: (e) => { e.preventDefault(); pressNote(midi); },
      onmouseup: () => releaseNote(midi),
      onmouseleave: () => { if (held.has(midi)) releaseNote(midi); },
    }, midi % 12 === 0 ? midiToName(midi) : ''));
  }
}
function pressNote(midi) {
  if (held.has(midi)) return;
  held.add(midi);
  const zone = noteOn(state.zones, midi, { releaseSec: 0.05 + opts.ampRelease * 2, attackSec: opts.ampAttack * 2 });
  // The keyboard follows into the editor: the zone that plays becomes the selected one.
  if (zone && zone.id !== state.selectedId) {
    state.selectedId = zone.id;
    render();
  } else {
    renderKeyboard();
  }
  highlightSlot(midi, true);
  animatePlayhead();
}
function releaseNote(midi) {
  held.delete(midi);
  // Mirror the device: leave the loop and play the tail, unless "loop until
  // release only" is on (loop forever), in which case keep looping and fade.
  noteOff(midi, opts.ampRelease > 0 ? 0.05 + opts.ampRelease * 4 : null, { exitLoop: !opts.onRelease });
  renderKeyboard();
  highlightSlot(midi, false);
}
function highlightSlot(midi, on) {
  const z = zoneForNote(sortedZones(), midi);
  if (!z) return;
  const slot = $(`#zonemap .slot[data-zone="${z.id}"]`);
  if (slot) slot.classList.toggle('playing', on);
}
let playheadRaf = null;
function animatePlayhead() {
  if (playheadRaf) return;
  const tick = () => {
    const z = selectedZone();
    if (z && z.processed) {
      const ph = playheadFor(z);
      editor.draw(ph);
      if (ph === null && held.size === 0 && !auditioning) { playheadRaf = null; return; }
    } else if (held.size === 0 && !auditioning) { playheadRaf = null; return; }
    playheadRaf = requestAnimationFrame(tick);
  };
  playheadRaf = requestAnimationFrame(tick);
}
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'Escape') { stopAudition(); held.clear(); allNotesOff(); renderKeyboard(); return; }
  const k = e.key.toLowerCase();
  if (k === 'z') { state.octave = Math.max(-2, state.octave - 1); renderKeyboard(); return; }
  if (k === 'x') { state.octave = Math.min(7, state.octave + 1); renderKeyboard(); return; }
  if (k in KEYMAP) { e.preventDefault(); pressNote(keyboardBase() + KEYMAP[k]); }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in KEYMAP) releaseNote(keyboardBase() + KEYMAP[k]);
});
window.addEventListener('blur', () => { held.clear(); stopAudition(); allNotesOff(); renderKeyboard(); });
setInterval(() => { if (auditioning && playheadFor(selectedZone() || {}) === null && !isRinging(auditioning.note)) { auditioning = null; $('#audition').textContent = 'play'; } }, 250);

// ---------- export ----------

function outputFrames(zone) {
  const p = zone.processed;
  if (!p) return 0;
  return Math.ceil((p.channels[0].length * opts.rate) / p.sampleRate);
}
function estimateBytes() {
  const ch = opts.mono ? 1 : 2;
  return state.zones.reduce((s, z) => s + 44 + 68 + outputFrames(z) * ch * 2, 0) + 4096;
}
function presetName() {
  return sanitiseName($('#preset-name').value) || 'untitled';
}

function renderExport() {
  const n = state.zones.length;
  const longest = state.zones.reduce((m, z) => Math.max(m, z.processed ? z.processed.channels[0].length / z.processed.sampleRate : 0), 0);
  $('#rerecord').classList.toggle('hidden', !(state.mode === 'sample' && selectedZone()?.origin === 'sample' && api.canRecord?.()));
  $('#stat-size').textContent = formatBytes(estimateBytes());
  $('#stat-longest').textContent = formatSeconds(longest);
  $('#stat-longest').classList.toggle('over', longest > MAX_SECONDS);
  $('#stat-zones').textContent = String(n);
  $('#stat-zones').classList.toggle('over', n > MAX_ZONES);
  const ok = n > 0 && n <= MAX_ZONES && longest <= MAX_SECONDS + 1e-6 && findDuplicateKeys().length === 0 && state.zones.every((z) => z.processed);
  $('#export').disabled = !ok;
}

$('#export').addEventListener('click', async () => {
  const btn = $('#export');
  const st = $('#export-status');
  btn.disabled = true;
  try {
    const name = presetName();
    const folder = `${name === 'untitled' ? `untitled ${new Date().toISOString().slice(11, 16).replace(':', '')}` : name}.preset`;
    const entries = [];
    const zonesOut = [];
    const sorted = sortedZones();
    const used = new Set();
    for (let i = 0; i < sorted.length; i++) {
      const z = sorted[i];
      st.textContent = `writing ${i + 1} / ${sorted.length}…`;
      await new Promise((r) => setTimeout(r));
      const p = z.processed;
      let ch = opts.mono ? toMono(p.channels) : p.channels;
      ch = await resample(ch, p.sampleRate, opts.rate);
      const frames = ch[0].length;
      const ratio = opts.rate / p.sampleRate;
      const loop = z.loopEnabled && p.loop
        ? { start: Math.min(frames - 2, Math.round(p.loop.start * ratio)), end: Math.min(frames - 1, Math.round(p.loop.end * ratio)), enabled: true, onRelease: opts.onRelease, crossfade: opts.crossfade }
        : null;
      let filename = `${name}-${midiToName(z.keycenter)}.wav`;
      let k = 2;
      while (used.has(filename)) filename = `${name}-${midiToName(z.keycenter)}-${k++}.wav`;
      used.add(filename);
      entries.push({ name: `${folder}/${filename}`, data: encodeWav(ch, opts.rate, { rootNote: z.keycenter, loop }) });
      zonesOut.push({ filename, keycenter: z.keycenter, framecount: frames, loop, gain: 0, tune: 0, reverse: false });
    }
    const patch = buildPatch(zonesOut, {
      ampAttack: opts.ampAttack, ampRelease: opts.ampRelease, extendTopZone: opts.extendTop,
    });
    entries.unshift({ name: `${folder}/patch.json`, data: patch });
    const zip = buildZip(entries);
    download(zip, `${folder}.zip`);
    st.textContent = `exported ${folder}.zip — ${formatBytes(zip.size)}, ${sorted.length} zones`;
  } catch (err) {
    st.textContent = `export failed: ${err.message}`;
    console.error(err);
  } finally {
    renderExport();
  }
});

$('#export-raw').addEventListener('click', async () => {
  const sorted = sortedZones().filter((z) => z.raw);
  if (!sorted.length) return;
  const name = presetName();
  const entries = [];
  const used = new Set();
  for (const z of sorted) {
    let filename = `${name}-${midiToName(z.keycenter)}-raw.wav`;
    let k = 2;
    while (used.has(filename)) filename = `${name}-${midiToName(z.keycenter)}-raw-${k++}.wav`;
    used.add(filename);
    entries.push({ name: `${name} raw takes/${filename}`, data: encodeWav(z.raw.channels, z.raw.sampleRate, { rootNote: z.keycenter }) });
  }
  const zip = buildZip(entries);
  download(zip, `${name} raw takes.zip`);
  $('#export-status').textContent = `exported ${sorted.length} raw takes — ${formatBytes(zip.size)} (untrimmed, at the recorded sample rate)`;
});

// ---------- session persistence ----------

let dirty = false;
let saveTimer = null;
function markDirty() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 1500);
}
async function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    if (!state.zones.length) { await clearSession(); return; }
    await saveSession({
      presetName: $('#preset-name').value,
      convention: Number($('#convention').value),
      zones: state.zones.filter((z) => z.raw).map((z) => ({
        name: z.name, keycenter: z.keycenter, noteSource: z.noteSource, hints: z.hints, origin: z.origin,
        detected: z.detected, fadeMs: z.fadeMs, loopEnabled: z.loopEnabled, loopOverride: z.loopOverride,
        raw: { channels: z.raw.channels, sampleRate: z.raw.sampleRate },
      })),
    });
  } catch (err) {
    console.warn('could not save session', err);
  }
}
async function offerRestore() {
  let data;
  try { data = await loadSession(); } catch { return; }
  if (!data?.zones?.length || state.zones.length) return;
  const box = $('#session-notice');
  const when = new Date(data.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  box.append(el('div', { class: 'notice' },
    `a previous session with ${data.zones.length} zone${data.zones.length === 1 ? '' : 's'} ("${data.presetName}", saved ${when}) is still here. `,
    el('button', { class: 'btn small', style: 'margin:0 6px', onclick: () => {
      $('#preset-name').value = data.presetName || 'untitled';
      $('#convention').value = String(data.convention || 3);
      setMiddleCOctave(Number($('#convention').value));
      for (const zd of data.zones) {
        const z = addZone({ name: zd.name, raw: zd.raw, keycenter: zd.keycenter, noteSource: zd.noteSource, hints: zd.hints, origin: zd.origin });
        z.detected = zd.detected || null; z.fadeMs = zd.fadeMs ?? null; z.loopEnabled = zd.loopEnabled !== false; z.loopOverride = zd.loopOverride || null;
        processZone(z);
      }
      box.innerHTML = '';
      dirty = false;
      render();
    } }, 'restore'),
    el('button', { class: 'btn ghost small', onclick: async () => { await clearSession(); box.innerHTML = ''; } }, 'discard'),
  ));
}
offerRestore();
window.addEventListener('pagehide', () => { if (dirty) persist(); });

// ---------- mode tabs ----------

$$('nav.modes button').forEach((b) => b.addEventListener('click', () => {
  if (b.disabled) return;
  $$('nav.modes button').forEach((x) => x.setAttribute('aria-selected', x === b));
  $('#mode-import').classList.toggle('hidden', b.dataset.mode !== 'import');
  $('#mode-sample').classList.toggle('hidden', b.dataset.mode !== 'sample');
  state.mode = b.dataset.mode;
  render();
}));

// Hooks the auto-sampler uses to feed zones into the shared state.
const api = {
  state, opts,
  addZone, processZone, removeZone, render, checkZoneCount, selectedZone, presetName,
  noteName: midiToName, parseNote: (v) => nameToMidi(v) ?? (/^\d{1,3}$/.test(v) && Number(v) <= 127 ? Number(v) : null),
  replaceZoneAudio(zone, raw, hints) { zone.raw = raw; zone.hints = hints; zone.loopOverride = null; processZone(zone); render(); },
};
initAutoSample(api);

initKnobs();
window.addEventListener('resize', () => { renderZoneList(); renderDetail(); });
render();
