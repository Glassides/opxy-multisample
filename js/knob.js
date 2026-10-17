// Turns range inputs marked data-knob into round dials. The input stays in
// the DOM (hidden) and still receives 'input' events, so existing bindings
// keep working. Drag vertically (shift for fine), scroll, double-click resets.

const SWEEP = 270;            // degrees of travel
const START = 135;            // degrees from 12 o'clock, clockwise, where travel begins

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arc(cx, cy, r, fromDeg, toDeg) {
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

export function initKnobs(root = document) {
  for (const input of root.querySelectorAll('input[type="range"][data-knob]')) {
    if (input._knob) continue;
    makeKnob(input);
  }
}

function makeKnob(input) {
  const size = 56;
  const c = size / 2;
  const r = c - 5;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'knob');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'slider');

  const track = document.createElementNS(svgNS, 'path');
  track.setAttribute('class', 'knob-track');
  track.setAttribute('d', arc(c, c, r, START, START + SWEEP));
  const fill = document.createElementNS(svgNS, 'path');
  fill.setAttribute('class', 'knob-fill');
  const body = document.createElementNS(svgNS, 'circle');
  body.setAttribute('class', 'knob-body');
  body.setAttribute('cx', c); body.setAttribute('cy', c); body.setAttribute('r', r - 7);
  const pointer = document.createElementNS(svgNS, 'line');
  pointer.setAttribute('class', 'knob-pointer');
  svg.append(track, fill, body, pointer);

  const min = Number(input.min), max = Number(input.max);
  const step = Number(input.step) || 1;
  const def = input.dataset.default !== undefined ? Number(input.dataset.default) : Number(input.value);
  const bipolar = input.dataset.bipolar !== undefined;

  function frac() { return (Number(input.value) - min) / (max - min); }
  function draw() {
    const f = frac();
    const deg = START + SWEEP * f;
    if (bipolar) {
      const mid = START + SWEEP / 2;
      fill.setAttribute('d', deg >= mid ? arc(c, c, r, mid, deg) : arc(c, c, r, deg, mid));
    } else {
      fill.setAttribute('d', f > 0.002 ? arc(c, c, r, START, deg) : '');
    }
    const [x0, y0] = polar(c, c, r - 7, deg);
    const [x1, y1] = polar(c, c, r - 14, deg);
    pointer.setAttribute('x1', x0); pointer.setAttribute('y1', y0);
    pointer.setAttribute('x2', x1); pointer.setAttribute('y2', y1);
    svg.setAttribute('aria-valuenow', input.value);
  }
  function set(v) {
    v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    const fixed = step < 1 ? v.toFixed(String(step).split('.')[1].length) : String(v);
    if (input.value !== fixed) {
      input.value = fixed;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    draw();
  }

  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, v: Number(input.value) };
    svg.classList.add('active');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const px = e.shiftKey ? 600 : 150;      // pixels for full travel
    const dv = ((drag.y - e.clientY) / px) * (max - min);
    set(drag.v + dv);
  });
  const end = () => { drag = null; svg.classList.remove('active'); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const inc = e.shiftKey ? step : Math.max(step, (max - min) / 50);
    set(Number(input.value) + dir * inc);
  }, { passive: false });
  svg.addEventListener('dblclick', () => set(def));
  svg.addEventListener('keydown', (e) => {
    const inc = e.shiftKey ? step : Math.max(step, (max - min) / 50);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); set(Number(input.value) + inc); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); set(Number(input.value) - inc); }
  });
  // Keep the dial in step with programmatic changes (e.g. planner suggestions).
  input.addEventListener('input', draw);
  input.addEventListener('change', draw);

  input._knob = svg;
  input.classList.add('knob-input');
  input.parentElement.classList.add('has-knob');
  input.before(svg);
  draw();
}
