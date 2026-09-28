import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { readMp3Frames } from './mp3-frames';

const RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = CHANNELS * 2; // interleaved signed 16-bit PCM
const FADE_SAMPLES = Math.round(RATE * 0.07);
const MAX_TURN_BYTES = 8 * 1024 * 1024;
const MAX_STINGER_BYTES = 5 * 1024 * 1024;
const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;

export type PodcastStingers = { intro?: Buffer; outro?: Buffer };

/** Optional, deploy-owned tracks. No file is needed for speech-only episodes. */
export async function configuredPodcastStingers(): Promise<PodcastStingers> {
  const base = join(process.cwd(), 'assets/podcast-audio');
  const load = async (name: string) => {
    const path = join(base, name);
    if (!existsSync(path)) return undefined;
    if ((await stat(path)).size > MAX_STINGER_BYTES) throw new Error('Podcast stinger is too large: ' + name);
    return readFile(path);
  };
  return { intro: await load('intro.mp3'), outro: await load('outro.mp3') };
}

function runFfmpeg(args: string[]): Promise<void> {
  if (!FFMPEG) throw new Error('Podcast FFmpeg binary is unavailable');
  return new Promise((done, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else done();
    };
    child.on('error', err => finish(err));
    child.on('close', code => finish(code === 0 ? undefined :
      new Error('Podcast FFmpeg failed (' + code + '): ' + stderr)));
  });
}

async function decode(input: Buffer, path: string, prefix: string): Promise<number> {
  if (!input.length || input.length > MAX_TURN_BYTES) throw new Error('Invalid podcast audio input size');
  const encoded = path + '.mp3';
  await writeFile(encoded, input);
  await runFfmpeg(['-i', encoded, '-map', '0:a:0', '-vn', '-ac', String(CHANNELS),
    '-ar', String(RATE), '-f', 's16le', '-acodec', 'pcm_s16le', path]);
  const size = (await stat(path)).size;
  if (!size || size % BYTES_PER_SAMPLE) throw new Error('Podcast ' + prefix + ' decoded to invalid PCM');
  return size / BYTES_PER_SAMPLE;
}

function crossfadePcm(turns: Buffer[]): Buffer {
  const overlapBytes = FADE_SAMPLES * BYTES_PER_SAMPLE;
  const length = turns.reduce((n, turn) => n + turn.length, 0) - (turns.length - 1) * overlapBytes;
  const output = Buffer.allocUnsafe(length);
  let cursor = 0;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const start = i ? cursor - overlapBytes : 0;
    if (i) {
      for (let sample = 0; sample < FADE_SAMPLES; sample++) {
        const gain = sample / (FADE_SAMPLES - 1);
        for (let channel = 0; channel < CHANNELS; channel++) {
          const at = (sample * CHANNELS + channel) * 2;
          const mixed = Math.round(output.readInt16LE(start + at) * (1 - gain) + turn.readInt16LE(at) * gain);
          output.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), start + at);
        }
      }
    }
    turn.copy(output, start + (i ? overlapBytes : 0), i ? overlapBytes : 0);
    cursor = start + turn.length;
  }
  return output;
}

/** Speech-gated bed mix. Sustained speech moves music to -12 dB over 10 ms;
 * its release is 200 ms so pauses do not pump the background level. */
