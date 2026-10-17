// Audio file reading and writing.
//
// Decoding goes through the browser's decoder (WAV, AIFF, FLAC, MP3 all work in
// Chrome) but we read the RIFF / AIFF headers ourselves first, both to learn the
// native sample rate (so we can decode without an unwanted resample) and to pick
// up root-note metadata from a WAV `smpl` chunk or an AIFF `INST` chunk.

function ascii(view, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// Returns { format: 'wav'|'aiff'|null, sampleRate, channels, bitDepth, rootNote, loop }
export function readHeader(buffer) {
  const view = new DataView(buffer);
  const info = { format: null, sampleRate: null, channels: null, bitDepth: null, rootNote: null, loop: null };
  if (buffer.byteLength < 12) return info;
  const magic = ascii(view, 0, 4);

  if (magic === 'RIFF' && ascii(view, 8, 4) === 'WAVE') {
    info.format = 'wav';
    let pos = 12;
    while (pos + 8 <= buffer.byteLength) {
      const id = ascii(view, pos, 4);
      const size = view.getUint32(pos + 4, true);
      const body = pos + 8;
      if (id === 'fmt ' && size >= 16) {
        info.channels = view.getUint16(body + 2, true);
        info.sampleRate = view.getUint32(body + 4, true);
        info.bitDepth = view.getUint16(body + 14, true);
      } else if (id === 'smpl' && size >= 36) {
        info.rootNote = view.getUint32(body + 12, true);
        const numLoops = view.getUint32(body + 28, true);
        if (numLoops > 0 && size >= 36 + 24) {
          const l = body + 36;
          info.loop = { start: view.getUint32(l + 8, true), end: view.getUint32(l + 12, true) };
        }
      }
      pos = body + size + (size & 1);
    }
  } else if (magic === 'FORM' && (ascii(view, 8, 4) === 'AIFF' || ascii(view, 8, 4) === 'AIFC')) {
    info.format = 'aiff';
    let pos = 12;
    while (pos + 8 <= buffer.byteLength) {
      const id = ascii(view, pos, 4);
      const size = view.getUint32(pos + 4, false);
      const body = pos + 8;
      if (id === 'COMM' && size >= 18) {
        info.channels = view.getUint16(body, false);
        info.bitDepth = view.getUint16(body + 6, false);
        info.sampleRate = readExtended(view, body + 8);
      } else if (id === 'INST' && size >= 20) {
        info.rootNote = view.getUint8(body);
      }
      pos = body + size + (size & 1);
    }
  }
  return info;
}

// 80-bit IEEE extended float, as used for the AIFF sample rate.
function readExtended(view, off) {
  const exp = view.getUint16(off, false) & 0x7fff;
  const hi = view.getUint32(off + 2, false);
  const lo = view.getUint32(off + 6, false);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const mant = hi * 2 ** 32 + lo;
  return mant * 2 ** (exp - 16383 - 63);
}

// Decode a File/Blob to { channels: Float32Array[], sampleRate, header }.
export async function decodeFile(file) {
  const buffer = await file.arrayBuffer();
  const header = readHeader(buffer);
  const rate = header.sampleRate && header.sampleRate >= 3000 && header.sampleRate <= 384000 ? header.sampleRate : 44100;
  const ctx = new OfflineAudioContext(1, 1, rate);
  const decoded = await ctx.decodeAudioData(buffer.slice(0));
  const channels = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  return { channels, sampleRate: decoded.sampleRate, header };
}

export function toMono(channels) {
  if (channels.length === 1) return channels;
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i];
    out[i] = s / channels.length;
  }
  return [out];
}

// High quality resample via the browser's own converter.
export async function resample(channels, fromRate, toRate) {
  if (fromRate === toRate) return channels;
  const length = Math.ceil((channels[0].length * toRate) / fromRate);
  const ctx = new OfflineAudioContext(channels.length, length, toRate);
  const buf = ctx.createBuffer(channels.length, channels[0].length, fromRate);
  channels.forEach((ch, i) => buf.copyToChannel(ch, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  const result = [];
  for (let c = 0; c < out.numberOfChannels; c++) result.push(out.getChannelData(c));
  return result;
}

// Write a 16-bit PCM WAV with an optional `smpl` chunk carrying the root note
// and loop. Frame counts in `loop` are in output frames.
export function encodeWav(channels, sampleRate, { rootNote = null, loop = null } = {}) {
  const numCh = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * numCh * 2;
  const smplBytes = rootNote === null ? 0 : 8 + 36 + (loop ? 24 : 0);
  const total = 12 + 24 + smplBytes + 8 + dataBytes;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  let p = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); };
  const u16 = (n) => { v.setUint16(p, n, true); p += 2; };
  const u32 = (n) => { v.setUint32(p, n >>> 0, true); p += 4; };

  str('RIFF'); u32(total - 8); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(numCh); u32(sampleRate); u32(sampleRate * numCh * 2); u16(numCh * 2); u16(16);

  if (rootNote !== null) {
    str('smpl'); u32(smplBytes - 8);
    u32(0); u32(0);                         // manufacturer, product
    u32(Math.round(1e9 / sampleRate));      // sample period in ns
    u32(rootNote); u32(0);                  // unity note, pitch fraction
    u32(0); u32(0);                         // SMPTE format, offset
    u32(loop ? 1 : 0); u32(0);              // loop count, sampler data
    if (loop) {
      u32(0); u32(0);                       // cue id, type forward
      u32(loop.start); u32(Math.max(loop.start, loop.end - 1));
      u32(0); u32(0);                       // fraction, play count (0 = forever)
    }
  }

  str('data'); u32(dataBytes);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
  }
  return buf;
}
