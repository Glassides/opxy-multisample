// Small DOM helpers and the waveform renderer.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === false || v === null || v === undefined) continue;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSeconds(s) {
  return s < 10 ? `${s.toFixed(2)} s` : `${s.toFixed(1)} s`;
}

// Draw a peak-envelope waveform of `channels` (mono-mixed) into a canvas, with
// optional markers: { loop: {start,end}, playhead: frame, trimmedFrom }.
// markers.view = { from, to } restricts drawing to that frame range;
// markers.band = { start, end } draws a faint band (the loop search window).
export function drawWaveform(canvas, channels, markers = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(canvas);
  const ink = styles.getPropertyValue('--ink').trim() || '#111';
  const accent = styles.getPropertyValue('--accent').trim() || '#ff5a00';
  const faint = styles.getPropertyValue('--line').trim() || '#ddd';

  if (!channels || !channels.length) return;
  const total = channels[0].length;
  const vFrom = markers.view ? markers.view.from : 0;
  const vTo = markers.view ? markers.view.to : total;
  const n = Math.max(1, vTo - vFrom);
  const fx = (f) => ((f - vFrom) / n) * w;
  const mid = h / 2;

  if (markers.band) {
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.05;
    ctx.fillRect(fx(markers.band.start), 0, fx(markers.band.end) - fx(markers.band.start), h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.25;
    ctx.setLineDash([3, 3]);
    for (const f of [markers.band.start, markers.band.end]) {
      const x = Math.round(fx(f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  if (markers.loop) {
    const x0 = fx(markers.loop.start);
    const x1 = fx(markers.loop.end);
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = faint;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();

  ctx.fillStyle = ink;
  const step = n / w;
  if (step >= 1) {
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, Math.floor(vFrom + x * step));
      const b = Math.min(total, Math.floor(vFrom + (x + 1) * step) + 1);
      let min = 1;
      let max = -1;
      for (const ch of channels) {
        for (let i = a; i < b; i++) {
          const v = ch[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (min > max) continue;
      const y0 = mid - max * mid;
      const y1 = mid - min * mid;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  } else {
    // Zoomed in past one frame per pixel: draw the actual samples as a line.
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    for (const ch of channels) {
      ctx.beginPath();
      for (let i = Math.max(0, Math.floor(vFrom)); i <= Math.min(total - 1, Math.ceil(vTo)); i++) {
        const x = fx(i), y = mid - ch[i] * mid;
        if (i === Math.max(0, Math.floor(vFrom))) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  if (markers.loop) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    for (const f of [markers.loop.start, markers.loop.end]) {
      const x = Math.round(fx(f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      // handle nub
      ctx.fillStyle = accent;
      ctx.fillRect(x - 3, 0, 6, 8);
    }
  }
  if (markers.playhead !== undefined && markers.playhead !== null) {
    const x = Math.round(fx(markers.playhead)) + 0.5;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