export function duckStingers(speech: Buffer, intro?: Buffer, outro?: Buffer): Buffer {
  if (!intro && !outro) return speech;
  const result = Buffer.allocUnsafe(speech.length);
  const frames = speech.length / BYTES_PER_SAMPLE;
  const introFrames = (intro?.length || 0) / BYTES_PER_SAMPLE;
  const outroFrames = (outro?.length || 0) / BYTES_PER_SAMPLE;
  const outroStart = Math.max(0, frames - outroFrames);
  let gain = 1;
  let level = 0;
  const gate = 0.008; // about -42 dBFS speech RMS
  const duckedGain = Math.pow(10, -12 / 20);
  const detectorStep = 1 / Math.round(RATE * 0.01);
  const attackStep = 1 / Math.round(RATE * 0.01);
  const releaseStep = 1 / Math.round(RATE * 0.2);
  for (let frame = 0; frame < frames; frame++) {
    const left = speech.readInt16LE(frame * 4);
    const right = speech.readInt16LE(frame * 4 + 2);
    const peak = Math.max(Math.abs(left), Math.abs(right)) / 32768;
    level += (peak - level) * detectorStep;
    const target = level > gate ? duckedGain : 1;
    gain += (target - gain) * (target < gain ? attackStep : releaseStep);
    for (let channel = 0; channel < CHANNELS; channel++) {
      const at = frame * 4 + channel * 2;
      let bed = frame < introFrames ? intro!.readInt16LE(at) : 0;
      const outroFrame = frame - outroStart;
      if (outroFrame >= 0 && outroFrame < outroFrames) bed += outro!.readInt16LE(outroFrame * 4 + channel * 2);
      const mixed = Math.round(speech.readInt16LE(at) + bed * gain);
      result.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), at);
    }
  }
  return result;
}

/** Decode each independent provider turn, overlap adjacent speakers by 70 ms,
 * optionally duck music beneath speech, normalize and encode one fresh MP3.
 * Markers switch at the midpoint of each overlap; the final one matches the
 * encoded MP3 duration used by the browser audio element. */
export async function buildPodcastAudio(
  segments: Buffer[], stingers: PodcastStingers = {},
): Promise<{ audio: Buffer; markers: number[] }> {
  if (!segments.length || segments.length > 16) throw new Error('Invalid podcast audio segment count');
  const directory = await mkdtemp(join(tmpdir(), 'fsn-podcast-'));
  try {
    const paths: string[] = [];
    const samples: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      const path = join(directory, `turn-${i}.pcm`);
      samples.push(await decode(segments[i], path, `turn ${i}`));
      paths.push(path);
    }
    if (samples.some(n => n <= FADE_SAMPLES * 2))
      throw new Error('Podcast turn is too short for a 70 ms crossfade');

    let mixed = crossfadePcm(await Promise.all(paths.map(path => readFile(path))));
    const markers: number[] = [];
    let elapsed = 0;
    for (let i = 0; i < samples.length; i++) {
      elapsed += samples[i] - (i ? FADE_SAMPLES : 0);
      // During an overlap both speakers are audible. Switch the active card
      // at its midpoint instead of waiting until the next turn is fully up.
      markers.push((elapsed - (i < samples.length - 1 ? FADE_SAMPLES / 2 : 0)) / RATE);
    }

    const beds: PodcastStingers = {};
    for (const [kind, data] of Object.entries(stingers) as [keyof PodcastStingers, Buffer | undefined][]) {
      if (!data) continue;
      if (data.length > MAX_STINGER_BYTES) throw new Error('Podcast ' + kind + ' stinger is too large');
      const path = join(directory, kind + '.pcm');
      await decode(data, path, kind);
      beds[kind] = await readFile(path);
    }
    mixed = duckStingers(mixed, beds.intro, beds.outro);
    const mixPath = join(directory, 'mix.pcm');
    await writeFile(mixPath, mixed);
    const output = join(directory, 'episode.mp3');
    await runFfmpeg(['-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', mixPath,
      '-af', `loudnorm=I=-16:TP=-1.0:LRA=11,aresample=${RATE}`,
      '-map_metadata', '-1', '-ac', String(CHANNELS), '-ar', String(RATE),
      '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', output]);
    const audio = await readFile(output);
    if (!audio.length) throw new Error('Podcast mix encoded an empty MP3');
    // The final encoder adds one frame of priming. Match the player's MP3
    // duration at the last marker while retaining speech boundaries earlier.
    markers[markers.length - 1] = readMp3Frames(audio).duration;
    return { audio, markers };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
