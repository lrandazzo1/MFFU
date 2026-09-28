import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readMp3Frames } = require('../lib/dist/mp3-frames.js');
const { buildPodcastAudio } = require('../lib/dist/build-podcast-audio.js');

function frame(bitrateIndex = 9, padding = 0) {
  const bitrate = { 8: 112, 9: 128, 10: 160 }[bitrateIndex];
  const bytes = Buffer.alloc(Math.floor(144000 * bitrate / 44100) + padding);
  bytes.set([0xff, 0xfb, (bitrateIndex << 4) | (padding << 1), 0]);
  return bytes;
}

const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3, 0x61, 0x62, 0x63]);
const xing = frame();
xing.write('Xing', 36, 'ascii');
const one = Buffer.concat([id3, xing, frame(9, 1), frame(10)]);
const two = Buffer.concat([frame(8), frame(9), Buffer.alloc(3)]);
const result = buildPodcastAudio([one, two]);
assert.equal(readMp3Frames(one).frames, 2);
assert.equal(result.audio.length, frame(9, 1).length + frame(10).length + frame(8).length + frame(9).length);
assert.deepEqual(result.markers, [2 * 1152 / 44100, 4 * 1152 / 44100]);
assert.equal(result.audio.subarray(0, 4).compare(frame(9, 1).subarray(0, 4)), 0);
assert.throws(() => readMp3Frames(one.subarray(0, -1)), /truncated/);
assert.throws(() => readMp3Frames(Buffer.concat([frame(), Buffer.from('junk')])), /Invalid/);
const dependent = frame();
dependent[4] = 1;
assert.throws(() => readMp3Frames(dependent), /bit reservoir/);
console.log('[mp3-frames-check] padded frames, tags, VBR timing and invalid input clean');
