// Web MIDI output. Chrome only.

let access = null;

export async function midiSupported() {
  return typeof navigator.requestMIDIAccess === 'function';
}

export async function requestMidi() {
  if (!access) access = await navigator.requestMIDIAccess({ sysex: false });
  return access;
}

export function listOutputs() {
  if (!access) return [];
  return [...access.outputs.values()].map((o) => ({ id: o.id, name: o.name || o.id, manufacturer: o.manufacturer || '' }));
}

export function onStateChange(fn) {
  if (access) access.onstatechange = fn;
}

export class MidiOut {
  constructor(outputId, channel = 1) {
    this.output = access?.outputs.get(outputId) || null;
    this.channel = channel; // 1-16
  }
  get ok() { return !!this.output; }
  noteOn(note, velocity = 100) {
    this.output?.send([0x90 | (this.channel - 1), note & 0x7f, velocity & 0x7f]);
  }
  noteOff(note) {
    this.output?.send([0x80 | (this.channel - 1), note & 0x7f, 0]);
  }
  allNotesOff() {
    if (!this.output) return;
    this.output.send([0xb0 | (this.channel - 1), 123, 0]); // all notes off
    this.output.send([0xb0 | (this.channel - 1), 120, 0]); // all sound off
  }
}
