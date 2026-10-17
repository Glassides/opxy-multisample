// Note naming and parsing.
//
// The OP-XY names middle C (MIDI 60) "c3" in its own sample filenames, so that
// is the default convention here. Some other gear calls MIDI 60 "C4"; the
// convention is switchable because imported files may follow either.

export const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

const PITCH_CLASS = {
  c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, fb: 4, 'e#': 5, f: 5, 'f#': 6, gb: 6,
  g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11, cb: 11, 'b#': 0,
};

// middleCOctave: the octave number given to MIDI 60. 3 = TE / Yamaha style, 4 = scientific.
let middleCOctave = 3;

export function setMiddleCOctave(n) { middleCOctave = n; }
export function getMiddleCOctave() { return middleCOctave; }

export function midiToName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - (5 - middleCOctave);
  return `${NOTE_NAMES[pc]}${octave}`;
}

export function nameToMidi(name) {
  const m = /^([a-g])([#b]?)(-?\d{1,2})$/i.exec(name.trim());
  if (!m) return null;
  const key = (m[1] + m[2]).toLowerCase();
  const pc = PITCH_CLASS[key];
  if (pc === undefined) return null;
  const octave = parseInt(m[3], 10);
  const midi = pc + (octave + (5 - middleCOctave)) * 12;
  return midi >= 0 && midi <= 127 ? midi : null;
}

// Pull a note out of a filename. Tries, in order:
//   1. a note name token ("c3", "C#3", "Db-1") separated by space / - / _ / .
//   2. a note name glued to other text at a token boundary ("pianoC3", "C3v100")
//   3. a bare MIDI number token (0-127)
// Returns { midi, source } or null.
export function noteFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const tokens = base.split(/[\s\-_.]+/).filter(Boolean);

  for (const t of tokens) {
    const midi = nameToMidi(t);
    if (midi !== null) return { midi, source: 'filename' };
  }
  for (const t of tokens) {
    const m = /(?:^|[^a-z])([a-g][#b]?-?\d)(?:[^\d]|$)/i.exec(t);
    if (m) {
      const midi = nameToMidi(m[1]);
      if (midi !== null) return { midi, source: 'filename' };
    }
  }
  // Bare numbers: only trust one if it is the only numeric token, since
  // many libraries also carry velocity or take numbers.
  const numeric = tokens.filter((t) => /^\d{1,3}$/.test(t)).map(Number).filter((n) => n <= 127);
  if (numeric.length === 1) return { midi: numeric[0], source: 'filename number' };
  return null;
}

// Filenames the OP-XY will accept: a-z A-Z 0-9 space # - ( ) and one dot for the extension.
export function sanitiseName(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 #\-()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
