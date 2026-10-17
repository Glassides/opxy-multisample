// Builds patch.json for an OP-XY multisampler preset. The wrapper blocks
// (engine / envelope / fx / lfo) are copied from a preset the device itself
// wrote (see reference/patch.json); only the regions and the amp envelope are
// ours. Keys are written in sorted order, as the device does.

export const MAX_ZONES = 24;
export const MAX_SECONDS = 20;

const TEMPLATE = {
  engine: {
    bendrange: 32767,
    highpass: 0,
    modulation: {
      aftertouch: { amount: 16383, target: 0 },
      modwheel: { amount: 16383, target: 0 },
      pitchbend: { amount: 16383, target: 0 },
      velocity: { amount: 32767, target: 16711 },
    },
    params: [16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384],
    playmode: 'poly',
    'portamento.amount': 0,
    'portamento.type': 32767,
    transpose: 0,
    'tuning.root': 0,
    'tuning.scale': 0,
    'velocity.sensitivity': 26540,
    volume: 30472,
    width: 0,
  },
  envelope: {
    amp: { attack: 0, decay: 26897, release: 0, sustain: 25066 },
    filter: { attack: 8683, decay: 15460, release: 0, sustain: 17365 },
  },
  fx: { active: true, params: [10812, 16547, 0, 0, 0, 32767, 0, 0], type: 'z lowpass' },
  lfo: { active: true, params: [21784, 18677, 15889, 4915, 0, 0, 0, 0], type: 'tremolo' },
  octave: 0,
  platform: 'OP-XY',
  type: 'multisampler',
  version: 4,
};

// Device parameters are 0..32767.
export const P_MAX = 32767;
export const pct = (fraction) => Math.round(Math.max(0, Math.min(1, fraction)) * P_MAX);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

// zones: [{ filename, keycenter, framecount, loop: {start, end, enabled, onRelease, crossfade}|null, gain, tune, reverse }]
// options: { ampAttack, ampDecay, ampSustain, ampRelease (0..1 fractions), extendTopZone, fxActive, lfoActive }
export function buildPatch(zones, options = {}) {
  const {
    ampAttack = 0,
    ampDecay = TEMPLATE.envelope.amp.decay / P_MAX,
    ampSustain = TEMPLATE.envelope.amp.sustain / P_MAX,
    ampRelease = 0,
    extendTopZone = true,
    fxActive = false,
    lfoActive = false,
  } = options;

  const sorted = [...zones].sort((a, b) => a.keycenter - b.keycenter);
  if (sorted.length > MAX_ZONES) throw new Error(`a multisampler holds at most ${MAX_ZONES} zones (got ${sorted.length})`);

  const regions = sorted.map((z, i) => {
    const isTop = i === sorted.length - 1;
    const loop = z.loop;
    const hasLoop = !!loop && loop.enabled;
    const defaultStart = Math.floor(z.framecount * 0.2);
    const defaultEnd = Math.floor(z.framecount * 0.8);
    return {
      framecount: z.framecount,
      gain: z.gain ?? 0,
      hikey: isTop && extendTopZone ? 127 : z.keycenter,
      lokey: 0,
      'loop.crossfade': hasLoop ? pct(loop.crossfade ?? 0) : 0,
      'loop.enabled': hasLoop,
      'loop.end': loop ? loop.end : defaultEnd,
      'loop.onrelease': hasLoop ? !!loop.onRelease : false,
      'loop.start': loop ? loop.start : defaultStart,
      'pitch.keycenter': z.keycenter,
      reverse: !!z.reverse,
      sample: z.filename,
      'sample.end': z.framecount,
      'sample.start': 0,
      tune: z.tune ?? 0,
    };
  });

  const patch = structuredClone(TEMPLATE);
  patch.envelope.amp = {
    attack: pct(ampAttack),
    decay: pct(ampDecay),
    sustain: pct(ampSustain),
    release: pct(ampRelease),
  };
  patch.fx.active = fxActive;
  patch.lfo.active = lfoActive;
  patch.regions = regions;
  return JSON.stringify(sortKeys(patch));
}

// Which zone plays a note: the region whose hikey is the lowest one >= note.
export function zoneForNote(zonesSortedByKey, note) {
  for (let i = 0; i < zonesSortedByKey.length; i++) {
    const z = zonesSortedByKey[i];
    const hikey = i === zonesSortedByKey.length - 1 ? 127 : z.keycenter;
    if (note <= hikey) return z;
  }
  return null;
}
