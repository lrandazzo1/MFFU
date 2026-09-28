/** Parse complete MPEG-1 Layer III frames from ElevenLabs or the 48 kHz final mix.
 * Frame padding is part of each frame's byte length and must be preserved. */
const SAMPLE_RATES = [44100, 48000, 32000];
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

function headerAt(input: Buffer, at: number) {
  if (at + 4 > input.length || input[at] !== 0xff || (input[at + 1] & 0xfe) !== 0xfa) return null;
  const bitrateIndex = input[at + 2] >>> 4;
  const sampleIndex = (input[at + 2] >>> 2) & 3;
  if (!BITRATES[bitrateIndex] || sampleIndex === 3) return null;
  const sampleRate = SAMPLE_RATES[sampleIndex];
  const padding = (input[at + 2] >>> 1) & 1;
  const length = Math.floor(144000 * BITRATES[bitrateIndex] / sampleRate) + padding;
  return { length, sampleRate, bitrateKbps: BITRATES[bitrateIndex], mono: (input[at + 3] >>> 6) === 3, crc: !(input[at + 1] & 1) };
}

function id3Start(input: Buffer): number {
  let at = 0;
  while (input.toString('ascii', at, at + 3) === 'ID3') {
    if (at + 10 > input.length || input.subarray(at + 6, at + 10).some(n => n & 0x80))
      throw new Error('Invalid ID3 header in MP3 segment');
    const size = ((input[at + 6] & 127) << 21) | ((input[at + 7] & 127) << 14) |
      ((input[at + 8] & 127) << 7) | (input[at + 9] & 127);
    at += 10 + size + (input[at + 5] & 0x10 ? 10 : 0);
    if (at > input.length) throw new Error('Truncated ID3 tag in MP3 segment');
  }
  return at;
}

function metadataFrame(input: Buffer, at: number, mono: boolean, crc: boolean, length: number): boolean {
  const sideInfoEnd = at + 4 + (crc ? 2 : 0) + (mono ? 17 : 32);
  const tag = input.toString('ascii', sideInfoEnd, sideInfoEnd + 4);
  return (sideInfoEnd + 4 <= at + length && (tag === 'Xing' || tag === 'Info')) ||
    (at + 40 <= at + length && input.toString('ascii', at + 36, at + 40) === 'VBRI');
}

export type Mp3Frames = { audio: Buffer; frames: number; duration: number; mono: boolean;
  sampleRate: number; bitrateKbps: number | null };

export function readMp3Frames(input: Buffer): Mp3Frames {
  if (!input.length) throw new Error('Empty MP3 segment');
  let at = id3Start(input);
  const limit = input.toString('ascii', input.length - 128, input.length - 125) === 'TAG'
    ? input.length - 128 : input.length;
  // Some encoders put a short zero prefix before the first sync word.
  while (at < limit && input[at] === 0) at++;
  const first = headerAt(input, at);
  if (!first) throw new Error('Unsupported MP3 segment: expected MPEG-1 Layer III at 44.1 or 48 kHz');
  const mono = first.mono;
  let bitrateKbps: number | null = first.bitrateKbps;
  const frames: Buffer[] = [];
  let firstAudio = true;
  while (at < limit) {
    const header = headerAt(input, at);
    if (!header) {
      // Encoder byte alignment at the end may be zero filled, but arbitrary
      // trailing bytes would make the final file malformed.
      if (input.subarray(at, limit).every(n => n === 0)) break;
      throw new Error('Invalid or truncated MP3 frame at byte ' + at);
    }
    if (header.mono !== mono || header.sampleRate !== first.sampleRate || at + header.length > limit)
      throw new Error('Inconsistent or truncated MP3 frame at byte ' + at);
    if (header.bitrateKbps !== first.bitrateKbps) bitrateKbps = null;
    if (!(frames.length === 0 && metadataFrame(input, at, mono, header.crc, header.length))) {
      // The first audio frame of an independently encoded turn cannot refer
      // to the previous turn's bit reservoir. Reject it if it does.
      if (firstAudio) {
        const side = at + 4 + (header.crc ? 2 : 0);
        const mainDataBegin = (input[side] << 1) | (input[side + 1] >>> 7);
        if (mainDataBegin) throw new Error('MP3 segment begins with a dependent bit reservoir frame');
        firstAudio = false;
      }
      frames.push(input.subarray(at, at + header.length));
    }
    at += header.length;
  }
  if (!frames.length) throw new Error('MP3 segment contains no audio frames');
  return { audio: Buffer.concat(frames), frames: frames.length,
    duration: frames.length * 1152 / first.sampleRate, mono,
    sampleRate: first.sampleRate, bitrateKbps };
}
