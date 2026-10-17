// Auto-sample mode UI: connections, test note, range planning and the run.
// Zones are pushed into the shared app state through the `api` passed in.

import { $, el, drawWaveform, formatSeconds } from './ui.js';
import { requestMidi, listOutputs, onStateChange, MidiOut, midiSupported } from './midi.js';
import { Recorder, listInputs, requestInputPermission } from './recorder.js';
import { AutoSampler, plannedNotes, fitSuggestions, MAX_ZONES } from './sampler.js';
import { MAX_SECONDS } from './patch.js';

export function initAutoSample(api) {
  const { state, opts } = api;
  const recorder = new Recorder();
  let midi = null;
  let sampler = null;
  let running = false;

  const cfg = {
    midiOut: '', midiCh: 1, velocity: 100,
    audioIn: '', pick: 'stereo',
    latencyMs: 0, releaseSec: 1.0,
    start: 'c1', end: 'c6', step: 3, hold: 2, anchorC: false,
    testNote: 'c3',
  };

  const ui = {
    connect: $('#connect'), midiOut: $('#midi-out'), midiCh: $('#midi-ch'), audioIn: $('#audio-in'), pick: $('#audio-pick'),
    velocity: $('#velocity'), velocityVal: $('#velocity-val'),
    meterL: $('#meter-l'), meterR: $('#meter-r'), meterVal: $('#meter-val'), connectStatus: $('#connect-status'),
    test: $('#test'), testNote: $('#test-note'), latency: $('#latency'), release: $('#release'),
    latencyMeasured: $('#latency-measured'), releaseMeasured: $('#release-measured'),
    noiseFloor: $('#noise-floor'), testPeak: $('#test-peak'), testWave: $('#test-wave'), testStatus: $('#test-status'),
    start: $('#range-start'), end: $('#range-end'), step: $('#range-step'), stepVal: $('#range-step-val'),
    hold: $('#hold'), holdVal: $('#hold-val'), anchorC: $('#anchor-c'),
    planCount: $('#plan-count'), planNotes: $('#plan-notes'), planTime: $('#plan-time'), planNotice: $('#plan-notice'),
    run: $('#run'), abort: $('#abort'), progress: $('#run-progress'), runStatus: $('#run-status'),
    rerecord: $('#rerecord'),
  };

  for (let c = 1; c <= 16; c++) ui.midiCh.append(el('option', { value: c }, String(c)));

  if (!midiSupported()) $('#midi-unsupported').classList.remove('hidden');

  // ----- connections -----

  const setStatus = (node, msg, err = false) => { node.textContent = msg; node.classList.toggle('danger', err); };

  async function connect() {
    try {
      setStatus(ui.connectStatus, 'asking for midi and audio permissions…');
      await requestMidi();
      await requestInputPermission();
      await refreshDevices();
      onStateChange(refreshDevices);
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      setStatus(ui.connectStatus, 'connected — choose a midi output and an audio input');
    } catch (err) {
      setStatus(ui.connectStatus, `could not connect: ${err.message}`, true);
    }
    updateReady();
  }

  async function refreshDevices() {
    const outs = listOutputs();
    ui.midiOut.innerHTML = '';
    ui.midiOut.append(el('option', { value: '' }, outs.length ? '— choose —' : 'no midi outputs found'));
    for (const o of outs) ui.midiOut.append(el('option', { value: o.id }, o.name));
    if (outs.find((o) => o.id === cfg.midiOut)) ui.midiOut.value = cfg.midiOut; else if (outs.length === 1) { ui.midiOut.value = outs[0].id; cfg.midiOut = outs[0].id; }

    const ins = await listInputs();
    ui.audioIn.innerHTML = '';
    ui.audioIn.append(el('option', { value: '' }, ins.length ? '— choose —' : 'no audio inputs found'));
    for (const i of ins) ui.audioIn.append(el('option', { value: i.id }, i.label));
    if (ins.find((i) => i.id === cfg.audioIn)) ui.audioIn.value = cfg.audioIn;
    updateReady();
  }

  async function openInput() {
    if (!cfg.audioIn) return;
    try {
      const info = await recorder.open(cfg.audioIn);
      setStatus(ui.connectStatus, `listening to ${info.label} — ${info.channels} ch @ ${info.sampleRate} hz`);
      if (info.channels < 2 && cfg.pick !== 'left') { cfg.pick = 'left'; ui.pick.value = 'left'; }
      ui.pick.querySelector('[value="stereo"]').disabled = info.channels < 2;
      ui.pick.querySelector('[value="right"]').disabled = info.channels < 2;
      meterLoop();
    } catch (err) {
      setStatus(ui.connectStatus, `could not open input: ${err.message}`, true);
    }
    updateReady();
  }

  let meterRaf = null;
  function meterLoop() {
    if (meterRaf) return;
    const tick = () => {
      if (!recorder.ctx) { meterRaf = null; ui.meterL.style.setProperty('--level', '0%'); ui.meterR.style.setProperty('--level', '0%'); return; }
      const [l, r] = recorder.meterDb();
      const pct = (db) => `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
      ui.meterL.style.setProperty('--level', pct(l));
      ui.meterR.style.setProperty('--level', pct(r));
      ui.meterL.classList.toggle('hot', l > -1);
      ui.meterR.classList.toggle('hot', r > -1);
      ui.meterVal.textContent = `${Math.max(l, r) > -90 ? Math.max(l, r).toFixed(0) : '–'} dB`;
      meterRaf = requestAnimationFrame(tick);
    };
    meterRaf = requestAnimationFrame(tick);
  }

  function makeMidi() {
    midi = cfg.midiOut ? new MidiOut(cfg.midiOut, cfg.midiCh) : null;
    sampler = midi && recorder.ctx ? new AutoSampler({ midi, recorder, pick: cfg.pick }) : null;
    if (sampler) sampler.pick = cfg.pick;
  }

  function ready() { return !!(midi?.ok && recorder.ctx) && !running; }
  function updateReady() {
    makeMidi();
    ui.test.disabled = !ready();
    renderPlan();
    api.render();
  }
  api.canRecord = () => ready();

  ui.connect.addEventListener('click', connect);
  ui.midiOut.addEventListener('change', () => { cfg.midiOut = ui.midiOut.value; updateReady(); });
  ui.midiCh.addEventListener('change', () => { cfg.midiCh = Number(ui.midiCh.value); updateReady(); });
  ui.audioIn.addEventListener('change', async () => { cfg.audioIn = ui.audioIn.value; await openInput(); });
  ui.pick.addEventListener('change', () => { cfg.pick = ui.pick.value; updateReady(); });
  ui.velocity.addEventListener('input', () => { cfg.velocity = Number(ui.velocity.value); ui.velocityVal.textContent = String(cfg.velocity); });

  // ----- test note -----

  ui.latency.addEventListener('input', () => { cfg.latencyMs = Math.max(0, Number(ui.latency.value) || 0); renderPlan(); });
  ui.release.addEventListener('input', () => { cfg.releaseSec = Math.max(0, Number(ui.release.value) || 0); renderPlan(); });
  ui.testNote.addEventListener('input', () => { cfg.testNote = ui.testNote.value; });

  ui.test.addEventListener('click', async () => {
    const note = api.parseNote(ui.testNote.value.trim());
    if (note === null) return setStatus(ui.testStatus, `"${ui.testNote.value}" is not a note`, true);
    running = true;
    updateReady();
    ui.test.disabled = true;
    setStatus(ui.testStatus, `playing ${api.noteName(note)} and listening for the tail…`);
    try {
      const r = await sampler.testNote({ note, velocity: cfg.velocity, holdSec: 1, onsetThresholdDb: opts.thresholdDb + 8 });
      drawWaveform(ui.testWave, r.channels, {});
      ui.noiseFloor.textContent = `${r.noiseFloorDb.toFixed(0)} dB`;
      ui.noiseFloor.classList.toggle('over', r.noiseFloorDb > -50);
      ui.testPeak.textContent = `${r.peakDb.toFixed(1)} dB`;
      ui.testPeak.classList.toggle('over', r.peakDb > -0.5);
      if (r.latencyMs === null) {
        setStatus(ui.testStatus, 'no sound detected — check the midi output / channel, the synth, and the audio input', true);
        ui.latencyMeasured.textContent = 'not detected';
        ui.releaseMeasured.textContent = '–';
      } else {
        cfg.latencyMs = Math.round(r.latencyMs);
        cfg.releaseSec = Math.round(r.releaseSec * 10) / 10 + 0.1;
        ui.latency.value = cfg.latencyMs;
        ui.release.value = cfg.releaseSec;
        ui.latencyMeasured.textContent = `measured ${r.latencyMs.toFixed(0)} ms`;
        ui.releaseMeasured.textContent = `measured ${r.releaseSec.toFixed(2)} s`;
        const warn = [];
        if (r.noiseFloorDb > -50) warn.push(`noise floor is high (${r.noiseFloorDb.toFixed(0)} dB) — trimming may misfire`);
        if (r.peakDb > -0.5) warn.push('input is clipping — turn the synth or interface gain down');
        if (r.peakDb < -24) warn.push('input is quiet — more gain would help the noise floor');
        setStatus(ui.testStatus, warn.length ? warn.join(' · ') : 'measured — adjust by hand if you like, then set the range', warn.length > 0);
      }
    } catch (err) {
      setStatus(ui.testStatus, `test failed: ${err.message}`, true);
    } finally {
      running = false;
      updateReady();
    }
  });

  // ----- range -----

  function plan() {
    const start = api.parseNote(ui.start.value.trim());
    const end = api.parseNote(ui.end.value.trim());
    if (start === null || end === null) return null;
    return { start, end, step: cfg.step, anchorToC: cfg.anchorC, notes: plannedNotes({ start, end, step: cfg.step, anchorToC: cfg.anchorC }) };
  }

  function renderPlan() {
    const p = plan();
    ui.planNotice.innerHTML = '';
    if (!p) {
      ui.planCount.textContent = '–';
      ui.planNotes.textContent = 'start or end note is not valid';
      ui.planTime.textContent = '–';
      ui.run.disabled = true;
      return;
    }
    const n = p.notes.length;
    ui.planCount.textContent = String(n);
    ui.planCount.classList.toggle('over', n > MAX_ZONES || n === 0);
    ui.planNotes.textContent = n ? p.notes.map(api.noteName).join(' ') : 'none in range';
    const perNote = cfg.hold + cfg.releaseSec + cfg.latencyMs / 1000 + 0.2;
    ui.planTime.textContent = formatSeconds(n * perNote).replace(/\.\d+/, '');
    const problems = [];
    if (n > MAX_ZONES) {
      const sug = fitSuggestions(p);
      const row = el('div', { class: 'notice error' }, `${n} zones — the op-xy holds ${MAX_ZONES}. `);
      for (const s of sug) {
        if (s.step) row.append(el('button', { class: 'btn small', style: 'margin-right:6px', onclick: () => { ui.step.value = s.step; ui.step.dispatchEvent(new Event('input')); } }, `every ${s.step} semitones`));
        if (s.end !== undefined) row.append(el('button', { class: 'btn small', onclick: () => { ui.end.value = api.noteName(s.end); renderPlan(); } }, `end at ${api.noteName(s.end)}`));
      }
      ui.planNotice.append(row);
      problems.push('too many');
    }
    if (cfg.hold + cfg.releaseSec > MAX_SECONDS) {
      ui.planNotice.append(el('div', { class: 'notice' }, `hold + release is ${(cfg.hold + cfg.releaseSec).toFixed(1)} s — samples will be cut at ${MAX_SECONDS} s.`));
    }
    const existing = state.zones.length;
    if (existing && existing + n > MAX_ZONES) {
      ui.planNotice.append(el('div', { class: 'notice' }, `${existing} zone${existing === 1 ? '' : 's'} already loaded — sampling will add to them. clear all first for a fresh preset.`));
    }
    ui.run.disabled = !ready() || n === 0 || problems.length > 0;
  }

  // Changing the step (or start, or snap) fills the end note in for exactly 24 zones.
  function autoEnd() {
    const start = api.parseNote(ui.start.value.trim());
    if (start === null) return;
    const first = plannedNotes({ start, end: 127, step: cfg.step, anchorToC: cfg.anchorC })[0];
    if (first === undefined) return;
    ui.end.value = api.noteName(Math.min(127, first + (MAX_ZONES - 1) * cfg.step));
  }
  ui.start.addEventListener('input', () => { autoEnd(); renderPlan(); });
  ui.end.addEventListener('input', renderPlan);
  ui.step.addEventListener('input', () => { cfg.step = Number(ui.step.value); ui.stepVal.textContent = String(cfg.step); autoEnd(); renderPlan(); });
  ui.hold.addEventListener('input', () => { cfg.hold = Number(ui.hold.value); ui.holdVal.textContent = `${cfg.hold.toFixed(1)} s`; renderPlan(); });
  ui.anchorC.addEventListener('change', () => { cfg.anchorC = ui.anchorC.checked; autoEnd(); renderPlan(); });
  $('#convention').addEventListener('change', renderPlan);

  // ----- run -----

  function hintsFor(info) {
    return {
      latencyFrames: Math.max(0, info.latencyFrames - Math.round(0.015 * recorder.sampleRate)),
      onsetFrame: info.latencyFrames,
      holdFrames: info.holdFrames,
    };
  }

  ui.run.addEventListener('click', async () => {
    const p = plan();
    if (!p || !sampler) return;
    running = true;
    updateReady();
    ui.run.classList.add('hidden');
    ui.abort.classList.remove('hidden');
    ui.progress.style.width = '0%';
    const name = api.presetName();
    const placeholders = new Map();
    for (const note of p.notes) {
      const z = api.addZone({ name: `${name}-${api.noteName(note)}`, raw: null, keycenter: note, noteSource: 'sampled', origin: 'sample' });
      z.recording = true;
      placeholders.set(note, z);
    }
    api.render();
    let count = 0;
    try {
      const finished = await sampler.run({
        notes: p.notes,
        velocity: cfg.velocity,
        holdSec: cfg.hold,
        releaseSec: cfg.releaseSec,
        latencyMs: cfg.latencyMs,
        onProgress: ({ index, note, phase }) => {
          setStatus(ui.runStatus, `${index + 1} / ${p.notes.length} — ${api.noteName(note)} ${phase === 'playing' ? 'playing' : 'tail'}…`);
        },
        onNote: (note, raw, index, info) => {
          const z = placeholders.get(note);
          z.recording = false;
          z.raw = raw;
          z.hints = hintsFor(info);
          api.processZone(z);
          state.selectedId = z.id;
          count++;
          ui.progress.style.width = `${((index + 1) / p.notes.length) * 100}%`;
          api.render();
        },
      });
      // Drop anything that never got recorded (abort).
      for (const z of placeholders.values()) if (z.recording) api.removeZone(z.id);
      setStatus(ui.runStatus, finished ? `done — ${count} zones sampled` : `aborted after ${count} zone${count === 1 ? '' : 's'}`);
    } catch (err) {
      for (const z of placeholders.values()) if (z.recording) api.removeZone(z.id);
      setStatus(ui.runStatus, `sampling failed: ${err.message}`, true);
    } finally {
      running = false;
      ui.run.classList.remove('hidden');
      ui.abort.classList.add('hidden');
      ui.abort.disabled = false;
      updateReady();
    }
  });

  ui.abort.addEventListener('click', () => { sampler?.abort(); ui.abort.disabled = true; setStatus(ui.runStatus, 'aborting…'); });

  // Re-record a single zone with the current settings.
  ui.rerecord.addEventListener('click', async () => {
    const z = api.selectedZone();
    if (!z || !sampler || running) return;
    running = true;
    updateReady();
    z.recording = true;
    api.render();
    try {
      await sampler.run({
        notes: [z.keycenter], velocity: cfg.velocity, holdSec: cfg.hold, releaseSec: cfg.releaseSec, latencyMs: cfg.latencyMs,
        onNote: (note, raw, index, info) => { z.recording = false; api.replaceZoneAudio(z, raw, hintsFor(info)); },
      });
    } catch (err) {
      setStatus(ui.runStatus, `re-record failed: ${err.message}`, true);
    } finally {
      z.recording = false;
      running = false;
      updateReady();
    }
  });

  window.addEventListener('beforeunload', () => { midi?.allNotesOff(); });
  updateReady();
}
