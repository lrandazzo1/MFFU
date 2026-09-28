import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const { buildPodcastAudio, duckStingers } = require('../lib/dist/build-podcast-audio.js');
const { readMp3Frames } = require('../lib/dist/mp3-frames.js');
const { sanitizePodcastScript } = require('../lib/dist/sanitize-podcast-script.js');

function run(args, input) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
    { input, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

function tone(frequency, duration) {
  return run(['-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
    '-ac', '2', '-ar', '44100', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
}

assert.equal(sanitizePodcastScript('**FSN** 🎙️ [SFX: swoosh] <break time="1s"/> A.J. Brown & NFL'),
  'F S N A J Brown and N F L');
assert.equal(sanitizePodcastScript('Team Fire plays McConkey!', { McConkey: 'Mick Conkey' }),
  'Team Fire plays Mick Conkey!');

const speechPcm = Buffer.alloc(44100 * 4);
const musicPcm = Buffer.alloc(44100 * 4);
for (let sample = 0; sample < 44100; sample++) {
  for (let channel = 0; channel < 2; channel++) {
    speechPcm.writeInt16LE(sample > 22050 ? 5000 : 0, sample * 4 + channel * 2);
    musicPcm.writeInt16LE(1000, sample * 4 + channel * 2);
  }
}
const ducked = duckStingers(speechPcm, musicPcm);
assert.equal(ducked.readInt16LE(10000 * 4), 1000, 'Music was reduced without speech');
const musicUnderSpeech = ducked.readInt16LE(40000 * 4) - 5000;
assert.ok(musicUnderSpeech >= 245 && musicUnderSpeech <= 258,
  `Expected -12 dB ducking, got ${musicUnderSpeech} / 1000`);

const turns = [tone(440, 0.4), tone(660, 0.5), tone(550, 0.45)];
const plain = await buildPodcastAudio(turns);
const withBeds = await buildPodcastAudio(turns, { intro: tone(220, 0.25), outro: tone(330, 0.25) });
for (const result of [plain, withBeds]) {
  assert.equal(result.markers.length, 3);
  assert.ok(result.markers[0] > 0.3 && result.markers[0] < 0.41);
  assert.ok(result.markers[1] > result.markers[0]);
  assert.ok(!result.audio.subarray(0, 3).equals(Buffer.from('ID3')));
  assert.ok(Math.abs(readMp3Frames(result.audio).duration - result.markers[2]) < 1 / 44100);
  run(['-f', 'mp3', '-i', 'pipe:0', '-f', 'null', '-'], result.audio);
  const measured = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', 'pipe:0',
    '-af', 'loudnorm=I=-16:TP=-1.0:LRA=11:print_format=json', '-f', 'null', '-'],
  { input: result.audio, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(measured.status, 0, measured.stderr.toString());
  const match = measured.stderr.toString().match(/"input_i"\s*:\s*"(-?[\d.]+)"[\s\S]*?"input_tp"\s*:\s*"(-?[\d.]+)"/);
  assert.ok(match, 'No loudnorm measurement in FFmpeg output');
  assert.ok(Math.abs(Number(match[1]) + 16) < 1.5, `Integrated loudness: ${match[1]} LUFS`);
  assert.ok(Number(match[2]) <= -0.8, `True peak: ${match[2]} dBFS`);
}
assert.ok(withBeds.audio.length > 0);
console.log('[podcast-audio-check] crossfades, stingers, markers, loudness and decode clean');
