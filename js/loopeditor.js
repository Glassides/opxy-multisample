// Interactive waveform for the selected zone: zoom / pan, draggable loop
// handles that snap to rising zero crossings (hold alt / option to move
// freely), a draggable loop search window, and a splice view that butts the
// audio before the loop end against the audio after the loop start.

import { drawWaveform } from './ui.js';
import { nearestZeroCrossing } from './process.js';

const HANDLE_PX = 7;

export class LoopEditor {
  constructor({ canvas, splice, getZone, onLoop, onWindow, onSeek }) {
    this.canvas = canvas;
    this.splice = splice;
    this.getZone = getZone;
    this.onLoop = onLoop;
    this.onWindow = onWindow;
    this.onSeek = onSeek;
    this.view = null;      // { from, to } frames
    this.drag = null;
    this.zoneKey = null;
    this.spliceMs = 20;

    canvas.addEventListener('mousedown', (e) => this._down(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', () => this._up());
    canvas.addEventListener('mousemove', (e) => this._hover(e));
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => this._dbl(e));
  }

  _n() { return this.getZone()?.processed?.channels[0].length || 0; }

  _ensureView() {
    const z = this.getZone();
    const key = z ? `${z.id}:${z.processed?.channels}` : null;
    if (key !== this.zoneKey || !this.view) {
      this.zoneKey = key;
      this.fit();
    }
  }

  fit() {
    this.view = { from: 0, to: this._n() };
  }

  zoomToLoop() {
    const z = this.getZone();
    const loop = z?.processed?.loop;
    if (!loop) return this.fit();
    const len = loop.end - loop.start;
    const pad = Math.max(200, len * 0.25);
    this.view = { from: Math.max(0, loop.start - pad), to: Math.min(this._n(), loop.end + pad) };
  }

  zoomBy(factor, centreFrac = 0.5) {
    const n = this._n();
    const { from, to } = this.view;
    const span = to - from;
    const newSpan = Math.max(64, Math.min(n, span / factor));
    const centre = from + span * centreFrac;
    let nf = centre - newSpan * centreFrac;
    nf = Math.max(0, Math.min(n - newSpan, nf));
    this.view = { from: Math.round(nf), to: Math.round(nf + newSpan) };
  }

  _xToFrame(x) {
    const w = this.canvas.clientWidth;
    return this.view.from + (x / w) * (this.view.to - this.view.from);
  }
  _frameToX(f) {
    const w = this.canvas.clientWidth;
    return ((f - this.view.from) / (this.view.to - this.view.from)) * w;
  }

  _targets() {
    const z = this.getZone();
    const p = z?.processed;
    const t = [];
    if (p?.loop && z.loopEnabled) {
      t.push({ kind: 'loopStart', frame: p.loop.start });
      t.push({ kind: 'loopEnd', frame: p.loop.end });
    }
    if (z?.window) {
      t.push({ kind: 'winFrom', frame: z.window.start });
      t.push({ kind: 'winTo', frame: z.window.end });
    }
    return t;
  }

  _hit(x) {
    let best = null;
    for (const t of this._targets()) {
      const d = Math.abs(this._frameToX(t.frame) - x);
      if (d <= HANDLE_PX && (!best || d < best.d)) best = { ...t, d };
    }
    return best;
  }

  _down(e) {
    this._ensureView();
    if (!this._n()) return;
    const x = e.offsetX;
    const hit = this._hit(x);
    if (hit) {
      this.drag = { kind: hit.kind, alt: e.altKey };
    } else {
      this.drag = { kind: 'pan', startX: x, from: this.view.from, to: this.view.to };
    }
    e.preventDefault();
  }

  _move(e) {
    if (!this.drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const z = this.getZone();
    if (!z?.processed) return;
    const n = this._n();
    if (this.drag.kind === 'pan') {
      const span = this.drag.to - this.drag.from;
      const dx = (x - this.drag.startX) / this.canvas.clientWidth * span;
      let from = Math.max(0, Math.min(n - span, this.drag.from - dx));
      this.view = { from: Math.round(from), to: Math.round(from + span) };
      this.draw();
      return;
    }
    let frame = Math.max(0, Math.min(n - 1, Math.round(this._xToFrame(x))));
    const snap = !(e.altKey || this.drag.alt);
    const loop = z.processed.loop;
    if (this.drag.kind === 'loopStart' || this.drag.kind === 'loopEnd') {
      if (snap) frame = nearestZeroCrossing(z.processed.channels, frame, Math.max(32, (this.view.to - this.view.from) / 50));
      let s = loop.start, en = loop.end;
      if (this.drag.kind === 'loopStart') s = Math.min(frame, en - 16); else en = Math.max(frame, s + 16);
      this.onLoop(s, en);
    } else if (this.drag.kind === 'winFrom' || this.drag.kind === 'winTo') {
      let a = z.window.start, b = z.window.end;
      if (this.drag.kind === 'winFrom') a = Math.min(frame, b - 64); else b = Math.max(frame, a + 64);
      this.onWindow(a, b);
    }
  }

  _up() {
    this.drag = null;
  }

  _hover(e) {
    if (this.drag || !this.view) return;
    const hit = this._hit(e.offsetX);
    this.canvas.style.cursor = hit ? 'col-resize' : 'grab';
    this.canvas.title = hit
      ? (hit.kind.startsWith('loop') ? 'drag loop point — snaps to zero crossings, hold ⌥ to move freely' : 'drag the loop search window edge')
      : 'drag to pan · scroll to zoom · double-click to audition from here';
  }

  _wheel(e) {
    this._ensureView();
    if (!this._n()) return;
    e.preventDefault();
    const frac = e.offsetX / this.canvas.clientWidth;
    this.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, frac);
    this.draw();
  }

  _dbl(e) {
    this._ensureView();
    if (!this._n()) return;
    this.onSeek?.(Math.round(this._xToFrame(e.offsetX)));
  }

  draw(playhead = null) {
    this._ensureView();
    const z = this.getZone();
    const p = z?.processed;
    if (!p) return;
    drawWaveform(this.canvas, p.channels, {
      loop: z.loopEnabled ? p.loop : null,
      band: z.window,
      playhead,
      view: this.view,
    });
    this._drawSplice(z);
  }

  _drawSplice(z) {
    const c = this.splice;
    if (!c) return;
    const p = z.processed;
    const loop = p.loop;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const styles = getComputedStyle(c);
    const ink = styles.getPropertyValue('--ink').trim();
    const accent = styles.getPropertyValue('--accent').trim();
    const faint = styles.getPropertyValue('--ink-3').trim();
    if (!loop || !z.loopEnabled) {
      ctx.fillStyle = faint;
      ctx.font = '11px ' + styles.getPropertyValue('--mono');
      ctx.fillText('no loop', 8, 16);
      return;
    }
    const half = Math.round((this.spliceMs / 1000) * p.sampleRate);
    const mono = p.channels.length === 1 ? p.channels[0] : null;
    const sample = (i) => {
      if (i < 0 || i >= p.channels[0].length) return 0;
      if (mono) return mono[i];
      let s = 0;
      for (const ch of p.channels) s += ch[i];
      return s / p.channels.length;
    };
    const mid = h / 2;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const total = half * 2;
    for (let x = 0; x < w; x++) {
      const k = Math.floor((x / w) * total);
      const idx = k < half ? loop.end - half + k : loop.start + (k - half);
      const y = mid - sample(idx) * mid * 0.9;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.moveTo(w / 2 + 0.5, 0);
    ctx.lineTo(w / 2 + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = faint;
    ctx.font = '10px ' + styles.getPropertyValue('--mono');
    ctx.fillText(`${this.spliceMs} ms before loop end`, 6, h - 5);
    const label = `${this.spliceMs} ms after loop start`;
    ctx.fillText(label, w - ctx.measureText(label).width - 6, h - 5);
  }
}
